import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { runTaskEngine } from "../dist/cli/commands/task-engine.js";
import { DocumentRepository } from "../dist/documents/index.js";
import { openDocumentDatabase } from "../dist/storage/index.js";

/** 捕获结构化命令输出，并验证 stdout 只有一次完整 JSON 写入。 */
async function runJson(args, projectRoot) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...items) => logs.push(items.join(" "));
    console.error = (...items) => errors.push(items.join(" "));
    const exitCode = await runCli([...args, "--json"], projectRoot);
    assert.equal(logs.length, 1, `stdout 应只写入一次，实际为：${logs.length}`);
    return { exitCode, response: JSON.parse(logs[0]), errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** 直接调用任务引擎以注入仅测试使用的投影竞态 hook，同时保持单一 JSON stdout 断言。 */
async function runTaskEngineJson(args, projectRoot, internalOptions) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...items) => logs.push(items.join(" "));
    console.error = (...items) => errors.push(items.join(" "));
    const exitCode = await runTaskEngine(
      projectRoot,
      "document",
      [...args, "--json"],
      projectRoot,
      internalOptions
    );
    assert.equal(logs.length, 1, `stdout 应只写入一次，实际为：${logs.length}`);
    return { exitCode, response: JSON.parse(logs[0]), errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** 返回当前数据库导出摘要数量，供副作用回归断言。 */
function countDocumentExports(projectRoot) {
  const connection = openDocumentDatabase({ projectRoot });
  try {
    return Number(connection.database.prepare("SELECT COUNT(*) AS count FROM document_exports").get().count);
  } finally {
    connection.close();
  }
}

/** 通过真实子进程向 stdin 写正文，覆盖 --body-stdin 的端到端协议。 */
async function runJsonProcess(args, projectRoot, stdinBody) {
  const entryPath = join(process.cwd(), "dist/index.js");
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entryPath, ...args, "--json"], {
      cwd: projectRoot,
      env: { ...process.env, CODE_HELPER_SKIP_VERSION_CHECK: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, response: JSON.parse(stdout), stderr });
    });
    child.stdin.end(stdinBody, "utf8");
  });
}

/** 创建最小 SQLite 权威任务和计划文档。 */
function seedTask(projectRoot) {
  const connection = openDocumentDatabase({ projectRoot });
  try {
    const repository = new DocumentRepository(connection);
    const task = repository.createTask({
      slug: "agent-contract",
      name: "Agent 接口",
      currentNode: "实现结构化入口"
    });
    const document = repository.createDocument({
      taskId: task.id,
      type: "plan",
      body: "# 初始计划\n"
    });
    return { task, document };
  } finally {
    connection.close();
  }
}

test("task status/transition/next 通过统一 envelope 结构化读写 SQLite 状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-task-engine-"));
  try {
    seedTask(root);

    const status = await runJson(["task", "status", "agent-contract"], root);
    assert.equal(status.exitCode, 0);
    assert.deepEqual(Object.keys(status.response), [
      "ok", "action", "status", "data", "diagnostics", "nextActions"
    ]);
    assert.equal(status.response.data.task.currentNode, "实现结构化入口");
    assert.deepEqual(status.response.nextActions, ["continue_current_node"]);

    const transition = await runJson([
      "task", "transition", "agent-contract", "paused", "--current-node", "等待复核"
    ], root);
    assert.equal(transition.exitCode, 0);
    assert.equal(transition.response.data.task.status, "paused");
    assert.equal(transition.response.data.task.currentNode, "等待复核");

    const next = await runJson(["task", "next", "agent-contract"], root);
    assert.deepEqual(next.response.nextActions, ["resume_task"]);

    const invalid = await runJson([
      "task", "transition", "agent-contract", "completed"
    ], root);
    assert.equal(invalid.exitCode, 2);
    assert.equal(invalid.response.ok, false);
    assert.equal(invalid.response.status, "invalid_state_transition");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task transition 拒绝绕过正式归档领域流程", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-task-transition-archive-"));
  try {
    seedTask(root);
    const result = await runJson(["task", "transition", "agent-contract", "archived"], root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.response.status, "invalid_input");
    assert.equal(result.response.diagnostics[0].code, "invalid_input");
    assert.match(result.response.diagnostics[0].message, /code-helper archive/u);

    const status = await runJson(["task", "status", "agent-contract"], root);
    assert.equal(status.response.data.task.status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document show/update/history 使用 revision CAS 且冲突返回稳定诊断", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-document-engine-"));
  try {
    const { document } = seedTask(root);
    const bodyPath = join(root, "next-plan.md");
    await writeFile(bodyPath, "# 更新计划\n", "utf8");

    const shown = await runJson(["document", "show", "agent-contract", "plan"], root);
    assert.equal(shown.response.data.document.revision, 1);
    assert.equal(shown.response.data.document.contentHash, document.contentHash);

    const updated = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body-file", "next-plan.md", "--expected-revision", "1", "--summary", "更新计划"
    ], root);
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.response.data.document.revision, 2);
    assert.equal(updated.response.data.document.body, "# 更新计划\n");
    assert.equal(updated.response.data.database.updated, true);
    assert.equal(updated.response.data.projection.updated, true);
    assert.equal(
      await readFile(join(root, ".code-helper/local/docs/plan-doc/Agent 接口.md"), "utf8"),
      "# 更新计划\n"
    );
    assert.deepEqual(
      await readdir(join(root, ".code-helper/local/docs/plan-doc")),
      ["Agent 接口.md"],
      "正常投影不应遗留 tmp 或 recovery 文件"
    );

    const conflict = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body", "# 过期写入\n", "--expected-revision", "1"
    ], root);
    assert.equal(conflict.exitCode, 2);
    assert.equal(conflict.response.status, "conflict");
    assert.equal(conflict.response.diagnostics[0].code, "cas_conflict");
    assert.match(conflict.response.diagnostics[0].fix, /revision/u);

    const history = await runJson(["document", "history", "agent-contract", "plan"], root);
    assert.equal(history.response.data.revisions.length, 2);
    assert.deepEqual(history.response.data.revisions.map((item) => item.revision), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document update 的 CAS 失败不会登记兼容投影基线", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-document-cas-side-effect-"));
  try {
    seedTask(root);
    const projectionPath = join(root, ".code-helper/local/docs/plan-doc/Agent 接口.md");
    await mkdir(join(root, ".code-helper/local/docs/plan-doc"), { recursive: true });
    await writeFile(projectionPath, "# 初始计划\n", "utf8");
    assert.equal(countDocumentExports(root), 0);

    const conflict = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body", "# 陈旧写入\n", "--expected-revision", "0"
    ], root);
    assert.equal(conflict.exitCode, 2);
    assert.equal(conflict.response.diagnostics[0].code, "cas_conflict");
    assert.equal(countDocumentExports(root), 0);

    const shown = await runJson(["document", "show", "agent-contract", "plan"], root);
    assert.equal(shown.response.data.document.revision, 1);
    assert.equal(shown.response.data.document.body, "# 初始计划\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("投影 read→move 竞态保留人工正文并准确报告 SQLite 已更新", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-document-projection-race-"));
  try {
    seedTask(root);
    const first = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body", "# 数据库第二版\n", "--expected-revision", "1"
    ], root);
    assert.equal(first.exitCode, 0);

    const projectionDirectory = join(root, ".code-helper/local/docs/plan-doc");
    const projectionPath = join(projectionDirectory, "Agent 接口.md");
    let hookCalls = 0;
    const raced = await runTaskEngineJson([
      "update", "agent-contract", "plan",
      "--body", "# 数据库第三版\n", "--expected-revision", "2"
    ], root, {
      markdownExportTestHooks: {
        async beforeExistingMove(context) {
          hookCalls += 1;
          await writeFile(context.targetPath, "# 窗口中的人工修改\n", "utf8");
        }
      }
    });

    assert.equal(hookCalls, 1);
    assert.equal(raced.exitCode, 1);
    assert.equal(raced.response.status, "projection_failed");
    assert.equal(raced.response.diagnostics[0].code, "markdown_projection_refresh_failed");
    assert.equal(raced.response.data.database.updated, true);
    assert.equal(raced.response.data.database.revision, 3);
    assert.equal(raced.response.data.projection.updated, false);
    assert.equal(await readFile(projectionPath, "utf8"), "# 窗口中的人工修改\n");
    assert.deepEqual(await readdir(projectionDirectory), ["Agent 接口.md"]);

    const shown = await runJson(["document", "show", "agent-contract", "plan"], root);
    assert.equal(shown.response.data.document.revision, 3);
    assert.equal(shown.response.data.document.body, "# 数据库第三版\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("投影目标在排他安装窗口被创建时不覆盖并发正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-document-projection-create-race-"));
  try {
    seedTask(root);
    const projectionPath = join(root, ".code-helper/local/docs/plan-doc/Agent 接口.md");
    let hookCalls = 0;
    const raced = await runTaskEngineJson([
      "update", "agent-contract", "plan",
      "--body", "# 数据库第二版\n", "--expected-revision", "1"
    ], root, {
      markdownExportTestHooks: {
        async beforeExclusiveInstall(context) {
          hookCalls += 1;
          await writeFile(context.targetPath, "# 安装窗口中的并发文件\n", "utf8");
        }
      }
    });

    assert.equal(hookCalls, 1);
    assert.equal(raced.exitCode, 1);
    assert.equal(raced.response.status, "projection_failed");
    assert.equal(raced.response.data.database.updated, true);
    assert.equal(raced.response.data.database.revision, 2);
    assert.equal(await readFile(projectionPath, "utf8"), "# 安装窗口中的并发文件\n");
    assert.deepEqual(
      await readdir(join(root, ".code-helper/local/docs/plan-doc")),
      ["Agent 接口.md"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document update 支持 stdin 且三种正文来源严格互斥", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-document-stdin-"));
  try {
    seedTask(root);

    const updated = await runJsonProcess([
      "document", "update", "agent-contract", "plan",
      "--body-stdin", "--expected-revision", "1", "--summary", "stdin 更新"
    ], root, "# stdin 计划\n");
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.response.data.document.body, "# stdin 计划\n");
    assert.equal(updated.response.data.document.revision, 2);

    const emptyStdin = await runJsonProcess([
      "document", "update", "agent-contract", "plan",
      "--body-stdin", "--expected-revision", "2", "--summary", "不应写入的空正文"
    ], root, "");
    assert.equal(emptyStdin.exitCode, 1);
    assert.equal(emptyStdin.response.status, "invalid_input");
    assert.match(emptyStdin.response.diagnostics[0].message, /未读取到正文/u);

    const unchangedAfterEmptyStdin = await runJson([
      "document", "show", "agent-contract", "plan"
    ], root);
    assert.equal(unchangedAfterEmptyStdin.response.data.document.body, "# stdin 计划\n");
    assert.equal(unchangedAfterEmptyStdin.response.data.document.revision, 2);

    const conflictingSources = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body", "重复正文", "--body-stdin", "--expected-revision", "2"
    ], root);
    assert.equal(conflictingSources.exitCode, 1);
    assert.equal(conflictingSources.response.status, "invalid_input");
    assert.match(conflictingSources.response.diagnostics[0].message, /必须且只能提供/u);

    await writeFile(join(root, "duplicate.md"), "文件正文", "utf8");
    const conflictingFileSource = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body", "参数正文", "--body-file", "duplicate.md", "--expected-revision", "2"
    ], root);
    assert.equal(conflictingFileSource.exitCode, 1);
    assert.equal(conflictingFileSource.response.status, "invalid_input");

    const missingSource = await runJson([
      "document", "update", "agent-contract", "plan", "--expected-revision", "2"
    ], root);
    assert.equal(missingSource.exitCode, 1);
    assert.equal(missingSource.response.status, "invalid_input");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document update 在人工修改投影时写前阻断且不增加 SQLite revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-document-projection-conflict-"));
  try {
    seedTask(root);
    // 兼容旧项目：尚无导出摘要、但正文与 SQLite 完全一致的投影可以安全建立基线。
    const projectionPath = join(root, ".code-helper/local/docs/plan-doc/Agent 接口.md");
    await mkdir(join(root, ".code-helper/local/docs/plan-doc"), { recursive: true });
    await writeFile(projectionPath, "# 初始计划\n", "utf8");
    const first = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body", "# 数据库第二版\n", "--expected-revision", "1"
    ], root);
    assert.equal(first.exitCode, 0);

    await writeFile(projectionPath, "# 人工修改但尚未导入\n", "utf8");
    const blocked = await runJson([
      "document", "update", "agent-contract", "plan",
      "--body", "# 数据库第三版\n", "--expected-revision", "2"
    ], root);
    assert.equal(blocked.exitCode, 2);
    assert.equal(blocked.response.status, "conflict");
    assert.equal(blocked.response.diagnostics[0].code, "markdown_projection_modified");
    assert.equal(blocked.response.data.database.updated, false);

    const shown = await runJson(["document", "show", "agent-contract", "plan"], root);
    assert.equal(shown.response.data.document.revision, 2);
    assert.equal(shown.response.data.document.body, "# 数据库第二版\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation 与 git 命令写入并读取生产记录且不执行 Git 操作", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-evidence-engine-"));
  try {
    seedTask(root);

    const recorded = await runJson([
      "validation", "record", "agent-contract",
      "--command", "node --test tests/task-engine-cli.test.js",
      "--working-directory", root,
      "--exit-code", "0",
      "--summary", "定向测试通过",
      "--baseline", "feature-0.3.0@dd1cde0",
      "--acceptance-criteria", "AC-001,AC-002",
      "--plan-items", "PLAN-001"
    ], root);
    assert.equal(recorded.exitCode, 0);
    assert.equal(recorded.response.data.validation.exitCode, 0);

    const validations = await runJson(["validation", "list", "agent-contract"], root);
    assert.equal(validations.response.data.validations.length, 1);
    assert.equal(validations.response.data.validations[0].baseline, "feature-0.3.0@dd1cde0");
    assert.deepEqual(
      validations.response.data.validations[0].acceptanceCriterionIds,
      ["AC-001", "AC-002"]
    );
    assert.deepEqual(validations.response.data.validations[0].planItemIds, ["PLAN-001"]);

    const linked = await runJson([
      "git", "link", "agent-contract", "0123456789abcdef",
      "--subject", "test(agent): 记录关联", "--scope", "agent"
    ], root);
    assert.equal(linked.exitCode, 0);
    assert.equal(linked.response.data.link.commitSha, "0123456789abcdef");

    const links = await runJson(["git", "list", "agent-contract"], root);
    assert.equal(links.response.data.links.length, 1);
    assert.equal(links.response.data.links[0].scope, "agent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
