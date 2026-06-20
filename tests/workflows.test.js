import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initializeProject } from "../dist/init.js";
import { archiveFeature, listTasks } from "../dist/archive.js";
import { createManualTestDocument, createPlanWorkbench, normalizeDocumentName, normalizeFeatureName } from "../dist/workflows.js";

test("normalizeFeatureName 会生成稳定路径片段", () => {
  // 该测试避免用户输入中的空格和符号污染生成路径。
  assert.equal(normalizeFeatureName(" My Feature! "), "My-Feature");
  assert.equal(normalizeFeatureName("中文 计划"), "中文-计划");
  assert.equal(normalizeFeatureName("!!!"), "feature");
});

test("normalizeDocumentName 会强制生成中文文档名", () => {
  // 该测试确保新生成的 docs 文档不会继续使用英文功能名。
  assert.equal(normalizeDocumentName("订单 管理!", "功能计划"), "订单-管理");
  assert.equal(normalizeDocumentName("demo-feature", "功能计划"), "功能计划");
  assert.equal(normalizeDocumentName("!!!", "功能计划"), "功能计划");
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
      featureName: "订单管理升级"
    });

    const plan = await readFile(join(root, "code-helper-docs/plan-doc/订单管理升级.md"), "utf8");
    const result = await readFile(join(root, "code-helper-docs/result-doc/订单管理升级/实施记录.md"), "utf8");
    const manual = await readFile(join(root, "code-helper-docs/result-doc/订单管理升级/手工测试.md"), "utf8");

    assert.equal(operations.length, 4);
    assert.match(plan, /当前推进建议/);
    assert.match(plan, /页面相关测试只生成手工测试文档/);
    assert.match(result, /实施总结/);
    assert.match(manual, /不默认执行 Playwright/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createPlanWorkbench 支持读取绝对路径需求文档", async () => {
  // 该测试覆盖用户把项目外部需求文档拖入终端后的路径读取。
  const root = await mkdtemp(join(tmpdir(), "code-helper-plan-absolute-"));
  const requirementRoot = await mkdtemp(join(tmpdir(), "code-helper-requirement-"));

  try {
    await initializeProject({ projectRoot: root });
    const requirementPath = join(requirementRoot, "absolute-requirement.md");
    await writeFile(requirementPath, "# 外部订单需求\n\n从项目外部拖入。", "utf8");

    const operations = await createPlanWorkbench({
      projectRoot: root,
      requirementPath,
      featureName: "absolute-feature"
    });

    const plan = await readFile(join(root, "code-helper-docs/plan-doc/外部订单需求.md"), "utf8");
    assert.equal(operations.length, 4);
    assert.match(plan, /从项目外部拖入/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(requirementRoot, { recursive: true, force: true });
  }
});

test("createManualTestDocument 会生成独立页面手工测试文档", async () => {
  // 该测试确认页面测试能力不会启动任何浏览器自动化，只落文档。
  const root = await mkdtemp(join(tmpdir(), "code-helper-manual-"));

  try {
    await initializeProject({ projectRoot: root });
    await createManualTestDocument({
      projectRoot: root,
      featureName: "页面功能",
      title: "页面功能手工测试"
    });

    const manual = await readFile(join(root, "code-helper-docs/result-doc/页面功能/手工测试.md"), "utf8");
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
      featureName: "待归档功能"
    });

    const operations = await archiveFeature(root, "待归档功能");
    const tasks = await listTasks(root);

    assert.ok(operations.some((operation) => operation.path.endsWith("code-helper-docs/plan-doc/archive/待归档功能.md")));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].featureName, "待归档功能");
    assert.equal(tasks[0].status, "archived");
    assert.ok(tasks[0].archivedArtifacts.includes("code-helper-docs/plan-doc/archive/待归档功能.md"));
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
      featureName: "手动归档功能"
    });

    await mkdir(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/result-doc/archive"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/status-doc/archive"), { recursive: true });
    await rename(
      join(root, "code-helper-docs/plan-doc/手动归档功能.md"),
      join(root, "code-helper-docs/plan-doc/archive/手动归档功能.md")
    );
    await rename(
      join(root, "code-helper-docs/result-doc/手动归档功能"),
      join(root, "code-helper-docs/result-doc/archive/手动归档功能")
    );
    await rename(
      join(root, "code-helper-docs/status-doc/手动归档功能-状态.md"),
      join(root, "code-helper-docs/status-doc/archive/手动归档功能-状态.md")
    );

    const tasks = await listTasks(root);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].featureName, "手动归档功能");
    assert.equal(tasks[0].status, "archived");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archiveFeature 保留旧英文任务文档归档兼容", async () => {
  // 该测试保证老项目升级后，仍能归档旧版英文命名的任务文档。
  const root = await mkdtemp(join(tmpdir(), "code-helper-legacy-archive-"));

  try {
    await initializeProject({ projectRoot: root });
    await mkdir(join(root, "code-helper-docs/plan-doc"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/result-doc/legacy-feature"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/status-doc"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/plan-doc/legacy-feature.md"), "# legacy", "utf8");
    await writeFile(join(root, "code-helper-docs/result-doc/legacy-feature/implementation.md"), "# legacy", "utf8");
    await writeFile(join(root, "code-helper-docs/status-doc/legacy-feature-status.md"), "# legacy", "utf8");

    const operations = await archiveFeature(root, "legacy-feature");
    const tasks = await listTasks(root);

    assert.ok(operations.some((operation) => operation.path.endsWith("code-helper-docs/plan-doc/archive/legacy-feature.md")));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].featureName, "legacy-feature");
    assert.equal(tasks[0].status, "archived");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archiveFeature 找不到任务文档时会报错", async () => {
  // 该测试避免不存在的功能被写入空归档记录。
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
