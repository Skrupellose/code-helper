import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildMainMenuSelectOptions,
  formatMainMenuGroupTitle,
  formatMainMenuSelectItemLabel,
  formatMainMenuTextItemLines,
  getMainMenuGroups,
  parseAgentHookTargetMenuSelection,
  parseSkillTargetMenuSelection,
  runCli
} from "../dist/cli.js";
import { initializeProject } from "../dist/init.js";
import { createPlanWorkbench } from "../dist/workflows.js";

test("主菜单按项目准备、任务推进、项目维护、工具设置分组展示", () => {
  // 主菜单分组是菜单信息架构的稳定契约，raw mode 和数字兜底菜单都复用这份配置。
  const groups = getMainMenuGroups();

  assert.deepEqual(groups.map((group) => group.title), ["项目准备", "任务推进", "项目维护", "工具设置"]);
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.name)),
    [
      ["初始化/刷新项目配置", "更新 code-helper 本地资产"],
      ["生成任务计划", "生成手工测试文档", "检查功能完成情况"],
      ["查看任务列表", "归档已完成任务", "检查协作规范"],
      ["功能管理", "管理项目 Skills", "管理 Hooks"]
    ]
  );
  assert.equal(groups.flatMap((group) => group.items).every((item) => item.description.length > 0), true);
  assert.equal(
    groups[0].items[0].description,
    "创建或更新工作区、入口索引、规则模板、Skills 和可用 hooks"
  );
});

test("主菜单 raw mode 选项包含不可选分组和功能说明", () => {
  // 方向键菜单通过 disabled 分组标题展示层级，用户只能确认具体功能项。
  const options = buildMainMenuSelectOptions();

  assert.equal(options.find((option) => option.label === "【项目准备】")?.disabled, true);
  assert.equal(options.find((option) => option.label === "【任务推进】")?.disabled, true);
  assert.equal(options.some((option) => option.label === "" && option.disabled), true);
  assert.ok(options.some((option) => option.value === "2" && option.label.includes("  2. 生成任务计划")));
  assert.ok(options.some((option) => option.value === "2" && option.label.includes("根据需求文档生成计划")));
  assert.ok(options.some((option) => option.value === "0" && option.label.includes("0. 退出")));
});

test("主菜单布局格式区分标题、功能名和说明", () => {
  // raw mode 使用固定名称列，数字兜底菜单使用说明缩进行，二者都由主菜单数据派生。
  const item = getMainMenuGroups()[1].items[0];

  assert.equal(formatMainMenuGroupTitle("任务推进"), "【任务推进】");
  assert.match(formatMainMenuSelectItemLabel(item), /^ {3}2\. 生成任务计划 +根据需求文档生成计划/);
  assert.deepEqual(formatMainMenuTextItemLines(item), [
    "   2. 生成任务计划",
    "      根据需求文档生成计划、状态记录和执行记录入口"
  ]);
});

test("功能管理 Skills 目标菜单解析支持当前默认、单目标和全部", () => {
  // 文本兜底菜单和 raw mode 菜单共用该解析规则，确保不支持方向键的终端仍可按 agent 目标选择。
  assert.deepEqual(parseSkillTargetMenuSelection("0", ["codex"]), []);
  assert.deepEqual(parseSkillTargetMenuSelection("default", ["codex", "claudecode"]), ["codex", "claudecode"]);
  assert.deepEqual(parseSkillTargetMenuSelection("1"), ["codex"]);
  assert.deepEqual(parseSkillTargetMenuSelection("2"), ["claudecode"]);
  assert.deepEqual(parseSkillTargetMenuSelection("3"), ["githubcopilot"]);
  assert.deepEqual(parseSkillTargetMenuSelection("copilot"), ["githubcopilot"]);
  assert.deepEqual(parseSkillTargetMenuSelection("all"), ["codex", "claudecode", "githubcopilot"]);
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

test("sync-local 刷新 AGENTS 和三类项目级 skills 且不创建其他入口或 hooks", async () => {
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
    const claudeSkill = await readFile(join(root, ".claude/skills/code-helper-completion-review/SKILL.md"), "utf8");
    const claudeCollaborationSkill = await readFile(join(root, ".claude/skills/code-helper-agent-collaboration/SKILL.md"), "utf8");
    const copilotSkill = await readFile(join(root, ".github/skills/code-helper-completion-review/SKILL.md"), "utf8");
    const copilotCollaborationSkill = await readFile(join(root, ".github/skills/code-helper-agent-collaboration/SKILL.md"), "utf8");
    const localSkillTemplate = await readFile(join(root, ".code-helper/skills/completion-review.SKILL.md"), "utf8");
    const localCollaborationTemplate = await readFile(join(root, ".code-helper/skills/agent-collaboration.SKILL.md"), "utf8");

    assert.equal(result, 0);
    assert.match(agents, /主会话只做管理、分配、审阅和结果同步；具体执行任务必须交给子代理/);
    assert.match(agents, /如果当前会话是主会话明确派发的执行子代理/);
    assert.match(agents, /Agent 协作规范/);
    assert.match(agents, /保留用户原有内容/);
    assert.match(agents, /Codex、Claude Code 或 GitHub Copilot/);
    assert.match(codexSkill, /name: code-helper-completion-review/);
    assert.match(codexCollaborationSkill, /name: code-helper-agent-collaboration/);
    assert.match(codexCollaborationSkill, /子代理/);
    assert.match(codexCollaborationSkill, /你现在是执行子代理/);
    assert.match(claudeSkill, /name: code-helper-completion-review/);
    assert.match(claudeCollaborationSkill, /name: code-helper-agent-collaboration/);
    assert.match(copilotSkill, /name: code-helper-completion-review/);
    assert.match(copilotCollaborationSkill, /name: code-helper-agent-collaboration/);
    assert.match(localSkillTemplate, /name: code-helper-completion-review/);
    assert.match(localCollaborationTemplate, /name: code-helper-agent-collaboration/);
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
