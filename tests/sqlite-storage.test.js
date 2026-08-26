import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CURRENT_SCHEMA_VERSION,
  REQUIRED_TABLES,
  StorageError,
  openDocumentDatabase,
  readSchemaVersion
} from "../dist/storage/index.js";

/** 为每个测试创建隔离项目根，避免 WAL/SHM 文件污染工作区。 */
async function withTemporaryProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "code-helper-sqlite-storage-"));
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("openDocumentDatabase 初始化最小 schema、迁移记录和安全 PRAGMA", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const connection = openDocumentDatabase({ projectRoot, busyTimeoutMs: 3210 });
    try {
      // 初始化必须一次性得到当前 schema，并启用外键、WAL 与调用方注入的锁等待时间。
      assert.equal(readSchemaVersion(connection.database), CURRENT_SCHEMA_VERSION);
      assert.equal(connection.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.equal(connection.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(connection.database.prepare("PRAGMA busy_timeout").get().timeout, 3210);

      const tables = new Set(
        connection.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
          .map((row) => row.name)
      );
      for (const table of REQUIRED_TABLES) {
        assert.equal(tables.has(table), true, `应创建 ${table}`);
      }
      assert.equal(
        connection.database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
        1
      );
    } finally {
      connection.close();
    }
  });
});

test("withImmediateTransaction 在异常时回滚全部写入", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const connection = openDocumentDatabase({ projectRoot });
    try {
      // 事务回调中的任务插入后主动抛错，回滚后不应留下半条任务或事件。
      assert.throws(() => connection.withImmediateTransaction((database) => {
        database.prepare(`
          INSERT INTO tasks(id, slug, name, tracking_mode, status, created_at, updated_at)
          VALUES ('task-rollback', 'rollback', '回滚测试', 'planned', 'active', 'now', 'now')
        `).run();
        throw new Error("主动失败");
      }), /主动失败/);
      assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);

      // DatabaseSync 事务不能跨 await；误传异步回调时应在提交前拒绝并回滚。
      assert.throws(
        () => connection.withImmediateTransaction(async () => "异步结果"),
        /事务回调必须同步完成/
      );
    } finally {
      connection.close();
    }
  });
});

test("openDocumentDatabase 允许为测试注入空 schema 计划", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const connection = openDocumentDatabase({
      projectRoot,
      databasePath: ".code-helper/injected.sqlite",
      migrations: [],
      supportedSchemaVersion: 0
    });
    try {
      // 注入空迁移时只打开连接，不应偷偷创建产品表；完整性检查会据此报告全部缺失表。
      assert.equal(readSchemaVersion(connection.database), 0);
      assert.deepEqual(connection.checkIntegrity().missingTables, [...REQUIRED_TABLES]);
    } finally {
      connection.close();
    }
  });
});

test("openDocumentDatabase 拒绝高于程序支持范围的 schema", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const controlledDirectory = join(projectRoot, ".code-helper");
    const databasePath = join(controlledDirectory, "future.sqlite");
    await mkdir(controlledDirectory, { recursive: true });
    const rawDatabase = new DatabaseSync(databasePath);
    rawDatabase.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    rawDatabase.close();

    // 高版本数据库必须原样拒绝，不能被当作空库重新初始化。
    assert.throws(
      () => openDocumentDatabase({ projectRoot, databasePath }),
      (error) => error instanceof StorageError && error.code === "SCHEMA_TOO_NEW"
    );
    const reopened = new DatabaseSync(databasePath);
    try {
      assert.equal(readSchemaVersion(reopened), CURRENT_SCHEMA_VERSION + 1);
    } finally {
      reopened.close();
    }
  });
});

test("checkIntegrity 同时报告 SQLite、外键和必需表状态", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const connection = openDocumentDatabase({ projectRoot });
    try {
      const healthy = connection.checkIntegrity();
      assert.equal(healthy.ok, true);
      assert.deepEqual(healthy.integrityMessages, ["ok"]);
      assert.deepEqual(healthy.foreignKeyViolations, []);
      assert.deepEqual(healthy.missingTables, []);

      // 人为删除非依赖表后，结构检查应给出精确缺失表，而非只依赖 PRAGMA integrity_check。
      connection.database.exec("DROP TABLE document_exports");
      const unhealthy = connection.checkIntegrity();
      assert.equal(unhealthy.ok, false);
      assert.deepEqual(unhealthy.missingTables, ["document_exports"]);
    } finally {
      connection.close();
    }
  });
});

test("openDocumentDatabase 拒绝项目外路径和中间符号链接", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const externalRoot = await mkdtemp(join(tmpdir(), "code-helper-sqlite-external-"));
    try {
      assert.throws(
        () => openDocumentDatabase({ projectRoot, databasePath: join(externalRoot, "outside.sqlite") }),
        (error) => error instanceof StorageError && error.code === "UNSAFE_DATABASE_PATH"
      );

      // 即使最终字符串仍位于项目根，受控目录中的符号链接也可能把 WAL/SHM 引到项目外，必须拒绝。
      await symlink(externalRoot, join(projectRoot, ".code-helper"));
      assert.throws(
        () => openDocumentDatabase({ projectRoot }),
        (error) => error instanceof StorageError && error.code === "UNSAFE_DATABASE_PATH"
      );
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});

test("openDocumentDatabase 抑制 node:sqlite 的 ExperimentalWarning", (t) => {
  // node:sqlite 在 Node 22 仍是实验特性，require 时会异步向 stderr 打印 ExperimentalWarning。
  // 本测试文件顶部已 import node:sqlite，无法在同一进程内复现「首次 require」，因此用子进程隔离验证。
  const databaseModulePath = fileURLToPath(new URL("../dist/storage/database.js", import.meta.url));

  // 负向对照：直接 require node:sqlite 必须仍能看到该警告，证明本测试确实能捕获它（而非空跑通过）。
  const bareRequire = spawnSync(
    process.execPath,
    ["-e", "require('node:sqlite'); setTimeout(() => {}, 50);"],
    { encoding: "utf8" }
  );
  assert.equal(bareRequire.status, 0);
  // 版本守卫：未来 Node 将 node:sqlite 转正后，裸 require 不再打印该警告，
  // 抑制逻辑失去存在意义，此时跳过而不是把「警告消失」误报成回归。
  if (!/ExperimentalWarning/u.test(bareRequire.stderr)) {
    t.skip(`当前 Node ${process.version} 的 node:sqlite 已不再是实验特性，无需验证警告抑制`);
    return;
  }

  // 正向断言：走 openDocumentDatabase 的进程不应把该警告泄漏到 stderr。
  const script = [
    `const { openDocumentDatabase } = require(${JSON.stringify(databaseModulePath)});`,
    'const { mkdtempSync } = require("node:fs");',
    'const { tmpdir } = require("node:os");',
    'const { join } = require("node:path");',
    'const root = mkdtempSync(join(tmpdir(), "code-helper-warn-suppress-"));',
    "const db = openDocumentDatabase({ projectRoot: root });",
    "db.close();",
    "setTimeout(() => {}, 50);"
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/u, result.stderr);
});
