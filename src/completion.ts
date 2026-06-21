import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { listTasks, type TaskRecord } from "./archive.js";
import { loadConfig } from "./config.js";
import { portablePath, projectPath, readTextIfExists } from "./fs-utils.js";
import { RESULT_RECORD_FILE_NAME } from "./workflows.js";

/**
 * 完成检查的判断结果。
 * 该状态不替代人工验收，只用于让 agent 在收尾前明确下一步动作。
 */
export type CompletionReviewStatus =
  | "needs-work"
  | "blocked"
  | "node-review"
  | "ready-to-archive"
  | "archived"
  | "missing-docs";

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
    throw new Error(`未找到任务文档：${featureName}。请先生成计划文档，或确认任务名称是否正确。`);
  }

  const plan = await readDocument(projectRoot, getPlanDocumentPath(task, config.directories.planDoc));
  const result = await readDocument(
    projectRoot,
    getResultDocumentPath(task, config.directories.resultDoc)
  );
  const status = await readDocument(projectRoot, getStatusDocumentPath(task, config.directories.statusDoc));
  const manualTest = await readDocument(projectRoot, getManualTestDocumentPath(task, config.directories.resultDoc));
  const combinedContent = [plan.content, result.content, status.content, manualTest.content].filter(Boolean).join("\n");
  const statusCounts = countStatusMarkers(combinedContent);
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
  const shouldAskMemoryUpdate = detectMemoryUpdateNeed(changedPaths, combinedContent);
  const shouldAskArchive = reviewStatus === "ready-to-archive";
  const shouldSelectNextTask = shouldAskArchive;
  const requiredConfirmations = buildRequiredConfirmations({
    reviewStatus,
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
  shouldAskMemoryUpdate: boolean;
  shouldAskArchive: boolean;
  shouldSelectNextTask: boolean;
}): string[] {
  const confirmations: string[] = [];

  if (input.reviewStatus === "needs-work" || input.reviewStatus === "blocked" || input.reviewStatus === "node-review" || input.reviewStatus === "missing-docs") {
    confirmations.push("不得询问归档或切换新任务，必须继续当前任务或先补齐阻塞/缺失文档。");
  }

  if (input.shouldAskMemoryUpdate) {
    confirmations.push("必须询问用户是否更新长期记忆；用户确认前不得写入长期规则。");
  }

  if (input.shouldAskArchive) {
    confirmations.push("必须询问用户是否归档当前任务文档；用户确认前不得执行 archive。");
  }

  if (input.shouldSelectNextTask) {
    confirmations.push("归档完成后必须查看任务列表，并询问用户是否选择下一个活动任务。");
  }

  return confirmations;
}

/**
 * 根据任务状态返回计划文档读取路径。
 * archived 任务已经结束，完成检查应读取 archive 中的文档而不是误判 active 文档缺失。
 */
function getPlanDocumentPath(task: TaskRecord, planDirectory: string): string {
  const activePath = portablePath(planDirectory, `${task.featureName}.md`);
  const archivedPath = portablePath(planDirectory, "archive", `${task.featureName}.md`);
  return task.status === "archived" ? archivedPath : activePath;
}

/**
 * 根据任务状态返回实施记录读取路径。
 */
function getResultDocumentPath(task: TaskRecord, resultDirectory: string): string {
  const activePath = portablePath(resultDirectory, task.featureName, RESULT_RECORD_FILE_NAME);
  const archivedPath = portablePath(resultDirectory, "archive", task.featureName, RESULT_RECORD_FILE_NAME);
  return task.status === "archived" ? archivedPath : activePath;
}

/**
 * 根据任务状态返回状态记录读取路径。
 */
function getStatusDocumentPath(task: TaskRecord, statusDirectory: string): string {
  const activePath = portablePath(statusDirectory, `${task.featureName}-状态.md`);
  const archivedPath = portablePath(statusDirectory, "archive", `${task.featureName}-状态.md`);
  return task.status === "archived" ? archivedPath : activePath;
}

/**
 * 根据任务状态返回手工测试文档读取路径。
 */
function getManualTestDocumentPath(task: TaskRecord, resultDirectory: string): string {
  const activePath = portablePath(resultDirectory, task.featureName, "手工测试.md");
  const archivedPath = portablePath(resultDirectory, "archive", task.featureName, "手工测试.md");
  return task.status === "archived" ? archivedPath : activePath;
}

/**
 * 从任务列表中按功能名查找任务。
 * 先做精确匹配，再做大小写不敏感匹配，兼容用户手动输入。
 */
function findTask(tasks: TaskRecord[], featureName: string): TaskRecord | undefined {
  return tasks.find((task) => task.featureName === featureName)
    ?? tasks.find((task) => task.featureName.toLowerCase() === featureName.toLowerCase());
}

/**
 * 读取文档内容，并保留相对路径和存在状态。
 */
async function readDocument(
  projectRoot: string,
  relativePath: string
): Promise<DocumentPresence & { content: string | undefined }> {
  const content = await readTextIfExists(projectPath(projectRoot, relativePath));

  return {
    relativePath,
    exists: content !== undefined,
    content
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
 * 这是启发式判断，最终仍以用户验收和 agent 的实现检查为准。
 */
function countStatusMarkers(content: string): CompletionReview["statusCounts"] {
  return {
    notStarted: countMatches(content, /状态：未开始/gu),
    inProgress: countMatches(content, /状态：进行中/gu),
    partial: countMatches(content, /状态：部分完成/gu),
    blocked: countMatches(content, /状态：被阻塞/gu),
    done: countMatches(content, /状态：已完成/gu)
  };
}

/**
 * 统计正则命中次数。
 */
function countMatches(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}

/**
 * 根据文档状态推导当前完成检查结论。
 * ready-to-archive 只在任务没有明显未完成状态时给出，避免误导归档。
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
 * 生成 agent 和用户都能直接执行的下一步建议。
 */
function buildRecommendations(input: {
  reviewStatus: CompletionReviewStatus;
  shouldAskMemoryUpdate: boolean;
  shouldAskArchive: boolean;
  shouldSelectNextTask: boolean;
  hasCurrentExecutionNode: boolean;
  hasSubPlanQueue: boolean;
}): string[] {
  const recommendations: string[] = [];

  if (input.reviewStatus === "missing-docs") {
    recommendations.push("先补齐 plan-doc、result-doc 和 status-doc，再判断功能是否完成。");
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

  if (input.reviewStatus === "archived") {
    recommendations.push("当前任务只存在于 archive 目录中，已视为结束任务；如需返工，请新建后续中文功能名或先明确恢复策略。");
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

  if (input.shouldAskArchive) {
    recommendations.push("功能整体完成并经用户确认后，询问是否执行文档归档。");
  }

  if (input.shouldSelectNextTask) {
    recommendations.push("归档完成后，列出活动任务并引导用户选择下一步。");
  }

  return recommendations;
}
