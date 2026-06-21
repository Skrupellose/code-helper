import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { initializeProject } from "../dist/init.js";
import { createPlanWorkbench } from "../dist/workflows.js";

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
