/** SQLite 文档存储层使用的稳定错误代码。 */
export type StorageErrorCode =
  | "UNSAFE_DATABASE_PATH"
  | "SCHEMA_TOO_NEW"
  | "INVALID_MIGRATION_PLAN"
  | "MIGRATION_MISMATCH"
  | "INTEGRITY_CHECK_FAILED"
  | "TRANSACTION_FAILED";

/** 带稳定代码的存储错误，供后续 CLI 在不解析错误文案的情况下分类处理。 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly cause?: unknown;

  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.cause = cause;
  }
}
