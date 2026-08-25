import { VersionGovernanceError } from "./errors.js";

/** 用户可选择的版本通道。 */
export type VersionChannel = "stable" | "canary";

/** 首版项目级版本策略；schemaVersion 为后续兼容迁移预留。 */
export interface VersionPolicy {
  readonly schemaVersion: 1;
  readonly channel: VersionChannel;
}

const POLICY_KEYS = new Set(["schemaVersion", "channel"]);

/**
 * 严格解析版本策略 JSON。
 * 未知字段会被拒绝，防止拼写错误被静默忽略后意外退回 stable。
 */
export function parseVersionPolicyJson(raw: string): VersionPolicy {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new VersionGovernanceError("INVALID_POLICY_JSON", "版本策略不是合法 JSON", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  if (!isPlainRecord(value)) {
    throw new VersionGovernanceError("INVALID_POLICY_SHAPE", "版本策略必须是 JSON 对象");
  }

  const keys = Object.keys(value);
  if (keys.length !== POLICY_KEYS.size || keys.some((key) => !POLICY_KEYS.has(key))) {
    throw new VersionGovernanceError("INVALID_POLICY_SHAPE", "版本策略字段必须且只能包含 schemaVersion 和 channel", {
      keys
    });
  }

  if (value.schemaVersion !== 1 || (value.channel !== "stable" && value.channel !== "canary")) {
    throw new VersionGovernanceError("INVALID_POLICY_SHAPE", "版本策略仅支持 schemaVersion=1 和 stable/canary 通道");
  }

  return {
    schemaVersion: 1,
    channel: value.channel
  };
}

/**
 * 以确定性格式序列化版本策略，便于 Git 审阅和内容摘要保持稳定。
 */
export function serializeVersionPolicy(policy: VersionPolicy): string {
  // 复用严格解析器验证调用方构造的运行时对象，避免 TypeScript 类型在 JS 调用边界失效。
  const validated = parseVersionPolicyJson(JSON.stringify(policy));
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** 创建默认 Stable 策略，调用方可显式传入 Canary。 */
export function createVersionPolicy(channel: VersionChannel = "stable"): VersionPolicy {
  if (channel !== "stable" && channel !== "canary") {
    throw new VersionGovernanceError("INVALID_POLICY_SHAPE", `不支持的版本通道：${String(channel)}`);
  }

  return { schemaVersion: 1, channel };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
