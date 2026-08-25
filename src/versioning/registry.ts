import { VersionGovernanceError } from "./errors.js";
import { parseSemVer } from "./semver.js";

/** npm 三个受管 dist-tag 的严格快照。 */
export interface NpmDistTags {
  readonly latest: string;
  readonly stable: string;
  readonly canary: string;
}

/** npm 精确版本元数据；首版只保留发布校验所需字段。 */
export interface NpmVersionMetadata {
  readonly version: string;
  readonly integrity: string;
}

const SHA512_SRI_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/**
 * 解析 `npm view <package> dist-tags --json` 的结果。
 * 三个受管标签缺一即失败；额外标签允许存在，因为它们不属于本模块治理范围。
 */
export function parseNpmDistTags(input: unknown): NpmDistTags {
  const record = requireRecord(input, "npm dist-tag 元数据必须是对象");
  const latest = requireVersion(record.latest, "latest");
  const stable = requireVersion(record.stable, "stable");
  const canary = requireVersion(record.canary, "canary");

  return { latest, stable, canary };
}

/**
 * 解析精确版本元数据，兼容 npm 的 `{ version, dist: { integrity } }` 结构。
 * SRI 固定接受单一 SHA-512，并复验 Base64 必须精确解码为 64 字节。
 * 发布通道需要比较精确制品身份，不能把短字符串或其它算法伪装成完整性值。
 */
export function parseNpmVersionMetadata(input: unknown): NpmVersionMetadata {
  const record = requireRecord(input, "npm 版本元数据必须是对象");
  const version = requireVersion(record.version, "version");
  const dist = requireRecord(record.dist, "npm 版本元数据缺少 dist 对象");

  if (typeof dist.integrity !== "string" || !isExactSha512Integrity(dist.integrity)) {
    throw new VersionGovernanceError("INVALID_REGISTRY_METADATA", "npm 版本元数据包含无效的 dist.integrity", {
      version
    });
  }

  return { version, integrity: dist.integrity };
}

/** 校验规范 SHA-512 SRI，并拒绝非规范 Base64、错误填充和非 64 字节摘要。 */
function isExactSha512Integrity(value: string): boolean {
  if (!SHA512_SRI_PATTERN.test(value)) {
    return false;
  }

  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64 && decoded.toString("base64") === encoded;
}

function requireVersion(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new VersionGovernanceError("INVALID_REGISTRY_METADATA", `npm 元数据缺少字符串字段 ${field}`);
  }

  try {
    parseSemVer(value);
  } catch (error) {
    throw new VersionGovernanceError("INVALID_REGISTRY_METADATA", `npm 元数据字段 ${field} 不是严格 SemVer`, {
      field,
      value,
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VersionGovernanceError("INVALID_REGISTRY_METADATA", message);
  }

  return value as Record<string, unknown>;
}
