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

let sqliteExperimentalWarningSuppressed = false;

/**
 * 定向抑制 node:sqlite 首次加载时打印的 ExperimentalWarning。
 * node:sqlite 在 Node 22 仍是实验特性，require 时会向 stderr 打印一条与业务无关的警告，
 * 污染 tasks / check / documents / plan / finish 等涉库命令的输出。
 * 这里只吞掉 name=ExperimentalWarning 且 message 含 SQLite 的那一条，其余 warning 按 Node 默认格式回写 stderr。
 *
 * 进程级副作用：Node 自带的默认打印也是一个 warning 监听器，无法只对 SQLite 这一条单独静音，
 * 因此必须先移除进程内全部 warning 监听器再挂载过滤器。这意味着：
 * - 若本模块被嵌入宿主程序（而非作为 CLI 独立进程），宿主在打开数据库前注册的 warning
 *   监听器会被一并移除，需要保留监听的宿主应在打开数据库后重新挂载；
 * - 替代处理器尽量贴近 Node 默认输出（code 前缀、detail、--trace-warnings 堆栈），
 *   但与默认实现并非逐字节一致。
 */
function suppressSqliteExperimentalWarningOnce(): void {
  if (sqliteExperimentalWarningSuppressed) {
    return;
  }
  sqliteExperimentalWarningSuppressed = true;

  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    const err = warning as Error & { code?: string; detail?: string };

    if (
      err.name === "ExperimentalWarning" &&
      typeof err.message === "string" &&
      err.message.includes("SQLite")
    ) {
      return;
    }

    // 按 Node 默认格式回写其余 warning；detail（如弃用警告的来源说明）
    // 与 --trace-warnings 堆栈一并保留，避免过滤后丢失诊断信息。
    const code = err.code ? `[${err.code}] ` : "";
    const name = err.name ? `${err.name}: ` : "";
    const detail = typeof err.detail === "string" && err.detail !== "" ? `\n${err.detail}` : "";
    // --trace-warnings 对应的运行时开关不在 Node 类型声明中，这里做局部收窄读取。
    const traceEnabled = (process as NodeJS.Process & { traceProcessWarnings?: boolean }).traceProcessWarnings === true;
    const trace = traceEnabled && typeof err.stack === "string" ? `\n${err.stack}` : "";
    process.stderr.write(`(node:${process.pid}) ${code}${name}${err.message}${detail}${trace}\n`);
  });
}

/**
 * 安全打开并初始化 SQLite 文档数据库。
 *
 * 默认数据库位于项目根 `.code-helper/code-helper.sqlite`；自定义路径仍必须落在项目根内，
 * 且从项目根到数据库文件的任何已存在路径段都不得是符号链接。
 *
 * 注意：首次调用会安装进程级 warning 过滤器以静音 node:sqlite 的实验特性警告，
 * 该操作会移除进程内已有的全部 warning 监听器，详见 suppressSqliteExperimentalWarningOnce 的说明。
 */
export function openDocumentDatabase(options: OpenDatabaseOptions = {}): DocumentDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("busyTimeoutMs 必须是非负整数");
  }

  const databasePath = resolveSafeDatabasePath(options.projectRoot ?? process.cwd(), options.databasePath);
  // 延迟加载 node:sqlite，避免 help/version 等不使用文档库的命令在进程启动时产生实验特性警告。
  // 首次 require 仍会向 stderr 打印 ExperimentalWarning，先安装定向过滤，避免污染涉库命令输出。
  suppressSqliteExperimentalWarningOnce();
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
