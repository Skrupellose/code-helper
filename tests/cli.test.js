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
