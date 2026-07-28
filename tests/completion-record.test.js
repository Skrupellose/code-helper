import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { archiveFeature, listTasks } from "../dist/archive.js";
import { runChecks } from "../dist/checks.js";
import { runCli } from "../dist/cli.js";
import { createCompletionReview } from "../dist/completion.js";
import {
  createCompletionRecord,
  findCompletionRecord,
  getCompletionRecordRelativePath
} from "../dist/completion-record.js";
import { initializeProject } from "../dist/init.js";

/**
 * 在独立临时目录初始化项目，避免完成记录测试修改真实工作区。
 */
async function createInitializedProject() {
  const root = await mkdtemp(join(tmpdir(), "code-helper-completion-record-"));
  await initializeProject({ projectRoot: root });
  return root;
}

test("initializeProject 会创建独立完成记录目录", async () => {
  // 完成记录目录不含 archive 子目录，因为记录创建时已经是终态。
  const root = await createInitializedProject();

  try {
    const directory = await stat(join(root, "code-helper-docs/completion-record"));
    assert.equal(directory.isDirectory(), true);
    await assert.rejects(
      () => stat(join(root, "code-helper-docs/completion-record/archive")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createCompletionRecord 生成终态元数据且重复执行不覆盖", async () => {
  // 首次创建后写入用户补充内容，再次执行必须返回 skipped 并保留原文。
  const root = await createInitializedProject();
  const targetPath = join(root, "code-helper-docs/completion-record/归档优化-完成记录.md");

  try {
    const first = await createCompletionRecord({
      projectRoot: root,
      featureName: "归档优化"
    });
    const generated = await readFile(targetPath, "utf8");

    assert.equal(first.action, "created");
    assert.match(generated, /code-helper-kind: completion-record/);
    assert.match(generated, /tracking-mode: direct/);
    assert.match(generated, /lifecycle: recorded/);
    assert.match(generated, /## 实施总结/);
    assert.match(generated, /## 实际改动/);
    assert.match(generated, /## 验证结果/);

    await writeFile(targetPath, `${generated}\n用户补充内容\n`, "utf8");
    const second = await createCompletionRecord({
      projectRoot: root,
      featureName: "归档优化-完成记录.md"
    });

    assert.equal(second.action, "skipped");
    assert.match(await readFile(targetPath, "utf8"), /用户补充内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("完成记录不进入 tasks 且 finish 返回 recorded 终态", async () => {
  // 单独存在完成记录是合法状态，不能反向触发 missing-docs 或归档/下一任务确认。
  const root = await createInitializedProject();

  try {
    await createCompletionRecord({
      projectRoot: root,
      featureName: "直接修复"
    });

    const tasks = await listTasks(root);
    const review = await createCompletionReview(root, "直接修复-完成记录");

    assert.deepEqual(tasks, []);
    assert.equal(review.taskStatus, "recorded");
    assert.equal(review.reviewStatus, "recorded");
    assert.equal(review.documents.completionRecord.exists, true);
    assert.equal(review.documents.plan.exists, false);
    assert.equal(review.shouldAskArchive, false);
    assert.equal(review.shouldSelectNextTask, false);
    assert.deepEqual(review.requiredConfirmations, []);
    assert.ok(review.recommendations.some((item) => item.includes("无需补齐")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finish 拒绝把损坏元数据的完成记录判为 recorded", async () => {
  // 文件名合法仍不足以证明记录已经进入终态；缺失 frontmatter 或生命周期错误都必须失败。
  const root = await createInitializedProject();
  const targetPath = join(root, "code-helper-docs/completion-record/损坏记录-完成记录.md");
  const invalidContents = [
    "# 损坏记录完成记录\n",
    [
      "---",
      "code-helper-kind: completion-record",
      "tracking-mode: direct",
      "lifecycle: active",
      "---",
      "",
      "# 损坏记录完成记录",
      ""
    ].join("\n")
  ];

  try {
    for (const content of invalidContents) {
      await writeFile(targetPath, content, "utf8");
      await assert.rejects(
        () => createCompletionReview(root, "损坏记录"),
        /完成记录缺少合法终态元数据/
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archiveFeature 明确拒绝已经处于终态的完成记录", async () => {
  // archive 只能处理 plan/status/result 活动任务，不能为完成记录再创建归档生命周期。
  const root = await createInitializedProject();

  try {
    await createCompletionRecord({
      projectRoot: root,
      featureName: "终态任务"
    });

    await assert.rejects(
      () => archiveFeature(root, "终态任务-完成记录.md"),
      /已经是终态，无需归档/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks 独立校验完成记录元数据、章节和命名", async () => {
  // 手工创建的损坏文件应由完成记录检查器报告，不能进入任务缺文档检查。
  const root = await createInitializedProject();
  const invalidPath = join(root, "code-helper-docs/completion-record/invalid.md");

  try {
    await writeFile(
      invalidPath,
      "---\ncode-helper-kind: wrong\ntracking-mode: planned\nlifecycle: active\n---\n\n# invalid\n",
      "utf8"
    );

    const issues = await runChecks(root);

    assert.ok(issues.some((issue) => issue.code === "invalid-completion-record-name"));
    assert.ok(issues.some((issue) => issue.code === "invalid-completion-record-frontmatter"));
    assert.ok(issues.some((issue) => issue.code === "missing-completion-record-section"));
    assert.equal(
      issues.some((issue) => issue.code === "missing-docs"),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("record CLI 创建记录、finish 清晰输出 recorded 且不进入主菜单", async () => {
  // CLI 只暴露非交互 record 子命令；主菜单结构由既有测试继续锁定，不增加入口项。
  const root = await createInitializedProject();
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    assert.equal(await runCli(["record", "CLI收尾"], root), 0);
    assert.equal(await runCli(["finish", "CLI收尾", "--check-only"], root), 0);

    const output = logs.join("\n");
    assert.match(output, /recorded/);
    assert.match(output, /无需补齐 plan\/status\/result/);
    assert.match(output, /无需归档/);
    assert.equal(await findCompletionRecord(root, "CLI收尾") !== undefined, true);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("record CLI 从子目录执行时仍写入已初始化项目根", async () => {
  // record 与 plan/finish 一样依赖项目工作区，不能在调用子目录生成嵌套 code-helper-docs。
  const root = await createInitializedProject();
  const nestedRoot = join(root, "docs", "notes");

  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nestedRoot, { recursive: true });

    assert.equal(await runCli(["record", "子目录记录"], nestedRoot), 0);
    await stat(join(root, "code-helper-docs/completion-record/子目录记录-完成记录.md"));
    await assert.rejects(
      () => stat(join(nestedRoot, "code-helper-docs/completion-record/子目录记录-完成记录.md")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("record CLI 拒绝为已有计划任务创建第二套终态", async () => {
  // CLI 在进入核心写入前先拒绝 active 计划任务，提供稳定退出码和清晰提示。
  const root = await createInitializedProject();
  const errors = [];
  const originalError = console.error;

  try {
    await writeFile(
      join(root, "code-helper-docs/plan-doc/已有计划.md"),
      "# 已有计划\n",
      "utf8"
    );
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    assert.equal(await runCli(["record", "已有计划"], root), 1);
    assert.match(errors.join("\n"), /已经存在 active 计划任务文档/);
    await assert.rejects(
      () => stat(join(root, "code-helper-docs/completion-record/已有计划-完成记录.md")),
      /ENOENT/
    );
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("核心完成记录 API 拒绝 archived、mixed 和大小写变体计划任务", async () => {
  // 非 CLI 调用也不能绕过计划生命周期；统一匹配规则覆盖归档、混合与大小写差异。
  const root = await createInitializedProject();

  try {
    await writeFile(
      join(root, "code-helper-docs/plan-doc/archive/API优化.md"),
      "# API 优化\n",
      "utf8"
    );
    await assert.rejects(
      () => createCompletionRecord({ projectRoot: root, featureName: "api优化" }),
      /已经存在 archived 计划任务文档/
    );

    await writeFile(
      join(root, "code-helper-docs/plan-doc/混合计划.md"),
      "# 混合计划\n",
      "utf8"
    );
    await writeFile(
      join(root, "code-helper-docs/plan-doc/archive/混合计划.md"),
      "# 混合计划归档副本\n",
      "utf8"
    );
    await assert.rejects(
      () => createCompletionRecord({ projectRoot: root, featureName: "混合计划" }),
      /已经存在 mixed 计划任务文档/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check 会报告手工形成的完成记录与计划任务冲突", async () => {
  // 用户可能绕过 CLI 手工创建计划文档，check 必须维护“不能存在两套终态”的不变量。
  const root = await createInitializedProject();

  try {
    await createCompletionRecord({
      projectRoot: root,
      featureName: "冲突任务"
    });
    await writeFile(
      join(root, "code-helper-docs/plan-doc/冲突任务.md"),
      "# 冲突任务\n",
      "utf8"
    );

    const issues = await runChecks(root);
    assert.ok(issues.some((issue) => issue.code === "completion-record-task-conflict"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("完成记录路径和查找会拒绝目录穿越候选", async () => {
  // raw 名称不能通过 `../` 逃出 completion-record；公开路径 helper 也必须保持同一边界。
  const root = await createInitializedProject();
  const outsidePath = join(root, "越界-完成记录.md");

  try {
    await writeFile(
      outsidePath,
      "---\ncode-helper-kind: completion-record\ntracking-mode: direct\nlifecycle: recorded\n---\n",
      "utf8"
    );

    assert.doesNotMatch(getCompletionRecordRelativePath("../越界"), /\.\./u);
    assert.doesNotMatch(getCompletionRecordRelativePath("..\\..\\越界"), /\.\./u);
    assert.equal(await findCompletionRecord(root, "../越界"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check 会拒绝无法由 finish 规范化命中的手工完成记录名", async () => {
  // 点号等字符会被 CLI 规范化移除，检查器不能把这种非 canonical 文件名判为合法。
  const root = await createInitializedProject();
  const nonCanonicalPath = join(
    root,
    "code-helper-docs/completion-record/功能.v2-完成记录.md"
  );

  try {
    await writeFile(
      nonCanonicalPath,
      [
        "---",
        "code-helper-kind: completion-record",
        "tracking-mode: direct",
        "lifecycle: recorded",
        "---",
        "",
        "# 功能 v2 完成记录",
        "",
        "## 任务背景",
        "背景。",
        "",
        "## 实施总结",
        "总结。",
        "",
        "## 实际改动",
        "改动。",
        "",
        "## 验证结果",
        "验证。",
        "",
        "## 未验证事项",
        "无。",
        "",
        "## 风险与后续",
        "无。",
        ""
      ].join("\n"),
      "utf8"
    );

    const issues = await runChecks(root);
    assert.ok(issues.some(
      (issue) =>
        issue.code === "invalid-completion-record-name"
        && issue.path.endsWith("功能.v2-完成记录.md")
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("无活动任务的 finish hook 提示直接执行分流且禁止倒写三件套", async () => {
  // Agent hook 不带任务名时也必须给出直接执行分支，避免收尾自检重新触发完整文档补齐。
  const root = await createInitializedProject();
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    assert.equal(await runCli(["finish", "--check-only"], root), 0);
    const output = logs.join("\n");
    assert.match(output, /具有复盘价值时才生成 completion-record/u);
    assert.match(output, /普通轻量任务直接总结/u);
    assert.match(output, /不要在收尾阶段倒写或补齐 plan\/status\/result/u);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});
