import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initializeProject } from "../dist/init.js";
import { runChecks } from "../dist/checks.js";

test("initializeProject 会创建默认工作区并保留已有 AGENTS 内容", async () => {
  // 该测试覆盖老项目兼容：入口文档已有内容时，只追加受控区块。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Existing Rules\n\n用户已有规则。\n", "utf8");

    const result = await initializeProject({ projectRoot: root });
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const config = await readFile(join(root, ".agent/code-helper/config.json"), "utf8");

    assert.ok(result.operations.some((operation) => operation.path.endsWith("项目记忆规则优化.md")));
    assert.match(agents, /用户已有规则/);
    assert.match(agents, /code-helper:start/);
    assert.match(config, /"gitHooks":/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks 在初始化后通过", async () => {
  // 该测试确保初始化产物满足自身检查规则。
  const root = await mkdtemp(join(tmpdir(), "code-helper-check-"));

  try {
    await initializeProject({ projectRoot: root });
    const issues = await runChecks(root);
    assert.deepEqual(issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
