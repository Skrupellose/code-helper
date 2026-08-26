import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { initializeProject } from "../dist/init.js";

const AGENT_RESPONSE_KEYS = ["action", "data", "diagnostics", "nextActions", "ok", "status"];

/** 捕获单次 CLI 调用，验证 JSON 模式不会把协议拆成多个 stdout 文档。 */
async function runJsonCli(args, projectRoot) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...items) => logs.push(items.join(" "));
    console.error = (...items) => errors.push(items.join(" "));
    const exitCode = await runCli([...args, "--json"], projectRoot);
    assert.equal(logs.length, 1, `${args.join(" ")} 应只输出一个 stdout JSON 文档`);
    const response = JSON.parse(logs[0]);
    assert.deepEqual(Object.keys(response).sort(), AGENT_RESPONSE_KEYS);
    assert.equal(Array.isArray(response.diagnostics), true);
    assert.equal(Array.isArray(response.nextActions), true);
    return { exitCode, response, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("旧主要 JSON 命令的成功路径统一使用 Agent envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-agent-json-success-"));
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const cases = [
      { args: ["tasks"], action: "tasks.list" },
      { args: ["finish", "--check-only"], action: "finish.candidates" },
      { args: ["documents", "check"], action: "documents.check" },
      { args: ["version"], action: "version.info" },
      { args: ["version", "status"], action: "version.status" },
      { args: ["version", "set", "canary"], action: "version.set" }
    ];

    for (const item of cases) {
      const result = await runJsonCli(item.args, root);
      assert.equal(result.exitCode, 0);
      assert.equal(result.response.ok, true);
      assert.equal(result.response.status, "success");
      assert.equal(result.response.action, item.action);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧主要 JSON 命令的参数错误返回稳定诊断和退出码 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-agent-json-invalid-"));
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const cases = [
      ["tasks", "unexpected"],
      ["finish"],
      ["documents", "check", "unexpected"],
      ["version", "status", "unexpected"],
      ["version", "set", "beta"],
      ["unknown-command"]
    ];

    for (const args of cases) {
      const result = await runJsonCli(args, root);
      assert.equal(result.exitCode, 1);
      assert.equal(result.response.ok, false);
      assert.equal(result.response.diagnostics[0].severity, "error");
      assert.match(result.response.diagnostics[0].code, /^(invalid_arguments|selection_required|invalid_command)$/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documents JSON 冲突保留完整数据并维持退出码 2", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-agent-json-conflict-"));
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    await mkdir(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/plan-doc/冲突任务.md"), "# 活动\n", "utf8");
    await writeFile(join(root, "code-helper-docs/plan-doc/archive/冲突任务.md"), "# 归档\n", "utf8");

    const result = await runJsonCli(["documents", "migrate"], root);
    assert.equal(result.exitCode, 2);
    assert.equal(result.response.ok, false);
    assert.equal(result.response.status, "conflict");
    assert.equal(result.response.action, "documents.migrate");
    assert.equal(result.response.data.conflicts.length > 0, true);
    assert.equal(result.response.diagnostics[0].code, "document_conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("异步底层失败仍由顶层捕获并返回单一失败 envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-agent-json-rejection-"));
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    const databasePath = join(root, ".code-helper/code-helper.sqlite");
    await rm(databasePath, { force: true });
    await mkdir(databasePath);

    const result = await runJsonCli(["documents", "check"], root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.response.ok, false);
    assert.equal(result.response.status, "error");
    assert.equal(result.response.action, "documents.check");
    assert.equal(result.response.diagnostics[0].code, "unexpected_error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
