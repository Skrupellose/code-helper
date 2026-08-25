import { VersionGovernanceError } from "./errors.js";

/**
 * 严格 SemVer 2.0.0 解析结果。build 不参与优先级比较，但会保留以支持无损序列化。
 */
export interface SemanticVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * 按 SemVer 2.0.0 严格解析版本号。
 * 不接受 v 前缀、缺失 patch、前后空白、数字前导零或空标识符。
 */
export function parseSemVer(value: string): SemanticVersion {
  const match = SEMVER_PATTERN.exec(value);

  if (match === null) {
    throw new VersionGovernanceError("INVALID_SEMVER", `无效的 SemVer 版本：${value}`, { value });
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  // JavaScript number 无法精确表示超过安全整数的版本段，因此必须拒绝，避免比较结果失真。
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new VersionGovernanceError("INVALID_SEMVER", `SemVer 数字段超出安全整数范围：${value}`, { value });
  }

  return {
    raw: value,
    major,
    minor,
    patch,
    prerelease: match[4] === undefined ? [] : match[4].split("."),
    build: match[5] === undefined ? [] : match[5].split(".")
  };
}

/**
 * 按 SemVer 优先级规则比较两个严格版本；build metadata 不影响比较结果。
 */
export function compareSemVer(left: string | SemanticVersion, right: string | SemanticVersion): number {
  const leftVersion = typeof left === "string" ? parseSemVer(left) : left;
  const rightVersion = typeof right === "string" ? parseSemVer(right) : right;

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] < rightVersion[key] ? -1 : 1;
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

/**
 * 判断版本是否为精确的正式版本 `x.y.z`。
 * 发布通道不接受 build metadata，避免本地规则与 npm 标签校验采用不同版本集合。
 */
export function isStableVersion(version: string | SemanticVersion): boolean {
  const parsed = typeof version === "string" ? parseSemVer(version) : version;
  return parsed.prerelease.length === 0 && parsed.build.length === 0;
}

/**
 * 判断版本是否使用完整、区分大小写的小写 canary 首标识。
 * 只接受 `-canary.N`，其中 N 是无前导零的非负整数；拒绝裸 canary、大小写变体和其它预发布通道。
 */
export function isCanaryVersion(version: string | SemanticVersion): boolean {
  const parsed = typeof version === "string" ? parseSemVer(version) : version;
  return parsed.build.length === 0
    && parsed.prerelease.length === 2
    && parsed.prerelease[0] === "canary"
    && /^(?:0|[1-9]\d*)$/u.test(parsed.prerelease[1] ?? "");
}

/**
 * 比较预发布标识符，严格遵循数字标识低于非数字标识、正式版高于预发布版的规则。
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) {
      return 0;
    }

    return left.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];

    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }

    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);

    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftIdentifier);
      const rightNumber = BigInt(rightIdentifier);
      return leftNumber < rightNumber ? -1 : 1;
    }

    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}
