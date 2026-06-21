import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseAgentHookTargetMenuSelection,
  parseSkillTargetMenuSelection,
  runCli
} from "../dist/cli.js";
import { initializeProject } from "../dist/init.js";
import { createPlanWorkbench } from "../dist/workflows.js";

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
