import {
  VersionGovernanceError,
  type VersionGovernanceErrorCode
} from "./errors.js";
import type { NpmDistTags, NpmVersionMetadata } from "./registry.js";
import { isCanaryVersion, isStableVersion } from "./semver.js";

/** 按 dist-tag 分组的发布元数据快照，便于识别相同版本却返回不同制品的异常。 */
export interface ReleaseSnapshot {
  readonly distTags: NpmDistTags;
  readonly releases: {
    readonly latest: NpmVersionMetadata;
    readonly stable: NpmVersionMetadata;
    readonly canary: NpmVersionMetadata;
  };
}

/** 单条发布快照问题使用稳定 code，CI 不需要解析中文提示。 */
export interface ReleaseValidationIssue {
  readonly code: Extract<VersionGovernanceErrorCode, `RELEASE_${string}`>;
  readonly message: string;
}

export interface ReleaseValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ReleaseValidationIssue[];
}

/**
 * 校验 Stable/Canary 发布快照，不执行 dist-tag 写操作。
 * 所有问题一次返回，方便发布后检查同时展示标签、版本与 SRI 的完整偏差。
 */
export function validateReleaseSnapshot(snapshot: ReleaseSnapshot): ReleaseValidationResult {
  const issues: ReleaseValidationIssue[] = [];

  for (const tag of ["latest", "stable", "canary"] as const) {
    if (snapshot.distTags[tag] !== snapshot.releases[tag].version) {
      issues.push({
        code: "RELEASE_TAG_VERSION_MISMATCH",
        message: `${tag} 标签版本 ${snapshot.distTags[tag]} 与精确版本元数据 ${snapshot.releases[tag].version} 不一致`
      });
    }
  }

  if (snapshot.distTags.latest !== snapshot.distTags.stable) {
    issues.push({
      code: "RELEASE_STABLE_TAG_MISMATCH",
      message: "latest 与 stable 必须指向同一正式版本"
    });
  }

  if (!isStableVersion(snapshot.distTags.latest) || !isStableVersion(snapshot.distTags.stable)) {
    issues.push({
      code: "RELEASE_STABLE_PRERELEASE",
      message: "latest 与 stable 不得指向预发布版本"
    });
  }

  if (snapshot.releases.latest.integrity !== snapshot.releases.stable.integrity) {
    issues.push({
      code: "RELEASE_STABLE_INTEGRITY_MISMATCH",
      message: "latest 与 stable 必须具有相同 SRI"
    });
  }

  if (!isCanaryVersion(snapshot.distTags.canary)) {
    issues.push({
      code: "RELEASE_CANARY_IDENTIFIER_REQUIRED",
      message: "canary 必须包含完整小写 canary 预发布标识"
    });
  }

  if (snapshot.distTags.canary === snapshot.distTags.stable) {
    issues.push({
      code: "RELEASE_CANARY_VERSION_COLLISION",
      message: "canary 与正式通道不得指向同一版本"
    });
  }

  if (
    snapshot.releases.canary.integrity === snapshot.releases.latest.integrity
    || snapshot.releases.canary.integrity === snapshot.releases.stable.integrity
  ) {
    issues.push({
      code: "RELEASE_CANARY_INTEGRITY_COLLISION",
      message: "canary 与正式通道必须使用独立制品 SRI"
    });
  }

  return { valid: issues.length === 0, issues };
}

/**
 * 断言发布快照有效；失败时以第一条稳定 finding code 抛错，并附带全部问题供 CLI 展示。
 */
export function assertValidReleaseSnapshot(snapshot: ReleaseSnapshot): void {
  const result = validateReleaseSnapshot(snapshot);

  if (!result.valid) {
    const firstIssue = result.issues[0];
    throw new VersionGovernanceError(firstIssue.code, firstIssue.message, {
      issues: result.issues
    });
  }
}
