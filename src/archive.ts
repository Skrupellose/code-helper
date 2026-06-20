import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "./config.js";
import { ensureDirectory, projectPath, writeText } from "./fs-utils.js";
import type { CodeHelperConfig, OperationResult } from "./types.js";
import { normalizeDocumentName, normalizeFeatureName } from "./workflows.js";

/**
 * 任务文档的状态。
 * active 表示仍在顶层工作目录，archived 表示已经进入 archive，mixed 表示两边都存在，需要人工收口。
 */
export type TaskStatus = "active" | "archived" | "mixed";

/**
 * 单个任务在 plan/result/status 三类文档中的分布。
 * CLI 会用该结构展示“哪些任务仍在进行，哪些已经结束”。
 */
export interface TaskRecord {
  featureName: string;
  status: TaskStatus;
  activeArtifacts: string[];
  archivedArtifacts: string[];
}

/**
 * 执行任务文档归档。
 * 归档目标固定为各文档目录下的 archive 子目录，避免已结束任务继续污染当前工作台。
 */
export async function archiveFeature(projectRoot: string, rawFeatureName: string): Promise<OperationResult[]> {
  const config = await loadConfig(projectRoot);

  if (!config.features.documentArchive.enabled) {
    throw new Error("文档归档功能已关闭，请先执行 `code-helper features enable documentArchive`。");
  }

  const featureNames = getArchiveFeatureNameCandidates(rawFeatureName);
  const recordFeatureName = featureNames[0];
  const operations: OperationResult[] = [];
  const moves = featureNames.flatMap((featureName) => getArchiveMoves(config, featureName));

  for (const move of moves) {
    operations.push(await movePathIfExists(projectRoot, move.from, move.to));
  }

  if (!operations.some((operation) => isKnownArchivedOperation(operation))) {
    throw new Error(`未找到功能文档：${rawFeatureName}。请确认 plan-doc、result-doc 或 status-doc 中存在对应任务。`);
  }

  operations.push(await writeArchiveRecord(projectRoot, config, recordFeatureName, operations));

  return operations;
}

/**
 * 生成归档任务名候选。
 * 新文档强制中文命名；旧项目可能仍有英文 feature 文档，因此归档时保留旧英文兼容。
 */
function getArchiveFeatureNameCandidates(rawFeatureName: string): string[] {
  const legacyName = normalizeFeatureName(rawFeatureName);
  const chineseName = normalizeDocumentName(rawFeatureName, "功能文档");
  const orderedNames = containsChinese(rawFeatureName)
    ? [chineseName, legacyName]
    : [legacyName, chineseName];

  return [...new Set(orderedNames)];
}

/**
 * 判断输入是否包含中文。
 * 归档命令用它决定中文新规则和英文旧规则的匹配优先级。
 */
function containsChinese(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

/**
 * 扫描当前项目任务。
 * 如果用户手动把文件移动到 archive 子目录，这里也会识别为 archived。
 */
export async function listTasks(projectRoot: string): Promise<TaskRecord[]> {
  const config = await loadConfig(projectRoot);
  const tasks = new Map<string, TaskRecord>();

  await collectPlanDocuments(projectRoot, config, tasks, false);
  await collectPlanDocuments(projectRoot, config, tasks, true);
  await collectResultDocuments(projectRoot, config, tasks, false);
  await collectResultDocuments(projectRoot, config, tasks, true);
  await collectStatusDocuments(projectRoot, config, tasks, false);
  await collectStatusDocuments(projectRoot, config, tasks, true);

  return [...tasks.values()]
    .map((task) => ({
      ...task,
      status: resolveTaskStatus(task)
    }))
    .sort((left, right) => left.featureName.localeCompare(right.featureName));
}

/**
 * 根据任务名生成三类文档的归档移动计划。
 * plan/status 是单文件，result 是目录，三者互相独立，允许部分存在。
 */
function getArchiveMoves(config: CodeHelperConfig, featureName: string): Array<{ from: string; to: string }> {
  return [
    {
      from: join(config.directories.planDoc, `${featureName}.md`),
      to: join(config.directories.planDoc, "archive", `${featureName}.md`)
    },
    {
      from: join(config.directories.resultDoc, featureName),
      to: join(config.directories.resultDoc, "archive", featureName)
    },
    {
      from: join(config.directories.statusDoc, `${featureName}-状态.md`),
      to: join(config.directories.statusDoc, "archive", `${featureName}-状态.md`)
    },
    {
      from: join(config.directories.statusDoc, `${featureName}-status.md`),
      to: join(config.directories.statusDoc, "archive", `${featureName}-status.md`)
    }
  ];
}

/**
 * 文件或目录存在时移动到 archive。
 * 目标已存在时不覆盖，避免破坏用户手动归档后的内容。
 */
async function movePathIfExists(projectRoot: string, fromRelativePath: string, toRelativePath: string): Promise<OperationResult> {
  const fromPath = projectPath(projectRoot, fromRelativePath);
  const toPath = projectPath(projectRoot, toRelativePath);
  const sourceExists = await pathExists(fromPath);
  const targetExists = await pathExists(toPath);

  if (!sourceExists && targetExists) {
    return {
      path: toPath,
      action: "skipped",
      message: "已在归档目录中，识别为已结束任务"
    };
  }

  if (!sourceExists) {
    return {
      path: fromPath,
      action: "skipped",
      message: "源文档不存在，跳过归档"
    };
  }

  if (targetExists) {
    return {
      path: toPath,
      action: "skipped",
      message: "归档目标已存在，为避免覆盖已跳过"
    };
  }

  await mkdir(dirname(toPath), { recursive: true });
  await rename(fromPath, toPath);

  return {
    path: toPath,
    action: "updated",
    message: "已移动到归档目录"
  };
}

/**
 * 写入归档记录。
 * 该记录只描述 code-helper 的归档动作，不替代业务 result-doc。
 */
async function writeArchiveRecord(
  projectRoot: string,
  config: CodeHelperConfig,
  featureName: string,
  operations: OperationResult[]
): Promise<OperationResult> {
  const archiveDirectory = projectPath(projectRoot, join(config.directories.workspace, "archives"));
  const targetPath = join(archiveDirectory, `${featureName}.json`);
  const archivedPaths = operations
    .filter((operation) => isKnownArchivedOperation(operation))
    .map((operation) => operation.path);

  await ensureDirectory(archiveDirectory);
  await writeText(
    targetPath,
    `${JSON.stringify(
      {
        featureName,
        archivedAt: new Date().toISOString(),
        archivedPaths,
        note: "此记录由 code-helper archive 生成。任务文档在 archive 目录中时视为已结束。"
      },
      null,
      2
    )}\n`
  );

  return {
    path: targetPath,
    action: "updated",
    message: "已写入归档记录"
  };
}

/**
 * 判断操作是否证明该任务已经处于归档状态。
 * 源文档不存在不算已归档，避免生成空归档记录。
 */
function isKnownArchivedOperation(operation: OperationResult): boolean {
  return operation.message === "已移动到归档目录" || operation.message === "已在归档目录中，识别为已结束任务";
}

/**
 * 收集 plan-doc 中的活动或归档计划文档。
 */
async function collectPlanDocuments(
  projectRoot: string,
  config: CodeHelperConfig,
  tasks: Map<string, TaskRecord>,
  archived: boolean
): Promise<void> {
  const directory = archived
    ? join(config.directories.planDoc, "archive")
    : config.directories.planDoc;
  const files = await safeReadDirectory(projectPath(projectRoot, directory));

  for (const file of files) {
    if (!file.endsWith(".md")) {
      continue;
    }

    const featureName = file.slice(0, -".md".length);
    addArtifact(tasks, featureName, join(directory, file), archived);
  }
}

/**
 * 收集 result-doc 中的活动或归档执行结果目录。
 */
async function collectResultDocuments(
  projectRoot: string,
  config: CodeHelperConfig,
  tasks: Map<string, TaskRecord>,
  archived: boolean
): Promise<void> {
  const directory = archived
    ? join(config.directories.resultDoc, "archive")
    : config.directories.resultDoc;
  const entries = await safeReadDirectory(projectPath(projectRoot, directory));

  for (const entry of entries) {
    if (entry === "archive" || entry.startsWith(".")) {
      continue;
    }

    const absolutePath = projectPath(projectRoot, join(directory, entry));
    if (!(await isDirectory(absolutePath))) {
      continue;
    }

    addArtifact(tasks, entry, join(directory, entry), archived);
  }
}

/**
 * 收集 status-doc 中的活动或归档状态文件。
 */
async function collectStatusDocuments(
  projectRoot: string,
  config: CodeHelperConfig,
  tasks: Map<string, TaskRecord>,
  archived: boolean
): Promise<void> {
  const directory = archived
    ? join(config.directories.statusDoc, "archive")
    : config.directories.statusDoc;
  const files = await safeReadDirectory(projectPath(projectRoot, directory));

  for (const file of files) {
    const featureName = extractStatusFeatureName(file);

    if (featureName === undefined) {
      continue;
    }

    addArtifact(tasks, featureName, join(directory, file), archived);
  }
}

/**
 * 从状态文档文件名中提取任务名。
 * 新文档使用中文 `-状态.md`，旧文档的 `-status.md` 仍兼容识别。
 */
function extractStatusFeatureName(file: string): string | undefined {
  if (file.endsWith("-状态.md")) {
    return file.slice(0, -"-状态.md".length);
  }

  if (file.endsWith("-status.md")) {
    return file.slice(0, -"-status.md".length);
  }

  return undefined;
}

/**
 * 把一个文档路径加入任务记录。
 * 统一在这里初始化 TaskRecord，避免各收集函数重复逻辑。
 */
function addArtifact(
  tasks: Map<string, TaskRecord>,
  featureName: string,
  relativePath: string,
  archived: boolean
): void {
  const existing = tasks.get(featureName) ?? {
    featureName,
    status: "active",
    activeArtifacts: [],
    archivedArtifacts: []
  };

  if (archived) {
    existing.archivedArtifacts.push(relativePath);
  } else {
    existing.activeArtifacts.push(relativePath);
  }

  tasks.set(featureName, existing);
}

/**
 * 根据活动文档和归档文档分布推导任务状态。
 */
function resolveTaskStatus(task: TaskRecord): TaskStatus {
  if (task.activeArtifacts.length > 0 && task.archivedArtifacts.length > 0) {
    return "mixed";
  }

  if (task.archivedArtifacts.length > 0) {
    return "archived";
  }

  return "active";
}

/**
 * 判断路径是否存在。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断路径是否为目录。
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 安全读取目录。
 * 不存在时返回空数组，方便新项目或未使用过的 archive 目录扫描。
 */
async function safeReadDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
