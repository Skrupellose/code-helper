/**
 * code-helper 支持的功能开关名称。
 * 这些 key 会直接写入 `.agent/code-helper/config.json`，因此需要保持稳定。
 */
export type FeatureKey =
  | "memoryTuning"
  | "planWorkbench"
  | "resultSummary"
  | "testingPolicy"
  | "checks"
  | "gitHooks";

/**
 * 单个功能开关的配置。
 * 使用对象而不是布尔值，是为了后续能无破坏扩展更多元数据。
 */
export interface FeatureToggle {
  enabled: boolean;
}

/**
 * code-helper 的项目级配置文件结构。
 * 该配置只描述 code-helper 自己的行为，不承载业务项目配置。
 */
export interface CodeHelperConfig {
  version: number;
  entryFiles: {
    agents: boolean;
    claude: boolean;
  };
  directories: {
    workspace: string;
    userRules: string;
    planDoc: string;
    resultDoc: string;
    statusDoc: string;
  };
  features: Record<FeatureKey, FeatureToggle>;
}

/**
 * 一次文件写入或跳过操作的结构化结果。
 * CLI 用它统一输出初始化摘要，测试也用它验证非覆盖行为。
 */
export interface OperationResult {
  path: string;
  action: "created" | "updated" | "skipped";
  message: string;
}

/**
 * 项目规则检查的严重程度。
 * error 会让 `code-helper check` 返回非 0，warning 只提示修复建议。
 */
export type CheckLevel = "error" | "warning";

/**
 * 单条检查结果。
 * 每条结果都带有可读建议，避免用户只看到失败而不知道下一步。
 */
export interface CheckIssue {
  level: CheckLevel;
  code: string;
  message: string;
  path?: string;
  suggestion: string;
}
