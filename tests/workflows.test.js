import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initializeProject } from "../dist/init.js";
import { archiveFeature, listTasks } from "../dist/archive.js";
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

test("archiveFeature 会把功能文档移动到归档目录并标记为 archived", async () => {
  // 该测试覆盖功能完成后的正式归档流程。
  const root = await mkdtemp(join(tmpdir(), "code-helper-archive-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 需求\n\n实现一个待归档功能。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "archived-feature"
    });

    const operations = await archiveFeature(root, "archived-feature");
    const tasks = await listTasks(root);

    assert.ok(operations.some((operation) => operation.path.endsWith(".agent/plan-doc/archive/archived-feature.md")));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].featureName, "archived-feature");
    assert.equal(tasks[0].status, "archived");
    assert.ok(tasks[0].archivedArtifacts.includes(".agent/plan-doc/archive/archived-feature.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listTasks 会把用户手动移动到 archive 的任务识别为 archived", async () => {
  // 该测试覆盖用户手动归档后的状态识别。
  const root = await mkdtemp(join(tmpdir(), "code-helper-manual-archive-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 需求\n\n实现一个手动归档功能。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "manual-archived-feature"
    });

    await mkdir(join(root, ".agent/plan-doc/archive"), { recursive: true });
    await mkdir(join(root, ".agent/result-doc/archive"), { recursive: true });
    await mkdir(join(root, ".agent/status-doc/archive"), { recursive: true });
    await rename(
      join(root, ".agent/plan-doc/manual-archived-feature.md"),
      join(root, ".agent/plan-doc/archive/manual-archived-feature.md")
    );
    await rename(
      join(root, ".agent/result-doc/manual-archived-feature"),
      join(root, ".agent/result-doc/archive/manual-archived-feature")
    );
    await rename(
      join(root, ".agent/status-doc/manual-archived-feature-status.md"),
      join(root, ".agent/status-doc/archive/manual-archived-feature-status.md")
    );

    const tasks = await listTasks(root);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].featureName, "manual-archived-feature");
    assert.equal(tasks[0].status, "archived");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archiveFeature 找不到任务文档时会报错", async () => {
  // 该测试避免不存在的 feature 被写入空归档记录。
  const root = await mkdtemp(join(tmpdir(), "code-helper-empty-archive-"));

  try {
    await initializeProject({ projectRoot: root });

    await assert.rejects(
      () => archiveFeature(root, "missing-feature"),
      /未找到功能文档：missing-feature/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
