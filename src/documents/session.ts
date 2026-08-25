import { openDocumentDatabase, StorageError, type OpenDatabaseOptions } from "../storage/index.js";
import { MarkdownExportConflictError } from "./errors.js";
import { exportMarkdownDocuments } from "./markdown-export.js";
import { DocumentRepository } from "./repository.js";

/**
 * 在单次同步领域操作中打开 SQLite 仓储并确保关闭连接。
 *
 * node:sqlite 的 DatabaseSync 和当前仓储均采用同步事务；调用方不得把 Promise 返回值
 * 交给本函数，否则连接会在异步操作完成前关闭。涉及文件导入导出的异步编排应显式管理连接。
 */
export function withDocumentRepository<T>(
  projectRoot: string,
  operation: (repository: DocumentRepository) => T,
  options: Omit<OpenDatabaseOptions, "projectRoot"> = {}
): T {
  const connection = openDocumentDatabase({ ...options, projectRoot });

  try {
    const result = operation(new DocumentRepository(connection));

    if (isPromiseLike(result)) {
      throw new TypeError("SQLite 文档仓储回调必须同步完成，不能返回 Promise");
    }

    return result;
  } finally {
    connection.close();
  }
}

/**
 * 确保项目数据库和当前 schema 已初始化。
 *
 * init/update 是项目资产变更入口，不能把缺表、外键异常或 SQLite 损坏误报为成功；
 * 完整性检查失败时抛出稳定存储错误，由 CLI 统一转换为非零退出码。
 */
export function ensureDocumentDatabase(projectRoot: string) {
  const connection = openDocumentDatabase({ projectRoot });

  try {
    const integrity = connection.checkIntegrity();
    if (!integrity.ok) {
      throw new StorageError(
        "INTEGRITY_CHECK_FAILED",
        "SQLite 文档库完整性检查未通过",
        integrity
      );
    }
    return integrity;
  } finally {
    connection.close();
  }
}

/**
 * 在 CLI 已写出兼容 Markdown 后登记导出摘要，供后续显式 import 判断单边修改。
 * 只处理指定任务；若其它文档已经被手工修改，导出器会保留冲突文件而不覆盖。
 */
export async function registerMarkdownExportBaseline(projectRoot: string, taskSlug: string): Promise<void> {
  const connection = openDocumentDatabase({ projectRoot });
  try {
    const repository = new DocumentRepository(connection);
    const task = repository.getTaskBySlug(taskSlug);
    if (task === undefined) {
      throw new Error(`无法登记 Markdown 导出基线，任务不存在：${taskSlug}`);
    }
    const result = await exportMarkdownDocuments(projectRoot, connection, repository, { taskId: task.id });
    if (result.conflicts.length > 0) {
      // 调用方必须感知兼容 Markdown 的手工修改，不能在 SQLite 与磁盘分叉时继续报告成功。
      throw new MarkdownExportConflictError(result.conflicts);
    }
  } finally {
    connection.close();
  }
}

/** 识别 thenable，避免同步连接生命周期被异步回调越过。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && "then" in value && typeof value.then === "function";
}
