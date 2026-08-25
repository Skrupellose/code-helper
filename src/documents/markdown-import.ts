import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { DocumentDatabase } from "../storage/database.js";
import { calculateDocumentHash, type DocumentRepository } from "./repository.js";
import { getStableMarkdownExportPath } from "./markdown-export.js";

export type MarkdownImportStatus = "unchanged" | "candidate" | "imported" | "database-newer" | "missing" | "conflict";

export interface MarkdownImportItem {
  documentId: string;
  taskId: string;
  relativePath: string;
  status: MarkdownImportStatus;
  message?: string;
}

export interface MarkdownImportResult {
  imported: MarkdownImportItem[];
  skipped: MarkdownImportItem[];
  conflicts: MarkdownImportItem[];
}

export interface MarkdownImportOptions {
  apply?: boolean;
  taskId?: string;
}

interface ExportRow {
  content_hash: string;
}

/**
 * 把 Markdown 兼容视图中的明确单边修改安全导回 SQLite。
 * 默认只预览；只有磁盘基于上次导出、且数据库正文未同时变化时才允许 --apply。
 */
export async function importMarkdownDocuments(
  projectRoot: string,
  database: DocumentDatabase,
  repository: DocumentRepository,
  options: MarkdownImportOptions = {}
): Promise<MarkdownImportResult> {
  if (options.apply === true) {
    // 先对整批文档做只读预检，避免普通已知冲突出现时先写入前面的候选项。
    // 预检与应用之间若发生并发修改，后续 CAS 仍会拒绝陈旧数据库 revision。
    const preview = await importMarkdownDocuments(projectRoot, database, repository, {
      ...options,
      apply: false
    });
    if (preview.conflicts.length > 0) {
      return preview;
    }
  }

  const safeRoot = await realpath(resolve(projectRoot));
  const tasks = options.taskId === undefined
    ? repository.listTasks()
    : [repository.getTask(options.taskId)].filter((task) => task !== undefined);
  const imported: MarkdownImportItem[] = [];
  const skipped: MarkdownImportItem[] = [];
  const conflicts: MarkdownImportItem[] = [];

  for (const task of tasks) {
    for (const document of repository.listDocuments(task.id)) {
      const relativePath = getStableMarkdownExportPath(task, document);
      const absolutePath = resolveInsideProject(safeRoot, relativePath);
      await assertSafeExistingPath(safeRoot, absolutePath);
      const diskBody = await readOptionalFile(absolutePath);

      if (diskBody === undefined) {
        skipped.push(makeItem(task.id, document.id, relativePath, "missing", "Markdown 兼容视图不存在"));
        continue;
      }

      const diskHash = calculateDocumentHash(diskBody);
      const previous = database.database.prepare(`
        SELECT content_hash
        FROM document_exports
        WHERE document_id = ? AND export_path = ?
      `).get(document.id, relativePath) as ExportRow | undefined;

      if (diskHash === document.contentHash) {
        if (options.apply === true) {
          repository.recordDocumentExport({
            documentId: document.id,
            exportPath: relativePath,
            contentHash: document.contentHash
          });
        }
        skipped.push(makeItem(task.id, document.id, relativePath, "unchanged"));
        continue;
      }

      if (previous === undefined) {
        conflicts.push(makeItem(
          task.id,
          document.id,
          relativePath,
          "conflict",
          "缺少上次导出基线，无法判断 Markdown 是否基于当前数据库正文修改"
        ));
        continue;
      }

      if (previous.content_hash === document.contentHash) {
        if (options.apply !== true) {
          skipped.push(makeItem(task.id, document.id, relativePath, "candidate", "可安全导入；使用 --apply 写入"));
          continue;
        }

        const updated = repository.updateDocument(document.id, {
          body: diskBody,
          expectedRevision: document.revision,
          expectedContentHash: document.contentHash,
          summary: "从 Markdown 兼容视图显式导入",
          source: `markdown-import:${relativePath}`
        });
        repository.recordDocumentExport({
          documentId: document.id,
          exportPath: relativePath,
          contentHash: updated.contentHash
        });
        imported.push(makeItem(task.id, document.id, relativePath, "imported"));
        continue;
      }

      if (diskHash === previous.content_hash) {
        skipped.push(makeItem(task.id, document.id, relativePath, "database-newer", "数据库已更新，Markdown 仍是上次导出版本"));
        continue;
      }

      conflicts.push(makeItem(
        task.id,
        document.id,
        relativePath,
        "conflict",
        "数据库与 Markdown 均在上次导出后变化，必须人工合并"
      ));
    }
  }

  return { imported, skipped, conflicts };
}

function makeItem(
  taskId: string,
  documentId: string,
  relativePath: string,
  status: MarkdownImportStatus,
  message?: string
): MarkdownImportItem {
  return {
    taskId,
    documentId,
    relativePath,
    status,
    ...(message === undefined ? {} : { message })
  };
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

/** 检查已存在的路径段并拒绝符号链接，避免兼容视图逃逸到项目外。 */
async function assertSafeExistingPath(projectRoot: string, targetPath: string): Promise<void> {
  const relativePath = relative(projectRoot, targetPath);
  let cursor = projectRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new Error(`导入路径不能包含符号链接：${cursor}`);
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
    throw new Error(`导入路径必须位于项目根目录内：${relativePath}`);
  }
  return target;
}
