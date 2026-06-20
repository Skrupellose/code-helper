import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initializeProject } from "../dist/init.js";
import { createManualTestDocument, createPlanWorkbench, normalizeFeatureName } from "../dist/workflows.js";

test("normalizeFeatureName 会生成稳定路径片段", () => {
  // 该测试避免用户输入中的空格和符号污染生成路径。
  assert.equal(normalizeFeatureName(" My Feature! "), "My-Feature");
  assert.equal(normalizeFeatureName("中文 计划"), "中文-计划");
  assert.equal(normalizeFeatureName("!!!"), "feature");
});

test("createPlanWorkbench 会生成计划、结果、状态和手工测试文档", async () => {
  // 该测试验证项目计划优化的核心产物齐全。
  const root = await mkdtemp(join(tmpdir(), "code-helper-plan-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 需求\n\n实现一个多阶段功能。", "utf8");

    const operations = await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "demo-feature"
    });

    const plan = await readFile(join(root, ".agent/plan-doc/demo-feature.md"), "utf8");
    const manual = await readFile(join(root, ".agent/result-doc/demo-feature/manual-test.md"), "utf8");

    assert.equal(operations.length, 4);
    assert.match(plan, /当前推进建议/);
    assert.match(plan, /页面相关测试只生成手工测试文档/);
    assert.match(manual, /不默认执行 Playwright/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createManualTestDocument 会生成独立页面手工测试文档", async () => {
  // 该测试确认页面测试能力不会启动任何浏览器自动化，只落文档。
  const root = await mkdtemp(join(tmpdir(), "code-helper-manual-"));

  try {
    await initializeProject({ projectRoot: root });
    await createManualTestDocument({
      projectRoot: root,
      featureName: "page-feature",
      title: "页面功能手工测试"
    });

    const manual = await readFile(join(root, ".agent/result-doc/page-feature/manual-test.md"), "utf8");
    assert.match(manual, /页面功能手工测试/);
    assert.match(manual, /工具侧只执行纯逻辑测试/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
