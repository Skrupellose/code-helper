import { VersionGovernanceError } from "./errors.js";
import type { VersionChannel, VersionPolicy } from "./policy.js";
import { compareSemVer, isCanaryVersion, isStableVersion, parseSemVer } from "./semver.js";

/** 本地版本状态不包含远端字段，保证 status 路径不会意外触发网络访问。 */
export interface LocalVersionStatus {
  readonly currentVersion: string;
  readonly currentChannel: VersionChannel;
  readonly selectedChannel: VersionChannel;
  readonly selectedDistTag: VersionChannel;
  readonly policyMatchesCurrentVersion: boolean;
}

/** 通道候选相对当前版本的纯逻辑判断。 */
export interface ChannelCandidateEvaluation {
  readonly channel: VersionChannel;
  readonly currentVersion: string;
  readonly candidateVersion: string;
  readonly status: "current" | "update-available" | "downgrade-blocked";
}

/**
 * 计算本地版本与所选策略的状态，不读取文件、不访问 registry，也不修改项目。
 */
export function createLocalVersionStatus(currentVersion: string, policy: VersionPolicy): LocalVersionStatus {
  const parsed = parseSemVer(currentVersion);
  const currentChannel = isStableVersion(parsed)
    ? "stable"
    : isCanaryVersion(parsed)
      ? "canary"
      : undefined;

  if (currentChannel === undefined) {
    throw new VersionGovernanceError(
      "INVALID_CHANNEL_VERSION",
      `当前版本既不是正式版也不是 Canary：${currentVersion}`,
      { currentVersion }
    );
  }

  return {
    currentVersion,
    currentChannel,
    selectedChannel: policy.channel,
    selectedDistTag: policy.channel,
    policyMatchesCurrentVersion: currentChannel === policy.channel
  };
}

/**
 * 判断远端通道候选是否可用；候选低于当前版本时显式返回 downgrade-blocked。
 */
export function evaluateChannelCandidate(
  currentVersion: string,
  candidateVersion: string,
  channel: VersionChannel
): ChannelCandidateEvaluation {
  assertVersionMatchesChannel(candidateVersion, channel);
  const comparison = compareSemVer(candidateVersion, currentVersion);

  return {
    channel,
    currentVersion,
    candidateVersion,
    status: comparison > 0 ? "update-available" : comparison === 0 ? "current" : "downgrade-blocked"
  };
}

/**
 * 选择可安装候选；禁止降级是硬门禁，不能由通道切换隐式绕过。
 */
export function selectChannelCandidate(
  currentVersion: string,
  candidateVersion: string,
  channel: VersionChannel
): string {
  const evaluation = evaluateChannelCandidate(currentVersion, candidateVersion, channel);

  if (evaluation.status === "downgrade-blocked") {
    throw new VersionGovernanceError(
      "CHANNEL_DOWNGRADE_BLOCKED",
      `拒绝从 ${currentVersion} 降级到 ${candidateVersion}`,
      { ...evaluation }
    );
  }

  return evaluation.candidateVersion;
}

/**
 * 强制候选版本符合通道语义，防止 stable/canary 标签被错误版本污染。
 */
export function assertVersionMatchesChannel(version: string, channel: VersionChannel): void {
  const matches = channel === "stable" ? isStableVersion(version) : isCanaryVersion(version);

  if (!matches) {
    throw new VersionGovernanceError(
      "INVALID_CHANNEL_VERSION",
      `${version} 不符合 ${channel} 通道规则`,
      { version, channel }
    );
  }
}
