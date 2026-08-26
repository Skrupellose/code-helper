/** 单个场景夹具文件；路径必须相对于临时项目根目录。 */
export interface EvaluationFixtureFile {
  path: string;
  content: string;
}

/** 场景步骤支持的验收断言。 */
export type EvaluationAssertion =
  | { type: "exitCode"; equals: number }
  | { type: "stdoutIncludes"; value: string }
  | { type: "stderrIncludes"; value: string }
  | { type: "jsonPathEquals"; path: string; equals: unknown }
  | { type: "fileExists"; path: string }
  | { type: "fileContains"; path: string; value: string };

/** 一次真实 CLI 往返及其验收条件。 */
export interface EvaluationStep {
  id: string;
  description: string;
  args: string[];
  assertions: EvaluationAssertion[];
}

/** 可选性能阈值；没有配置的指标只报告，不做门禁。 */
export interface EvaluationThresholds {
  maxFailureCount?: number;
  maxAverageDurationMs?: number;
  maxAverageDiskGrowthBytes?: number;
  maxDurationRegressionPercent?: number;
  maxDiskGrowthRegressionPercent?: number;
}

/** 可重复执行的工作流场景描述。 */
export interface EvaluationScenario {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  fixtureFiles: EvaluationFixtureFile[];
  /** 可选真实 Agent 提示；配置后必须由调用方显式提供 runner。 */
  agent?: {
    prompt: string;
  };
  steps: EvaluationStep[];
  thresholds?: EvaluationThresholds;
}

/** 单条断言的执行结果。 */
export interface EvaluationAssertionResult {
  type: EvaluationAssertion["type"];
  passed: boolean;
  message: string;
}

/** 单个 CLI 步骤的受控结果；不保留潜在敏感 stdout/stderr 原文。 */
export interface EvaluationStepResult {
  id: string;
  exitCode: number;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  assertions: EvaluationAssertionResult[];
  passed: boolean;
}

/** Token 只能来自外部观测，不能根据输出字节数推算。 */
export type EvaluationTokenMetric =
  | { status: "observed"; value: number; source: "external" | "agent_runner" }
  | { status: "unknown"; source: "unavailable_in_local_cli" };

/** 一次可插拔真实 Agent runner 的观测结果；不保留输出正文。 */
export interface EvaluationAgentResult {
  exitCode: number;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  turns?: number;
  tokens: EvaluationTokenMetric;
  passed: boolean;
}

/** 一次隔离样本的完整指标。 */
export interface EvaluationSampleResult {
  sample: number;
  passed: boolean;
  durationMs: number;
  processRoundTrips: number;
  stdoutBytes: number;
  stderrBytes: number;
  initialFileCount: number;
  finalFileCount: number;
  fileCountGrowth: number;
  initialDiskBytes: number;
  finalDiskBytes: number;
  diskGrowthBytes: number;
  tokens: EvaluationTokenMetric;
  agent?: EvaluationAgentResult;
  steps: EvaluationStepResult[];
}

/** 聚合数值统计。 */
export interface EvaluationMetricSummary {
  min: number;
  max: number;
  mean: number;
  p50: number;
}

/** 多样本的聚合统计。 */
export interface EvaluationAggregate {
  sampleCount: number;
  passedSamples: number;
  failedSamples: number;
  durationMs: EvaluationMetricSummary;
  processRoundTrips: EvaluationMetricSummary;
  stdoutBytes: EvaluationMetricSummary;
  stderrBytes: EvaluationMetricSummary;
  fileCountGrowth: EvaluationMetricSummary;
  diskGrowthBytes: EvaluationMetricSummary;
  tokens: {
    status: "observed" | "partial" | "unknown";
    observedSamples: number;
    value?: EvaluationMetricSummary;
  };
}

/** 阈值或基线比较产生的稳定诊断。 */
export interface EvaluationDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  target?: string;
  fix?: string;
}

/** 可持久化并作为下次基线输入的统一评测报告。 */
export interface EvaluationReport {
  schemaVersion: 1;
  scenario: Pick<EvaluationScenario, "id" | "name" | "description">;
  generatedAt: string;
  environment: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  samples: EvaluationSampleResult[];
  aggregate: EvaluationAggregate;
  baseline?: {
    scenarioId: string;
    durationRegressionPercent: number | null;
    diskGrowthRegressionPercent: number | null;
  };
  diagnostics: EvaluationDiagnostic[];
  passed: boolean;
}

/** 评测执行参数。 */
export interface RunEvaluationOptions {
  sampleCount?: number;
  tokenObservations?: Array<number | undefined>;
  baseline?: EvaluationReport;
  executablePath?: string;
  /** 显式 opt-in 的真实 Agent 适配器；runner 从 stdin 接收 prompt，并向 stdout 返回 JSON。 */
  agentRunner?: {
    executablePath: string;
    args?: string[];
  };
  keepTemporaryProjects?: boolean;
}
