import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");

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
    await initializeProject({ projectRoot: root });
    await initializeProject({ projectRoot: root });

    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const memoryRule = await readFile(join(root, "code-helper-docs/user-rules/项目记忆规则优化.md"), "utf8");

    assert.match(claude, /用户手动创建的 Claude 规则/);
    assert.match(claude, /code-helper:start/);
    assert.match(config, /"claude": true/);
    assert.match(memoryRule, /- `AGENTS.md`/);
    assert.match(memoryRule, /- `CLAUDE.md`/);
    assert.equal([...memoryRule.matchAll(/- `CLAUDE\.md`/g)].length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 会迁移旧版内部工作区配置到 .code-helper", async () => {
  // 该测试覆盖老项目升级：旧路径只作为读取来源，新配置和项目文档统一写入 .code-helper。
  const root = await mkdtemp(join(tmpdir(), "code-helper-migrate-workspace-"));

  try {
    await mkdir(join(root, ".agent/code-helper"), { recursive: true });
    await mkdir(join(root, ".agent/user-rules"), { recursive: true });
    await mkdir(join(root, ".agent/plan-doc"), { recursive: true });
    await writeFile(
      join(root, ".agent/code-helper/config.json"),
      JSON.stringify({
        directories: {
          workspace: ".agent/code-helper"
        },
        features: {
          gitHooks: { enabled: true }
        }
      }),
      "utf8"
    );
    await writeFile(
      join(root, ".agent/user-rules/旧规则.md"),
      "# 旧规则\n\n## 功能描述\n\n旧规则。\n\n## 调用时机\n\n旧项目。\n\n## 调用入口文件\n\n- `AGENTS.md`\n\n## 规则\n\n1. 保留。\n",
      "utf8"
    );
    await writeFile(join(root, ".agent/plan-doc/旧计划.md"), "# 旧计划\n", "utf8");

    const result = await initializeProject({ projectRoot: root });
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const migratedRule = await readFile(join(root, "code-helper-docs/user-rules/旧规则.md"), "utf8");
    const migratedPlan = await readFile(join(root, "code-helper-docs/plan-doc/旧计划.md"), "utf8");

    assert.equal(result.config.directories.workspace, ".code-helper");
    assert.match(config, /"workspace": ".code-helper"/);
    assert.match(config, /"gitHooks": \{\n      "enabled": true\n    \}/);
    assert.match(migratedRule, /旧规则/);
    assert.match(migratedPlan, /旧计划/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 会把早期 .code-helper 文档迁移到 code-helper-docs", async () => {
  // 该测试覆盖上一版布局：内部状态在 .code-helper，协作文档也误放在 .code-helper 下。
  const root = await mkdtemp(join(tmpdir(), "code-helper-migrate-docs-"));

  try {
    await mkdir(join(root, ".code-helper/user-rules"), { recursive: true });
    await mkdir(join(root, ".code-helper/status-doc"), { recursive: true });
    await writeFile(
      join(root, ".code-helper/user-rules/旧协作规则.md"),
      "# 旧协作规则\n\n## 功能描述\n\n旧规则。\n\n## 调用时机\n\n旧项目。\n\n## 调用入口文件\n\n- `AGENTS.md`\n\n## 规则\n\n1. 保留。\n",
      "utf8"
    );
    await writeFile(join(root, ".code-helper/status-doc/旧功能-状态.md"), "# 旧状态\n", "utf8");

    await initializeProject({ projectRoot: root });

    const migratedRule = await readFile(join(root, "code-helper-docs/user-rules/旧协作规则.md"), "utf8");
    const migratedStatus = await readFile(join(root, "code-helper-docs/status-doc/旧功能-状态.md"), "utf8");

    assert.match(migratedRule, /旧协作规则/);
    assert.match(migratedStatus, /旧状态/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
