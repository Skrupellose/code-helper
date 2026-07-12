/**
 * checks 模块负向/契约单测。
 * 以 initializeProject 产物为基线，再故意破坏文件系统或配置，断言 issue.code（而非仅匹配 message 文本）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, ENTRY_BLOCK_START } from "../dist/constants.js";
import { initializeProject } from "../dist/init.js";
import { runChecks } from "../dist/checks.js";

/**
 * 在临时目录中初始化完整项目，返回根路径。
 * 显式选择 codex 目标，确保会创建 AGENTS.md 并把 entryFiles.agents 设为 true，
 * 否则默认「无入口、无目标」的 init 不会维护任何入口文档，entry 负向路径无法触发。
 */
async function createInitializedProject(prefix = "code-helper-checks-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await initializeProject({ projectRoot: root, skillRegistrationTargets: ["codex"] });
  return root;
}

/**
 * 断言 issues 中至少有一条匹配指定 code，可选再匹配 path 子串。
 * 统一用 code 字段做契约断言，避免只依赖中文 message。
 */
function assertHasIssue(issues, code, pathIncludes) {
  const matched = issues.filter((issue) => issue.code === code);
  assert.ok(matched.length > 0, `期望存在 code=${code}，实际 codes=[${issues.map((i) => i.code).join(", ")}]`);

  if (pathIncludes !== undefined) {
    assert.ok(
      matched.some((issue) => typeof issue.path === "string" && issue.path.includes(pathIncludes)),
      `期望 code=${code} 的 path 包含 ${pathIncludes}，实际 paths=[${matched.map((i) => i.path).join(", ")}]`
    );
  }

  return matched;
}

test("runChecks：missing-entry-document 与 missing-managed-block", async () => {
  const root = await createInitializedProject("code-helper-checks-entry-");

  try {
    // 删除入口文档 → missing-entry-document
    await rm(join(root, "AGENTS.md"), { force: true });
    let issues = await runChecks(root);
    assertHasIssue(issues, "missing-entry-document", "AGENTS.md");
    assert.equal(
      issues.find((issue) => issue.code === "missing-entry-document")?.level,
      "error"
    );

    // 恢复文件但去掉受控区块标记 → missing-managed-block
    await writeFile(join(root, "AGENTS.md"), "# Agents\n\n用户手写规则，无 code-helper 区块。\n", "utf8");
    issues = await runChecks(root);
    assertHasIssue(issues, "missing-managed-block", "AGENTS.md");
    assert.equal(
      issues.find((issue) => issue.code === "missing-managed-block")?.level,
      "error"
    );

    // 仅有 start 没有 end 也算缺失受控区块
    await writeFile(
      join(root, "AGENTS.md"),
      `# Agents\n\n${ENTRY_BLOCK_START}\n半截区块\n`,
      "utf8"
    );
    issues = await runChecks(root);
    assertHasIssue(issues, "missing-managed-block", "AGENTS.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：rules 目录缺失 / 为空 / 小节不全", async () => {
  const root = await createInitializedProject("code-helper-checks-rules-");

  try {
    // 整目录删除 → missing-user-rules-directory
    await rm(join(root, "code-helper-docs/user-rules"), { recursive: true, force: true });
    let issues = await runChecks(root);
    assertHasIssue(issues, "missing-user-rules-directory");
    assert.equal(
      issues.find((issue) => issue.code === "missing-user-rules-directory")?.level,
      "error"
    );

    // 空目录（无 .md）→ empty-user-rules-directory
    await mkdir(join(root, "code-helper-docs/user-rules"), { recursive: true });
    issues = await runChecks(root);
    assertHasIssue(issues, "empty-user-rules-directory");
    assert.equal(
      issues.find((issue) => issue.code === "empty-user-rules-directory")?.level,
      "error"
    );

    // 有规则文件但缺固定四段 → invalid-rule-document
    await writeFile(
      join(root, "code-helper-docs/user-rules/残缺规则.md"),
      "# 残缺规则\n\n只有标题，没有功能描述等小节。\n",
      "utf8"
    );
    issues = await runChecks(root);
    const invalid = assertHasIssue(issues, "invalid-rule-document", "残缺规则.md");
    assert.ok(invalid.every((issue) => issue.level === "error"));
    // 四个小节都应分别报错
    assert.ok(invalid.length >= 4, `期望至少 4 条 invalid-rule-document，实际 ${invalid.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：documents 非中文名 / 意外结果文件名 / 缺失工作台目录", async () => {
  const root = await createInitializedProject("code-helper-checks-docs-");

  try {
    // 计划文档英文名、结果目录英文名、意外结果文件名、状态旧后缀 → 均为 non-chinese-document-name（warning）
    await writeFile(join(root, "code-helper-docs/plan-doc/english-plan.md"), "# plan\n", "utf8");
    await mkdir(join(root, "code-helper-docs/result-doc/order-task"), { recursive: true });
    // 中文任务目录内使用非固定文件名，也应走同一 code
    await mkdir(join(root, "code-helper-docs/result-doc/订单任务"), { recursive: true });
    await writeFile(
      join(root, "code-helper-docs/result-doc/订单任务/其他笔记.md"),
      "# unexpected result file\n",
      "utf8"
    );
    await writeFile(join(root, "code-helper-docs/status-doc/订单任务-status.md"), "# status\n", "utf8");

    let issues = await runChecks(root);
    const naming = assertHasIssue(issues, "non-chinese-document-name");
    assert.ok(naming.every((issue) => issue.level === "warning"));
    assert.ok(naming.some((issue) => issue.path === "code-helper-docs/plan-doc/english-plan.md"));
    assert.ok(naming.some((issue) => issue.path === "code-helper-docs/result-doc/order-task"));
    assert.ok(naming.some((issue) => issue.path === "code-helper-docs/result-doc/订单任务/其他笔记.md"));
    assert.ok(naming.some((issue) => issue.path === "code-helper-docs/status-doc/订单任务-status.md"));

    // 删除 plan-doc 工作台目录 → missing-workbench-directory
    await rm(join(root, "code-helper-docs/plan-doc"), { recursive: true, force: true });
    issues = await runChecks(root);
    assertHasIssue(issues, "missing-workbench-directory", "plan-doc");
    assert.equal(
      issues.find((issue) => issue.code === "missing-workbench-directory")?.level,
      "error"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：missing-testing-policy 与 testing-policy-weakened", async () => {
  const root = await createInitializedProject("code-helper-checks-testing-");

  try {
    const policyPath = join(root, "code-helper-docs/user-rules/测试策略规范.md");

    // 删除规范文件 → missing-testing-policy
    await rm(policyPath, { force: true });
    let issues = await runChecks(root);
    assertHasIssue(issues, "missing-testing-policy", "测试策略规范.md");
    assert.equal(
      issues.find((issue) => issue.code === "missing-testing-policy")?.level,
      "error"
    );

    // 保留四段结构但去掉页面手工测试硬约束句 → testing-policy-weakened
    // 说明：规则检查要求四个小节标题存在；内容可故意弱化关键句。
    await writeFile(
      policyPath,
      `# 测试策略规范

## 功能描述
弱化版测试策略，故意不写页面手工测试硬约束。

## 调用时机
涉及测试时。

## 调用入口文件
无。

## 规则
1. 工具可直接执行所有测试。
`,
      "utf8"
    );
    issues = await runChecks(root);
    assertHasIssue(issues, "testing-policy-weakened", "测试策略规范.md");
    assert.equal(
      issues.find((issue) => issue.code === "testing-policy-weakened")?.level,
      "warning"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：missing-archive-directory 与 mixed-task-archive-state", async () => {
  const root = await createInitializedProject("code-helper-checks-archive-");

  try {
    // 删掉某一侧 archive 子目录 → missing-archive-directory
    await rm(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true, force: true });
    let issues = await runChecks(root);
    assertHasIssue(issues, "missing-archive-directory", "plan-doc/archive");
    assert.equal(
      issues.find((issue) => issue.code === "missing-archive-directory")?.level,
      "error"
    );

    // 恢复 archive 后构造 active + archive 同名任务 → mixed-task-archive-state
    await mkdir(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true });
    // 复杂夹具：同一中文功能名在活动侧与归档侧各放一份 plan，触发 mixed
    await writeFile(join(root, "code-helper-docs/plan-doc/混合任务.md"), "# active plan\n", "utf8");
    await writeFile(join(root, "code-helper-docs/plan-doc/archive/混合任务.md"), "# archived plan\n", "utf8");

    issues = await runChecks(root);
    assertHasIssue(issues, "mixed-task-archive-state");
    assert.equal(
      issues.find((issue) => issue.code === "mixed-task-archive-state")?.level,
      "warning"
    );
    assert.ok(
      issues.some(
        (issue) => issue.code === "mixed-task-archive-state" && issue.message.includes("混合任务")
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：config 负向路径（JSON / shape / features / 单 toggle）", async () => {
  // 这些用例不依赖完整 init：raw config 非法时 runChecks 会提前返回，只报 config 类 issue。
  const root = await mkdtemp(join(tmpdir(), "code-helper-checks-config-"));

  try {
    await mkdir(join(root, ".code-helper"), { recursive: true });
    const configPath = join(root, ".code-helper/config.json");

    // 非法 JSON → invalid-config-json
    await writeFile(configPath, "{ not-json ", "utf8");
    let issues = await runChecks(root);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "invalid-config-json");
    assert.equal(issues[0].level, "error");

    // 合法 JSON 但非对象 → invalid-config-shape
    await writeFile(configPath, "[]", "utf8");
    issues = await runChecks(root);
    assert.equal(issues[0].code, "invalid-config-shape");
    assert.equal(issues[0].level, "error");

    // 对象但无 features → missing-feature-toggles
    // 说明：仅 invalid-config-json/shape 会提前返回；本 code 会与后续结构检查并存。
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        entryFiles: { agents: false, claude: false, copilot: false },
        directories: DEFAULT_CONFIG.directories
      }),
      "utf8"
    );
    issues = await runChecks(root);
    const missingToggles = assertHasIssue(issues, "missing-feature-toggles");
    assert.equal(missingToggles[0].level, "error");

    // features 缺部分 key → missing-feature-toggle（可多条）
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        entryFiles: { agents: false, claude: false, copilot: false },
        directories: DEFAULT_CONFIG.directories,
        features: {
          checks: { enabled: true },
          gitHooks: { enabled: false }
        }
      }),
      "utf8"
    );
    issues = await runChecks(root);
    const toggles = assertHasIssue(issues, "missing-feature-toggle");
    assert.ok(toggles.every((issue) => issue.level === "error"));
    assert.ok(toggles.some((issue) => issue.message.includes("memoryTuning")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：writeReport 写入 .code-helper/checks/latest.json", async () => {
  const root = await createInitializedProject("code-helper-checks-report-");

  try {
    // 故意制造一条可断言的 error，便于验证报告内容与返回值一致
    await rm(join(root, "AGENTS.md"), { force: true });

    const issues = await runChecks(root, { writeReport: true });
    assertHasIssue(issues, "missing-entry-document");

    const reportPath = join(root, ".code-helper/checks/latest.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    assert.equal(typeof report.checkedAt, "string");
    assert.ok(Array.isArray(report.issues));
    assert.ok(report.issues.some((issue) => issue.code === "missing-entry-document"));
    // 报告中的 issue 列表应与 API 返回一致
    assert.deepEqual(
      report.issues.map((issue) => issue.code).sort(),
      issues.map((issue) => issue.code).sort()
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：完整 init 后无 issue（正对照）", async () => {
  // 负向用例的基线：初始化产物必须能通过检查，否则破坏性断言不可信。
  const root = await createInitializedProject("code-helper-checks-happy-");

  try {
    const issues = await runChecks(root);
    assert.deepEqual(issues, []);

    // writeReport 在无 issue 时也应落盘空列表
    await runChecks(root, { writeReport: true });
    const report = JSON.parse(await readFile(join(root, ".code-helper/checks/latest.json"), "utf8"));
    assert.deepEqual(report.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks：checks 功能关闭时直接返回空列表", async () => {
  const root = await createInitializedProject("code-helper-checks-disabled-");

  try {
    // 即使入口已破坏，关闭 checks 后也不应再扫描
    await rm(join(root, "AGENTS.md"), { force: true });
    const configPath = join(root, ".code-helper/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.features.checks = { enabled: false };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const issues = await runChecks(root);
    assert.deepEqual(issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
