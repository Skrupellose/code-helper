import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";

/** 捕获 evaluate 的单一 JSON envelope。 */
async function runEvaluationCli(args) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...items) => logs.push(items.join(" "));
    console.error = (...items) => errors.push(items.join(" "));
    const exitCode = await runCli(args, process.cwd());
    return { exitCode, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("evaluate CLI 默认运行三个样本并输出统一 Agent envelope", async () => {
  const result = await runEvaluationCli(["evaluate", "--samples", "3", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.logs.length, 1);
  const response = JSON.parse(result.logs[0]);
  assert.deepEqual(Object.keys(response).sort(), ["action", "data", "diagnostics", "nextActions", "ok", "status"]);
  assert.equal(response.ok, true);
  assert.equal(response.action, "evaluation.run");
  assert.equal(response.data.aggregate.sampleCount, 3);
  assert.equal(response.data.aggregate.tokens.status, "unknown");
});

test("evaluate CLI 对不足三个样本返回稳定输入错误", async () => {
  const result = await runEvaluationCli(["evaluate", "--samples", "2", "--json"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.logs.length, 1);
  const response = JSON.parse(result.logs[0]);
  assert.equal(response.ok, false);
  assert.equal(response.status, "invalid_input");
  assert.equal(response.diagnostics[0].code, "invalid_input");
});
