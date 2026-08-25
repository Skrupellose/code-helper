import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { StorageError } from "./errors.js";
import type { SchemaMigration } from "./types.js";

/** 当前程序能够读写的最高 schema 版本。 */
export const CURRENT_SCHEMA_VERSION = 1;

/** 完整性检查要求存在的首版核心表。 */
export const REQUIRED_TABLES = [
  "schema_migrations",
  "tasks",
  "documents",
  "document_revisions",
  "task_events",
  "validations",
  "git_links",
  "document_exports"
] as const;

const INITIAL_SCHEMA_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tracking_mode TEXT NOT NULL DEFAULT 'planned' CHECK (tracking_mode IN ('planned', 'recorded')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'archived', 'recorded')),
  current_node TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('plan', 'status', 'result', 'manual_test', 'completion_record')),
  body TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, type)
);

CREATE TABLE document_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(document_id, revision)
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  summary TEXT NOT NULL,
  baseline TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE git_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  subject TEXT,
  scope TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, commit_sha)
);

CREATE TABLE document_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  export_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  UNIQUE(document_id, export_path)
);

CREATE INDEX task_events_task_id_idx ON task_events(task_id);
CREATE INDEX validations_task_id_idx ON validations(task_id);
CREATE INDEX git_links_task_id_idx ON git_links(task_id);
CREATE INDEX document_exports_document_id_idx ON document_exports(document_id);
`;

/** 计算迁移正文摘要，保证测试注入和未来迁移审计使用同一算法。 */
export function calculateMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** 产品默认迁移序列；测试可通过 openDocumentDatabase 注入替代序列。 */
export const DEFAULT_SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "initial_document_schema",
    checksum: calculateMigrationChecksum(INITIAL_SCHEMA_SQL),
    sql: INITIAL_SCHEMA_SQL
  }
];

/** 读取 SQLite user_version；该值是拒绝未知高版本数据库的第一道门禁。 */
export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 按顺序执行 schema 迁移。
 *
 * 每个迁移都在独立的 BEGIN IMMEDIATE 事务中记录版本与摘要；任何 SQL 或后置记录失败都会回滚，
 * 且绝不会把未知高版本数据库重建为空库。
 */
export function migrateSchema(
  database: DatabaseSync,
  migrations: readonly SchemaMigration[] = DEFAULT_SCHEMA_MIGRATIONS,
  supportedSchemaVersion: number = CURRENT_SCHEMA_VERSION
): void {
  validateMigrationPlan(migrations, supportedSchemaVersion);
  const currentVersion = readSchemaVersion(database);

  if (currentVersion > supportedSchemaVersion) {
    throw new StorageError(
      "SCHEMA_TOO_NEW",
      `数据库 schema 版本 ${currentVersion} 高于当前支持版本 ${supportedSchemaVersion}`
    );
  }

  verifyAppliedMigrationChecksums(database, migrations, currentVersion);

  for (const migration of migrations) {
    if (migration.version <= currentVersion || migration.version > supportedSchemaVersion) {
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(database);
      throw new StorageError(
        "TRANSACTION_FAILED",
        `执行数据库迁移 ${migration.version}:${migration.name} 失败`,
        error
      );
    }
  }
}

/** 检查迁移是否连续、摘要是否与 SQL 相符，避免测试注入或未来维护时误跳版本。 */
function validateMigrationPlan(
  migrations: readonly SchemaMigration[],
  supportedSchemaVersion: number
): void {
  if (!Number.isInteger(supportedSchemaVersion) || supportedSchemaVersion < 0) {
    throw new StorageError("INVALID_MIGRATION_PLAN", "支持的 schema 版本必须是非负整数");
  }

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new StorageError(
        "INVALID_MIGRATION_PLAN",
        `迁移版本必须连续：期望 ${expectedVersion}，实际 ${migration.version}`
      );
    }
    if (migration.checksum !== calculateMigrationChecksum(migration.sql)) {
      throw new StorageError(
        "INVALID_MIGRATION_PLAN",
        `迁移 ${migration.version}:${migration.name} 的 checksum 与 SQL 不一致`
      );
    }
  }

  if (supportedSchemaVersion > migrations.length) {
    throw new StorageError(
      "INVALID_MIGRATION_PLAN",
      `支持版本 ${supportedSchemaVersion} 没有对应的迁移定义`
    );
  }
}

/** 已迁移数据库再次打开时核对迁移摘要，防止历史迁移被原地改写。 */
function verifyAppliedMigrationChecksums(
  database: DatabaseSync,
  migrations: readonly SchemaMigration[],
  currentVersion: number
): void {
  if (currentVersion === 0) {
    return;
  }

  const table = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get();
  if (table === undefined) {
    throw new StorageError("MIGRATION_MISMATCH", "数据库已有版本号，但缺少 schema_migrations 表");
  }

  const applied = database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
  ).all() as Array<{ version: number; name: string; checksum: string }>;

  for (let version = 1; version <= currentVersion; version += 1) {
    const expected = migrations[version - 1];
    const actual = applied.find((entry) => entry.version === version);
    if (
      expected === undefined
      || actual === undefined
      || actual.name !== expected.name
      || actual.checksum !== expected.checksum
    ) {
      throw new StorageError("MIGRATION_MISMATCH", `数据库迁移记录 ${version} 与当前程序不一致`);
    }
  }
}

/** 回滚失败不能覆盖原始事务错误，因此只在内部尽力执行。 */
function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // SQLite 已自动回滚或连接损坏时无需再次抛出。
  }
}
