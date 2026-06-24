import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { archiveFeature } from "../dist/archive.js";
import { createCompletionReview } from "../dist/completion.js";
import { initializeProject } from "../dist/init.js";
import { createPlanWorkbench } from "../dist/workflows.js";

test("createCompletionReview 会识别当前执行节点和子计划队列", async () => {
  // 该测试确认 plan 生成后的 status-doc 能作为 agent 继续推进任务的入口。
  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 订单重构\n\n拆成多个阶段推进。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "订单重构"
    });

    const review = await createCompletionReview(root, "订单重构");

    assert.equal(review.featureName, "订单重构");
    assert.equal(review.reviewStatus, "needs-work");
    assert.equal(review.documents.plan.exists, true);
    assert.equal(review.documents.result.exists, true);
    assert.equal(review.documents.status.exists, true);
    assert.equal(review.hasCurrentExecutionNode, true);
    assert.equal(review.hasSubPlanQueue, true);
    assert.ok(review.recommendations.some((recommendation) => recommendation.includes("继续推进")));
    assert.ok(review.requiredConfirmations.some((confirmation) => confirmation.includes("不得询问归档")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionReview 会列出必须确认的归档和记忆问题", async (t) => {
  // 该测试锁定完成检查的防漏清单，避免 agent 忽略必须询问用户的步骤。
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("当前环境缺少 git，跳过 git 变更检测测试。");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-required-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 收尾检查\n\n验证必须确认事项。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "收尾检查"
    });
    await writeFile(
      join(root, "code-helper-docs/plan-doc/收尾检查.md"),
      "# 收尾检查\n\n## 当前执行节点\n\n状态：已完成\n\n## 子计划队列\n\n状态：已完成\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/status-doc/收尾检查-状态.md"),
      "# 收尾检查状态\n\n## 当前执行节点\n\n状态：已完成\n\n## 子计划队列\n\n状态：已完成\n",
      "utf8"
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/cli.ts"), "export const changed = true;\n", "utf8");

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "src/cli.ts"], { cwd: root, stdio: "ignore" });

    const review = await createCompletionReview(root, "收尾检查");

    assert.equal(review.reviewStatus, "ready-to-archive");
    assert.equal(review.shouldAskMemoryUpdate, true);
    assert.equal(review.shouldAskArchive, true);
    assert.ok(review.requiredConfirmations.some((confirmation) => confirmation.includes("更新长期记忆")));
    assert.ok(review.requiredConfirmations.some((confirmation) => confirmation.includes("归档当前任务文档")));
    assert.ok(review.requiredConfirmations.some((confirmation) => confirmation.includes("选择下一个活动任务")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionReview 缺少任务文档时会报错", async () => {
  // 该测试避免 finish 对不存在任务给出误导性完成建议。
  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-missing-"));

  try {
    await initializeProject({ projectRoot: root });

    await assert.rejects(
      () => createCompletionReview(root, "不存在功能"),
      /未找到任务文档/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionReview 会把已归档任务识别为已结束", async () => {
  // archived 任务应读取 archive 路径，不应误判 active 文档缺失。
  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-archived-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 已归档能力\n\n验证归档后的完成检查。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "已归档能力"
    });
    await archiveFeature(root, "已归档能力");

    const review = await createCompletionReview(root, "已归档能力");

    assert.equal(review.taskStatus, "archived");
    assert.equal(review.reviewStatus, "archived");
    assert.equal(review.documents.plan.exists, true);
    assert.match(review.documents.plan.relativePath, /archive/);
    assert.equal(review.shouldAskArchive, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionReview 兼容读取活动旧英文任务文档", async () => {
  // 旧项目可能只存在 implementation.md、manual-test.md 和 -status.md，完成检查需要 fallback 读取。
  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-legacy-active-"));

  try {
    await initializeProject({ projectRoot: root });
    await mkdir(join(root, "code-helper-docs/plan-doc"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/result-doc/legacy-feature"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/status-doc"), { recursive: true });
    await writeFile(
      join(root, "code-helper-docs/plan-doc/legacy-feature.md"),
      "# legacy feature\n\n状态：已完成\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/result-doc/legacy-feature/implementation.md"),
      "# legacy implementation\n\n状态：已完成\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/result-doc/legacy-feature/manual-test.md"),
      "# legacy manual test\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/status-doc/legacy-feature-status.md"),
      "# legacy status\n\n## 当前执行节点\n\n状态：已完成\n\n## 子计划队列\n\n状态：已完成\n",
      "utf8"
    );

    const review = await createCompletionReview(root, "legacy-feature");

    assert.equal(review.reviewStatus, "ready-to-archive");
    assert.equal(review.documents.result.exists, true);
    assert.equal(review.documents.result.relativePath, "code-helper-docs/result-doc/legacy-feature/implementation.md");
    assert.equal(review.documents.status.exists, true);
    assert.equal(review.documents.status.relativePath, "code-helper-docs/status-doc/legacy-feature-status.md");
    assert.equal(review.documents.manualTest.exists, true);
    assert.equal(review.documents.manualTest.relativePath, "code-helper-docs/result-doc/legacy-feature/manual-test.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionReview 读取旧英文任务时优先使用中文新文档", async () => {
  // 同一任务同时存在新旧命名时，中文新文件优先，旧英文只作为兼容 fallback。
  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-legacy-priority-"));

  try {
    await initializeProject({ projectRoot: root });
    await mkdir(join(root, "code-helper-docs/plan-doc"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/result-doc/legacy-priority"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/status-doc"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/plan-doc/legacy-priority.md"), "# legacy priority\n", "utf8");
    await writeFile(
      join(root, "code-helper-docs/result-doc/legacy-priority/implementation.md"),
      "# legacy implementation\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/result-doc/legacy-priority/实施记录.md"),
      "# 中文实施记录\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/result-doc/legacy-priority/manual-test.md"),
      "# legacy manual test\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/result-doc/legacy-priority/手工测试.md"),
      "# 中文手工测试\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/status-doc/legacy-priority-status.md"),
      "# legacy status\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/status-doc/legacy-priority-状态.md"),
      "# 中文状态\n",
      "utf8"
    );

    const review = await createCompletionReview(root, "legacy-priority");

    assert.equal(review.documents.result.relativePath, "code-helper-docs/result-doc/legacy-priority/实施记录.md");
    assert.equal(review.documents.status.relativePath, "code-helper-docs/status-doc/legacy-priority-状态.md");
    assert.equal(review.documents.manualTest.relativePath, "code-helper-docs/result-doc/legacy-priority/手工测试.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionReview 兼容读取归档旧英文任务文档", async () => {
  // 用户手动归档旧英文任务后，finish 应读取 archive 下的英文 fallback 文件。
  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-legacy-archived-"));

  try {
    await initializeProject({ projectRoot: root });
    await mkdir(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/result-doc/archive/legacy-archived"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/status-doc/archive"), { recursive: true });
    await writeFile(
      join(root, "code-helper-docs/plan-doc/archive/legacy-archived.md"),
      "# legacy archived\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/result-doc/archive/legacy-archived/implementation.md"),
      "# legacy implementation\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/result-doc/archive/legacy-archived/manual-test.md"),
      "# legacy manual test\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/status-doc/archive/legacy-archived-status.md"),
      "# legacy status\n",
      "utf8"
    );

    const review = await createCompletionReview(root, "legacy-archived");

    assert.equal(review.taskStatus, "archived");
    assert.equal(review.reviewStatus, "archived");
    assert.equal(review.documents.result.exists, true);
    assert.equal(review.documents.result.relativePath, "code-helper-docs/result-doc/archive/legacy-archived/implementation.md");
    assert.equal(review.documents.status.exists, true);
    assert.equal(review.documents.status.relativePath, "code-helper-docs/status-doc/archive/legacy-archived-status.md");
    assert.equal(review.documents.manualTest.exists, true);
    assert.equal(review.documents.manualTest.relativePath, "code-helper-docs/result-doc/archive/legacy-archived/manual-test.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionReview 会保留 git 当前变更路径的首字符和中文路径", async (t) => {
  // 完成检查会把当前变更展示给用户，路径不能因为 git porcelain 解析丢首字符或把中文转成转义片段。
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("当前环境缺少 git，跳过 git 当前变更路径解析测试。");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-git-"));

  try {
    await initializeProject({ projectRoot: root });
    await writeFile(join(root, "requirement.md"), "# 菜单优化\n\n优化 CLI 菜单。", "utf8");
    await createPlanWorkbench({
      projectRoot: root,
      requirementPath: "requirement.md",
      featureName: "菜单优化"
    });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# 测试 README\n", "utf8");
    await writeFile(join(root, "src/cli.ts"), "export const value = 1;\n", "utf8");

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "README.md", "src/cli.ts", "code-helper-docs/plan-doc/菜单优化.md"], {
      cwd: root,
      stdio: "ignore"
    });

    const review = await createCompletionReview(root, "菜单优化");

    assert.ok(review.changedPaths.includes("README.md"));
    assert.ok(review.changedPaths.includes("src/cli.ts"));
    assert.ok(review.changedPaths.includes("code-helper-docs/plan-doc/菜单优化.md"));
    assert.equal(review.changedPaths.some((path) => path === "EADME.md" || path === "rc/cli.ts"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
