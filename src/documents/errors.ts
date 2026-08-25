import type { MarkdownExportItem } from "./markdown-export.js";

/** 文档领域仓储使用的稳定错误代码。 */
export type DocumentRepositoryErrorCode =
  | "NOT_FOUND"
  | "DUPLICATE"
  | "CAS_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "INVALID_INPUT";

/** 后续 CLI 可依据 code 输出稳定提示，而无需匹配数据库原生错误文案。 */
export class DocumentRepositoryError extends Error {
  readonly code: DocumentRepositoryErrorCode;
  readonly cause?: unknown;

  constructor(code: DocumentRepositoryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "DocumentRepositoryError";
    this.code = code;
    this.cause = cause;
  }
}

/** Markdown 兼容视图与 SQLite 权威正文分叉时使用的稳定错误。 */
export class MarkdownExportConflictError extends Error {
  readonly code = "MARKDOWN_EXPORT_CONFLICT" as const;
  readonly conflicts: readonly MarkdownExportItem[];

  constructor(conflicts: readonly MarkdownExportItem[]) {
    const paths = conflicts.map((conflict) => conflict.relativePath).join("、");
    super(`Markdown 兼容视图存在 ${conflicts.length} 个导出冲突：${paths}`);
    this.name = "MarkdownExportConflictError";
    this.conflicts = conflicts;
  }
}
