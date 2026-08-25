import { VersionGovernanceError } from "./errors.js";
import type { VersionChannel } from "./policy.js";
import { parseSemVer } from "./semver.js";

export type RegistryQueryDescription =
  | {
      readonly kind: "dist-tags";
      readonly packageName: string;
      readonly registryUrl: string;
      readonly npmArguments: readonly string[];
    }
  | {
      readonly kind: "exact-version";
      readonly packageName: string;
      readonly version: string;
      readonly registryUrl: string;
      readonly npmArguments: readonly string[];
    };

/**
 * 生成 dist-tag 查询描述，只返回 URL 和参数数组，不执行网络请求或 shell 命令。
 */
export function describeDistTagsQuery(
  packageName: string,
  registryBaseUrl = "https://registry.npmjs.org"
): RegistryQueryDescription {
  assertPackageName(packageName);
  const baseUrl = normalizeRegistryBaseUrl(registryBaseUrl);

  return {
    kind: "dist-tags",
    packageName,
    registryUrl: `${baseUrl}/-/package/${encodeURIComponent(packageName)}/dist-tags`,
    npmArguments: ["view", packageName, "dist-tags", "--json"]
  };
}

/**
 * 生成精确版本查询描述；版本先通过严格 SemVer 校验，避免 tag 或范围表达式混入精确查询。
 */
export function describeExactVersionQuery(
  packageName: string,
  version: string,
  registryBaseUrl = "https://registry.npmjs.org"
): RegistryQueryDescription {
  assertPackageName(packageName);
  parseSemVer(version);
  const baseUrl = normalizeRegistryBaseUrl(registryBaseUrl);

  return {
    kind: "exact-version",
    packageName,
    version,
    registryUrl: `${baseUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    npmArguments: ["view", `${packageName}@${version}`, "version", "dist.integrity", "--json"]
  };
}

/**
 * 返回通道对应的 dist-tag 查询选择器；该描述不会安装版本，也不会移动远端标签。
 */
export function describeChannelSelector(packageName: string, channel: VersionChannel): {
  readonly packageName: string;
  readonly channel: VersionChannel;
  readonly packageSpecifier: string;
  readonly npmArguments: readonly string[];
} {
  assertPackageName(packageName);

  return {
    packageName,
    channel,
    packageSpecifier: `${packageName}@${channel}`,
    npmArguments: ["view", `${packageName}@${channel}`, "version", "dist.integrity", "--json"]
  };
}

/** npm 包名采用保守白名单，防止查询描述被误用于拼接 shell 时引入控制字符。 */
function assertPackageName(packageName: string): void {
  const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;

  if (!packagePattern.test(packageName)) {
    throw new VersionGovernanceError("INVALID_PACKAGE_NAME", `无效的 npm 包名：${packageName}`, { packageName });
  }
}

/** registry 基础地址必须使用 http(s)，且去除尾部斜杠以稳定生成 URL。 */
function normalizeRegistryBaseUrl(registryBaseUrl: string): string {
  let url: URL;

  try {
    url = new URL(registryBaseUrl);
  } catch {
    throw new VersionGovernanceError("INVALID_REGISTRY_METADATA", `无效的 registry 地址：${registryBaseUrl}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new VersionGovernanceError("INVALID_REGISTRY_METADATA", "registry 地址只支持 http 或 https");
  }

  return url.toString().replace(/\/$/, "");
}
