import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { StorageError } from "./errors.js";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SCHEMA_MIGRATIONS,
  REQUIRED_TABLES,
  migrateSchema
} from "./schema.js";
import type {
  DatabaseIntegrityResult,
  ImmediateTransactionCallback,
  OpenDatabaseOptions
} from "./types.js";

const DEFAULT_DATABASE_RELATIVE_PATH = ".code-helper/code-helper.sqlite";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const require = createRequire(import.meta.url);

/**
 * 文档数据库连接门面。
 *
 * 领域仓储通过此对象复用 BEGIN IMMEDIATE、完整性检查和关闭语义，不直接散落事务控制 SQL。
 */
export class DocumentDatabase {
  readonly path: string;
  readonly database: DatabaseSyncType;
  #closed = false;

  constructor(path: string, database: DatabaseSyncType) {
    this.path = path;
    this.database = database;
  }

  /** 在抢占写锁后执行回调；异常路径保证回滚并保留原始错误。 */
  withImmediateTransaction<T>(callback: ImmediateTransactionCallback<T>): T {
    this.ensureOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(this.database);
      if (isPromiseLike(result)) {
        throw new TypeError("BEGIN IMMEDIATE 事务回调必须同步完成，不能返回 Promise");
      }
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // 已自动回滚时忽略二次回滚错误，调用方应收到最初的领域或 SQLite 错误。
      }
      throw error;
    }
  }

  /** 执行 SQLite 自检、外键检查和最小表集检查，不修改任何业务数据。 */
  checkIntegrity(): DatabaseIntegrityResult {
    this.ensureOpen();
    const integrityRows = this.database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const integrityMessages = integrityRows.map((row) => String(Object.values(row)[0] ?? "unknown"));
    const foreignKeyViolations = this.database.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
    const existingRows = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all() as Array<{ name: string }>;
    const existingTables = new Set(existingRows.map((row) => row.name));
    const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table));
    const sqliteHealthy = integrityMessages.length === 1 && integrityMessages[0]?.toLowerCase() === "ok";

    return {
      ok: sqliteHealthy && foreignKeyViolations.length === 0 && missingTables.length === 0,
      integrityMessages,
      foreignKeyViolations,
      missingTables
    };
  }

  /** 关闭连接；重复关闭是安全的，方便 finally 清理。 */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.database.close();
    this.#closed = true;
  }

  /** 避免关闭后的仓储误用产生难以定位的原生异常。 */
  private ensureOpen(): void {
    if (this.#closed) {
      throw new Error("文档数据库连接已经关闭");
    }
  }
}

/** 原生 DatabaseSync 不能跨 await 保持可靠事务边界，因此显式拒绝异步回调。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && "then" in value && typeof value.then === "function";
}

/**
 * 安全打开并初始化 SQLite 文档数据库。
 *
 * 默认数据库位于项目根 `.code-helper/code-helper.sqlite`；自定义路径仍必须落在项目根内，
 * 且从项目根到数据库文件的任何已存在路径段都不得是符号链接。
 */
export function openDocumentDatabase(options: OpenDatabaseOptions = {}): DocumentDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("busyTimeoutMs 必须是非负整数");
  }

  const databasePath = resolveSafeDatabasePath(options.projectRoot ?? process.cwd(), options.databasePath);
  // 延迟加载 node:sqlite，避免 help/version 等不使用文档库的命令在进程启动时产生实验特性警告。
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath);

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    migrateSchema(
      database,
      options.migrations ?? DEFAULT_SCHEMA_MIGRATIONS,
      options.supportedSchemaVersion ?? CURRENT_SCHEMA_VERSION
    );
    // 先完成高版本拒绝，再切换持久化 journal 模式，避免不受支持的数据库被本程序改写。
    database.exec("PRAGMA journal_mode = WAL");
    return new DocumentDatabase(databasePath, database);
  } catch (error) {
    database.close();
    throw error;
  }
}

/** 解析受控数据库路径并拒绝越界或符号链接路径。 */
function resolveSafeDatabasePath(projectRoot: string, configuredPath?: string): string {
  const configuredRoot = resolve(projectRoot);
  const absoluteRoot = realpathSync(configuredRoot);
  const requested = configuredPath === undefined
    ? join(absoluteRoot, DEFAULT_DATABASE_RELATIVE_PATH)
    : isAbsolute(configuredPath)
      ? normalizeAbsoluteConfiguredPath(configuredRoot, absoluteRoot, configuredPath)
      : resolve(absoluteRoot, configuredPath);
  const relativePath = relative(absoluteRoot, requested);

  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new StorageError("UNSAFE_DATABASE_PATH", "数据库路径必须位于项目根目录内且不能等于项目根");
  }

  assertNoSymlinkSegments(absoluteRoot, dirname(requested));
  mkdirSync(dirname(requested), { recursive: true });
  assertNoSymlinkSegments(absoluteRoot, dirname(requested));
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
    throw new StorageError("UNSAFE_DATABASE_PATH", "数据库文件不能是符号链接");
  }
  return requested;
}

/**
 * macOS 的 `/var` 等路径可能由系统符号链接映射到 `/private/var`。
 * 若调用方绝对路径明确位于其传入的项目根字符串下，则把同一相对后缀映射到真实项目根，
 * 既保留受控范围判断，也不会把系统级根路径别名误判成逃逸。
 */
function normalizeAbsoluteConfiguredPath(
  configuredRoot: string,
  realProjectRoot: string,
  configuredPath: string
): string {
  const absoluteConfiguredPath = resolve(configuredPath);
  const relativeToConfiguredRoot = relative(configuredRoot, absoluteConfiguredPath);
  if (
    relativeToConfiguredRoot !== ""
    && relativeToConfiguredRoot !== ".."
    && !relativeToConfiguredRoot.startsWith(`..${sep}`)
    && !isAbsolute(relativeToConfiguredRoot)
  ) {
    return resolve(realProjectRoot, relativeToConfiguredRoot);
  }
  return absoluteConfiguredPath;
}

/** 从可信项目根逐段检查已存在目录，阻止受控目录通过中间符号链接逃逸。 */
function assertNoSymlinkSegments(projectRoot: string, targetDirectory: string): void {
  const relativeDirectory = relative(projectRoot, targetDirectory);
  let cursor = projectRoot;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new StorageError("UNSAFE_DATABASE_PATH", `数据库路径包含符号链接目录：${cursor}`);
    }
  }
}
