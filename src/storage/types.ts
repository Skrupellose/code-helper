import type { DatabaseSync } from "node:sqlite";

/** SQLite schema 迁移定义；迁移版本必须从 1 开始连续递增。 */
export interface SchemaMigration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

/** 打开文档数据库时允许注入的运行时参数。 */
export interface OpenDatabaseOptions {
  projectRoot?: string;
  databasePath?: string;
  busyTimeoutMs?: number;
  migrations?: readonly SchemaMigration[];
  supportedSchemaVersion?: number;
}

/** 数据库完整性检查的结构化结果。 */
export interface DatabaseIntegrityResult {
  ok: boolean;
  integrityMessages: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  missingTables: string[];
}

/** 事务回调只接收原生连接，避免领域仓储直接管理提交或回滚。 */
export type ImmediateTransactionCallback<T> = (database: DatabaseSync) => T;
