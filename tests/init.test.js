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

test("initializeProject 会自动维护用户手动创建的 CLAUDE.md 并同步规则入口", async () => {
  // 该测试覆盖用户手动新增 CLAUDE.md 后再次 init 的双入口同步行为。
  const root = await mkdtemp(join(tmpdir(), "code-helper-claude-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Existing Agents\n\n用户已有 AGENTS 规则。\n", "utf8");
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "CLAUDE.md"), "# Existing Claude\n\n用户手动创建的 Claude 规则。\n", "utf8");

    await initializeProject({ projectRoot: root });

    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const config = await readFile(join(root, ".agent/code-helper/config.json"), "utf8");
    const memoryRule = await readFile(join(root, ".agent/user-rules/项目记忆规则优化.md"), "utf8");

    assert.match(claude, /用户手动创建的 Claude 规则/);
    assert.match(claude, /code-helper:start/);
    assert.match(config, /"claude": true/);
    assert.match(memoryRule, /- `AGENTS.md`/);
    assert.match(memoryRule, /- `CLAUDE.md`/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
