import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
