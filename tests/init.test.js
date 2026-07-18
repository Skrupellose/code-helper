import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { ENTRY_BLOCK_END, ENTRY_BLOCK_START } from "../dist/constants.js";
import { setFeatureEnabled } from "../dist/config.js";
import { initializeProject, updateProject } from "../dist/init.js";
import { runChecks } from "../dist/checks.js";
import { runCli } from "../dist/cli.js";
import {
  buildInitTargetMultiSelectOptions,
  resolveInitMultiSelectTargetPromptResult,
  resolveInitTextTargetPromptAnswer
} from "../dist/cli/commands/core.js";
import { promptMultiSelect } from "../dist/terminal-ui.js";

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

function extractManagedBlock(content) {
  // 只截取 code-helper 受控区块，避免区块外用户规则影响模板提示断言。
  const blockStart = content.indexOf(ENTRY_BLOCK_START);
  const blockEnd = content.indexOf(ENTRY_BLOCK_END);

  assert.notEqual(blockStart, -1);
  assert.notEqual(blockEnd, -1);

  return content.slice(blockStart, blockEnd + ENTRY_BLOCK_END.length);
}

async function writeLegacyEnglishWorkbenchDocs(root) {
  // 旧项目可能已经存在英文计划、结果和状态文档；测试统一复用这组兼容样本。
  await mkdir(join(root, "code-helper-docs/result-doc/seo-docs"), { recursive: true });
  await writeFile(join(root, "code-helper-docs/plan-doc/seo-plan.md"), "# legacy seo plan\n", "utf8");
  await writeFile(
    join(root, "code-helper-docs/result-doc/seo-docs/implementation.md"),
    "# legacy implementation\n",
    "utf8"
  );
  await writeFile(join(root, "code-helper-docs/status-doc/seo-docs-status.md"), "# legacy status\n", "utf8");
}

test("init raw mode 目标多选默认不勾选任何 agent", () => {
  // 新项目无法推断用户实际使用的 agent 工具，菜单默认值必须保持完全未选择。
  const options = buildInitTargetMultiSelectOptions();

  assert.deepEqual(
    options.map((option) => [option.value, option.checked]),
    [
      ["codex", false],
      ["claudecode", false],
      ["githubcopilot", false],
      ["grok", false]
    ]
  );
});

test("init raw mode 目标多选空确认要求重试，Esc 才取消", () => {
  // 回车保存空选择不能继续初始化 agent 目标；只有 Esc 这类显式取消才允许跳过。
  const emptyOptions = buildInitTargetMultiSelectOptions();
  const selectedOptions = emptyOptions.map((option) => ({
    ...option,
    checked: option.value === "claudecode"
  }));

  assert.deepEqual(
    resolveInitMultiSelectTargetPromptResult({ options: emptyOptions, cancelled: false }),
    { action: "retry", targets: [] }
  );
  assert.deepEqual(
    resolveInitMultiSelectTargetPromptResult({ options: emptyOptions, cancelled: true }),
    { action: "cancel", targets: [] }
  );
  assert.deepEqual(
    resolveInitMultiSelectTargetPromptResult({ options: selectedOptions, cancelled: false }),
    { action: "select", targets: ["claudecode"] }
  );
});

test("init raw mode 目标多选结束后恢复 stdin 暂停状态", async () => {
  // 直接 init 会在新项目中进入 raw mode 多选；结束后必须恢复暂停，否则 TTY stdin 会继续引用事件循环导致进程不退出。
  const input = new PassThrough();
  const output = new PassThrough();
  const rawModeChanges = [];
  let pauseCount = 0;
  let resumeCount = 0;

  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled) => {
    rawModeChanges.push(enabled);
    input.isRaw = enabled;
    return input;
  };
  const originalPause = input.pause.bind(input);
  const originalResume = input.resume.bind(input);
  input.pause = () => {
    pauseCount += 1;
    return originalPause();
  };
  input.resume = () => {
    resumeCount += 1;
    return originalResume();
  };
  output.isTTY = true;
  input.pause();

  const prompt = promptMultiSelect(
    input,
    output,
    "选择 init 要应用的 agent 工具",
    buildInitTargetMultiSelectOptions()
  );

  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "space" });
  input.emit("keypress", "", { name: "return" });

  const result = await prompt;

  assert.deepEqual(result.options.filter((option) => option.checked).map((option) => option.value), ["claudecode"]);
  assert.deepEqual(rawModeChanges, [true, false]);
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.ok(resumeCount >= 1);
  assert.ok(pauseCount >= 2);
});

test("init 文本兜底菜单空输入重试，0 才显式取消", () => {
  // 文本菜单中直接回车常见于误触，必须继续提示；输入 0 才表示用户明确跳过 agent 目标。
  assert.deepEqual(resolveInitTextTargetPromptAnswer(""), { action: "retry", targets: [] });
  assert.deepEqual(resolveInitTextTargetPromptAnswer("   "), { action: "retry", targets: [] });
  assert.deepEqual(resolveInitTextTargetPromptAnswer("0"), { action: "cancel", targets: [] });
  assert.deepEqual(resolveInitTextTargetPromptAnswer("1,3"), {
    action: "select",
    targets: ["codex", "githubcopilot"]
  });
  assert.deepEqual(resolveInitTextTargetPromptAnswer("all"), {
    action: "select",
    targets: ["codex", "claudecode", "githubcopilot", "grok"]
  });
  assert.deepEqual(resolveInitTextTargetPromptAnswer("unknown"), { action: "retry", targets: [] });
});

test("initializeProject 会创建默认工作区并保留已有 AGENTS 内容", async () => {
  // 老项目只有 AGENTS.md：首次 init 识别 Codex，默认打开 agentHooks 并安装对应 hooks。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Existing Rules\n\n用户已有规则。\n", "utf8");

    const result = await initializeProject({ projectRoot: root });
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const reviewFixSkill = await readFile(join(root, ".agents/skills/code-helper-review-fix/SKILL.md"), "utf8");
    const codexHook = await readFile(join(root, ".codex/hooks.json"), "utf8");
    const managedBlock = extractManagedBlock(agents);

    assert.ok(result.operations.some((operation) => operation.path.endsWith("项目记忆规则优化.md")));
    assert.match(agents, /用户已有规则/);
    assert.match(agents, /code-helper:start/);
    assert.match(managedBlock, /自动维护/);
    assert.match(managedBlock, /不要手工编辑/);
    assert.match(managedBlock, /自定义规则应写在本区块外/);
    assert.match(managedBlock, /手工测试生成/);
    assert.match(managedBlock, /code-helper-manual-test-workbench/);
    assert.match(managedBlock, /代码审查与修复/);
    assert.match(managedBlock, /code-helper-review-fix/);
    assert.match(config, /"gitHooks":/);
    assert.match(config, /"agentHooks": \{\n      "enabled": true\n    \}/);
    assert.match(codexSkill, /name: code-helper-memory-tuning/);
    assert.match(reviewFixSkill, /name: code-helper-review-fix/);
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
  // 显式选择 Codex：首次 init 应装 skills + Agent hooks，且 agentHooks.enabled 为 true。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-codex-"));

  try {
    const result = await runCliSilently(["init", "codex"], root);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const codexHook = await readFile(join(root, ".codex/hooks.json"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(agents, /code-helper:start/);
    assert.match(config, /"agentHooks": \{\n      "enabled": true\n    \}/);
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
  // 显式选择 Claude Code：不创建 Codex 入口；首次 init 应安装 Claude Agent hooks。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-claudecode-"));

  try {
    const result = await runCliSilently(["init", "claudecode"], root);

    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const claudeCodeSkill = await readFile(join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const claudeHook = await readFile(join(root, ".claude/settings.json"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(claude, /code-helper:start/);
    assert.match(config, /"agentHooks": \{\n      "enabled": true\n    \}/);
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

test("TTY 下直接 code-helper init claudecode 会输出完成提示", async () => {
  // 直接命令没有主菜单的完成包装和回车暂停，因此 TTY 场景需要自己给出明确完成提示；非 TTY 由既有测试覆盖不额外污染脚本输出。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-claudecode-tty-"));
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  try {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

    const result = await runCliSilently(["init", "claudecode"], root);

    assert.equal(result.exitCode, 0);
    assert.match(result.logs.join("\n"), /init 已完成/);
    assert.match(result.logs.join("\n"), /code-helper` 打开操作菜单/);
  } finally {
    if (stdinDescriptor === undefined) {
      delete process.stdin.isTTY;
    } else {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    }

    if (stdoutDescriptor === undefined) {
      delete process.stdout.isTTY;
    } else {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    }

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

test("code-helper init grok 会复用 AGENTS 入口并注册原生 Grok Skills", async () => {
  // Grok Build 与 Codex 共用 AGENTS.md，但显式 Grok 目标只写入 .grok/skills，且本轮不安装 Grok Hook。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-grok-"));

  try {
    const result = await runCliSilently(["init", "grok-build"], root);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const grokSkill = await readFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(agents, /code-helper:start/);
    assert.match(grokSkill, /name: code-helper-memory-tuning/);
    await assert.rejects(() => stat(join(root, ".agents/skills")), /ENOENT/u);
    await assert.rejects(() => stat(join(root, "CLAUDE.md")), /ENOENT/u);
    await assert.rejects(() => stat(join(root, ".grok/hooks")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok-only 项目再次 init 不会把共享 AGENTS 入口误判为 Codex", async () => {
  // 首次显式选择已写入受控注册状态，后续无 target init 必须延续 Grok-only。
  const root = await mkdtemp(join(tmpdir(), "code-helper-reinit-grok-only-"));

  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: ["grok"] });
    await initializeProject({ projectRoot: root });

    assert.match(
      await readFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "utf8"),
      /name: code-helper-memory-tuning/
    );
    await assert.rejects(() => stat(join(root, ".agents/skills")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 会从已有 .grok 资产推断 Grok，但不会从 AGENTS 单独推断", async () => {
  // `.grok/config.toml` 是明确的 Grok 使用证据；AGENTS.md 本身仍只保守推断既有 Codex 目标。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-existing-grok-"));

  try {
    await mkdir(join(root, ".grok"), { recursive: true });
    await writeFile(join(root, ".grok/config.toml"), "# Grok project config\n", "utf8");
    await initializeProject({ projectRoot: root });

    assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), /code-helper:start/);
    assert.match(
      await readFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "utf8"),
      /name: code-helper-memory-tuning/
    );
    await assert.rejects(() => stat(join(root, ".agents/skills")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex-only 项目新增 .grok 资产后 init 会保留 Codex 并启用 Grok", async () => {
  // 已有 Codex 状态只能消解 AGENTS.md 的归属，不能覆盖后续出现的独立 `.grok` 证据。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-codex-add-grok-"));

  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: ["codex"] });
    await mkdir(join(root, ".grok"), { recursive: true });
    await writeFile(join(root, ".grok/config.toml"), "# Grok Build project\n", "utf8");

    await initializeProject({ projectRoot: root });

    assert.match(
      await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8"),
      /name: code-helper-memory-tuning/
    );
    assert.match(
      await readFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "utf8"),
      /name: code-helper-memory-tuning/
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

test("code-helper init all 会补齐四类 agent 资产", async () => {
  // 显式选择 all 时，三个入口及 Grok Build 原生 Skills 都必须被维护。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-all-"));

  try {
    const result = await runCliSilently(["init", "all"], root);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const copilot = await readFile(join(root, ".github/copilot-instructions.md"), "utf8");
    const grokSkill = await readFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(agents, /code-helper:start/);
    assert.match(claude, /code-helper:start/);
    assert.match(copilot, /code-helper:start/);
    assert.match(grokSkill, /name: code-helper-memory-tuning/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 支持显式目标并按同一批目标安装 skills 和 Agent hooks", async () => {
  // 首次 init + 显式 Codex/Claude Code：同一批目标创建入口、skills，并默认打开 agentHooks 安装 hooks。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-targets-"));

  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: ["codex", "claudecode"] });

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const claudeCodeSkill = await readFile(join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md"), "utf8");
    const codexHook = await readFile(join(root, ".codex/hooks.json"), "utf8");
    const claudeHook = await readFile(join(root, ".claude/settings.json"), "utf8");

    assert.match(agents, /code-helper:start/);
    assert.match(claude, /code-helper:start/);
    assert.match(config, /"agentHooks": \{\n      "enabled": true\n    \}/);
    assert.match(codexSkill, /name: code-helper-memory-tuning/);
    assert.match(claudeCodeSkill, /name: code-helper-memory-tuning/);
    assert.match(codexHook, /commandWindows/);
    assert.match(claudeHook, /agent-finish-check\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 在 agentHooks 关闭后不会重装或强制启用 Agent hooks", async () => {
  // 与 skillRegistration 对齐：用户 features disable 后再次 init 不得重写开关或安装 hooks。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-hooks-disabled-"));

  try {
    await setFeatureEnabled(root, "agentHooks", true);
    await initializeProject({ projectRoot: root, skillRegistrationTargets: ["codex"] });
    assert.match(await readFile(join(root, ".codex/hooks.json"), "utf8"), /agent-finish-check\.mjs/);

    await setFeatureEnabled(root, "agentHooks", false);
    await rm(join(root, ".codex/hooks.json"), { force: true });

    const result = await initializeProject({ projectRoot: root, skillRegistrationTargets: ["codex"] });
    const config = await readFile(join(root, ".code-helper/config.json"), "utf8");

    assert.ok(result.operations.some((operation) => operation.message.includes("Agent hooks 功能已关闭")));
    assert.match(config, /"agentHooks": \{\n      "enabled": false\n    \}/);
    await assert.rejects(
      () => stat(join(root, ".codex/hooks.json")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 在只有 CLAUDE.md 的项目中只注册 Claude Code skills", async () => {
  // Claude Code 单工具项目：不创建 AGENTS.md；首次 init 应默认安装 Claude Agent hooks。
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
    assert.match(config, /"agentHooks": \{\n      "enabled": true\n    \}/);
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

test("initializeProject 追加 CLAUDE 受控区块时逐字保留 Nuxt 项目原规则", async () => {
  // 该测试复现用户反馈：已有 CLAUDE.md 没有 code-helper 区块时，init 只能追加受控区块，不能整理或摘要用户原文。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-claude-nuxt-"));
  const originalClaude = [
    "# CLAUDE.md",
    "",
    "## 项目开发规则",
    "",
    "- 基于当前 Nuxt 项目继续开发新功能、持续优化既有页面与功能。",
    "- 页面样式和功能要与原站保持一致。",
    "- 后续开发优先解决 Nuxt / TypeScript / 运行时兼容问题。",
    "",
    "## 交付要求",
    "",
    "不要重排这些规则，也不要把它们总结成其他说法。  "
  ].join("\n");

  try {
    await writeFile(join(root, "CLAUDE.md"), originalClaude, "utf8");

    await initializeProject({ projectRoot: root });

    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");

    assert.ok(claude.startsWith(originalClaude));
    assert.equal(claude.slice(0, originalClaude.length), originalClaude);
    assert.match(claude, /基于当前 Nuxt 项目继续开发新功能、持续优化既有页面与功能/);
    assert.match(claude, /页面样式和功能要与原站保持一致/);
    assert.match(claude, /后续开发优先解决 Nuxt \/ TypeScript \/ 运行时兼容问题/);
    assert.match(claude, /code-helper:start/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeProject 替换 CLAUDE 受控区块时逐字保留区块外用户内容", async () => {
  // 该测试覆盖已有 code-helper 区块的升级路径：只能替换标记之间的内容，前后用户规则必须逐字保留。
  const root = await mkdtemp(join(tmpdir(), "code-helper-init-claude-managed-"));
  const beforeBlock = "# Claude 项目规则\n\n用户前置规则：保持原站交互和视觉节奏。\n\n";
  const oldManagedBlock = `${ENTRY_BLOCK_START}\n旧版受控内容，应该被替换。\n${ENTRY_BLOCK_END}`;
  const afterBlock = "\n\n## 用户后置规则\n\n后续开发优先解决 Nuxt / TypeScript / 运行时兼容问题。  \n保留这个文件结尾的原始形态";
  const originalClaude = `${beforeBlock}${oldManagedBlock}${afterBlock}`;

  try {
    await writeFile(join(root, "CLAUDE.md"), originalClaude, "utf8");

    await initializeProject({ projectRoot: root });

    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const blockStart = claude.indexOf(ENTRY_BLOCK_START);
    const blockEnd = claude.indexOf(ENTRY_BLOCK_END) + ENTRY_BLOCK_END.length;

    assert.notEqual(blockStart, -1);
    assert.notEqual(blockEnd, ENTRY_BLOCK_END.length - 1);
    assert.equal(claude.slice(0, blockStart), beforeBlock);
    assert.equal(claude.slice(blockEnd), afterBlock);
    assert.notEqual(claude.slice(blockStart, blockEnd), oldManagedBlock);
    assert.match(claude.slice(blockStart, blockEnd), /code-helper 协作入口/);
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
    await assert.rejects(() => stat(join(root, ".grok/skills")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateProject 只刷新已注册 Grok Skills，不因空 .grok 资产自动开启", async () => {
  // update 必须以现有受控注册为准；仅有用户自己的 `.grok` 配置时不能静默创建 code-helper Skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-update-grok-"));

  try {
    await mkdir(join(root, ".grok"), { recursive: true });
    await writeFile(join(root, ".grok/config.toml"), "# user config\n", "utf8");
    await updateProject(root);
    await assert.rejects(
      () => stat(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md")),
      /ENOENT/u
    );

    await initializeProject({ projectRoot: root, skillRegistrationTargets: ["grok"] });
    // 删除整个物理目录，确认 update 仍能依据 state 中的受控注册恢复 Grok，而不是改猜 Codex。
    await rm(join(root, ".grok/skills"), { recursive: true, force: true });
    const result = await updateProject(root);

    assert.ok(result.operations.some((operation) => operation.message.includes("已注册 Grok Build 项目级 skill")));
    assert.match(
      await readFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "utf8"),
      /name: code-helper-memory-tuning/
    );
    await assert.rejects(() => stat(join(root, ".agents/skills")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateProject 保留 Codex 与 Grok Build 的共享入口双目标", async () => {
  // 共享 AGENTS.md 不能把已明确注册的双目标收窄成单一目标。
  const root = await mkdtemp(join(tmpdir(), "code-helper-update-codex-grok-"));

  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: ["codex", "grok"] });
    await writeFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "old codex", "utf8");
    await writeFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "old grok", "utf8");

    await updateProject(root);

    assert.match(
      await readFile(join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"), "utf8"),
      /name: code-helper-memory-tuning/
    );
    assert.match(
      await readFile(join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"), "utf8"),
      /name: code-helper-memory-tuning/
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

test("runChecks 对旧英文工作文档只提示 warning", async () => {
  // 英文旧文档命名需要兼容读取和提示迁移，但不能让 check 失败。
  const root = await mkdtemp(join(tmpdir(), "code-helper-check-legacy-names-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeLegacyEnglishWorkbenchDocs(root);

    const issues = await runChecks(root);
    const legacyIssues = issues.filter((issue) => issue.code === "non-chinese-document-name");

    assert.equal(issues.some((issue) => issue.level === "error"), false);
    assert.equal(legacyIssues.every((issue) => issue.level === "warning"), true);
    assert.ok(legacyIssues.some((issue) => issue.path === "code-helper-docs/plan-doc/seo-plan.md"));
    assert.ok(legacyIssues.some((issue) => issue.path === "code-helper-docs/result-doc/seo-docs"));
    assert.ok(legacyIssues.some((issue) => issue.path === "code-helper-docs/result-doc/seo-docs/implementation.md"));
    assert.ok(legacyIssues.some((issue) => issue.path === "code-helper-docs/status-doc/seo-docs-status.md"));
    assert.ok(legacyIssues.every((issue) => issue.message.includes("旧文档命名兼容提醒")));
    assert.ok(legacyIssues.every((issue) => issue.suggestion.includes("不阻塞当前检查")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI check 对旧英文工作文档 warning 返回 0", async () => {
  // CLI 退出码只应由 error 决定，旧英文命名 warning 不能阻塞脚本继续执行。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-check-legacy-names-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeLegacyEnglishWorkbenchDocs(root);

    const result = await runCliSilently(["check"], root);
    const output = result.logs.join("\n");

    assert.equal(result.exitCode, 0);
    assert.match(output, /\[warning\] non-chinese-document-name/);
    assert.match(output, /旧文档命名兼容提醒/);
    assert.match(output, /不阻塞当前检查/);
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
