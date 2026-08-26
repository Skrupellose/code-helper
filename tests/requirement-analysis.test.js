import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeRequirementCoverage } from "../dist/analysis/index.js";
import {
  clarifyRequirementExploration,
  clarifyRequirementSpecification,
  createRequirementExploration,
  createRequirementSpecification,
  renderRequirementExplorationMarkdown,
  renderRequirementSpecificationMarkdown
} from "../dist/requirements/index.js";

test("多轮部分回答保留语义问题 ID 并记录答案来源", () => {
  const initial = createRequirementExploration({ rawRequest: "改善任务流程" });
  const firstRound = clarifyRequirementExploration({
    exploration: initial,
    answers: [
      {
        questionId: "Q-001",
        answer: "让维护者能恢复当前任务节点。",
        source: "user",
        updates: { goal: "让维护者能恢复当前任务节点。" }
      },
      {
        questionId: "Q-002",
        answer: "主要用户是项目维护者，场景稍后补充。",
        source: "product-owner",
        updates: { users: ["项目维护者"] }
      }
    ]
  });

  assert.deepEqual(
    firstRound.clarificationQuestions.map((question) => question.id),
    ["Q-002", "Q-003", "Q-004", "Q-005"]
  );
  assert.deepEqual(
    firstRound.clarificationAnswers.map((answer) => [answer.questionId, answer.status, answer.source]),
    [["Q-001", "answered", "user"], ["Q-002", "partial", "product-owner"]]
  );

  const secondRound = clarifyRequirementExploration({
    exploration: firstRound,
    answers: [{
      questionId: "Q-002",
      answer: "维护者重新打开项目时继续未完成节点。",
      source: "user",
      updates: { scenarios: ["维护者重新打开项目时继续未完成节点。"] }
    }]
  });

  assert.deepEqual(
    secondRound.clarificationQuestions.map((question) => question.id),
    ["Q-003", "Q-004", "Q-005"]
  );
  assert.deepEqual(
    secondRound.clarificationAnswers.filter((answer) => answer.questionId === "Q-002").map((answer) => answer.status),
    ["partial", "answered"]
  );
  assert.match(renderRequirementExplorationMarkdown(secondRound), /Q-002.*product-owner；部分回答/u);
  assert.match(renderRequirementExplorationMarkdown(secondRound), /Q-002.*user；已关闭/u);
});

test("规格澄清追加验收条件时保留既有 AC-ID", () => {
  const exploration = createRequirementExploration({
    rawRequest: "恢复任务状态",
    goal: "恢复当前节点",
    users: ["维护者"],
    scenarios: ["重新打开项目"],
    acceptanceCriteria: ["返回当前节点"]
  });
  const specification = createRequirementSpecification({ exploration });
  const clarified = clarifyRequirementSpecification({
    specification,
    answers: [{
      questionId: "Q-004",
      answer: "不接入远端任务系统。",
      source: "user",
      updates: {
        nonGoals: ["不接入远端任务系统"],
        acceptanceCriteria: ["返回下一步动作"]
      }
    }]
  });

  assert.deepEqual(clarified.acceptanceCriteria, [
    { id: "AC-001", description: "返回当前节点" },
    { id: "AC-002", description: "返回下一步动作" }
  ]);
  assert.ok(!clarified.openQuestions.some((question) => question.id === "Q-004"));
  assert.equal(clarified.clarificationAnswers.at(-1).status, "answered");
});

/** 构造具备进入计划条件的最小规格，供语义分析用例复用。 */
function createReadySpecification() {
  const exploration = createRequirementExploration({
    rawRequest: "让任务状态可以稳定恢复。",
    title: "任务状态恢复",
    goal: "重新进入项目时能看到当前任务节点。",
    nonGoals: ["本阶段不接入远端任务系统。"],
    users: ["项目维护者"],
    scenarios: ["维护者在新会话中恢复未完成任务。"],
    constraints: ["保持本地优先。"],
    acceptanceCriteria: ["状态查询返回当前节点。", "状态查询列出下一步动作。"]
  });

  return createRequirementSpecification({ exploration });
}

test("模糊需求生成稳定的待澄清问题和中文探索文档", () => {
  const exploration = createRequirementExploration({
    rawRequest: "想把任务流程做得更好"
  });

  assert.equal(exploration.title, "想把任务流程做得更好");
  assert.equal(exploration.readyForSpecification, false);
  assert.deepEqual(
    exploration.clarificationQuestions.map((question) => question.id),
    ["Q-001", "Q-002", "Q-003", "Q-004", "Q-005"]
  );
  assert.deepEqual(
    exploration.clarificationQuestions.filter((question) => question.blocking).map((question) => question.category),
    ["goal", "user", "acceptance"]
  );

  const markdown = renderRequirementExplorationMarkdown(exploration);
  assert.match(markdown, /^# 想把任务流程做得更好：需求探索/mu);
  assert.match(markdown, /\[Q-001\].*（阻断）/u);
  assert.match(markdown, /规格准备状态：需要继续澄清/u);
});

test("完整探索结果生成带稳定验收 ID 的规格骨架", () => {
  const specification = createReadySpecification();

  assert.equal(specification.readyForPlanning, true);
  assert.deepEqual(
    specification.acceptanceCriteria.map((criterion) => criterion.id),
    ["AC-001", "AC-002"]
  );
  assert.deepEqual(specification.openQuestions, []);

  const markdown = renderRequirementSpecificationMarkdown(specification);
  assert.match(markdown, /\[AC-001\] 状态查询返回当前节点。/u);
  assert.match(markdown, /计划准备状态：可以进入计划/u);
});

test("规格阶段补充缺失用户后可以关闭用户阻断问题", () => {
  const exploration = createRequirementExploration({
    rawRequest: "提供任务状态查询。",
    goal: "新会话可以恢复当前任务节点。",
    scenarios: ["重新进入项目时查询任务状态。"],
    acceptanceCriteria: ["状态查询返回当前节点。"]
  });

  assert.equal(exploration.readyForSpecification, false);
  assert.ok(exploration.clarificationQuestions.some((question) => question.category === "user"));

  const specification = createRequirementSpecification({
    exploration,
    users: ["项目维护者"]
  });

  assert.equal(specification.readyForPlanning, true);
  assert.deepEqual(specification.users, ["项目维护者"]);
  assert.ok(!specification.openQuestions.some((question) => question.category === "user"));
  assert.match(renderRequirementSpecificationMarkdown(specification), /用户：项目维护者/u);
});

test("需求输入会清理空项与重复项，但保留首次出现顺序", () => {
  const exploration = createRequirementExploration({
    rawRequest: "整理状态",
    goal: "提供状态",
    users: ["维护者", " 维护者 "],
    scenarios: ["恢复任务", "", "恢复任务"],
    acceptanceCriteria: ["返回节点", " 返回节点 "]
  });

  assert.deepEqual(exploration.users, ["维护者"]);
  assert.deepEqual(exploration.scenarios, ["恢复任务"]);
  assert.deepEqual(exploration.acceptanceCriteria, ["返回节点"]);
  assert.equal(exploration.readyForSpecification, true);
});

test("只读语义分析在追踪链完整时通过且不改变输入", () => {
  const input = {
    specification: createReadySpecification(),
    planItems: [
      { id: "PLAN-001", title: "实现状态查询", acceptanceCriterionIds: ["AC-001"] },
      { id: "PLAN-002", title: "实现下一步建议", acceptanceCriterionIds: ["AC-002"] }
    ],
    statusItems: [
      { planItemId: "PLAN-001", status: "completed" },
      { planItemId: "PLAN-002", status: "completed" }
    ],
    validationEvidence: [
      {
        id: "VAL-001",
        command: "node --test tests/status.test.js",
        exitCode: 0,
        summary: "状态查询用例通过",
        planItemIds: ["PLAN-001", "PLAN-002"]
      }
    ]
  };
  const snapshot = structuredClone(input);

  const result = analyzeRequirementCoverage(input);

  assert.equal(result.passed, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.summary, { acceptanceCriteria: 2, errors: 0, warnings: 0 });
  assert.deepEqual(input, snapshot);
});

test("只读语义分析按首个缺失层级返回稳定诊断 code", () => {
  const result = analyzeRequirementCoverage({
    specification: createReadySpecification(),
    planItems: [
      { id: "PLAN-002", title: "实现下一步建议", acceptanceCriterionIds: ["AC-002"] }
    ],
    statusItems: [
      { planItemId: "PLAN-002", status: "completed" }
    ],
    validationEvidence: []
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["spec.acceptance.not-planned", "spec.acceptance.validation-missing"]
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.acceptanceCriterionId),
    ["AC-001", "AC-002"]
  );
});

test("只读语义分析区分未完成、失败验证和悬空引用", () => {
  const result = analyzeRequirementCoverage({
    specification: createReadySpecification(),
    planItems: [
      { id: "PLAN-001", title: "实现状态查询", acceptanceCriterionIds: ["AC-001", "AC-999"] },
      { id: "PLAN-002", title: "实现下一步建议", acceptanceCriterionIds: ["AC-002"] }
    ],
    statusItems: [
      { planItemId: "PLAN-001", status: "in_progress" },
      { planItemId: "PLAN-002", status: "completed" },
      { planItemId: "PLAN-999", status: "completed" }
    ],
    validationEvidence: [
      {
        id: "VAL-001",
        command: "node --test tests/status.test.js",
        exitCode: 1,
        summary: "下一步建议断言失败",
        acceptanceCriterionIds: ["AC-002", "AC-998"],
        planItemIds: ["PLAN-002", "PLAN-998"]
      }
    ]
  });
  const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

  assert.deepEqual(codes, [
    "plan.acceptance.unknown-reference",
    "status.plan.unknown-reference",
    "validation.acceptance.unknown-reference",
    "validation.plan.unknown-reference",
    "spec.acceptance.not-completed",
    "spec.acceptance.validation-failed"
  ]);
  assert.equal(result.summary.errors, 2);
  assert.equal(result.summary.warnings, 4);
});
