import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildMainMenuSelectOptions,
  buildSubMenuSelectOptions,
  formatMainMenuGroupTitle,
  formatMainMenuSelectItemLabel,
  formatMainMenuTextItemLines,
  formatSubMenuTextLines,
  formatVersionUpgradeSelectItemLabel,
  getApplyMenuItems,
  getHooksMenuItems,
  getMainMenuGroups,
  getSkillMenuItems,
  isFatalInteractiveMenuError,
  parseAgentHookTargetMenuSelection,
  parseSkillTargetMenuSelection,
  resolveCodeHelperUpdateCommand,
  runCodeHelperQuickUpgrade,
  runCli
} from "../dist/cli.js";
import { loadConfig, setFeatureEnabled } from "../dist/config.js";
import { initializeProject } from "../dist/init.js";
import { resolvePackageManagerSpawnCommand } from "../dist/cli/quick-upgrade.js";
import { createPlanWorkbench } from "../dist/workflows.js";

test("isFatalInteractiveMenuError：code / AbortError 命中，普通 Error 不命中", () => {
  // 纯函数契约：优先 name/code，message 仅兜底；业务 Error 不得被当成致命会话错误。
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  assert.equal(isFatalInteractiveMenuError(abortError), true);

  const closed = Object.assign(new Error("Interface closed"), { code: "ERR_USE_AFTER_CLOSE" });
  assert.equal(isFatalInteractiveMenuError(closed), true);

  const destroyed = Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" });
  assert.equal(isFatalInteractiveMenuError(destroyed), true);

  const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  assert.equal(isFatalInteractiveMenuError(epipe), true);

  // message 子串兜底（无 code 的历史文案）
  assert.equal(isFatalInteractiveMenuError(new Error("readline was closed")), true);
  assert.equal(
    isFatalInteractiveMenuError(new Error("The readline interface instance has been finished")),
    true
  );

  // 普通业务错误与非 Error 值不得命中
  assert.equal(isFatalInteractiveMenuError(new Error("功能文档不存在")), false);
  assert.equal(isFatalInteractiveMenuError(new Error("invalid selection")), false);
  assert.equal(isFatalInteractiveMenuError("string error"), false);
  assert.equal(isFatalInteractiveMenuError(null), false);
  assert.equal(isFatalInteractiveMenuError(undefined), false);
});

test("主菜单按项目准备、任务推进、项目维护、工具设置分组展示", () => {
  // 主菜单分组是菜单信息架构的稳定契约，raw mode 和数字兜底菜单都复用这份配置。
  const groups = getMainMenuGroups();

  assert.deepEqual(groups.map((group) => group.title), ["项目准备", "任务推进", "项目维护", "工具设置"]);
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.name)),
    [
      ["初始化/刷新项目配置"],
      ["生成任务计划模板", "生成手工测试模板", "检查功能完成情况"],
      ["查看任务列表", "归档已完成任务", "检查协作规范"],
      ["功能管理", "管理项目 Skills", "管理 Hooks"]
    ]
  );
  assert.equal(groups.flatMap((group) => group.items).every((item) => item.description.length > 0), true);
  assert.equal(
    groups[0].items[0].description,
    "创建或更新工作区、入口索引、规则模板、Skills 和可用 hooks"
  );
  assert.equal(groups.flatMap((group) => group.items).some((item) => item.value === "11"), false);
  assert.equal(groups.flatMap((group) => group.items).some((item) => item.name.includes("更新 code-helper 本地资产")), false);
});

test("主菜单 raw mode 选项包含不可选分组和功能说明", () => {
  // 方向键菜单通过 disabled 分组标题展示层级，用户只能确认具体功能项。
  const options = buildMainMenuSelectOptions();

  assert.equal(options.find((option) => option.label === "【项目准备】")?.disabled, true);
  assert.equal(options.find((option) => option.label === "【任务推进】")?.disabled, true);
  assert.equal(options.some((option) => option.label === "" && option.disabled), true);
  assert.ok(options.some((option) => option.value === "2" && option.label.includes("  2. 生成任务计划模板")));
  assert.ok(options.some((option) => option.value === "2" && option.label.includes("根据需求文档创建计划")));
  assert.equal(options.some((option) => option.value === "11" || option.label.includes("更新 code-helper 本地资产")), false);
  assert.ok(options.some((option) => option.value === "0" && option.label.includes("0. 退出")));
});

test("检测到新版本时主菜单顶部出现独立快捷升级项", () => {
  // 快捷升级项只由版本状态触发，不写入普通 MAIN_MENU_GROUPS 分组。
  const versionUpdate = { currentVersion: "0.1.3", latestVersion: "0.1.4", outdated: true };
  const groups = getMainMenuGroups();
  const options = buildMainMenuSelectOptions(versionUpdate);
  const quickUpgradeIndex = options.findIndex((option) => option.label.includes("更新到最新版本"));
  const firstGroupIndex = options.findIndex((option) => option.label === "【项目准备】");

  assert.equal(groups.flatMap((group) => group.items).some((item) => item.name.includes("更新到最新版本")), false);
  assert.equal(quickUpgradeIndex, 0);
  assert.equal(quickUpgradeIndex < firstGroupIndex, true);
  assert.match(options[quickUpgradeIndex].label, /升级 npm 包并刷新当前项目 code-helper 入口、Skills 和 Hooks/);
  assert.match(formatVersionUpgradeSelectItemLabel(versionUpdate), /0\.1\.3 -> 0\.1\.4/);
});

test("主菜单布局格式区分标题、功能名和说明", () => {
  // raw mode 使用固定名称列，数字兜底菜单使用说明缩进行，二者都由主菜单数据派生。
  const item = getMainMenuGroups()[1].items[0];

  assert.equal(formatMainMenuGroupTitle("任务推进"), "【任务推进】");
  assert.match(formatMainMenuSelectItemLabel(item), /^ {3}2\. 生成任务计划模板 +根据需求文档创建计划/);
  assert.deepEqual(formatMainMenuTextItemLines(item), [
    "   2. 生成任务计划模板",
    "      根据需求文档创建计划、状态记录和执行记录模板，供 agent 继续完善"
  ]);
});

/**
 * 断言子菜单 raw 选项与 text 行由同一 items 派生，且含返回 0 与关键项。
 * 与主菜单契约测试一致：锁定 value/label，防止两套手写列表漂移。
 */
function assertSubMenuContract(items, expectedKeyLabels) {
  const rawOptions = buildSubMenuSelectOptions(items);
  const textLines = formatSubMenuTextLines(items);

  assert.deepEqual(
    rawOptions.map((option) => ({ value: option.value, label: option.label })),
    items.map((item) => ({ value: item.value, label: item.label }))
  );
  assert.deepEqual(
    textLines,
    items.map((item) => `${item.value}. ${item.label}`)
  );
  assert.equal(items.some((item) => item.value === "0" && item.label === "返回"), true);
  assert.equal(rawOptions.some((option) => option.value === "0" && option.label === "返回"), true);
  assert.equal(textLines.some((line) => line === "0. 返回"), true);

  for (const [value, label] of expectedKeyLabels) {
    assert.equal(items.some((item) => item.value === value && item.label === label), true);
    assert.equal(rawOptions.some((option) => option.value === value && option.label === label), true);
    assert.equal(textLines.some((line) => line === `${value}. ${label}`), true);
  }

  // raw 与 text 的 value 序列必须完全一致，避免用户在不同终端下编号不同。
  assert.deepEqual(
    rawOptions.map((option) => option.value),
    items.map((item) => item.value)
  );
  assert.deepEqual(
    textLines.map((line) => line.split(".")[0]),
    items.map((item) => item.value)
  );
}

test("Skills 子菜单 raw 与 text 由同一数据驱动且含返回与关键项", () => {
  // Skills 管理菜单的 value 是用户习惯编号，不得与 switch 分发脱节。
  assertSubMenuContract(getSkillMenuItems(), [
    ["1", "查看注册状态"],
    ["2", "按当前项目注册 Skills"],
    ["9", "Skills 质量检查"],
    ["10", "Skills 建议分析"],
    ["11", "仅注册 Grok Build"]
  ]);
});

test("Hooks 子菜单 raw 与 text 由同一数据驱动且含返回与关键项", () => {
  // Hooks 管理菜单需同时覆盖 Git 与 Agent 安装/卸载入口。
  assertSubMenuContract(getHooksMenuItems(), [
    ["1", "查看 Hooks 状态"],
    ["2", "安装 Git pre-commit hook"],
    ["4", "安装 Codex Agent hook"],
    ["8", "安装全部 Hooks"],
    ["9", "卸载全部 Hooks"]
  ]);
});

test("功能管理子菜单 raw 与 text 由同一数据驱动且含返回与关键项", () => {
  // 功能管理是一级能力入口，应用/取消 Skills、hooks 与状态查看必须齐全。
  assertSubMenuContract(getApplyMenuItems(), [
    ["1", "应用项目级 Skills"],
    ["3", "应用 Agent hooks"],
    ["5", "应用 Git hook"],
    ["7", "刷新规则和模板"],
    ["8", "查看应用状态"]
  ]);
});

test("快捷升级会先执行 npm install 再运行新版 code-helper update", async () => {
  // 未声明包管理器且没有锁文件时，快捷升级默认走 npm；安装成功后必须启动项目里的新版 CLI 执行 update。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-quick-upgrade-"));
  const calls = [];
  const originalLog = console.log;

  try {
    console.log = () => {};
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: {} }, null, 2), "utf8");

    const exitCode = await runCodeHelperQuickUpgrade(root, {
      runPackageCommand: async (command, projectRoot) => {
        calls.push(["install", command.command, command.args, projectRoot]);
        return 0;
      },
      runUpdateCommand: async (projectRoot) => {
        // 默认 update 路径解析应使用完整 scoped 包名，而不是裸短名 code-helper
        const updateCommand = await resolveCodeHelperUpdateCommand(projectRoot);
        calls.push(["update", updateCommand.command, updateCommand.args, projectRoot]);
        return 0;
      }
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      ["install", "npm", ["install", "-D", "@skrupellose/code-helper@latest"], root],
      ["update", "npx", ["--yes", "@skrupellose/code-helper", "update"], root]
    ]);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("快捷升级 update 优先使用当前 Node 可执行文件运行本地入口", async () => {
  // 本地已安装包时，update 必须走当前 Node 绝对路径，避免 Windows 将 node 错误改写成 node.cmd。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-quick-upgrade-local-"));

  try {
    const localEntry = join(root, "node_modules/@skrupellose/code-helper/dist/index.js");
    await mkdir(join(root, "node_modules/@skrupellose/code-helper/dist"), { recursive: true });
    await writeFile(localEntry, "console.log('local');\n", "utf8");

    const command = await resolveCodeHelperUpdateCommand(root);

    assert.equal(command.command, process.execPath);
    assert.deepEqual(command.args, [localEntry, "update"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows 快捷升级通过命令处理器运行包管理器 cmd shim", () => {
  // .cmd 不能由 shell:false 的 spawn 直接执行，生产调用链必须显式启动 cmd.exe 并保持参数数组结构。
  assert.deepEqual(
    resolvePackageManagerSpawnCommand(
      { command: "npm", args: ["install", "-D", "@skrupellose/code-helper@latest"] },
      "win32",
      "C:\\Windows\\System32\\cmd.exe"
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "install", "-D", "@skrupellose/code-helper@latest"]
    }
  );
  assert.deepEqual(
    resolvePackageManagerSpawnCommand(
      { command: "npx", args: ["--yes", "@skrupellose/code-helper", "update"] },
      "win32",
      "cmd.exe"
    ),
    {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npx.cmd", "--yes", "@skrupellose/code-helper", "update"]
    }
  );
});

test("Windows 快捷升级直接启动 Node 与 Bun 原生可执行文件", () => {
  // Node 使用绝对路径，Bun 使用原生 exe；二者都不得追加 .cmd 或经过命令处理器。
  const nodeCommand = { command: process.execPath, args: ["local-entry.js", "update"] };
  const bunCommand = { command: "bun", args: ["add", "-d", "@skrupellose/code-helper@latest"] };
  const bunxCommand = { command: "bunx", args: ["code-helper", "update"] };

  assert.deepEqual(resolvePackageManagerSpawnCommand(nodeCommand, "win32"), nodeCommand);
  assert.deepEqual(resolvePackageManagerSpawnCommand(bunCommand, "win32"), bunCommand);
  assert.deepEqual(resolvePackageManagerSpawnCommand(bunxCommand, "win32"), bunxCommand);
});

test("非 Windows 平台不改写包管理器命令", () => {
  // macOS 与 Linux 直接执行 PATH 中的包管理器二进制，不追加 Windows 专用后缀。
  const npmCommand = { command: "npm", args: ["install"] };
  const pnpmCommand = { command: "pnpm", args: ["add"] };

  assert.deepEqual(resolvePackageManagerSpawnCommand(npmCommand, "darwin"), npmCommand);
  assert.deepEqual(resolvePackageManagerSpawnCommand(pnpmCommand, "linux"), pnpmCommand);
});

test("快捷升级缺少 package.json 时失败且不刷新项目资产", async () => {
  // 快捷升级必须先确认当前目录是 Node 项目；否则不能继续执行安装和刷新。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-quick-upgrade-missing-package-"));
  const errors = [];
  let installCalled = false;
  let updateCalled = false;
  const originalError = console.error;

  try {
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    const exitCode = await runCodeHelperQuickUpgrade(root, {
      runPackageCommand: async () => {
        installCalled = true;
        return 0;
      },
      runUpdateCommand: async () => {
        updateCalled = true;
        return 0;
      }
    });

    assert.equal(exitCode, 1);
    assert.equal(installCalled, false);
    assert.equal(updateCalled, false);
    assert.match(errors.join("\n"), /当前目录没有 package\.json/);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("功能管理 Skills 目标菜单解析支持当前默认、单目标和全部", () => {
  // 文本兜底菜单和 raw mode 菜单共用该解析规则，确保不支持方向键的终端仍可按 agent 目标选择。
  assert.deepEqual(parseSkillTargetMenuSelection("0", ["codex"]), []);
  assert.deepEqual(parseSkillTargetMenuSelection("default", ["codex", "claudecode"]), ["codex", "claudecode"]);
  assert.deepEqual(parseSkillTargetMenuSelection("1"), ["codex"]);
  assert.deepEqual(parseSkillTargetMenuSelection("2"), ["claudecode"]);
  assert.deepEqual(parseSkillTargetMenuSelection("3"), ["githubcopilot"]);
  assert.deepEqual(parseSkillTargetMenuSelection("4"), ["grok"]);
  assert.deepEqual(parseSkillTargetMenuSelection("grok-build"), ["grok"]);
  assert.deepEqual(parseSkillTargetMenuSelection("copilot"), ["githubcopilot"]);
  assert.deepEqual(parseSkillTargetMenuSelection("all"), ["codex", "claudecode", "githubcopilot", "grok"]);
});

test("功能管理 Agent hooks 目标菜单只允许 Codex 和 Claude Code", () => {
  // Agent hooks 没有 GitHub Copilot 安装目标，解析层必须给出明确拒绝而不是静默安装其他 hook。
  assert.deepEqual(parseAgentHookTargetMenuSelection("default", ["codex", "githubcopilot"]), ["codex"]);
  assert.deepEqual(parseAgentHookTargetMenuSelection("1"), ["codex"]);
  assert.deepEqual(parseAgentHookTargetMenuSelection("2"), ["claudecode"]);
  assert.deepEqual(parseAgentHookTargetMenuSelection("all"), ["codex", "claudecode"]);
  assert.throws(
    () => parseAgentHookTargetMenuSelection("githubcopilot"),
    /GitHub Copilot 不支持 Agent hook/
  );
  assert.throws(
    () => parseAgentHookTargetMenuSelection("grok"),
    /Grok Build Agent hook 不在当前支持范围/
  );
});

test("help 会展示 sync-local 子命令", async () => {
  // help 是用户发现非交互命令的入口，新增子命令必须在总帮助中可见。
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    const exitCode = await runCli(["help"], process.cwd());

    assert.equal(exitCode, 0);
    assert.match(logs.join("\n"), /code-helper update/);
    assert.match(logs.join("\n"), /code-helper version/);
    assert.match(logs.join("\n"), /code-helper npm-scripts install/);
    assert.match(logs.join("\n"), /code-helper sync-local/);
    assert.match(logs.join("\n"), /注册全部项目级 skills/);
  } finally {
    console.log = originalLog;
  }
});

test("version 输出当前包版本且测试环境不触发 latest 查询", async () => {
  // version 命令必须稳定输出当前包版本；测试环境跳过网络查询，避免单测依赖 npm registry。
  const logs = [];
  const originalLog = console.log;
  const originalSkip = process.env.CODE_HELPER_SKIP_VERSION_CHECK;
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));

  try {
    process.env.CODE_HELPER_SKIP_VERSION_CHECK = "1";
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    const exitCode = await runCli(["version"], process.cwd());

    assert.equal(exitCode, 0);
    assert.deepEqual(logs, [`code-helper ${packageJson.version}`]);
  } finally {
    if (originalSkip === undefined) {
      delete process.env.CODE_HELPER_SKIP_VERSION_CHECK;
    } else {
      process.env.CODE_HELPER_SKIP_VERSION_CHECK = originalSkip;
    }
    console.log = originalLog;
  }
});

test("plan 从需求文档子目录执行时仍写入已初始化项目根", async () => {
  // 该测试复现 Windows 拖拽或封装命令把 cwd 切到 docs/ 后，曾误生成 docs/code-helper-docs 的问题。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-plan-root-"));
  const docsRoot = join(root, "docs");
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });
    await mkdir(docsRoot, { recursive: true });
    await writeFile(join(docsRoot, "需求.md"), "# 子目录需求\n\n从 docs 目录执行 plan。", "utf8");

    const exitCode = await runCli(["plan", "需求.md"], docsRoot);
    const plan = await readFile(join(root, "code-helper-docs/plan-doc/子目录需求.md"), "utf8");

    assert.equal(exitCode, 0);
    assert.match(plan, /从 docs 目录执行 plan/);
    assert.match(plan, /原始需求文档：`docs\/需求\.md`/);
    assert.match(logs.join("\n"), /code-helper-docs\/plan-doc\/子目录需求\.md/);
    await assert.rejects(
      () => stat(join(docsRoot, "code-helper-docs")),
      /ENOENT/
    );
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("check 与 finish 从子目录执行时仍解析到已初始化项目根", async () => {
  // finish/check 与 plan 一样依赖工作区文档；cwd 落在子目录时不能把子目录当成项目根。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-subroot-"));
  const nestedRoot = join(root, "packages", "app");
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };
    console.error = (...args) => {
      logs.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(join(root, "requirement.md"), "# 子目录收尾\n\n验证项目根上探。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "子目录收尾"
    });

    const checkExitCode = await runCli(["check"], nestedRoot);
    const finishExitCode = await runCli(["finish", "子目录收尾", "--check-only"], nestedRoot);

    assert.equal(checkExitCode, 0);
    assert.equal(finishExitCode, 0);
    // 若误用 nestedRoot，finish 会找不到任务文档或写到错误位置
    assert.match(logs.join("\n"), /子目录收尾|完成检查|协作规范|check/i);
    await assert.rejects(
      () => stat(join(nestedRoot, "code-helper-docs")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(nestedRoot, ".code-helper")),
      /ENOENT/
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("sync-local 刷新 AGENTS 和四类项目级 skills 且不创建其他入口或 hooks", async () => {
  // sync-local 面向 code-helper 本仓库开发后刷新本地资产，不能借初始化顺带安装 Agent/Git hooks。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-sync-local-"));
  const logs = [];
  const originalLog = console.log;
  const oldAgents = `# Agent 协作规则

<!-- code-helper:start -->
## code-helper 协作入口

### 核心规则

1. 开始新需求、迁移、重构或反馈修复前，先读取本区块索引到的专题规则。
2. 长期规则写入 \`code-helper-docs/user-rules/\`，短期过程写入 \`code-helper-docs/result-doc/\`，当前状态记录写入 \`code-helper-docs/status-doc/\`。
3. 不把一次性调试过程、临时失败细节或大段实现流水写进入口文档。

### 专题规则索引

- Skills 管理：需要让 Codex 或 Claude Code 在当前项目自动发现 code-helper skills 时，执行 \`npx @skrupellose/code-helper skills register\`。

### 文档维护规则

- 入口文档只保留轻量索引和核心约束。
<!-- code-helper:end -->

## 用户规则

保留用户原有内容。
`;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    await writeFile(join(root, "AGENTS.md"), oldAgents, "utf8");

    const result = await runCli(["sync-local"], root);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const codexSkill = await readFile(join(root, ".agents/skills/code-helper-completion-review/SKILL.md"), "utf8");
    const codexCollaborationSkill = await readFile(join(root, ".agents/skills/code-helper-agent-collaboration/SKILL.md"), "utf8");
    const codexManualTestSkill = await readFile(join(root, ".agents/skills/code-helper-manual-test-workbench/SKILL.md"), "utf8");
    const codexReviewFixSkill = await readFile(join(root, ".agents/skills/code-helper-review-fix/SKILL.md"), "utf8");
    const claudeSkill = await readFile(join(root, ".claude/skills/code-helper-completion-review/SKILL.md"), "utf8");
    const claudeCollaborationSkill = await readFile(join(root, ".claude/skills/code-helper-agent-collaboration/SKILL.md"), "utf8");
    const claudeManualTestSkill = await readFile(join(root, ".claude/skills/code-helper-manual-test-workbench/SKILL.md"), "utf8");
    const claudeReviewFixSkill = await readFile(join(root, ".claude/skills/code-helper-review-fix/SKILL.md"), "utf8");
    const copilotSkill = await readFile(join(root, ".github/skills/code-helper-completion-review/SKILL.md"), "utf8");
    const copilotCollaborationSkill = await readFile(join(root, ".github/skills/code-helper-agent-collaboration/SKILL.md"), "utf8");
    const copilotManualTestSkill = await readFile(join(root, ".github/skills/code-helper-manual-test-workbench/SKILL.md"), "utf8");
    const grokSkill = await readFile(join(root, ".grok/skills/code-helper-completion-review/SKILL.md"), "utf8");
    const copilotReviewFixSkill = await readFile(join(root, ".github/skills/code-helper-review-fix/SKILL.md"), "utf8");
    const localSkillTemplate = await readFile(join(root, ".code-helper/skills/completion-review.SKILL.md"), "utf8");
    const localCollaborationTemplate = await readFile(join(root, ".code-helper/skills/agent-collaboration.SKILL.md"), "utf8");
    const localManualTestTemplate = await readFile(join(root, ".code-helper/skills/manual-test-workbench.SKILL.md"), "utf8");
    const localReviewFixTemplate = await readFile(join(root, ".code-helper/skills/review-fix.SKILL.md"), "utf8");

    assert.equal(result, 0);
    assert.match(agents, /主会话只做管理、分配、审阅和结果同步；具体执行任务必须交给子代理/);
    assert.match(agents, /如果当前会话是主会话明确派发的执行子代理/);
    assert.match(agents, /Agent 协作规范/);
    assert.match(agents, /手工测试生成/);
    assert.match(agents, /code-helper-manual-test-workbench/);
    assert.match(agents, /code-helper-review-fix/);
    assert.match(agents, /保留用户原有内容/);
    assert.match(agents, /Codex、Claude Code、GitHub Copilot 或 Grok Build/);
    assert.match(codexSkill, /name: code-helper-completion-review/);
    assert.match(codexCollaborationSkill, /name: code-helper-agent-collaboration/);
    assert.match(codexCollaborationSkill, /子代理/);
    assert.match(codexCollaborationSkill, /你现在是执行子代理/);
    assert.match(codexManualTestSkill, /name: code-helper-manual-test-workbench/);
    assert.match(codexManualTestSkill, /测试环境、前置数据、操作步骤、预期结果、回归范围和阻塞记录/);
    assert.match(codexReviewFixSkill, /name: code-helper-review-fix/);
    assert.match(claudeSkill, /name: code-helper-completion-review/);
    assert.match(claudeCollaborationSkill, /name: code-helper-agent-collaboration/);
    assert.match(claudeManualTestSkill, /name: code-helper-manual-test-workbench/);
    assert.match(claudeReviewFixSkill, /name: code-helper-review-fix/);
    assert.match(copilotSkill, /name: code-helper-completion-review/);
    assert.match(copilotCollaborationSkill, /name: code-helper-agent-collaboration/);
    assert.match(copilotManualTestSkill, /name: code-helper-manual-test-workbench/);
    assert.match(grokSkill, /name: code-helper-completion-review/);
    assert.match(copilotReviewFixSkill, /name: code-helper-review-fix/);
    assert.match(localSkillTemplate, /name: code-helper-completion-review/);
    assert.match(localCollaborationTemplate, /name: code-helper-agent-collaboration/);
    assert.match(localManualTestTemplate, /name: code-helper-manual-test-workbench/);
    assert.match(localReviewFixTemplate, /name: code-helper-review-fix/);
    await assert.rejects(
      () => stat(join(root, "CLAUDE.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".github/copilot-instructions.md")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".codex/hooks.json")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".claude/settings.json")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(root, ".git/hooks/pre-commit")),
      /ENOENT/
    );
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("sync-local Skills 批量注册失败时保持 skillRegistration 配置关闭", async () => {
  // 在 Claude Code 的受控 Skill 路径制造冲突，确认 sync-local 不会先行开启配置。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-sync-local-atomic-config-"));
  const errors = [];
  const originalError = console.error;

  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    await setFeatureEnabled(root, "skillRegistration", false);
    await mkdir(join(root, ".claude/skills"), { recursive: true });
    await writeFile(join(root, ".claude/skills/code-helper-plan-workbench"), "路径冲突", "utf8");
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    const result = await runCli(["sync-local"], root);
    const config = await loadConfig(root);

    assert.equal(result, 1);
    assert.equal(config.features.skillRegistration.enabled, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ENOTDIR|not a directory/u);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("manual-test 缺少功能名时会提示当前可选任务", async () => {
  // 非 TTY 场景不能弹出选择菜单，应输出已有任务，帮助用户补齐命令参数。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-manual-select-"));
  const errors = [];
  const originalError = console.error;

  try {
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 需求\n\n实现页面验收能力。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "页面验收能力"
    });

    const exitCode = await runCli(["manual-test"], root);

    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /页面验收能力/);
    assert.match(errors.join("\n"), /缺少功能名称/);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("archive 缺少功能名时会提示当前可选任务", async () => {
  // 归档命令同样应利用现有任务文档提示候选项，而不是要求用户凭记忆输入。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-archive-select-"));
  const errors = [];
  const originalError = console.error;

  try {
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 需求\n\n实现待归档能力。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "待归档能力"
    });

    const exitCode = await runCli(["archive"], root);

    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /待归档能力/);
    assert.match(errors.join("\n"), /缺少功能名称/);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("finish 缺少功能名时会提示当前可选任务", async () => {
  // 完成检查命令也应复用任务文档列表，避免用户只能手动输入功能名。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-finish-select-"));
  const errors = [];
  const originalError = console.error;

  try {
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 需求\n\n实现完成检查能力。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "完成检查能力"
    });

    const exitCode = await runCli(["finish"], root);

    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /完成检查能力/);
    assert.match(errors.join("\n"), /缺少功能名称/);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("finish check-only 缺少功能名时只提示候选任务", async () => {
  // Agent hook 场景通常没有功能名，check-only 应提醒而不是直接失败。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-finish-check-only-"));
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 需求\n\n实现 hook 完成检查。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "Hook完成检查"
    });

    const exitCode = await runCli(["finish", "--check-only"], root);

    assert.equal(exitCode, 0);
    assert.match(logs.join("\n"), /完成检查/);
    assert.match(logs.join("\n"), /选择当前任务/);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("finish 输出必须确认事项以防遗漏收尾步骤", async () => {
  // CLI 必须把归档、记忆更新等确认项单独展示，避免 agent 在最终回复中漏问。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-finish-required-"));
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 收尾确认\n\n验证 finish 输出。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "收尾确认"
    });
    await writeFile(
      join(root, "code-helper-docs/plan-doc/收尾确认.md"),
      "# 收尾确认\n\n## 当前执行节点\n\n状态：已完成\n\n## 子计划队列\n\n状态：已完成\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/status-doc/收尾确认-状态.md"),
      "# 收尾确认状态\n\n## 当前执行节点\n\n状态：已完成\n\n## 子计划队列\n\n状态：已完成\n",
      "utf8"
    );

    const exitCode = await runCli(["finish", "收尾确认", "--check-only"], root);
    const output = logs.join("\n");

    assert.equal(exitCode, 0);
    assert.match(output, /必须确认事项/);
    assert.match(output, /归档当前任务文档/);
    assert.match(output, /选择下一个活动任务/);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("features list/enable/disable 在临时项目上切换开关并写回配置", async () => {
  // 最小 CLI 契约：list 展示默认状态；disable/enable 立刻改 config 且 stdout 反映新状态。
  const root = await mkdtemp(join(tmpdir(), "code-helper-cli-features-"));
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    await initializeProject({ projectRoot: root });

    const listExitCode = await runCli(["features", "list"], root);
    assert.equal(listExitCode, 0);
    assert.match(logs.join("\n"), /documentArchive: 启用/);
    assert.match(logs.join("\n"), /checks: 启用/);

    logs.length = 0;
    const disableExitCode = await runCli(["features", "disable", "documentArchive"], root);
    assert.equal(disableExitCode, 0);
    assert.match(logs.join("\n"), /documentArchive: 关闭/);

    const configAfterDisable = JSON.parse(await readFile(join(root, ".code-helper/config.json"), "utf8"));
    assert.equal(configAfterDisable.features.documentArchive.enabled, false);

    logs.length = 0;
    const enableExitCode = await runCli(["features", "enable", "documentArchive"], root);
    assert.equal(enableExitCode, 0);
    assert.match(logs.join("\n"), /documentArchive: 启用/);

    const configAfterEnable = JSON.parse(await readFile(join(root, ".code-helper/config.json"), "utf8"));
    assert.equal(configAfterEnable.features.documentArchive.enabled, true);

    logs.length = 0;
    const invalidExitCode = await runCli(["features", "enable", "notAFeature"], root);
    assert.equal(invalidExitCode, 1);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});
