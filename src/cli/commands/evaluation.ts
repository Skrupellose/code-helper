import { resolve } from "node:path";

import {
  BUILTIN_MINIMAL_SCENARIO,
  loadEvaluationBaseline,
  loadEvaluationScenario,
  runWorkflowEvaluation,
  type EvaluationReport
} from "../../evaluation.js";
import {
  createErrorResponse,
  printAgentResponse,
  type AgentResponse
} from "../agent-response.js";

const EVALUATE_USAGE = "code-helper evaluate [--scenario <JSON 文件>] [--samples <N>] [--baseline <报告文件>] [--token-observations <N,unknown,...>] [--agent-runner <可执行文件>] [--process-timeout-ms <N>] [--process-output-limit-bytes <N>] [--json]";

/**
 * 工作流评测 CLI。
 * 场景文件和基线只从调用目录读取；真正执行始终发生在新建临时项目中。
 */
export async function runEvaluation(args: string[], inputBasePath: string): Promise<number> {
  const json = args.includes("--json");
  try {
    if (args.filter((arg) => arg === "--json").length > 1) {
      throw new Error("参数不能重复：--json");
    }
    const options = parseEvaluationOptions(args.filter((arg) => arg !== "--json"));
    const scenario = options.scenarioPath === undefined
      ? BUILTIN_MINIMAL_SCENARIO
      : await loadEvaluationScenario(resolve(inputBasePath, options.scenarioPath));
    const baseline = options.baselinePath === undefined
      ? undefined
      : await loadEvaluationBaseline(resolve(inputBasePath, options.baselinePath));
    const report = await runWorkflowEvaluation(scenario, {
      sampleCount: options.sampleCount,
      tokenObservations: options.tokenObservations,
      baseline,
      processTimeoutMs: options.processTimeoutMs,
      processOutputLimitBytes: options.processOutputLimitBytes,
      agentRunner: options.agentRunnerPath === undefined
        ? undefined
        : { executablePath: resolve(inputBasePath, options.agentRunnerPath) }
    });
    const response: AgentResponse<EvaluationReport> = {
      ok: report.passed,
      action: "evaluation.run",
      status: report.passed ? "success" : "acceptance_failed",
      data: report,
      diagnostics: report.diagnostics,
      nextActions: report.passed ? ["store_as_baseline"] : ["inspect_failed_assertions"]
    };
    printEvaluationResponse(response, json);
    return report.passed ? 0 : 2;
  } catch (error) {
    const response = createErrorResponse("evaluation.run", "invalid_input", {
      severity: "error",
      code: "invalid_input",
      message: error instanceof Error ? error.message : String(error),
      fix: `检查命令参数和 JSON 文件。用法：${EVALUATE_USAGE}`
    });
    printEvaluationResponse(response, json);
    return 1;
  }
}

interface EvaluationCliOptions {
  scenarioPath?: string;
  baselinePath?: string;
  sampleCount: number;
  tokenObservations?: Array<number | undefined>;
  agentRunnerPath?: string;
  processTimeoutMs?: number;
  processOutputLimitBytes?: number;
}

/** 严格解析评测参数，拒绝重复、未知或缺值选项。 */
function parseEvaluationOptions(args: string[]): EvaluationCliOptions {
  if (args.length % 2 !== 0) {
    throw new Error(`用法：${EVALUATE_USAGE}`);
  }
  const values: Record<string, string> = {};
  const allowed = new Set([
    "--scenario",
    "--samples",
    "--baseline",
    "--token-observations",
    "--agent-runner",
    "--process-timeout-ms",
    "--process-output-limit-bytes"
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !allowed.has(key) || value.startsWith("--")) {
      throw new Error(`用法：${EVALUATE_USAGE}`);
    }
    if (values[key] !== undefined) {
      throw new Error(`参数不能重复：${key}`);
    }
    values[key] = value;
  }

  const sampleCount = values["--samples"] === undefined ? 3 : Number(values["--samples"]);
  if (!Number.isInteger(sampleCount) || sampleCount < 3) {
    throw new Error("--samples 必须是大于或等于 3 的整数");
  }
  const tokenObservations = values["--token-observations"] === undefined
    ? undefined
    : parseTokenObservations(values["--token-observations"], sampleCount);
  const processTimeoutMs = parseOptionalPositiveInteger(values["--process-timeout-ms"], "--process-timeout-ms");
  const processOutputLimitBytes = parseOptionalPositiveInteger(
    values["--process-output-limit-bytes"],
    "--process-output-limit-bytes"
  );
  return {
    scenarioPath: values["--scenario"],
    baselinePath: values["--baseline"],
    agentRunnerPath: values["--agent-runner"],
    sampleCount,
    tokenObservations,
    processTimeoutMs,
    processOutputLimitBytes
  };
}

/** 解析可选正整数资源边界，拒绝零、负数、小数和非数字。 */
function parseOptionalPositiveInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  const maximum = option === "--process-timeout-ms" ? 2_147_483_647 : Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${option} 必须是正整数`);
  }
  return parsed;
}

/** 解析外部 Token 观测；unknown 保留为未观测，禁止用输出字节推算。 */
function parseTokenObservations(value: string, sampleCount: number): Array<number | undefined> {
  const observations = value.split(",").map((item) => {
    const normalized = item.trim().toLowerCase();
    if (normalized === "unknown" || normalized === "") {
      return undefined;
    }
    const parsed = Number(normalized);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("--token-observations 只接受非负整数或 unknown");
    }
    return parsed;
  });
  if (observations.length !== sampleCount) {
    throw new Error(`--token-observations 必须提供 ${sampleCount} 个逗号分隔值`);
  }
  return observations;
}

/** JSON 模式使用统一 envelope；人类模式只输出聚合摘要与诊断。 */
function printEvaluationResponse(response: AgentResponse<EvaluationReport> | AgentResponse, json: boolean): void {
  if (json) {
    printAgentResponse(response);
    return;
  }
  if (typeof response.data !== "object" || response.data === null || !("aggregate" in response.data)) {
    for (const diagnostic of response.diagnostics) {
      console.error(`${diagnostic.code}：${diagnostic.message}`);
    }
    return;
  }
  const report = response.data as EvaluationReport;
  console.log(`场景：${report.scenario.name}（${report.scenario.id}）`);
  console.log(`样本：${report.aggregate.passedSamples}/${report.aggregate.sampleCount} 通过`);
  console.log(`平均耗时：${report.aggregate.durationMs.mean} ms`);
  console.log(`平均进程往返：${report.aggregate.processRoundTrips.mean}`);
  console.log(`平均 stdout/stderr：${report.aggregate.stdoutBytes.mean}/${report.aggregate.stderrBytes.mean} 字节`);
  console.log(`平均文件/磁盘增长：${report.aggregate.fileCountGrowth.mean} 个 / ${report.aggregate.diskGrowthBytes.mean} 字节`);
  console.log(`Token：${report.aggregate.tokens.status}`);
  for (const diagnostic of report.diagnostics) {
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}：${diagnostic.message}`);
  }
}
