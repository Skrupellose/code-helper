import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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
      const relativePath = getStableMarkdownExportPath(task, document);
      const item = await exportSingleDocument(
        safeRoot,
        database,
        repository,
        task,
        document,
        relativePath,
        options.force === true
      );
      (item.status === "conflict" ? conflicts : exported).push(item);
    }
  }

  return { exported, conflicts };
}

/** 根据任务生命周期和文档类型计算稳定的兼容导出路径。 */
export function getStableMarkdownExportPath(task: TaskRecord, document: DocumentRecord): string {
  const name = validatePathSegment(task.name, "任务名称");
  if (document.type === "completion_record") {
    return join("code-helper-docs", "completion-record", `${name}-完成记录.md`);
  }

  const archive = task.status === "archived" ? ["archive"] : [];
  switch (document.type) {
    case "plan":
      return join("code-helper-docs", "plan-doc", ...archive, `${name}.md`);
    case "status":
      return join("code-helper-docs", "status-doc", ...archive, `${name}-状态.md`);
    case "result":
      return join("code-helper-docs", "result-doc", ...archive, name, "实施记录.md");
    case "manual_test":
      return join("code-helper-docs", "result-doc", ...archive, name, "手工测试.md");
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
  force: boolean
): Promise<MarkdownExportItem> {
  const absolutePath = resolveInsideProject(projectRoot, relativePath);
  await assertSafeExistingPath(projectRoot, absolutePath);
  const previous = database.database.prepare(`
    SELECT content_hash
    FROM document_exports
    WHERE document_id = ? AND export_path = ?
  `).get(document.id, relativePath) as ExportRow | undefined;
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
  await atomicWriteFile(absolutePath, document.body);
  repository.recordDocumentExport({
    documentId: document.id,
    exportPath: relativePath,
    contentHash: document.contentHash
  });
  return makeItem(task, document, relativePath, existingBody === undefined ? "created" : "updated");
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

/** 同目录临时文件加 rename，避免进程中断留下半份 Markdown 正文。 */
async function atomicWriteFile(targetPath: string, body: string): Promise<void> {
  const temporaryPath = `${targetPath}.code-helper-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, body, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
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
