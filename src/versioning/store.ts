import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import {
  createVersionPolicy,
  parseVersionPolicyJson,
  serializeVersionPolicy,
  type VersionChannel,
  type VersionPolicy
} from "./policy.js";

/** 项目级通道偏好固定放在 code-helper 工作区，便于审阅且不混入运行缓存。 */
export const VERSION_POLICY_RELATIVE_PATH = ".code-helper/version-policy.json";

export interface StoredVersionPolicy {
  policy: VersionPolicy;
  explicit: boolean;
  relativePath: string;
}

/**
 * 读取项目通道偏好；文件不存在时返回隐式 Stable，但不创建文件。
 * 损坏策略必须抛错，不能静默退回正式通道掩盖用户原本选择。
 */
export async function readStoredVersionPolicy(projectRoot: string): Promise<StoredVersionPolicy> {
  const raw = await readTextIfExists(projectPath(projectRoot, VERSION_POLICY_RELATIVE_PATH));

  if (raw === undefined) {
    return {
      policy: createVersionPolicy("stable"),
      explicit: false,
      relativePath: VERSION_POLICY_RELATIVE_PATH
    };
  }

  return {
    policy: parseVersionPolicyJson(raw),
    explicit: true,
    relativePath: VERSION_POLICY_RELATIVE_PATH
  };
}

/** 显式保存 Stable 或 Canary 通道；该操作不联网、不安装版本，也不移动 npm 标签。 */
export async function writeStoredVersionPolicy(
  projectRoot: string,
  channel: VersionChannel
): Promise<StoredVersionPolicy> {
  const policy = createVersionPolicy(channel);
  await writeText(
    projectPath(projectRoot, VERSION_POLICY_RELATIVE_PATH),
    serializeVersionPolicy(policy)
  );

  return {
    policy,
    explicit: true,
    relativePath: VERSION_POLICY_RELATIVE_PATH
  };
}
