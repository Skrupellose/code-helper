import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { DocumentRepository } from "../dist/documents/index.js";
import { openDocumentDatabase } from "../dist/storage/index.js";

/** 捕获 CLI JSON 响应，并确认 stdout 只有一个完整 envelope。 */
async function runJson(args, projectRoot) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...items) => logs.push(items.join(" "));
    console.error = () => undefined;
    const exitCode = await runCli([...args, "--json"], projectRoot);
    assert.equal(logs.length, 1);
    return { exitCode, response: JSON.parse(logs[0]) };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("requirement explore/specify 通过显式 JSON 输入生成可追踪规格", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-requirement-cli-"));
  try {
    const explorationInputPath = join(root, "explore.json");
    await writeFile(explorationInputPath, JSON.stringify({ rawRequest: "优化任务恢复" }), "utf8");
    const explored = await runJson(["requirement", "explore", "--input", explorationInputPath], root);
    assert.equal(explored.exitCode, 0);
    assert.equal(explored.response.action, "requirement.explore");
    assert.equal(explored.response.data.exploration.readyForSpecification, false);
    assert.deepEqual(explored.response.nextActions, ["answer_blocking_questions"]);

    const specificationInputPath = join(root, "specify.json");
    await writeFile(specificationInputPath, JSON.stringify({
      exploration: explored.response.data.exploration,
      goal: "新会话可以恢复当前任务节点。",
      users: ["项目维护者"],
      scenarios: ["维护者重新打开项目后继续当前节点。"],
      acceptanceCriteria: ["状态查询返回当前节点。"]
    }), "utf8");
    const specified = await runJson(["requirement", "specify", "--input", specificationInputPath], root);
    assert.equal(specified.exitCode, 0);
    assert.equal(specified.response.data.specification.readyForPlanning, true);
    assert.equal(specified.response.data.specification.acceptanceCriteria[0].id, "AC-001");
    assert.deepEqual(specified.response.nextActions, ["create_plan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requirement clarify 以统一 JSON 契约合并多轮回答", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-requirement-clarify-cli-"));
  try {
    const explorationPath = join(root, "explore.json");
    await writeFile(explorationPath, JSON.stringify({ rawRequest: "优化任务恢复" }), "utf8");
    const explored = await runJson(["requirement", "explore", "--input", explorationPath], root);

    const clarifyPath = join(root, "clarify.json");
    await writeFile(clarifyPath, JSON.stringify({
      exploration: explored.response.data.exploration,
      answers: [{
        questionId: "Q-001",
        answer: "新会话可以恢复当前任务节点。",
        source: "user",
        updates: { goal: "新会话可以恢复当前任务节点。" }
      }]
    }), "utf8");
    const clarified = await runJson(["requirement", "clarify", "--input", clarifyPath], root);

    assert.equal(clarified.exitCode, 0);
    assert.equal(clarified.response.action, "requirement.clarify");
    assert.equal(clarified.response.data.artifactType, "exploration");
    assert.equal(clarified.response.data.exploration.clarificationAnswers[0].status, "answered");
    assert.equal(clarified.response.data.exploration.clarificationAnswers[0].source, "user");
    assert.deepEqual(
      clarified.response.data.exploration.clarificationQuestions.map((question) => question.id),
      ["Q-002", "Q-003", "Q-004", "Q-005"]
    );
    assert.deepEqual(clarified.response.nextActions, ["answer_open_questions"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requirement answer 成功与失败都规范化为 clarify action", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-requirement-answer-cli-"));
  try {
    const invalid = await runJson(["requirement", "answer"], root);
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.response.action, "requirement.clarify");

    const explorationPath = join(root, "explore.json");
    await writeFile(explorationPath, JSON.stringify({ rawRequest: "优化任务恢复" }), "utf8");
    const explored = await runJson(["requirement", "explore", "--input", explorationPath], root);
    const answerPath = join(root, "answer.json");
    await writeFile(answerPath, JSON.stringify({
      exploration: explored.response.data.exploration,
      answers: [{
        questionId: "Q-001",
        answer: "新会话恢复当前节点。",
        source: "user",
        updates: { goal: "新会话恢复当前节点。" }
      }]
    }), "utf8");
    const answered = await runJson(["requirement", "answer", "--input", answerPath], root);
    assert.equal(answered.exitCode, 0);
    assert.equal(answered.response.action, "requirement.clarify");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze 只读返回稳定诊断和下一动作", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-analyze-cli-"));
  try {
    const inputPath = join(root, "analysis.json");
    const input = {
      specification: {
        contractVersion: 1,
        title: "任务恢复",
        goal: "恢复任务",
        nonGoals: [],
        users: ["维护者"],
        scenarios: ["恢复会话"],
        constraints: [],
        acceptanceCriteria: [{ id: "AC-001", description: "返回当前节点" }],
        openQuestions: [],
        readyForPlanning: true
      },
      planItems: [],
      statusItems: [],
      validationEvidence: []
    };
    await writeFile(inputPath, JSON.stringify(input), "utf8");
    const analyzed = await runJson(["analyze", "--input", inputPath], root);
    assert.equal(analyzed.exitCode, 0);
    assert.equal(analyzed.response.data.analysis.passed, false);
    assert.equal(analyzed.response.data.analysis.diagnostics[0].code, "spec.acceptance.not-planned");
    assert.deepEqual(analyzed.response.nextActions, ["resolve_diagnostics"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze --task 从 SQLite 权威任务读取带追踪关系的验证回执", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-analyze-task-cli-"));
  try {
    const connection = openDocumentDatabase({ projectRoot: root });
    try {
      const repository = new DocumentRepository(connection);
      const task = repository.createTask({ slug: "task-analysis", name: "任务分析" });
      repository.recordValidation({
        taskId: task.id,
        command: "node --test",
        workingDirectory: root,
        exitCode: 0,
        summary: "追踪验证通过",
        acceptanceCriterionIds: ["AC-001"],
        planItemIds: ["PLAN-001"]
      });
    } finally {
      connection.close();
    }

    const inputPath = join(root, "analysis-task.json");
    await writeFile(inputPath, JSON.stringify({
      specification: {
        contractVersion: 1,
        title: "任务恢复",
        goal: "恢复任务",
        nonGoals: [],
        users: ["维护者"],
        scenarios: ["恢复会话"],
        constraints: [],
        acceptanceCriteria: [{ id: "AC-001", description: "返回当前节点" }],
        openQuestions: [],
        readyForPlanning: true
      },
      planItems: [{ id: "PLAN-001", title: "实现状态查询", acceptanceCriterionIds: ["AC-001"] }],
      statusItems: [{ planItemId: "PLAN-001", status: "completed" }],
      validationEvidence: []
    }), "utf8");

    const analyzed = await runJson(["analyze", "--input", inputPath, "--task", "task-analysis"], root);
    assert.equal(analyzed.exitCode, 0);
    assert.equal(analyzed.response.data.analysis.passed, true);
    assert.deepEqual(analyzed.response.data.analysis.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("需求 CLI 输入错误仍返回单一失败 envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-requirement-error-"));
  try {
    const result = await runJson(["requirement", "explore"], root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.response.ok, false);
    assert.equal(result.response.status, "invalid_input");
    assert.equal(result.response.diagnostics[0].code, "invalid_input");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
