/**
 * 版本治理模块对外暴露的稳定错误代码。
 * 调用方应依赖 code 而不是中文 message，以便后续调整提示文案而不破坏脚本集成。
 */
export type VersionGovernanceErrorCode =
  | "INVALID_SEMVER"
  | "INVALID_CHANNEL_VERSION"
  | "INVALID_POLICY_JSON"
  | "INVALID_POLICY_SHAPE"
  | "INVALID_PACKAGE_NAME"
  | "INVALID_REGISTRY_METADATA"
  | "CHANNEL_DOWNGRADE_BLOCKED"
  | "RELEASE_TAG_VERSION_MISMATCH"
  | "RELEASE_STABLE_TAG_MISMATCH"
  | "RELEASE_STABLE_INTEGRITY_MISMATCH"
  | "RELEASE_STABLE_PRERELEASE"
  | "RELEASE_CANARY_IDENTIFIER_REQUIRED"
  | "RELEASE_CANARY_VERSION_COLLISION"
  | "RELEASE_CANARY_INTEGRITY_COLLISION";

/**
 * 错误所属的稳定分类，用于 CLI 决定退出码、提示分组和是否允许重试。
 */
export type VersionGovernanceErrorCategory =
  | "input"
  | "policy"
  | "registry"
  | "release"
  | "downgrade";

const ERROR_CATEGORIES: Readonly<Record<VersionGovernanceErrorCode, VersionGovernanceErrorCategory>> = {
  INVALID_SEMVER: "input",
  INVALID_CHANNEL_VERSION: "input",
  INVALID_POLICY_JSON: "policy",
  INVALID_POLICY_SHAPE: "policy",
  INVALID_PACKAGE_NAME: "input",
  INVALID_REGISTRY_METADATA: "registry",
  CHANNEL_DOWNGRADE_BLOCKED: "downgrade",
  RELEASE_TAG_VERSION_MISMATCH: "release",
  RELEASE_STABLE_TAG_MISMATCH: "release",
  RELEASE_STABLE_INTEGRITY_MISMATCH: "release",
  RELEASE_STABLE_PRERELEASE: "release",
  RELEASE_CANARY_IDENTIFIER_REQUIRED: "release",
  RELEASE_CANARY_VERSION_COLLISION: "release",
  RELEASE_CANARY_INTEGRITY_COLLISION: "release"
};

/**
 * 可跨 CLI 与测试稳定识别的版本治理错误。
 * details 只承载结构化诊断信息，不应包含令牌、认证头或 registry 响应全文。
 */
export class VersionGovernanceError extends Error {
  readonly code: VersionGovernanceErrorCode;
  readonly category: VersionGovernanceErrorCategory;
  readonly retryable = false;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: VersionGovernanceErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "VersionGovernanceError";
    this.code = code;
    this.category = ERROR_CATEGORIES[code];
    this.details = details;
  }
}

/**
 * 将未知异常归一化为稳定分类；未知异常保留 unknown，避免被误判成可安全忽略的输入错误。
 */
export function classifyVersionGovernanceError(error: unknown): {
  code: VersionGovernanceErrorCode | "UNKNOWN_VERSION_GOVERNANCE_ERROR";
  category: VersionGovernanceErrorCategory | "unknown";
  retryable: boolean;
} {
  if (error instanceof VersionGovernanceError) {
    return {
      code: error.code,
      category: error.category,
      retryable: error.retryable
    };
  }

  return {
    code: "UNKNOWN_VERSION_GOVERNANCE_ERROR",
    category: "unknown",
    retryable: false
  };
}
