import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BUILTIN_MINIMAL_SCENARIO,
  loadEvaluationBaseline,
  runWorkflowEvaluation
} from "../dist/evaluation.js";

test("内置场景在三个隔离样本中通过并明确 Token 不可观测", async () => {
  const report = await runWorkflowEvaluation(BUILTIN_MINIMAL_SCENARIO, { sampleCount: 3 });

  assert.equal(report.passed, true);
  assert.equal(report.aggregate.sampleCount, 3);
  assert.equal(report.aggregate.passedSamples, 3);
  assert.equal(report.aggregate.processRoundTrips.mean, 3);
  assert.equal(report.aggregate.tokens.status, "unknown");
  assert.equal(report.samples.every((sample) => sample.tokens.status === "unknown"), true);
  assert.equal(report.samples.every((sample) => sample.finalFileCount > sample.initialFileCount), true);
  assert.equal(report.samples.every((sample) => sample.steps.every((step) => step.passed)), true);
  assert.equal(report.diagnostics.some((item) => item.code === "token_metric_unknown"), true);
});

test("外部 Token、基线比较与阈值诊断进入统一报告", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-evaluation-baseline-"));
  const scenario = {
    schemaVersion: 1,
    id: "version-contract",
    name: "版本 JSON 契约",
    description: "验证结构化版本输出并采集最小 CLI 往返。",
    fixtureFiles: [{ path: "fixture.txt", content: "评测夹具\n" }],
    steps: [{
      id: "version",
      description: "读取本地版本",
      args: ["version", "--json"],
      assertions: [
        { type: "exitCode", equals: 0 },
        { type: "jsonPathEquals", path: "ok", equals: true },
        { type: "fileContains", path: "fixture.txt", value: "评测夹具" }
      ]
    }],
    thresholds: { maxFailureCount: 0, maxDurationRegressionPercent: 0 }
  };
  const baselinePath = join(root, "baseline.json");
  try {
    const seed = await runWorkflowEvaluation({ ...scenario, thresholds: { maxFailureCount: 0 } }, {
      sampleCount: 3,
      tokenObservations: [10, 12, 11]
    });
    const syntheticBaseline = {
      ...seed,
      aggregate: {
        ...seed.aggregate,
        durationMs: { min: 1, max: 1, mean: 1, p50: 1 }
      }
    };
    await writeFile(baselinePath, `${JSON.stringify({ ok: true, data: syntheticBaseline })}\n`, "utf8");
    const baseline = await loadEvaluationBaseline(baselinePath);
    const report = await runWorkflowEvaluation(scenario, {
      sampleCount: 3,
      tokenObservations: [20, undefined, 22],
      baseline
    });

    assert.equal(report.aggregate.tokens.status, "partial");
    assert.equal(report.aggregate.tokens.observedSamples, 2);
    assert.equal(report.baseline.scenarioId, scenario.id);
    assert.equal(report.baseline.durationRegressionPercent > 0, true);
    assert.equal(report.passed, false);
    assert.equal(report.diagnostics.some((item) => item.code === "duration_regression_exceeded"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("场景拒绝跳出临时项目和联网命令", async () => {
  await assert.rejects(
    () => runWorkflowEvaluation({
      schemaVersion: 1,
      id: "unsafe-path",
      name: "越界路径",
      description: "验证隔离边界。",
      fixtureFiles: [{ path: "../outside.txt", content: "禁止写入" }],
      steps: [{
        id: "version",
        description: "读取版本",
        args: ["version", "--json"],
        assertions: [{ type: "exitCode", equals: 0 }]
      }]
    }, { sampleCount: 3 }),
    /必须位于临时项目内/u
  );

  await assert.rejects(
    () => runWorkflowEvaluation({
      schemaVersion: 1,
      id: "network-command",
      name: "联网命令",
      description: "验证联网边界。",
      fixtureFiles: [],
      steps: [{
        id: "network",
        description: "禁止联网查询",
        args: ["version", "check", "--json"],
        assertions: [{ type: "exitCode", equals: 0 }]
      }]
    }, { sampleCount: 3 }),
    /未允许的交互、递归或联网命令/u
  );

  await assert.rejects(
    () => runWorkflowEvaluation({
      schemaVersion: 1,
      id: "unsafe-step-path",
      name: "步骤越界路径",
      description: "验证命令参数路径边界。",
      fixtureFiles: [],
      steps: [{
        id: "outside-input",
        description: "禁止读取临时项目外文件",
        args: ["requirement", "explore", "--input", "../outside.json", "--json"],
        assertions: [{ type: "exitCode", equals: 0 }]
      }]
    }, { sampleCount: 3 }),
    /输入路径必须位于临时项目内/u
  );
});

test("显式 Agent runner 在临时项目执行并提供真实 Token 与轮次观测", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-evaluation-agent-runner-"));
  const runnerPath = join(root, "runner.mjs");
  try {
    await writeFile(runnerPath, `
      let prompt = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { prompt += chunk; });
      process.stdin.on("end", () => {
        console.log(JSON.stringify({ passed: prompt.includes("检查任务"), tokens: 321, turns: 2 }));
      });
    `, "utf8");
    const scenario = {
      schemaVersion: 1,
      id: "agent-runner-protocol",
      name: "真实 Agent runner 协议",
      description: "验证外部 Agent 适配器的观测数据进入报告。",
      fixtureFiles: [],
      agent: { prompt: "检查任务并返回结果。" },
      steps: [{
        id: "version",
        description: "确认 CLI 仍可执行",
        args: ["version", "--json"],
        assertions: [{ type: "exitCode", equals: 0 }]
      }]
    };

    const report = await runWorkflowEvaluation(scenario, {
      sampleCount: 3,
      agentRunner: { executablePath: process.execPath, args: [runnerPath] }
    });
    assert.equal(report.passed, true);
    assert.equal(report.aggregate.tokens.status, "observed");
    assert.equal(report.aggregate.tokens.value.mean, 321);
    assert.equal(report.samples.every((sample) => sample.agent?.turns === 2), true);
    assert.equal(report.samples.every((sample) => sample.processRoundTrips === 2), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
