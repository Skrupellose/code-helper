import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initializeProject, updateProject } from "../dist/init.js";
import { runChecks } from "../dist/checks.js";
import { runCli } from "../dist/cli.js";

async function runCliSilently(args, projectRoot) {
  // CLI 测试只关心文件结果和退出码，捕获日志避免测试输出被初始化摘要刷屏。
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...items) => {
      logs.push(items.join(" "));
    };

    return {
      exitCode: await runCli(args, projectRoot),
      logs
    };
  } finally {
    console.log = originalLog;
  }
}

test("initializeProject 会创建默认工作区并保留已有 AGENTS 内容", async () => {
  // 该测试覆盖老项目兼容：只有 AGENTS.md 时只注册 Codex，并同步安装 Codex Agent hook。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Existing Rules\n\n用户已有规则。\n", "utf8");

    const result = await initializeProject({ projectRoot: root });
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const codexHook = await readFile(join(root, ".codex/hooks.json"), "utf8");

    assert.ok(result.operations.some((operation) => operation.path.endsWith("项目记忆规则优化.md")));
    assert.match(agents, /用户已有规则/);
    assert.match(agents, /code-helper:start/);
    assert.match(config, /"gitHooks":/);
    assert.match(config, /"agentHooks": \{\n      "enabled": true\n    \}/);
    assert.match(codexSkill, /name: code-helper-memory-tuning/);
    assert.match(codexHook, /agent-finish-check\.mjs/);
    await assert.rejects(
      () => stat(join(root, ".git/hooks/pre-commit")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/skills/code-helper-memory-tuning/SKILL.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 在没有入口文档的新项目中跳过项目级 skills 和 Agent hooks", async () => {
  // 该测试覆盖非交互/CI 场景：无法判断实际使用工具时不能默认全量注册。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-new-"));

  try {
    const result = await runCliSilently(["init"], root);
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(config, /"agents": false/);
    assert.match(config, /"claude": false/);
    assert.match(config, /"copilot": false/);
    assert.match(result.logs.join("\n"), /不会默认全量安装/);
    assert.match(result.logs.join("\n"), /跳过项目级 skills/);
    await assert.rejects(
      () => stat(join(root, "AGENTS.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".claude/settings.json")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/copilot-instructions.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/skills/code-helper-memory-tuning/SKILL.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-helper init codex 会补齐 AGENTS.md 且不创建 CLAUDE.md", async () => {
  // 显式选择 Codex 时，入口记忆文档、项目级 skills 和 Codex Agent hook 必须使用同一目标。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-codex-"));

  try {
    const result = await runCliSilently(["init", "codex"], root);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const codexHook = await readFile(join(root, ".codex/hooks.json"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(agents, /code-helper:start/);
    assert.match(codexSkill, /name: code-helper-memory-tuning/);
    assert.match(codexHook, /agent-finish-check\.mjs/);
    await assert.rejects(
      () => stat(join(root, "CLAUDE.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/copilot-instructions.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-helper init claudecode 会补齐 CLAUDE.md 且不创建 AGENTS.md", async () => {
  // 显式选择 Claude Code 时，不能因为默认配置额外创建 Codex 入口。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-claudecode-"));

  try {
    const result = await runCliSilently(["init", "claudecode"], root);

    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const claudeCodeSkill = await readFile(join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const claudeHook = await readFile(join(root, ".claude/settings.json"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(claude, /code-helper:start/);
    assert.match(claudeCodeSkill, /name: code-helper-memory-tuning/);
    assert.match(claudeHook, /agent-finish-check\.mjs/);
    await assert.rejects(
      () => stat(join(root, "AGENTS.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/copilot-instructions.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-helper init githubcopilot 会补齐 Copilot instructions", async () => {
  // 显式选择 GitHub Copilot 时，维护 .github/copilot-instructions.md 并注册 Copilot 项目级 skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-copilot-"));

  try {
    const result = await runCliSilently(["init", "githubcopilot"], root);

    const copilot = await readFile(join(root, ".github/copilot-instructions.md"), "utf8");
    const githubCopilotSkill = await readFile(join(root, ".github/skills/code-helper-memory-tuning/SKILL.md"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(copilot, /code-helper:start/);
    assert.match(copilot, /code-helper 协作入口/);
    assert.match(githubCopilotSkill, /name: code-helper-memory-tuning/);
    await assert.rejects(
      () => stat(join(root, "AGENTS.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, "CLAUDE.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 会自动维护已有 Copilot instructions", async () => {
  // 已有 GitHub Copilot 入口时，init 应自动识别目标并只维护受控区块。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-existing-copilot-"));

  try {
    await mkdir(join(root, ".github"), { recursive: true });
    await writeFile(join(root, ".github/copilot-instructions.md"), "# Copilot\n\n用户已有 Copilot 规则。\n", "utf8");

    await initializeProject({ projectRoot: root });

    const copilot = await readFile(join(root, ".github/copilot-instructions.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const githubCopilotSkill = await readFile(join(root, ".github/skills/code-helper-memory-tuning/SKILL.md"), "utf8");

    assert.match(copilot, /用户已有 Copilot 规则/);
    assert.match(copilot, /code-helper:start/);
    assert.match(config, /"copilot": true/);
    assert.match(githubCopilotSkill, /name: code-helper-memory-tuning/);
    await assert.rejects(
      () => stat(join(root, "AGENTS.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, "CLAUDE.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-helper init all 会补齐三类 agent 入口", async () => {
  // 显式选择 all 时，Codex、Claude Code 和 GitHub Copilot 入口都必须被维护。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-all-"));

  try {
    const result = await runCliSilently(["init", "all"], root);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const copilot = await readFile(join(root, ".github/copilot-instructions.md"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(agents, /code-helper:start/);
    assert.match(claude, /code-helper:start/);
    assert.match(copilot, /code-helper:start/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 支持显式目标并按同一批目标安装 skills 和 Agent hooks", async () => {
  // 该测试覆盖显式 init 目标：选择 Codex 和 Claude Code 时，同时创建入口、skills 与对应 Agent hooks。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-targets-"));

  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: ["codex", "claudecode"] });

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const claudeCodeSkill = await readFile(join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const codexHook = await readFile(join(root, ".codex/hooks.json"), "utf8");
    const claudeHook = await readFile(join(root, ".claude/settings.json"), "utf8");

    assert.match(agents, /code-helper:start/);
    assert.match(claude, /code-helper:start/);
    assert.match(codexSkill, /name: code-helper-memory-tuning/);
    assert.match(claudeCodeSkill, /name: code-helper-memory-tuning/);
    assert.match(codexHook, /commandWindows/);
    assert.match(claudeHook, /agent-finish-check\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 在只有 CLAUDE.md 的项目中只注册 Claude Code skills", async () => {
  // 该测试覆盖 Claude Code 单工具项目：不能因为默认配置创建 AGENTS.md 或注册其他 agent 工具。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-claude-only-"));

  try {
    await writeFile(join(root, "CLAUDE.md"), "# Existing Claude\n\n用户已有 Claude 规则。\n", "utf8");

    await initializeProject({ projectRoot: root });

    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const claudeCodeSkill = await readFile(join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const claudeHook = await readFile(join(root, ".claude/settings.json"), "utf8");

    assert.match(claude, /用户已有 Claude 规则/);
    assert.match(claude, /code-helper:start/);
    assert.match(config, /"agents": false/);
    assert.match(config, /"claude": true/);
    assert.match(claudeCodeSkill, /name: code-helper-memory-tuning/);
    assert.match(claudeHook, /agent-finish-check\.mjs/);
    await assert.rejects(
      () => stat(join(root, "AGENTS.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/skills/code-helper-memory-tuning/SKILL.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateProject 刷新已有 Codex skills 且不创建未使用 agent 入口", async () => {
  // update 用于升级已存在的 code-helper 资产，不能像 init 一样扩展新的 agent 目标。
  const root = await mkdtemp(join(tmpdir(), "code-helper-update-codex-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Existing Rules\n\n用户已有规则。\n", "utf8");
    await initializeProject({ projectRoot: root });
    await writeFile(
      join(root, ".agents/skills/code-helper-agent-collaboration/SKILL.md"),
      "old skill",
      "utf8"
    );

    const result = await updateProject(root);
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-agent-collaboration/SKILL.md"), "utf8");

    assert.ok(result.operations.some((operation) => operation.message.includes("已注册 Codex 项目级 skill")));
    assert.match(codexSkill, /你现在是执行子代理/);
    await assert.rejects(
      () => stat(join(root, "CLAUDE.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/copilot-instructions.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateProject 在无入口项目中不注册 skills 或安装 hooks", async () => {
  // update 可以刷新工作区和模板，但不能在无法识别 agent 的目录中开启新能力。
  const root = await mkdtemp(join(tmpdir(), "code-helper-update-empty-"));

  try {
    const result = await updateProject(root);

    assert.ok(result.operations.some((operation) => operation.message.includes("已跳过项目级 skills 更新")));
    assert.ok(result.operations.some((operation) => operation.message.includes("已跳过 hooks 更新")));
    await assert.rejects(
      () => stat(join(root, "AGENTS.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".agents/skills/code-helper-agent-collaboration/SKILL.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".codex/hooks.json")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateProject 会升级已安装的旧 Codex Stop hook", async () => {
  // 旧版 hook 直接运行 finish --check-only；update 必须升级为包装脚本，避免 stdout 污染 Stop hook JSON。
  const root = await mkdtemp(join(tmpdir(), "code-helper-update-hook-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Existing Rules\n", "utf8");
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(
      join(root, ".codex/hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "npx @skrupellose/code-helper finish --check-only"
                }
              ]
            }
          ]
        }
      }, null, 2),
      "utf8"
    );

    await updateProject(root);

    const codexHook = JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8"));
    const command = codexHook.hooks.Stop[0].hooks[0].command;
    const wrapper = await readFile(join(root, ".code-helper/hooks/agent-finish-check.mjs"), "utf8");

    assert.equal(command, "node .code-helper/hooks/agent-finish-check.mjs");
    assert.match(wrapper, /process\.stdout\.write\("\{\}\\n"\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installCodeHelperNpmScripts 写入常用脚本且不覆盖已有同名脚本", async () => {
  // npm scripts 安装面向用户已有项目，必须保留同名脚本，避免覆盖用户自定义初始化流程。
  const root = await mkdtemp(join(tmpdir(), "code-helper-npm-scripts-"));

  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: {
          "code-helper:init": "custom init"
        }
      }, null, 2),
      "utf8"
    );

    const result = await runCliSilently(["npm-scripts", "install"], root);
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

    assert.equal(result.exitCode, 0);
    assert.equal(packageJson.scripts["code-helper:init"], "custom init");
    assert.equal(packageJson.scripts["code-helper:update"], "code-helper update");
    assert.equal(packageJson.scripts["code-helper:check"], "code-helper check");
    assert.equal(packageJson.scripts["code-helper:finish"], "code-helper finish");
    assert.match(result.logs.join("\n"), /\[skipped\].*code-helper:init/);
    assert.match(result.logs.join("\n"), /\[updated\].*code-helper:update/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-helper npm-scripts install 缺少 package.json 时给出清晰错误", async () => {
  // 没有 package.json 通常表示不在 Node 项目根目录，错误信息应直接说明该如何执行。
  const root = await mkdtemp(join(tmpdir(), "code-helper-npm-scripts-missing-"));
  const errors = [];
  const originalError = console.error;

  try {
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    const exitCode = await runCli(["npm-scripts", "install"], root);

    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /当前目录没有 package\.json/);
    assert.match(errors.join("\n"), /code-helper npm-scripts install/);
  } finally {
    console.error = originalError;
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
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const claudeCodeSkill = await readFile(join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md"), "utf8");

    assert.match(claude, /用户手动创建的 Claude 规则/);
    assert.match(claude, /code-helper:start/);
    assert.match(config, /"claude": true/);
    assert.match(memoryRule, /- `AGENTS.md`/);
    assert.match(memoryRule, /- `CLAUDE.md`/);
    assert.equal([...memoryRule.matchAll(/- `CLAUDE\.md`/g)].length, 1);
    assert.match(codexSkill, /name: code-helper-memory-tuning/);
    assert.match(claudeCodeSkill, /name: code-helper-memory-tuning/);
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
