import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type {
  EvaluationAggregate,
  EvaluationAgentResult,
  EvaluationAssertion,
  EvaluationAssertionResult,
  EvaluationDiagnostic,
  EvaluationMetricSummary,
  EvaluationProcessFailureCode,
  EvaluationReport,
  EvaluationSampleResult,
  EvaluationScenario,
  EvaluationStepResult,
  RunEvaluationOptions
} from "./types.js";

/** 单个评测子进程的默认最长运行时间，避免异常 runner 永久占用评测。 */
export const DEFAULT_EVALUATION_PROCESS_TIMEOUT_MS = 30_000;

/** stdout 与 stderr 各自的默认收集上限，避免持续输出耗尽内存。 */
export const DEFAULT_EVALUATION_PROCESS_OUTPUT_LIMIT_BYTES = 1_048_576;

/** Node.js 定时器支持的最大毫秒值；更大值会被运行时缩短为 1ms。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 进程树终止后等待 stdio 关闭的宽限期；超时后主动释放本进程持有的管道。 */
const PROCESS_TREE_CLOSE_GRACE_MS = 1_000;

/** Windows taskkill 自身的执行上限，避免终止辅助进程反过来挂住评测。 */
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

/** 内置最小场景覆盖初始化、任务读取和文档完整性检查三次真实 CLI 往返。 */
export const BUILTIN_MINIMAL_SCENARIO: EvaluationScenario = {
  schemaVersion: 1,
  id: "builtin-minimal-workflow",
  name: "内置最小工作流",
  description: "在空临时项目中初始化 Codex 资产，并验证任务查询与文档完整性检查。",
  fixtureFiles: [],
  steps: [
    {
      id: "initialize",
      description: "初始化隔离项目",
      args: ["init", "codex"],
      assertions: [
        { type: "exitCode", equals: 0 },
        { type: "fileExists", path: "AGENTS.md" },
        { type: "fileExists", path: ".code-helper/code-helper.sqlite" }
      ]
    },
    {
      id: "list-tasks",
      description: "读取任务列表的 Agent JSON",
      args: ["tasks", "--json"],
      assertions: [
        { type: "exitCode", equals: 0 },
        { type: "jsonPathEquals", path: "ok", equals: true },
        { type: "jsonPathEquals", path: "action", equals: "tasks.list" }
      ]
    },
    {
      id: "check-documents",
      description: "检查 SQLite 文档库完整性",
      args: ["documents", "check", "--json"],
      assertions: [
        { type: "exitCode", equals: 0 },
        { type: "jsonPathEquals", path: "ok", equals: true },
        { type: "jsonPathEquals", path: "action", equals: "documents.check" }
      ]
    }
  ],
  thresholds: { maxFailureCount: 0 }
};

/** 从显式 JSON 文件读取并校验场景，避免在评测期间执行任意脚本。 */
export async function loadEvaluationScenario(path: string): Promise<EvaluationScenario> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertEvaluationScenario(parsed);
  return parsed;
}

/** 从本工具生成的裸报告或 Agent envelope 中读取可比较基线。 */
export async function loadEvaluationBaseline(path: string): Promise<EvaluationReport> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const candidate = typeof parsed === "object" && parsed !== null && "data" in parsed
    ? (parsed as { data?: unknown }).data
    : parsed;
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("基线文件不是有效的 code-helper 评测报告");
  }
  const report = candidate as Partial<EvaluationReport>;
  if (report.schemaVersion !== 1 || typeof report.scenario?.id !== "string" || report.aggregate === undefined) {
    throw new Error("基线文件不是有效的 code-helper 评测报告");
  }
  return report as EvaluationReport;
}

/**
 * 重复执行同一场景并聚合结果。
 * 每个样本使用独立临时目录，默认完成后删除，不读取或写入调用方业务仓库。
 */
export async function runWorkflowEvaluation(
  scenario: EvaluationScenario,
  options: RunEvaluationOptions = {}
): Promise<EvaluationReport> {
  assertEvaluationScenario(scenario);
  const sampleCount = options.sampleCount ?? 3;
  if (!Number.isInteger(sampleCount) || sampleCount < 3) {
    throw new Error("评测样本数必须是大于或等于 3 的整数");
  }
  const processTimeoutMs = requirePositiveInteger(
    options.processTimeoutMs ?? DEFAULT_EVALUATION_PROCESS_TIMEOUT_MS,
    "processTimeoutMs",
    MAX_TIMER_DELAY_MS
  );
  const processOutputLimitBytes = requirePositiveInteger(
    options.processOutputLimitBytes ?? DEFAULT_EVALUATION_PROCESS_OUTPUT_LIMIT_BYTES,
    "processOutputLimitBytes"
  );
  if (options.baseline !== undefined && options.baseline.scenario.id !== scenario.id) {
    throw new Error(`基线场景 ${options.baseline.scenario.id} 与当前场景 ${scenario.id} 不一致`);
  }

  const executablePath = options.executablePath ?? fileURLToPath(new URL("../index.js", import.meta.url));
  const samples: EvaluationSampleResult[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await runEvaluationSample(scenario, index + 1, executablePath, {
      observedTokens: options.tokenObservations?.[index],
      agentRunner: options.agentRunner,
      processTimeoutMs,
      processOutputLimitBytes,
      keepTemporaryProject: options.keepTemporaryProjects === true
    }));
  }

  const aggregate = aggregateSamples(samples);
  const diagnostics = diagnoseReport(scenario, samples, aggregate, options.baseline);
  if (aggregate.tokens.status !== "observed") {
    diagnostics.push({
      severity: "info",
      code: "token_metric_unknown",
      message: aggregate.tokens.status === "unknown"
        ? "本地 CLI 无法观测 Agent Token；所有样本均明确记录为 unknown。"
        : "仅部分样本提供了外部 Token 观测值；未观测样本保持 unknown。",
      fix: "如需 Token 对比，请用 --token-observations 传入外部系统的真实观测值"
    });
  }

  const baseline = options.baseline === undefined ? undefined : {
    scenarioId: options.baseline.scenario.id,
    durationRegressionPercent: calculateRegression(
      aggregate.durationMs.mean,
      options.baseline.aggregate.durationMs.mean
    ),
    diskGrowthRegressionPercent: calculateRegression(
      aggregate.diskGrowthBytes.mean,
      options.baseline.aggregate.diskGrowthBytes.mean
    )
  };
  const passed = aggregate.failedSamples === 0 && diagnostics.every((item) => item.severity !== "error");

  return {
    schemaVersion: 1,
    scenario: { id: scenario.id, name: scenario.name, description: scenario.description },
    generatedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch
    },
    samples,
    aggregate,
    baseline,
    diagnostics,
    passed
  };
}

interface SampleOptions {
  observedTokens?: number;
  agentRunner?: RunEvaluationOptions["agentRunner"];
  processTimeoutMs: number;
  processOutputLimitBytes: number;
  keepTemporaryProject: boolean;
}

/** 执行单个隔离样本，并确保失败路径也清理临时目录。 */
async function runEvaluationSample(
  scenario: EvaluationScenario,
  sample: number,
  executablePath: string,
  options: SampleOptions
): Promise<EvaluationSampleResult> {
  const safeScenarioId = scenario.id.replace(/[^a-zA-Z0-9_-]+/gu, "-");
  const projectRoot = await mkdtemp(join(tmpdir(), `code-helper-evaluation-${safeScenarioId}-`));
  try {
    await writeFixtureFiles(projectRoot, scenario);
    const initial = await measureDirectory(projectRoot);
    const startedAt = performance.now();
    const agent = scenario.agent === undefined
      ? undefined
      : await runAgentEvaluation(projectRoot, scenario.agent.prompt, options.agentRunner, options);
    const steps: EvaluationStepResult[] = [];
    for (const step of scenario.steps) {
      steps.push(await runEvaluationStep(projectRoot, executablePath, step, options));
    }
    const durationMs = roundMetric(performance.now() - startedAt);
    const final = await measureDirectory(projectRoot);

    return {
      sample,
      passed: (agent?.passed ?? true) && steps.every((step) => step.passed),
      durationMs,
      processRoundTrips: steps.length + (agent === undefined ? 0 : 1),
      stdoutBytes: steps.reduce((total, step) => total + step.stdoutBytes, agent?.stdoutBytes ?? 0),
      stderrBytes: steps.reduce((total, step) => total + step.stderrBytes, agent?.stderrBytes ?? 0),
      initialFileCount: initial.fileCount,
      finalFileCount: final.fileCount,
      fileCountGrowth: final.fileCount - initial.fileCount,
      initialDiskBytes: initial.diskBytes,
      finalDiskBytes: final.diskBytes,
      diskGrowthBytes: final.diskBytes - initial.diskBytes,
      tokens: agent?.tokens.status === "observed"
        ? agent.tokens
        : options.observedTokens === undefined
          ? { status: "unknown", source: "unavailable_in_local_cli" }
          : { status: "observed", value: options.observedTokens, source: "external" },
      agent,
      steps
    };
  } finally {
    if (!options.keepTemporaryProject) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
}

/**
 * 运行调用方显式提供的真实 Agent 适配器。
 * runner 在临时项目中执行，从 stdin 接收 prompt，并必须向 stdout 返回
 * `{ "passed": boolean, "tokens"?: number, "turns"?: number }`，其余输出正文不进入报告。
 */
async function runAgentEvaluation(
  projectRoot: string,
  prompt: string,
  runner: RunEvaluationOptions["agentRunner"],
  limits: Pick<SampleOptions, "processTimeoutMs" | "processOutputLimitBytes">
): Promise<EvaluationAgentResult> {
  if (runner === undefined) {
    throw new Error("评测场景声明了 agent.prompt，必须显式提供 Agent runner");
  }
  const startedAt = performance.now();
  const execution = await spawnAgentRunner(runner, projectRoot, prompt, limits);
  const durationMs = roundMetric(performance.now() - startedAt);
  let payload: { passed?: unknown; tokens?: unknown; turns?: unknown } = {};
  try {
    payload = JSON.parse(execution.stdout) as typeof payload;
  } catch {
    // 非 JSON 输出按失败处理，但只记录字节数，不把潜在敏感正文写入报告。
  }
  const tokens = Number.isInteger(payload.tokens) && Number(payload.tokens) >= 0
    ? { status: "observed" as const, value: Number(payload.tokens), source: "agent_runner" as const }
    : { status: "unknown" as const, source: "unavailable_in_local_cli" as const };
  const turns = Number.isInteger(payload.turns) && Number(payload.turns) >= 0
    ? Number(payload.turns)
    : undefined;
  return {
    exitCode: execution.exitCode,
    durationMs,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    turns,
    tokens,
    failureCode: execution.failureCode,
    passed: execution.failureCode === undefined && execution.exitCode === 0 && payload.passed === true
  };
}

/** 使用参数数组启动显式 Agent runner，不启用 Shell，并把 prompt 写入标准输入。 */
function spawnAgentRunner(
  runner: NonNullable<RunEvaluationOptions["agentRunner"]>,
  cwd: string,
  prompt: string,
  limits: Pick<SampleOptions, "processTimeoutMs" | "processOutputLimitBytes">
): Promise<SpawnResult> {
  return spawnBoundedProcess(runner.executablePath, runner.args ?? [], {
    cwd,
    env: { ...process.env, CODE_HELPER_EVALUATION: "1" },
    stdin: prompt,
    ...limits
  });
}

/** 写入声明式夹具；拒绝绝对路径和跳出临时根目录的相对路径。 */
async function writeFixtureFiles(projectRoot: string, scenario: EvaluationScenario): Promise<void> {
  for (const fixture of scenario.fixtureFiles) {
    const path = resolveSafeProjectPath(projectRoot, fixture.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fixture.content, "utf8");
  }
}

/** 启动真实 code-helper 子进程并收集稳定指标。 */
async function runEvaluationStep(
  projectRoot: string,
  executablePath: string,
  step: EvaluationScenario["steps"][number],
  limits: Pick<SampleOptions, "processTimeoutMs" | "processOutputLimitBytes">
): Promise<EvaluationStepResult> {
  const startedAt = performance.now();
  const execution = await spawnCodeHelper(executablePath, step.args, projectRoot, limits);
  const durationMs = roundMetric(performance.now() - startedAt);
  const assertions: EvaluationAssertionResult[] = [];
  for (const assertion of step.assertions) {
    assertions.push(await evaluateAssertion(assertion, execution, projectRoot));
  }
  return {
    id: step.id,
    exitCode: execution.exitCode,
    durationMs,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    assertions,
    failureCode: execution.failureCode,
    passed: execution.failureCode === undefined && assertions.every((assertion) => assertion.passed)
  };
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  failureCode?: EvaluationProcessFailureCode;
}

interface SpawnLimits {
  processTimeoutMs: number;
  processOutputLimitBytes: number;
}

interface SpawnBoundedOptions extends SpawnLimits {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}

/** 使用参数数组直接启动 Node，不启用 shell，确保 Windows/macOS 行为一致。 */
function spawnCodeHelper(
  executablePath: string,
  args: string[],
  cwd: string,
  limits: SpawnLimits
): Promise<SpawnResult> {
  return spawnBoundedProcess(process.execPath, [executablePath, ...args], {
    cwd,
    env: {
      ...process.env,
      CI: "1",
      CODE_HELPER_SKIP_VERSION_CHECK: "1"
    },
    ...limits
  });
}

/**
 * 在统一超时和输出边界内运行子进程。
 * 触发任一边界后终止完整进程树，并以 settled 防止 error/close/timer 多次结算。
 */
function spawnBoundedProcess(command: string, args: string[], options: SpawnBoundedOptions): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: options.env,
      // POSIX 独立进程组允许按负 PID 一次终止 runner 及其后代；Windows 改由 taskkill /T 管理进程树。
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failureCode: EvaluationProcessFailureCode | undefined;
    let settled = false;
    let closeGraceTimer: NodeJS.Timeout | undefined;

    /** 所有成功、失败和宽限期路径都通过这里完成，确保 Promise 只结算一次。 */
    const settleResult = (exitCode: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (closeGraceTimer !== undefined) {
        clearTimeout(closeGraceTimer);
      }
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutBytes,
        stderrBytes,
        failureCode
      });
    };

    /** 首次触发资源边界时终止整棵进程树，并设置有界的 stdio 关闭宽限期。 */
    const requestTermination = (code: EvaluationProcessFailureCode): void => {
      if (failureCode !== undefined) {
        return;
      }
      failureCode = code;
      void terminateProcessTree(child).finally(() => {
        if (settled) {
          return;
        }
        closeGraceTimer = setTimeout(() => {
          // 极端情况下后代仍持有继承管道；销毁本端句柄并完成失败结果，避免评测永久悬挂。
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          settleResult(1);
        }, PROCESS_TREE_CLOSE_GRACE_MS);
      });
    };

    /** 只记录上限内的字节；首次越界立即终止进程。 */
    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const currentBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = options.processOutputLimitBytes - currentBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        (stream === "stdout" ? stdoutChunks : stderrChunks).push(retained);
        if (stream === "stdout") {
          stdoutBytes += retained.length;
        } else {
          stderrBytes += retained.length;
        }
      }
      if (chunk.length > remaining && failureCode === undefined) {
        requestTermination(stream === "stdout" ? "stdout_limit_exceeded" : "stderr_limit_exceeded");
      }
    };

    // stdout/stderr 在上方固定配置为 pipe，因此这里可以安全断言非空。
    child.stdout!.on("data", (chunk: Buffer) => { collect("stdout", chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { collect("stderr", chunk); });
    const timeout = setTimeout(() => {
      if (failureCode === undefined) {
        requestTermination("process_timeout");
      }
    }, options.processTimeoutMs);

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (closeGraceTimer !== undefined) {
        clearTimeout(closeGraceTimer);
      }
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settleResult(code ?? 1);
    });
    if (options.stdin !== undefined && child.stdin !== null) {
      // runner 可能在读取 prompt 前退出；吸收 EPIPE，最终结果仍由 close 统一结算。
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin, "utf8");
    }
  });
}

/**
 * 跨平台终止完整进程树。
 * POSIX 使用独立进程组；Windows 使用系统 taskkill.exe 的 /T /F，失败时至少强杀直接子进程。
 */
async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    const treeTerminated = await runWindowsTaskkill(pid);
    if (treeTerminated) {
      return;
    }
  } else {
    try {
      // detached 子进程的 PID 同时是进程组 ID；负 PID 会向组内所有后代发送 SIGKILL。
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // 进程组可能恰好已退出；继续尝试直接子进程作为安全兜底。
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // 直接子进程可能已经退出；外层关闭宽限期仍保证评测 Promise 有界完成。
  }
}

/** 使用固定可执行文件和参数数组调用 Windows 进程树终止命令，始终保持 shell:false。 */
function runWindowsTaskkill(pid: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise(succeeded);
    };
    const timeout = setTimeout(() => {
      killer.kill("SIGKILL");
      finish(false);
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    killer.once("error", () => { finish(false); });
    killer.once("close", (code) => { finish(code === 0); });
  });
}

/** 逐类执行声明式验收断言。 */
async function evaluateAssertion(
  assertion: EvaluationAssertion,
  execution: SpawnResult,
  projectRoot: string
): Promise<EvaluationAssertionResult> {
  if (assertion.type === "exitCode") {
    return assertionResult(assertion, execution.exitCode === assertion.equals, `退出码应为 ${assertion.equals}，实际为 ${execution.exitCode}`);
  }
  if (assertion.type === "stdoutIncludes") {
    return assertionResult(assertion, execution.stdout.includes(assertion.value), "stdout 应包含指定文本");
  }
  if (assertion.type === "stderrIncludes") {
    return assertionResult(assertion, execution.stderr.includes(assertion.value), "stderr 应包含指定文本");
  }
  if (assertion.type === "jsonPathEquals") {
    try {
      const actual = resolveJsonPath(JSON.parse(execution.stdout) as unknown, assertion.path);
      return assertionResult(assertion, JSON.stringify(actual) === JSON.stringify(assertion.equals), `JSON 路径 ${assertion.path} 应等于 ${JSON.stringify(assertion.equals)}`);
    } catch (error) {
      return assertionResult(assertion, false, `stdout 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const filePath = resolveSafeProjectPath(projectRoot, assertion.path);
  if (assertion.type === "fileExists") {
    try {
      await stat(filePath);
      return assertionResult(assertion, true, `文件 ${assertion.path} 应存在`);
    } catch {
      return assertionResult(assertion, false, `文件 ${assertion.path} 应存在`);
    }
  }
  try {
    const content = await readFile(filePath, "utf8");
    return assertionResult(assertion, content.includes(assertion.value), `文件 ${assertion.path} 应包含指定文本`);
  } catch (error) {
    return assertionResult(assertion, false, `无法读取文件 ${assertion.path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 统一生成断言结果，避免输出实际 stdout、stderr 或文件内容。 */
function assertionResult(
  assertion: EvaluationAssertion,
  passed: boolean,
  expectation: string
): EvaluationAssertionResult {
  return { type: assertion.type, passed, message: passed ? `通过：${expectation}` : `失败：${expectation}` };
}

/** 只支持点分隔对象路径，足以断言 Agent JSON 契约且不引入表达式执行。 */
function resolveJsonPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) {
      throw new Error(`路径不存在：${path}`);
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

/** 计算目录内普通文件数量与磁盘字节，不跟随符号链接。 */
async function measureDirectory(root: string): Promise<{ fileCount: number; diskBytes: number }> {
  let fileCount = 0;
  let diskBytes = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureDirectory(path);
      fileCount += nested.fileCount;
      diskBytes += nested.diskBytes;
    } else if (entry.isFile()) {
      fileCount += 1;
      diskBytes += (await stat(path)).size;
    }
  }
  return { fileCount, diskBytes };
}

/** 汇总三个或更多同条件样本。 */
function aggregateSamples(samples: EvaluationSampleResult[]): EvaluationAggregate {
  const observedTokens = samples.flatMap((sample) => sample.tokens.status === "observed" ? [sample.tokens.value] : []);
  return {
    sampleCount: samples.length,
    passedSamples: samples.filter((sample) => sample.passed).length,
    failedSamples: samples.filter((sample) => !sample.passed).length,
    durationMs: summarize(samples.map((sample) => sample.durationMs)),
    processRoundTrips: summarize(samples.map((sample) => sample.processRoundTrips)),
    stdoutBytes: summarize(samples.map((sample) => sample.stdoutBytes)),
    stderrBytes: summarize(samples.map((sample) => sample.stderrBytes)),
    fileCountGrowth: summarize(samples.map((sample) => sample.fileCountGrowth)),
    diskGrowthBytes: summarize(samples.map((sample) => sample.diskGrowthBytes)),
    tokens: {
      status: observedTokens.length === 0 ? "unknown" : observedTokens.length === samples.length ? "observed" : "partial",
      observedSamples: observedTokens.length,
      value: observedTokens.length === 0 ? undefined : summarize(observedTokens)
    }
  };
}

/** 计算最小值、最大值、均值和最近秩 p50。 */
function summarize(values: number[]): EvaluationMetricSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    max: sorted.at(-1) ?? sorted[0],
    mean: roundMetric(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]
  };
}

/** 根据验收、绝对阈值和基线回归阈值生成稳定诊断。 */
function diagnoseReport(
  scenario: EvaluationScenario,
  samples: EvaluationSampleResult[],
  aggregate: EvaluationAggregate,
  baseline?: EvaluationReport
): EvaluationDiagnostic[] {
  const diagnostics: EvaluationDiagnostic[] = [];
  const processFailures = new Map<EvaluationProcessFailureCode, number>();
  for (const sample of samples) {
    const failureCodes = [sample.agent?.failureCode, ...sample.steps.map((step) => step.failureCode)];
    for (const failureCode of failureCodes) {
      if (failureCode !== undefined) {
        processFailures.set(failureCode, (processFailures.get(failureCode) ?? 0) + 1);
      }
    }
  }
  for (const [code, count] of processFailures) {
    diagnostics.push({
      severity: "error",
      code,
      message: `${count} 个评测子进程触发资源边界：${describeProcessFailure(code)}`,
      target: scenario.id,
      fix: "检查 runner/场景是否挂起或持续输出；确需放宽时使用受控的正整数评测参数"
    });
  }
  if (aggregate.failedSamples > 0) {
    diagnostics.push({ severity: "error", code: "acceptance_failed", message: `${aggregate.failedSamples} 个样本未通过验收断言`, target: scenario.id });
  }
  const thresholds = scenario.thresholds;
  if (thresholds?.maxFailureCount !== undefined && aggregate.failedSamples > thresholds.maxFailureCount) {
    diagnostics.push({ severity: "error", code: "failure_count_threshold_exceeded", message: `失败样本数 ${aggregate.failedSamples} 超过阈值 ${thresholds.maxFailureCount}`, target: scenario.id });
  }
  if (thresholds?.maxAverageDurationMs !== undefined && aggregate.durationMs.mean > thresholds.maxAverageDurationMs) {
    diagnostics.push({ severity: "error", code: "duration_threshold_exceeded", message: `平均耗时 ${aggregate.durationMs.mean}ms 超过阈值 ${thresholds.maxAverageDurationMs}ms`, target: scenario.id });
  }
  if (thresholds?.maxAverageDiskGrowthBytes !== undefined && aggregate.diskGrowthBytes.mean > thresholds.maxAverageDiskGrowthBytes) {
    diagnostics.push({ severity: "error", code: "disk_growth_threshold_exceeded", message: `平均磁盘增长 ${aggregate.diskGrowthBytes.mean} 字节超过阈值 ${thresholds.maxAverageDiskGrowthBytes} 字节`, target: scenario.id });
  }
  if (baseline !== undefined) {
    appendRegressionDiagnostic(diagnostics, "duration", calculateRegression(aggregate.durationMs.mean, baseline.aggregate.durationMs.mean), thresholds?.maxDurationRegressionPercent);
    appendRegressionDiagnostic(diagnostics, "disk_growth", calculateRegression(aggregate.diskGrowthBytes.mean, baseline.aggregate.diskGrowthBytes.mean), thresholds?.maxDiskGrowthRegressionPercent);
  }
  return diagnostics;
}

/** 将稳定失败码转换为不包含子进程原始输出的诊断文本。 */
function describeProcessFailure(code: EvaluationProcessFailureCode): string {
  if (code === "process_timeout") {
    return "超过执行超时";
  }
  return code === "stdout_limit_exceeded" ? "stdout 超过字节上限" : "stderr 超过字节上限";
}

/** 仅在场景显式声明回归阈值时将基线变化作为门禁。 */
function appendRegressionDiagnostic(
  diagnostics: EvaluationDiagnostic[],
  metric: "duration" | "disk_growth",
  regression: number | null,
  threshold?: number
): void {
  if (threshold === undefined || regression === null || regression <= threshold) {
    return;
  }
  diagnostics.push({
    severity: "error",
    code: `${metric}_regression_exceeded`,
    message: `${metric === "duration" ? "平均耗时" : "平均磁盘增长"}相对基线上升 ${regression}%，超过阈值 ${threshold}%`
  });
}

/** 基线为零时无法计算百分比，明确返回 null。 */
function calculateRegression(current: number, baseline: number): number | null {
  return baseline === 0 ? null : roundMetric(((current - baseline) / baseline) * 100);
}

/** 指标统一保留三位小数，降低平台浮点噪音。 */
function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 公共 API 的资源边界必须是严格正整数，避免零值或无穷值关闭保护。 */
function requirePositiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 之间的整数`);
  }
  return value;
}

/** 把场景路径限制在临时项目根目录中。 */
function resolveSafeProjectPath(projectRoot: string, path: string): string {
  if (isAbsolute(path)) {
    throw new Error(`场景文件路径不能是绝对路径：${path}`);
  }
  const resolved = resolve(projectRoot, path);
  const relativePath = relative(projectRoot, resolved);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../")
    || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new Error(`场景文件路径必须位于临时项目内：${path}`);
  }
  return resolved;
}

/** 对外部场景做必要的运行时校验，拒绝任意命令与空验收。 */
function assertEvaluationScenario(value: unknown): asserts value is EvaluationScenario {
  if (typeof value !== "object" || value === null) {
    throw new Error("评测场景必须是 JSON 对象");
  }
  const scenario = value as Partial<EvaluationScenario>;
  if (scenario.schemaVersion !== 1 || typeof scenario.id !== "string" || scenario.id.trim() === ""
    || typeof scenario.name !== "string" || typeof scenario.description !== "string"
    || !Array.isArray(scenario.fixtureFiles) || !Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new Error("评测场景缺少 schemaVersion、id、name、description、fixtureFiles 或 steps");
  }
  for (const fixture of scenario.fixtureFiles) {
    if (typeof fixture?.path !== "string" || typeof fixture.content !== "string") {
      throw new Error("fixtureFiles 必须包含字符串 path 和 content");
    }
  }
  if (
    scenario.agent !== undefined
    && (typeof scenario.agent !== "object" || scenario.agent === null
      || typeof scenario.agent.prompt !== "string" || scenario.agent.prompt.trim() === "")
  ) {
    throw new Error("agent.prompt 必须是非空字符串");
  }
  for (const step of scenario.steps) {
    if (typeof step?.id !== "string" || typeof step.description !== "string"
      || !Array.isArray(step.args) || !step.args.every((arg) => typeof arg === "string")
      || !Array.isArray(step.assertions) || step.assertions.length === 0) {
      throw new Error("每个评测步骤必须包含 id、description、字符串 args 和非空 assertions");
    }
    validateEvaluationStepArgs(step.id, step.args);
  }
}

/** 评测只允许确定为本地、非交互的 code-helper 命令，避免新命令绕过隔离边界。 */
const EVALUATION_COMMAND_ALLOWLIST = new Set([
  "init", "update", "version", "npm-scripts", "check", "features", "plan", "record",
  "manual-test", "archive", "finish", "tasks", "documents", "requirement", "analyze",
  "task", "document", "validation", "git", "skills", "hooks", "help", "--help", "-h"
]);

/** 输入文件型参数必须解析到临时项目内；记录型 working-directory 不会触发外部读取。 */
const EVALUATION_PATH_OPTIONS = new Set(["--input", "--body-file"]);

/** 校验步骤命令与所有会读取文件的参数，拒绝绝对路径和目录逃逸。 */
function validateEvaluationStepArgs(stepId: string, args: string[]): void {
  const [command, subcommand] = args;
  if (command === undefined || !EVALUATION_COMMAND_ALLOWLIST.has(command)
    || (command === "version" && subcommand === "check")) {
    throw new Error(`评测步骤 ${stepId} 使用了未允许的交互、递归或联网命令`);
  }

  if (command === "plan") {
    const requirementPath = args[1];
    if (requirementPath === undefined || requirementPath.startsWith("--")) {
      throw new Error(`评测步骤 ${stepId} 的 plan 缺少项目内需求路径`);
    }
    assertSafeRelativeInputPath(stepId, requirementPath);
  }

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!EVALUATION_PATH_OPTIONS.has(option)) {
      continue;
    }
    const path = args[index + 1];
    if (path === undefined) {
      throw new Error(`评测步骤 ${stepId} 的 ${option} 缺少路径`);
    }
    assertSafeRelativeInputPath(stepId, path);
  }
}

/** 路径输入只能使用临时项目内的非空相对路径。 */
function assertSafeRelativeInputPath(stepId: string, path: string): void {
  if (path.trim() === "" || isAbsolute(path)) {
    throw new Error(`评测步骤 ${stepId} 的输入路径必须位于临时项目内：${path}`);
  }
  const normalized = relative(".", resolve(".", path));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("..\\")) {
    throw new Error(`评测步骤 ${stepId} 的输入路径必须位于临时项目内：${path}`);
  }
}
