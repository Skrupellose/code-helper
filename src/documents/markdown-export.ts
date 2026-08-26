import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { DocumentDatabase } from "../storage/database.js";
import { calculateDocumentHash, type DocumentRepository } from "./repository.js";
import type { DocumentRecord, TaskRecord } from "./types.js";

export type MarkdownExportStatus = "created" | "updated" | "unchanged" | "conflict";

export interface MarkdownExportItem {
  documentId: string;
  taskId: string;
  relativePath: string;
  status: MarkdownExportStatus;
  message?: string;
}

export interface MarkdownExportResult {
  exported: MarkdownExportItem[];
  conflicts: MarkdownExportItem[];
}

export interface MarkdownExportOptions {
  taskId?: string;
  force?: boolean;
  /** 为 true 时导出到可由项目选择提交的旧版稳定目录。 */
  tracked?: boolean;
  /** 仅供定向测试稳定注入文件竞态；生产调用不得传入。 */
  testHooks?: MarkdownExportTestHooks;
}

/** 投影替换协议的最小测试注入点，不改变生产默认行为。 */
export interface MarkdownExportTestHooks {
  /** 临时文件准备完成、移动现有目标之前触发，用于稳定模拟 read→move 窗口中的人工修改。 */
  beforeExistingMove?: (context: MarkdownExportHookContext) => Promise<void> | void;
  /** 旧目标校验完成、排他安装新投影之前触发，用于模拟目标在空档中被并发创建。 */
  beforeExclusiveInstall?: (context: MarkdownExportHookContext) => Promise<void> | void;
}

export interface MarkdownExportHookContext {
  targetPath: string;
  temporaryPath: string;
  recoveryPath?: string;
}

export type MarkdownProjectionCheckStatus = "missing" | "unchanged" | "database-newer" | "conflict";

export interface MarkdownProjectionCheckItem {
  documentId: string;
  taskId: string;
  relativePath: string;
  status: MarkdownProjectionCheckStatus;
  /** 当前磁盘正文摘要；文件不存在时省略。 */
  diskContentHash?: string;
  message?: string;
}

export interface MarkdownProjectionCheckResult {
  checked: MarkdownProjectionCheckItem[];
  conflicts: MarkdownProjectionCheckItem[];
}

interface ExportRow {
  content_hash: string;
}

/**
 * 将 SQLite 当前正文导出到兼容旧工具的稳定 Markdown 路径。
 * 默认只有目标不存在、内容未变化，或磁盘仍等于上次导出摘要时才写入。
 */
export async function exportMarkdownDocuments(
  projectRoot: string,
  database: DocumentDatabase,
  repository: DocumentRepository,
  options: MarkdownExportOptions = {}
): Promise<MarkdownExportResult> {
  const safeRoot = await realpath(resolve(projectRoot));
  const tasks = options.taskId === undefined
    ? repository.listTasks()
    : [repository.getTask(options.taskId)].filter((task): task is TaskRecord => task !== undefined);
  const exported: MarkdownExportItem[] = [];
  const conflicts: MarkdownExportItem[] = [];

  for (const task of tasks) {
    for (const document of repository.listDocuments(task.id)) {
      const relativePath = getStableMarkdownExportPath(task, document, options);
      const item = await exportSingleDocument(
        safeRoot,
        database,
        repository,
        task,
        document,
        relativePath,
        options.force === true,
        options.testHooks
      );
      (item.status === "conflict" ? conflicts : exported).push(item);
    }
  }

  return { exported, conflicts };
}

/**
 * 在 SQLite mutation 前检查一个任务的 Markdown 兼容投影。
 *
 * 文件不存在、等于当前数据库正文，或仍等于最近一次导出摘要时均可安全刷新；
 * 文件偏离最近导出摘要，或已有文件但无法证明来源时视为人工修改并阻断写入。
 * 本函数只读，不登记新基线，确保冲突路径不会产生数据库副作用。
 */
export async function checkMarkdownProjectionForTask(
  projectRoot: string,
  database: DocumentDatabase,
  repository: DocumentRepository,
  taskId: string
): Promise<MarkdownProjectionCheckResult> {
  const safeRoot = await realpath(resolve(projectRoot));
  const task = repository.getTask(taskId);
  if (task === undefined) {
    throw new Error(`无法检查 Markdown 投影，任务不存在：${taskId}`);
  }

  const checked: MarkdownProjectionCheckItem[] = [];
  const conflicts: MarkdownProjectionCheckItem[] = [];
  for (const document of repository.listDocuments(task.id)) {
    const relativePath = getStableMarkdownExportPath(task, document);
    const absolutePath = resolveInsideProject(safeRoot, relativePath);
    await assertSafeExistingPath(safeRoot, absolutePath);
    const diskBody = await readOptionalFile(absolutePath);
    if (diskBody === undefined) {
      checked.push(makeProjectionCheckItem(task, document, relativePath, "missing"));
      continue;
    }

    const diskContentHash = calculateDocumentHash(diskBody);
    const previous = readExportBaseline(database, document.id, relativePath);
    if (diskContentHash === document.contentHash) {
      checked.push(makeProjectionCheckItem(
        task,
        document,
        relativePath,
        "unchanged",
        diskContentHash
      ));
      continue;
    }
    if (previous !== undefined && diskContentHash === previous.content_hash) {
      checked.push(makeProjectionCheckItem(
        task,
        document,
        relativePath,
        "database-newer",
        diskContentHash,
        "Markdown 仍等于最近导出基线，可由 SQLite 安全刷新"
      ));
      continue;
    }

    const conflict = makeProjectionCheckItem(
      task,
      document,
      relativePath,
      "conflict",
      diskContentHash,
      previous === undefined
        ? "Markdown 已存在但缺少导出基线，无法证明可安全覆盖"
        : "Markdown 在最近导出后被人工修改"
    );
    checked.push(conflict);
    conflicts.push(conflict);
  }
  return { checked, conflicts };
}

/**
 * 为预检时与当前 SQLite 正文完全一致、但尚无摘要的旧投影补登记基线。
 * 调用方必须先完成 checkMarkdownProjectionForTask 且确认没有冲突；登记后导出器仍会
 * 对写入前出现的并发文件修改做摘要比较，不会使用 force 静默覆盖。
 */
export function registerCompatibleProjectionBaselines(
  repository: DocumentRepository,
  result: MarkdownProjectionCheckResult
): void {
  for (const item of result.checked) {
    if (item.status !== "unchanged" || item.diskContentHash === undefined) {
      continue;
    }
    repository.recordDocumentExport({
      documentId: item.documentId,
      exportPath: item.relativePath,
      contentHash: item.diskContentHash
    });
  }
}

/** 计算稳定导出路径所需的最小任务字段；结构化声明避免调用方为凑类型伪造完整 TaskRecord。 */
export type StableExportTaskView = Pick<TaskRecord, "name" | "status">;

/** 计算稳定导出路径所需的最小文档字段。 */
export type StableExportDocumentView = Pick<DocumentRecord, "type">;

/** 根据任务生命周期和文档类型计算稳定的兼容导出路径。 */
export function getStableMarkdownExportPath(
  task: StableExportTaskView,
  document: StableExportDocumentView,
  options: Pick<MarkdownExportOptions, "tracked"> = {}
): string {
  const name = validatePathSegment(task.name, "任务名称");
  // 默认视图与 SQLite 同属 `.code-helper`，由 init 写入 Git 忽略区块；
  // `--tracked` 是用户明确请求的交接/审计副本，使用旧版公共目录以保持兼容。
  const root = options.tracked === true ? "code-helper-docs" : ".code-helper/local/docs";
  if (document.type === "completion_record") {
    return join(root, "completion-record", `${name}-完成记录.md`);
  }

  const archive = task.status === "archived" ? ["archive"] : [];
  switch (document.type) {
    case "plan":
      return join(root, "plan-doc", ...archive, `${name}.md`);
    case "status":
      return join(root, "status-doc", ...archive, `${name}-状态.md`);
    case "result":
      return join(root, "result-doc", ...archive, name, "实施记录.md");
    case "manual_test":
      return join(root, "result-doc", ...archive, name, "手工测试.md");
    default: {
      const exhaustive: never = document.type;
      throw new Error(`不支持的文档类型：${exhaustive}`);
    }
  }
}

async function exportSingleDocument(
  projectRoot: string,
  database: DocumentDatabase,
  repository: DocumentRepository,
  task: TaskRecord,
  document: DocumentRecord,
  relativePath: string,
  force: boolean,
  testHooks?: MarkdownExportTestHooks
): Promise<MarkdownExportItem> {
  const absolutePath = resolveInsideProject(projectRoot, relativePath);
  await assertSafeExistingPath(projectRoot, absolutePath);
  const previous = readExportBaseline(database, document.id, relativePath);
  const existingBody = await readOptionalFile(absolutePath);

  if (existingBody !== undefined) {
    const existingHash = calculateDocumentHash(existingBody);
    if (existingHash === document.contentHash) {
      repository.recordDocumentExport({
        documentId: document.id,
        exportPath: relativePath,
        contentHash: document.contentHash
      });
      return makeItem(task, document, relativePath, "unchanged");
    }

    // 没有历史摘要的文件归用户所有；有摘要但不相等则说明导出后被手工修改。
    if (!force && (previous === undefined || existingHash !== previous.content_hash)) {
      return makeItem(
        task,
        document,
        relativePath,
        "conflict",
        previous === undefined ? "目标文件已存在且没有导出记录" : "目标文件在上次导出后被手工修改"
      );
    }
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await assertSafeExistingPath(projectRoot, dirname(absolutePath));
  const replacement = await safelyReplaceProjectionFile(
    absolutePath,
    document.body,
    existingBody === undefined ? undefined : calculateDocumentHash(existingBody),
    testHooks
  );
  if (!replacement.ok) {
    return makeItem(task, document, relativePath, "conflict", replacement.message);
  }
  repository.recordDocumentExport({
    documentId: document.id,
    exportPath: relativePath,
    contentHash: document.contentHash
  });
  return makeItem(task, document, relativePath, existingBody === undefined ? "created" : "updated");
}

function readExportBaseline(
  database: DocumentDatabase,
  documentId: string,
  relativePath: string
): ExportRow | undefined {
  return database.database.prepare(`
    SELECT content_hash
    FROM document_exports
    WHERE document_id = ? AND export_path = ?
  `).get(documentId, relativePath) as ExportRow | undefined;
}

function makeProjectionCheckItem(
  task: TaskRecord,
  document: DocumentRecord,
  relativePath: string,
  status: MarkdownProjectionCheckStatus,
  diskContentHash?: string,
  message?: string
): MarkdownProjectionCheckItem {
  return {
    documentId: document.id,
    taskId: task.id,
    relativePath,
    status,
    ...(diskContentHash === undefined ? {} : { diskContentHash }),
    ...(message === undefined ? {} : { message })
  };
}

function makeItem(
  task: TaskRecord,
  document: DocumentRecord,
  relativePath: string,
  status: MarkdownExportStatus,
  message?: string
): MarkdownExportItem {
  return {
    documentId: document.id,
    taskId: task.id,
    relativePath,
    status,
    ...(message === undefined ? {} : { message })
  };
}

interface ProjectionReplacementResult {
  ok: boolean;
  message?: string;
}

/**
 * 使用可恢复、排他安装的协议替换投影文件。
 *
 * 不能直接 rename 临时文件覆盖目标：POSIX rename 会静默覆盖在读取摘要后新写入的用户内容。
 * 本协议先把现有目标原子移动到唯一 recovery，再校验被移动正文是否仍是调用方读取的摘要，
 * 最后用 hard link 以 EEXIST 为门禁排他安装新投影。任何竞态都恢复原文件，或在目标已被
 * 并发占用时保留 recovery 并明确路径；因此不会为了刷新兼容投影丢失用户内容。
 */
async function safelyReplaceProjectionFile(
  targetPath: string,
  body: string,
  expectedExistingHash: string | undefined,
  testHooks?: MarkdownExportTestHooks
): Promise<ProjectionReplacementResult> {
  const nonce = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const temporaryPath = `${targetPath}.code-helper-${nonce}.tmp`;
  const recoveryPath = `${targetPath}.code-helper-${nonce}.recovery`;
  let recoveryCreated = false;
  let installed = false;
  try {
    await writeFile(temporaryPath, body, { encoding: "utf8", flag: "wx" });

    if (expectedExistingHash !== undefined) {
      await testHooks?.beforeExistingMove?.({ targetPath, temporaryPath });
      try {
        await rename(targetPath, recoveryPath);
        recoveryCreated = true;
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) {
          return { ok: false, message: "Markdown 在投影替换窗口中被删除，已保留用户操作" };
        }
        throw error;
      }

      const recoveredHash = calculateDocumentHash(await readFile(recoveryPath, "utf8"));
      if (recoveredHash !== expectedExistingHash) {
        const restored = await restoreRecoveryFile(recoveryPath, targetPath);
        recoveryCreated = !restored;
        return {
          ok: false,
          message: restored
            ? "Markdown 在投影替换窗口中被人工修改，用户正文已恢复"
            : `Markdown 在投影替换窗口中被人工修改；目标又被占用，用户正文保留于 ${recoveryPath}`
        };
      }
    }

    await testHooks?.beforeExclusiveInstall?.({
      targetPath,
      temporaryPath,
      ...(recoveryCreated ? { recoveryPath } : {})
    });
    try {
      // hard link 的目标必须不存在，跨 macOS/Windows 都以 EEXIST 拒绝并发创建，
      // 不会像 rename 那样在 POSIX 上覆盖刚写入的用户文件。
      await link(temporaryPath, targetPath);
      installed = true;
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) {
        const restored = recoveryCreated ? await restoreRecoveryFile(recoveryPath, targetPath) : false;
        recoveryCreated = recoveryCreated && !restored;
        return {
          ok: false,
          message: recoveryCreated
            ? `Markdown 在排他安装窗口中被并发创建；原正文保留于 ${recoveryPath}`
            : "Markdown 在排他安装窗口中被并发创建，未覆盖并发正文"
        };
      }
      throw error;
    }

    await rm(temporaryPath);
    if (recoveryCreated) {
      await rm(recoveryPath);
      recoveryCreated = false;
    }
    return { ok: true };
  } finally {
    // 安装成功后 target 与临时文件指向同一 inode；删除临时名称不会影响目标内容。
    await rm(temporaryPath, { force: true });
    if (!installed && recoveryCreated) {
      // 异常路径优先尝试无覆盖恢复；目标已被并发占用时保留 recovery 供人工处理。
      const restored = await restoreRecoveryFile(recoveryPath, targetPath);
      recoveryCreated = !restored;
    }
  }
}

/** 使用排他 hard link 恢复 recovery，绝不覆盖并发创建的目标。 */
async function restoreRecoveryFile(recoveryPath: string, targetPath: string): Promise<boolean> {
  try {
    await link(recoveryPath, targetPath);
    await rm(recoveryPath);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "EEXIST") || isFileSystemError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** 检查已经存在的每一级路径，禁止通过目录或目标文件符号链接逃逸。 */
async function assertSafeExistingPath(projectRoot: string, targetPath: string): Promise<void> {
  const relativePath = relative(projectRoot, targetPath);
  let cursor = projectRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new Error(`导出路径不能包含符号链接：${cursor}`);
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function resolveInsideProject(projectRoot: string, relativePath: string): string {
  const target = resolve(projectRoot, relativePath);
  const relativeTarget = relative(projectRoot, target);
  if (
    relativeTarget === ""
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    throw new Error(`导出路径必须位于项目根目录内：${relativePath}`);
  }
  return target;
}

function validatePathSegment(value: string, label: string): string {
  const normalized = value.normalize("NFC").trim();
  const windowsStem = normalized.split(".")[0]?.toLocaleUpperCase("en-US") ?? "";
  const windowsReservedNames = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u;
  if (
    normalized.length === 0
    || normalized === "."
    || normalized === ".."
    || normalized.includes("/")
    || normalized.includes("\\")
    || normalized.includes("\0")
    || /[<>:"|?*\u0000-\u001F]/u.test(normalized)
    || /[. ]$/u.test(normalized)
    || windowsReservedNames.test(windowsStem)
  ) {
    throw new Error(`${label}不能包含跨平台非法字符、保留名称或特殊路径段`);
  }
  return normalized;
}
