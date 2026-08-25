import { CODE_HELPER_PACKAGE_NAME } from "../version-check.js";
import { VersionGovernanceError } from "./errors.js";
import { describeDistTagsQuery, describeExactVersionQuery } from "./queries.js";
import { parseNpmDistTags, parseNpmVersionMetadata } from "./registry.js";
import {
  assertValidReleaseSnapshot,
  type ReleaseSnapshot
} from "./release.js";

const DEFAULT_REGISTRY_BASE_URL = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 5_000;

/** 远端发布状态包含已通过完整快照校验的三个受管通道。 */
export interface PublishedReleaseStatus {
  packageName: string;
  snapshot: ReleaseSnapshot;
}

export interface FetchPublishedReleaseOptions {
  packageName?: string;
  registryBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 只读查询 Stable/Latest/Canary 并校验精确版本与 SRI。
 *
 * 先读取 dist-tag，再查询对应精确版本；最终快照校验会检测查询期间标签与精确版本不一致。
 * 本函数不执行安装、发布或 dist-tag 写操作。
 */
export async function fetchPublishedReleaseStatus(
  options: FetchPublishedReleaseOptions = {}
): Promise<PublishedReleaseStatus> {
  const packageName = options.packageName ?? CODE_HELPER_PACKAGE_NAME;
  const registryBaseUrl = options.registryBaseUrl ?? DEFAULT_REGISTRY_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("版本通道查询 timeoutMs 必须是正整数");
  }

  const tagsQuery = describeDistTagsQuery(packageName, registryBaseUrl);
  const tags = parseNpmDistTags(await fetchRegistryJson(tagsQuery.registryUrl, timeoutMs, fetchImpl));
  const [latest, stable, canary] = await Promise.all([
    fetchExactRelease(packageName, tags.latest, registryBaseUrl, timeoutMs, fetchImpl),
    fetchExactRelease(packageName, tags.stable, registryBaseUrl, timeoutMs, fetchImpl),
    fetchExactRelease(packageName, tags.canary, registryBaseUrl, timeoutMs, fetchImpl)
  ]);
  const snapshot: ReleaseSnapshot = {
    distTags: tags,
    releases: { latest, stable, canary }
  };

  assertValidReleaseSnapshot(snapshot);
  return { packageName, snapshot };
}

/** 查询并严格解析一个精确版本的 npm 元数据。 */
async function fetchExactRelease(
  packageName: string,
  version: string,
  registryBaseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
) {
  const query = describeExactVersionQuery(packageName, version, registryBaseUrl);
  return parseNpmVersionMetadata(await fetchRegistryJson(query.registryUrl, timeoutMs, fetchImpl));
}

/** 为每次请求建立独立超时，外部响应正文只进入严格解析器，不拼入错误提示。 */
async function fetchRegistryJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });

    if (!response.ok) {
      throw new VersionGovernanceError(
        "INVALID_REGISTRY_METADATA",
        `npm registry 查询失败，HTTP ${response.status}`
      );
    }

    return await response.json() as unknown;
  } catch (error) {
    if (error instanceof VersionGovernanceError) {
      throw error;
    }

    throw new VersionGovernanceError(
      "INVALID_REGISTRY_METADATA",
      "无法读取 npm 版本通道元数据"
    );
  } finally {
    clearTimeout(timeout);
  }
}
