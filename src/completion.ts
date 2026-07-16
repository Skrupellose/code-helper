import { spawnSync } from "node:child_process";

import { getArchiveFeatureNameCandidates, listTasks, type TaskRecord } from "./archive.js";
import { loadConfig } from "./config.js";
import { portablePath, projectPath, readTextIfExists } from "./fs-utils.js";
import { MANUAL_TEST_FILE_NAME, RESULT_RECORD_FILE_NAME } from "./workflows.js";

const LEGACY_RESULT_RECORD_FILE_NAME = "implementation.md";
const LEGACY_MANUAL_TEST_FILE_NAME = "manual-test.md";

/**
 * 完成检查的判断结果。
 * 该状态不替代人工验收，只用于让 agent 在收尾前明确下一步动作。
 * mixed：任务同时存在 active 与 archive 文档，且已过文档/阻塞/节点门槛，需先整理冲突而非直接归档切换。
 */
export type CompletionReviewStatus =
  | "needs-work"
  | "blocked"
  | "node-review"
  | "ready-to-archive"
  | "archived"
  | "missing-docs"
  | "mixed";

/**
 * 完成检查的结构化结果。
 * CLI、人机交互和 agent hook 模板都复用该结构，避免多处重复判断。
 */
export interface CompletionReview {
  featureName: string;
  taskStatus: TaskRecord["status"];
  reviewStatus: CompletionReviewStatus;
  documents: {
    plan: DocumentPresence;
    result: DocumentPresence;
    status: DocumentPresence;
    manualTest: DocumentPresence;
  };
  statusCounts: Record<"notStarted" | "inProgress" | "partial" | "blocked" | "done", number>;
  hasCurrentExecutionNode: boolean;
  hasSubPlanQueue: boolean;
  changedPaths: string[];
  shouldAskMemoryUpdate: boolean;
  shouldAskArchive: boolean;
  shouldSelectNextTask: boolean;
  requiredConfirmations: string[];
  recommendations: string[];
}

/**
 * 单个协作文档的存在状态。
 * relativePath 固定使用 POSIX 风格，保证 macOS 和 Windows 输出一致。
 */
export interface DocumentPresence {
  relativePath: string;
  exists: boolean;
}

/**
 * 执行功能完成检查。
 * 该函数只读取项目状态，不自动修改文档、不归档、不更新长期记忆。
 */
export async function createCompletionReview(projectRoot: string, featureName: string): Promise<CompletionReview> {
  const config = await loadConfig(projectRoot);

  if (!config.features.completionReview.enabled) {
    throw new Error("功能完成检查已关闭，请先执行 `code-helper features enable completionReview`。");
  }

  const tasks = await listTasks(projectRoot);
  const task = findTask(tasks, featureName);

  if (task === undefined) {
    // 找不到任务时附上可用任务列表，方便用户对照空格/连字符/中英文候选名差异。
    const availableTasks = tasks.map((item) => item.featureName);
    const availableHint = availableTasks.length > 0
      ? `可用任务：${availableTasks.join("、")}。`
      : "当前项目还没有可识别的任务文档。";
    throw new Error(`未找到任务文档：${featureName}。请先生成计划文档，或确认任务名称是否正确。${availableHint}`);
  }

  // plan 也走候选列表：mixed 时需在 active 与 archive 双侧探测，避免误判缺失。
  const plan = await readDocumentCandidates(
    projectRoot,
    getPlanDocumentPathCandidates(task, config.directories.planDoc)
  );
  const result = await readDocumentCandidates(
    projectRoot,
    getResultDocumentPathCandidates(task, config.directories.resultDoc)
  );
  const status = await readDocumentCandidates(
    projectRoot,
    getStatusDocumentPathCandidates(task, config.directories.statusDoc)
  );
  const manualTest = await readDocumentCandidates(
    projectRoot,
    getManualTestDocumentPathCandidates(task, config.directories.resultDoc)
  );
  const combinedContent = [plan.content, result.content, status.content, manualTest.content].filter(Boolean).join("\n");
  // 完成结论只读取 status-doc 的结构化执行区段。计划说明、历史实施记录、状态枚举示例和
  // 明确不做范围都不代表当前仍需执行的节点，不能参与 blocked / needs-work 判定。
  const statusCounts = countExecutionStatusMarkers(status.content ?? "");
  const changedPaths = readGitChangedPaths(projectRoot);
  const hasCurrentExecutionNode = status.content?.includes("## 当前执行节点") === true;
  const hasSubPlanQueue = status.content?.includes("## 子计划队列") === true;
  const reviewStatus = resolveReviewStatus({
    task,
    plan,
    result,
    status,
    statusCounts,
    hasCurrentExecutionNode,
    hasSubPlanQueue
  });
  const memoryUpdateHandled = detectMemoryUpdateHandled(combinedContent);
  // archived 已由目录生命周期确认结束，mixed 需先解决文档冲突；两者都不能被 Git 变更
  // 或归档正文中的历史“下一步”重新拉回长期记忆确认流程。
  const shouldAskMemoryUpdate = task.status === "active"
    && !memoryUpdateHandled
    && detectMemoryUpdateNeed(changedPaths, combinedContent);
  // 仅 pure ready-to-archive 或明确的 mixed 结论才提示归档整理；mixed 文档不全时仍为 missing-docs，不误导归档。
  const shouldAskArchive = reviewStatus === "ready-to-archive" || reviewStatus === "mixed";
  // 只有纯 active 且文档/状态齐全的 ready-to-archive 才引导切换下一任务；mixed 必须先整理冲突。
  const shouldSelectNextTask = reviewStatus === "ready-to-archive";
  const requiredConfirmations = buildRequiredConfirmations({
    reviewStatus,
    taskStatus: task.status,
    shouldAskMemoryUpdate,
    shouldAskArchive,
    shouldSelectNextTask
  });

  return {
    featureName: task.featureName,
    taskStatus: task.status,
    reviewStatus,
    documents: {
      plan: toDocumentPresence(plan),
      result: toDocumentPresence(result),
      status: toDocumentPresence(status),
      manualTest: toDocumentPresence(manualTest)
    },
    statusCounts,
    hasCurrentExecutionNode,
    hasSubPlanQueue,
    changedPaths,
    shouldAskMemoryUpdate,
    shouldAskArchive,
    shouldSelectNextTask,
    requiredConfirmations,
    recommendations: buildRecommendations({
      reviewStatus,
      taskStatus: task.status,
      shouldAskMemoryUpdate,
      shouldAskArchive,
      shouldSelectNextTask,
      hasCurrentExecutionNode,
      hasSubPlanQueue
    })
  };
}

/**
 * 生成必须向用户确认的事项。
 * 该列表用于 CLI 单独高亮，避免 agent 只读到普通建议后漏问归档、记忆更新或下一任务选择。
 */
function buildRequiredConfirmations(input: {
  reviewStatus: CompletionReviewStatus;
  taskStatus: TaskRecord["status"];
  shouldAskMemoryUpdate: boolean;
  shouldAskArchive: boolean;
  shouldSelectNextTask: boolean;
}): string[] {
  const confirmations: string[] = [];
  // taskStatus 或 reviewStatus 任一为 mixed 都需要显式冲突提示（文档不全时 reviewStatus 仍可能是 missing-docs）。
  const isMixed = input.taskStatus === "mixed" || input.reviewStatus === "mixed";

  // mixed 时必须先处理 active/archive 冲突，不能当成普通未完成任务或直接切换新任务。
  if (isMixed) {
    confirmations.push(
      "任务处于 mixed（活动文档与归档文档并存），必须先整理后再继续：确认 archive 为终态则执行 `code-helper archive <功能名> --resolve-mixed` 清理活动副本；若活动侧仍有未归档内容，补齐后执行 `code-helper archive <功能名>`。"
    );
  }

  if (
    !isMixed
    && (input.reviewStatus === "needs-work"
      || input.reviewStatus === "blocked"
      || input.reviewStatus === "node-review"
      || input.reviewStatus === "missing-docs")
  ) {
    confirmations.push("不得询问归档或切换新任务，必须继续当前任务或先补齐阻塞/缺失文档。");
  }

  if (input.shouldAskMemoryUpdate) {
    confirmations.push("必须询问用户是否更新长期记忆；用户确认前不得写入长期规则。");
  }

  if (input.shouldAskArchive && isMixed) {
    confirmations.push("必须先向用户说明 mixed 冲突处理方式，用户确认前不得执行 archive 或 --resolve-mixed。");
  } else if (input.shouldAskArchive) {
    confirmations.push("必须询问用户是否归档当前任务文档；用户确认前不得执行 archive。");
  }

  if (input.shouldSelectNextTask) {
    confirmations.push("归档完成后必须查看任务列表，并询问用户是否选择下一个活动任务。");
  }

  return confirmations;
}

/**
 * 按任务状态合并 active / archive 文档候选路径。
 * - active：只读活动侧
 * - archived：只读归档侧
 * - mixed：先 active 后 archive，避免部分归档时误判 missing-docs
 */
function mergeDocumentPathCandidates(task: TaskRecord, activePaths: string[], archivedPaths: string[]): string[] {
  if (task.status === "archived") {
    return archivedPaths;
  }

  if (task.status === "mixed") {
    return [...activePaths, ...archivedPaths];
  }

  return activePaths;
}

/**
 * 根据任务状态返回计划文档读取候选路径。
 * archived 任务已经结束，完成检查应读取 archive 中的文档而不是误判 active 文档缺失。
 */
function getPlanDocumentPathCandidates(task: TaskRecord, planDirectory: string): string[] {
  const activePath = portablePath(planDirectory, `${task.featureName}.md`);
  const archivedPath = portablePath(planDirectory, "archive", `${task.featureName}.md`);
  return mergeDocumentPathCandidates(task, [activePath], [archivedPath]);
}

/**
 * 根据任务状态返回实施记录读取候选路径。
 * 新项目固定生成中文文件；旧项目可能仍保留 implementation.md，因此作为兼容 fallback。
 */
function getResultDocumentPathCandidates(task: TaskRecord, resultDirectory: string): string[] {
  const activePaths = [
    portablePath(resultDirectory, task.featureName, RESULT_RECORD_FILE_NAME),
    portablePath(resultDirectory, task.featureName, LEGACY_RESULT_RECORD_FILE_NAME)
  ];
  const archivedPaths = [
    portablePath(resultDirectory, "archive", task.featureName, RESULT_RECORD_FILE_NAME),
    portablePath(resultDirectory, "archive", task.featureName, LEGACY_RESULT_RECORD_FILE_NAME)
  ];

  return mergeDocumentPathCandidates(task, activePaths, archivedPaths);
}

/**
 * 根据任务状态返回状态记录读取候选路径。
 * 新版状态记录优先使用 `-状态.md`，旧项目的 `-status.md` 仅作为 fallback 读取。
 */
function getStatusDocumentPathCandidates(task: TaskRecord, statusDirectory: string): string[] {
  const activePaths = [
    portablePath(statusDirectory, `${task.featureName}-状态.md`),
    portablePath(statusDirectory, `${task.featureName}-status.md`)
  ];
  const archivedPaths = [
    portablePath(statusDirectory, "archive", `${task.featureName}-状态.md`),
    portablePath(statusDirectory, "archive", `${task.featureName}-status.md`)
  ];

  return mergeDocumentPathCandidates(task, activePaths, archivedPaths);
}

/**
 * 根据任务状态返回手工测试文档读取候选路径。
 * 手工测试文档仍按中文生成，manual-test.md 仅用于旧项目完成检查兼容。
 */
function getManualTestDocumentPathCandidates(task: TaskRecord, resultDirectory: string): string[] {
  const activePaths = [
    portablePath(resultDirectory, task.featureName, MANUAL_TEST_FILE_NAME),
    portablePath(resultDirectory, task.featureName, LEGACY_MANUAL_TEST_FILE_NAME)
  ];
  const archivedPaths = [
    portablePath(resultDirectory, "archive", task.featureName, MANUAL_TEST_FILE_NAME),
    portablePath(resultDirectory, "archive", task.featureName, LEGACY_MANUAL_TEST_FILE_NAME)
  ];

  return mergeDocumentPathCandidates(task, activePaths, archivedPaths);
}

/**
 * 从任务列表中按功能名查找任务。
 * 依次尝试精确匹配、大小写不敏感匹配、规范化候选名匹配（空格/连字符、中英文命名规则）。
 */
function findTask(tasks: TaskRecord[], featureName: string): TaskRecord | undefined {
  const exact = tasks.find((task) => task.featureName === featureName);
  if (exact !== undefined) {
    return exact;
  }

  const caseInsensitive = tasks.find((task) => task.featureName.toLowerCase() === featureName.toLowerCase());
  if (caseInsensitive !== undefined) {
    return caseInsensitive;
  }

  const inputKeys = getFeatureNameLookupKeys(featureName);
  return tasks.find((task) => {
    for (const key of getFeatureNameLookupKeys(task.featureName)) {
      if (inputKeys.has(key)) {
        return true;
      }
    }

    return false;
  });
}

/**
 * 生成用于任务名比对的查找键集合。
 * 复用 archive 的功能名候选规则，保证 finish / archive / tasks 对同一输入命中同一任务。
 */
function getFeatureNameLookupKeys(rawFeatureName: string): Set<string> {
  const keys = new Set<string>();
  const raw = rawFeatureName.trim();

  if (raw.length > 0) {
    keys.add(raw);
    keys.add(raw.toLowerCase());
  }

  for (const candidate of getArchiveFeatureNameCandidates(rawFeatureName)) {
    keys.add(candidate);
    keys.add(candidate.toLowerCase());
  }

  return keys;
}

/**
 * 按优先级读取文档候选路径。
 * 中文新文件始终排在第一位；旧英文文件仅在中文文件不存在时兼容读取。
 * mixed 时候选列表已合并 active 与 archive，按先 active 后 archive 探测。
 */
async function readDocumentCandidates(
  projectRoot: string,
  relativePaths: string[]
): Promise<DocumentPresence & { content: string | undefined }> {
  for (const relativePath of relativePaths) {
    const content = await readTextIfExists(projectPath(projectRoot, relativePath));

    if (content !== undefined) {
      return {
        relativePath,
        exists: true,
        content
      };
    }
  }

  return {
    relativePath: relativePaths[0],
    exists: false,
    content: undefined
  };
}

/**
 * 去掉内部 content 字段，避免 CLI JSON 输出过大。
 */
function toDocumentPresence(document: DocumentPresence & { content: string | undefined }): DocumentPresence {
  return {
    relativePath: document.relativePath,
    exists: document.exists
  };
}

/**
 * 统计计划和状态文档中的标准状态枚举。
 * 同时接受全角冒号「状态：」与半角冒号「状态:」，兼容手写与自动生成混用。
 * 这是启发式判断，最终仍以用户验收和 agent 的实现检查为准。
 */
function countExecutionStatusMarkers(content: string): CompletionReview["statusCounts"] {
  const currentExecutionNode = extractMarkdownSection(content, "当前执行节点");
  const subPlanQueue = extractMarkdownSection(content, "子计划队列");
  // 两个区段必须分别解析再汇总。若直接拼接，当“子计划队列”标题上下没有空行时，
  // 当前节点表与子计划表可能被误认为同一张连续表，从而复用错误的表头和列号。
  return mergeStatusCounts(
    countStructuredStatuses(currentExecutionNode),
    countStructuredStatuses(subPlanQueue)
  );
}

/**
 * 汇总两个结构化区段的状态计数，不共享任何 Markdown 表格解析上下文。
 */
function mergeStatusCounts(
  left: CompletionReview["statusCounts"],
  right: CompletionReview["statusCounts"]
): CompletionReview["statusCounts"] {
  return {
    notStarted: left.notStarted + right.notStarted,
    inProgress: left.inProgress + right.inProgress,
    partial: left.partial + right.partial,
    blocked: left.blocked + right.blocked,
    done: left.done + right.done
  };
}

/**
 * 提取指定二级 Markdown 标题下的内容，遇到下一个同级或更高层级标题即停止。
 * 旧文档在区段内使用普通段落，新文档使用表格；保留区段原文可同时兼容两种格式。
 */
function extractMarkdownSection(content: string, heading: string): string {
  const lines = content.split(/\r?\n/gu);
  const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);

  if (startIndex < 0) {
    return "";
  }

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/u.test(lines[index].trim())) {
      break;
    }

    sectionLines.push(lines[index]);
  }

  return sectionLines.join("\n");
}

/**
 * 统计结构化执行区段里的某个状态。
 *
 * 兼容格式：
 * 1. 旧文档的 `状态：进行中` / `状态:进行中`；
 * 2. 当前节点表格的 `| 当前状态 | 进行中 |`；
 * 3. 子计划表独立状态列中的 `| ... | 进行中 | ... |`。
 *
 * 表格逐单元格判断可以避免把“历史说明中曾经处于未开始”之类叙述误当成状态；
 * 带括号补充说明（如“已完成（实现侧）”）仍按主状态识别。
 */
function countStructuredStatuses(content: string): CompletionReview["statusCounts"] {
  const counts: CompletionReview["statusCounts"] = {
    notStarted: 0,
    inProgress: 0,
    partial: 0,
    blocked: 0,
    done: 0
  };
  const lines = content.split(/\r?\n/gu);

  for (let index = 0; index < lines.length;) {
    const trimmedLine = lines[index].trim();

    if (!isMarkdownTableLine(trimmedLine)) {
      addExplicitStatusMarkers(counts, trimmedLine);
      index += 1;
      continue;
    }

    // 连续的表格行作为一张独立表解析。每张表自行定位表头，避免前一张表的“状态”列号
    // 被错误套用到列结构不同的后一张表。
    const tableRows: string[][] = [];
    while (index < lines.length && isMarkdownTableLine(lines[index].trim())) {
      tableRows.push(parseMarkdownTableRow(lines[index].trim()));
      index += 1;
    }
    countMarkdownTableStatuses(counts, tableRows);
  }

  return counts;
}

/**
 * 解析单张 Markdown 表中的状态。
 * - 当前节点键值表只接受“当前状态”键对应的值；
 * - 子计划表优先接受独立“状态”列；
 * - 兼容项目既有规范，在“备注”列接受显式 `状态：...`；
 * - “描述”“已完成”“未完成”等其它列即使出现状态词也不参与统计。
 */
function countMarkdownTableStatuses(
  counts: CompletionReview["statusCounts"],
  rows: string[][]
): void {
  if (rows.length === 0) {
    return;
  }

  const header = rows[0];
  const statusColumnIndex = header.findIndex((cell) => cell === "状态");
  const remarkColumnIndex = header.findIndex((cell) => cell === "备注");

  for (const cells of rows.slice(1)) {
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      continue;
    }

    const currentStatusIndex = cells.findIndex((cell) => cell === "当前状态");
    if (currentStatusIndex >= 0) {
      addStatusValue(counts, cells[currentStatusIndex + 1] ?? "");
      continue;
    }

    if (statusColumnIndex >= 0) {
      addStatusValue(counts, cells[statusColumnIndex] ?? "");
      continue;
    }

    if (remarkColumnIndex >= 0) {
      addExplicitStatusMarkers(counts, cells[remarkColumnIndex] ?? "");
    }
  }
}

/**
 * 统计旧式显式状态标记。状态后允许句末，也允许全角/半角括号补充说明。
 */
function addExplicitStatusMarkers(counts: CompletionReview["statusCounts"], content: string): void {
  for (const [label, key] of STATUS_LABELS) {
    const matches = content.match(new RegExp(`状态[：:]\\s*${label}(?=$|[\\s。；;，,（(）)])`, "gu"));
    counts[key] += matches?.length ?? 0;
  }
}

/**
 * 解析结构化状态单元格；允许 `已完成（实现侧）` 与 `已完成(实现侧)` 等补充说明。
 */
function addStatusValue(counts: CompletionReview["statusCounts"], value: string): void {
  for (const [label, key] of STATUS_LABELS) {
    if (new RegExp(`^${label}(?=$|[\\s（(])`, "u").test(value.trim())) {
      counts[key] += 1;
      return;
    }
  }
}

const STATUS_LABELS = [
  ["未开始", "notStarted"],
  ["进行中", "inProgress"],
  ["部分完成", "partial"],
  ["被阻塞", "blocked"],
  ["已完成", "done"]
] as const;

/**
 * 判断一行是否为 Markdown 管道表格行。
 */
function isMarkdownTableLine(line: string): boolean {
  return line.startsWith("|") && line.endsWith("|");
}

/**
 * 把 Markdown 表格行拆成单元格；当前协作文档不在单元格中使用转义管道符。
 */
function parseMarkdownTableRow(line: string): string[] {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

/**
 * 根据文档状态推导当前完成检查结论。
 * ready-to-archive 只在非 mixed 任务且没有明显未完成状态时给出，避免误导归档或切换任务。
 * mixed 任务在越过文档/阻塞/节点门槛后固定返回 "mixed"，不得再升为 ready-to-archive。
 */
function resolveReviewStatus(input: {
  task: TaskRecord;
  plan: DocumentPresence;
  result: DocumentPresence;
  status: DocumentPresence;
  statusCounts: CompletionReview["statusCounts"];
  hasCurrentExecutionNode: boolean;
  hasSubPlanQueue: boolean;
}): CompletionReviewStatus {
  if (input.task.status === "archived") {
    return "archived";
  }

  // mixed 与 active 共用文档不全 / 阻塞 / 缺节点门槛，便于保留可操作性；越过门槛后不再走 needs-work / ready-to-archive。
  if (input.task.status === "mixed") {
    if (!input.plan.exists || !input.result.exists || !input.status.exists) {
      return "missing-docs";
    }

    if (input.statusCounts.blocked > 0) {
      return "blocked";
    }

    if (!input.hasCurrentExecutionNode || !input.hasSubPlanQueue) {
      return "node-review";
    }

    return "mixed";
  }

  if (!input.plan.exists || !input.result.exists || !input.status.exists) {
    return "missing-docs";
  }

  if (input.statusCounts.blocked > 0) {
    return "blocked";
  }

  if (!input.hasCurrentExecutionNode || !input.hasSubPlanQueue) {
    return "node-review";
  }

  if (input.statusCounts.done > 0 && input.statusCounts.notStarted === 0 && input.statusCounts.inProgress === 0 && input.statusCounts.partial === 0) {
    return "ready-to-archive";
  }

  return "needs-work";
}

/**
 * 读取当前 git 变更文件。
 * 非 git 项目或 git 不可用时返回空数组，保证 completion review 可在任意目录运行。
 */
function readGitChangedPaths(projectRoot: string): string[] {
  const result = spawnSync("git", ["status", "--porcelain", "-z"], {
    cwd: projectRoot,
    encoding: "utf8"
  });

  if (result.status !== 0 || result.error !== undefined) {
    return [];
  }

  return normalizeGitStatusEntries(result.stdout);
}

/**
 * 从 git porcelain -z 输出中提取路径。
 * -z 会保留中文路径原文，避免普通 porcelain 把非 ASCII 路径转成带反斜杠的引号形式。
 */
function normalizeGitStatusEntries(stdout: string): string[] {
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const rawPath = entry.slice(3);

    if (rawPath.length > 0) {
      paths.push(rawPath.replace(/\\/gu, "/"));
    }

    /**
     * rename / copy 在 -z 格式中会额外跟一个旧路径字段。
     * 完成检查只关心当前路径，因此跳过旧路径。
     */
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }

  return paths;
}

/**
 * 判断本轮变更是否可能需要询问用户更新长期记忆。
 * 这里只做提示，不直接写入 user-rules，避免把短期实现细节误沉淀为规则。
 */
function detectMemoryUpdateNeed(changedPaths: string[], content: string): boolean {
  if (changedPaths.some((path) => path.startsWith("code-helper-docs/user-rules/") || path === "AGENTS.md" || path === "CLAUDE.md")) {
    return false;
  }

  if (changedPaths.some((path) => path.startsWith("src/") || path === "package.json" || path === "README.md")) {
    return true;
  }

  return /长期规则|项目规则|协作规范|以后都|默认策略|测试策略|发布流程/u.test(content);
}

/**
 * 判断任务文档是否已经记录长期记忆处理结论。
 *
 * 这里只接受明确的完成或无需处理表达，不把“尚未更新”“仍需确认”“下一步更新”
 * 等历史待办当成已处理。这样 active 任务完成后可以停止重复询问，archived 任务也不会
 * 因旧计划中的历史说明重新进入确认流程。
 */
function detectMemoryUpdateHandled(content: string): boolean {
  const pendingPatterns = [
    /长期记忆(?:尚未|还未|未)(?:完成)?(?:更新|沉淀|处理)/u,
    /(?:尚未|还未|未)(?:完成)?(?:更新|沉淀|处理)(?:了)?长期记忆/u,
    /长期记忆(?:仍需|还需|需要)(?:用户)?(?:确认|更新|沉淀|处理)/u,
    /(?:仍需|还需|需要)(?:用户)?确认(?:是否)?(?:更新|沉淀|处理)?长期记忆/u,
    /(?:仍需|还需|需要)(?:更新|沉淀|处理)长期记忆/u,
    /下一步(?:是|为|需|需要)?(?:更新|沉淀|处理)长期记忆/u
  ];
  const handledPatterns = [
    /长期记忆(?:已|已经)(?:完成)?(?:更新|沉淀|处理)/u,
    /(?:已|已经)(?:完成)?(?:更新|沉淀|处理)(?:了)?长期记忆/u,
    /长期记忆(?:无需|不需要|不再需要)(?:更新|沉淀|处理)?/u,
    /(?:无需|不需要|不再需要)(?:更新|沉淀|处理)?长期记忆/u,
    /(?:决定|确认)(?:本轮)?不(?:更新|沉淀|处理)长期记忆/u
  ];

  // 历史完成记录与当前待办可能同时存在。只要正文仍有明确“尚未、仍需、下一步”
  // 表达，就按当前未处理判断，不依赖两段文字出现顺序，避免旧“已更新”覆盖新待办。
  if (pendingPatterns.some((pattern) => pattern.test(content))) {
    return false;
  }

  return handledPatterns.some((pattern) => pattern.test(content));
}

/**
 * 生成 agent 和用户都能直接执行的下一步建议。
 */
function buildRecommendations(input: {
  reviewStatus: CompletionReviewStatus;
  taskStatus: TaskRecord["status"];
  shouldAskMemoryUpdate: boolean;
  shouldAskArchive: boolean;
  shouldSelectNextTask: boolean;
  hasCurrentExecutionNode: boolean;
  hasSubPlanQueue: boolean;
}): string[] {
  const recommendations: string[] = [];
  // 与 buildRequiredConfirmations 对齐：task mixed 或 reviewStatus mixed 都需要冲突整理提示。
  const isMixed = input.taskStatus === "mixed" || input.reviewStatus === "mixed";

  // mixed 优先提示，避免只看到 missing-docs / ready-to-archive 而忽略 active/archive 冲突。
  if (isMixed) {
    recommendations.push(
      "任务处于 mixed：active 与 archive 同时存在同名文档。请先确认哪一侧为正确版本；若 archive 已是终态，执行 `code-helper archive <功能名> --resolve-mixed` 清理活动副本；若活动侧仍有内容，补齐 plan/result/status 后执行 `code-helper archive <功能名>` 完成归档。"
    );
  }

  if (input.reviewStatus === "missing-docs") {
    recommendations.push(
      isMixed
        ? "mixed 场景下请同时检查 active 与 archive 两侧：补齐仍缺失的 plan-doc、result-doc 和 status-doc 后再判断功能是否完成。"
        : "先补齐 plan-doc、result-doc 和 status-doc，再判断功能是否完成。"
    );
  }

  if (input.reviewStatus === "blocked") {
    recommendations.push("当前任务存在阻塞状态，请继续当前节点或在 status-doc 写清阻塞原因和恢复条件。");
  }

  if (input.reviewStatus === "needs-work") {
    recommendations.push("当前任务仍有未开始、进行中或部分完成节点，应继续推进当前功能，不应归档，也不应切换到新任务。");
  }

  if (input.reviewStatus === "node-review") {
    recommendations.push("先把 status-doc 补成当前执行入口，明确当前执行节点和子计划队列。");
  }

  if (input.reviewStatus === "mixed") {
    recommendations.push(
      "完成检查结论为 mixed：文档与节点门槛已通过，但仍存在 active/archive 冲突，不得视为 ready-to-archive，也不得切换新任务。"
    );
  }

  if (input.reviewStatus === "archived") {
    recommendations.push("当前任务只存在于 archive 目录中，已视为结束任务；如需返工，请新建后续中文功能名或先明确恢复策略。");
    // archived 是终态。归档正文中即使还保留历史“下一步”、缺少新版结构区段，
    // 也不能再附加活动任务式的补文档、更新节点、记忆确认或归档建议。
    return recommendations;
  }

  if (!input.hasCurrentExecutionNode) {
    recommendations.push("status-doc 缺少“当前执行节点”，agent 恢复任务时可能无法稳定判断下一步。");
  }

  if (!input.hasSubPlanQueue) {
    recommendations.push("status-doc 缺少“子计划队列”，建议补齐后再继续推进。");
  }

  recommendations.push("小节点完成后，更新 实施记录.md、计划文档状态和 status-doc 的下一个执行节点。");

  if (input.shouldAskMemoryUpdate) {
    recommendations.push("本轮变更可能形成长期规则，请询问用户是否更新项目记忆。");
  } else {
    recommendations.push("如果本轮变更只是一次性实现细节，不需要更新长期记忆。");
  }

  if (input.shouldAskArchive && isMixed) {
    recommendations.push("整理 mixed 冲突并经用户确认后，再执行 archive 或 --resolve-mixed；确认前不得切换到新任务。");
  } else if (input.shouldAskArchive) {
    recommendations.push("功能整体完成并经用户确认后，询问是否执行文档归档。");
  }

  if (input.shouldSelectNextTask) {
    recommendations.push("归档完成后，列出活动任务并引导用户选择下一步。");
  }

  return recommendations;
}
