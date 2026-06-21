import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      ["初始化/刷新项目配置"],
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
