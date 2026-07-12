import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { projectPath, readTextIfExists, writeText } from "./fs-utils.js";

const PACKAGE_NAME = "@skrupellose/code-helper";
const VERSION_CACHE_RELATIVE_PATH = ".code-helper/checks/version-cache.json";
const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 1500;

interface VersionCache {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string;
  packageName: string;
  registryUrl: string;
  status: "latest" | "outdated" | "unknown";
}

interface RegistryLatestResponse {
  version?: unknown;
}

/**
 * 版本检查结果。
 * 该对象只暴露给交互菜单使用，避免普通命令为了展示升级提示而污染 stdout/stderr。
 */
export interface VersionUpdateState {
  currentVersion: string;
  latestVersion: string;
  outdated: boolean;
}

/**
 * npm 包名在版本提醒、version 命令和安装提示中必须保持一致。
 * 集中定义可以避免 CLI 文案和 registry 查询地址出现分叉。
 */
export const CODE_HELPER_PACKAGE_NAME = PACKAGE_NAME;

/**
 * 交互式启动时提示 npm 上的新版本。
 * 版本检查是提示型能力，网络失败、缓存异常或 registry 异常都不能影响原命令执行。
 */
export async function maybeNotifyVersionUpdate(
  projectRoot: string,
  command: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<VersionUpdateState | undefined> {
  if (shouldSkipVersionCheck(command, env)) {
    return undefined;
  }

  try {
    const currentVersion = await getCurrentPackageVersion();
    const cache = await readVersionCache(projectRoot);

    if (cache !== undefined && canReuseVersionCache(cache, currentVersion)) {
      const cachedState = createVersionUpdateState(currentVersion, cache.latestVersion);
      printOutdatedMessageIfNeeded(cachedState);
      return cachedState.outdated ? cachedState : undefined;
    }

    const latestVersion = await fetchLatestPackageVersion();
    const state = createVersionUpdateState(currentVersion, latestVersion);
    const status = state.outdated ? "outdated" : "latest";

    await writeVersionCache(projectRoot, {
      checkedAt: new Date().toISOString(),
      currentVersion,
      latestVersion,
      packageName: PACKAGE_NAME,
      registryUrl: getRegistryUrl(),
      status
    });

    printOutdatedMessageIfNeeded(state);
    return state.outdated ? state : undefined;
  } catch {
    // 版本检查不能影响用户原命令，离线、代理或 registry 异常时静默跳过。
    return undefined;
  }
}

/**
 * 判断当前命令是否应该跳过版本检查。
 * 只在交互菜单路径提醒，避免污染脚本、CI 和 hook 输出。
 */
export function shouldSkipVersionCheck(command: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODE_HELPER_SKIP_VERSION_CHECK === "1") {
    return true;
  }

  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    return true;
  }

  if (env.npm_lifecycle_event === "test" || env.npm_lifecycle_event === "check" || env.npm_lifecycle_event === "prepack") {
    return true;
  }

  if (!process.stdout.isTTY || !process.stderr.isTTY) {
    return true;
  }

  if (isLocalDevelopmentRepository()) {
    return true;
  }

  return command !== undefined && command !== "menu";
}

/**
 * 比较两个 npm 版本号。
 * 只需要处理当前项目使用的数字版本；预发布后缀按数字部分之后的字符串轻量比较。
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/**
 * 从当前安装包的 package.json 读取版本号。
 */
export async function getCurrentPackageVersion(): Promise<string> {
  const distDirectory = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(distDirectory, "..", "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json 缺少 version 字段");
  }

  return packageJson.version;
}

/**
 * 请求 npm registry 的 latest 版本。
 */
export async function fetchLatestPackageVersion(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(getRegistryUrl(), {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`npm registry 返回 ${response.status}`);
    }

    const body = await response.json() as RegistryLatestResponse;

    if (typeof body.version !== "string") {
      throw new Error("npm registry 响应缺少 version 字段");
    }

    return body.version;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 读取本地版本检查缓存。
 */
async function readVersionCache(projectRoot: string): Promise<VersionCache | undefined> {
  const raw = await readTextIfExists(projectPath(projectRoot, VERSION_CACHE_RELATIVE_PATH));

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = JSON.parse(raw) as Partial<VersionCache>;

  if (
    typeof parsed.checkedAt !== "string" ||
    typeof parsed.currentVersion !== "string" ||
    typeof parsed.latestVersion !== "string" ||
    typeof parsed.packageName !== "string" ||
    typeof parsed.registryUrl !== "string"
  ) {
    return undefined;
  }

  return {
    checkedAt: parsed.checkedAt,
    currentVersion: parsed.currentVersion,
    latestVersion: parsed.latestVersion,
    packageName: parsed.packageName,
    registryUrl: parsed.registryUrl,
    status: parsed.status === "latest" || parsed.status === "outdated" ? parsed.status : "unknown"
  };
}

/**
 * 写入版本检查缓存，减少交互菜单频繁访问网络。
 */
async function writeVersionCache(projectRoot: string, cache: VersionCache): Promise<void> {
  await writeText(projectPath(projectRoot, VERSION_CACHE_RELATIVE_PATH), `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * 只有缓存未过期且记录的当前版本仍一致时才能复用。
 * 包升级后即使 TTL 未过期，也必须重新查询 registry 并写入新版本，避免菜单继续展示旧 currentVersion。
 */
function canReuseVersionCache(cache: VersionCache, currentVersion: string): boolean {
  return cache.currentVersion === currentVersion && isCacheFresh(cache);
}

/**
 * 判断缓存是否仍在有效期内。
 */
function isCacheFresh(cache: VersionCache): boolean {
  const checkedAt = Date.parse(cache.checkedAt);

  if (Number.isNaN(checkedAt)) {
    return false;
  }

  return Date.now() - checkedAt < VERSION_CHECK_TTL_MS;
}

/**
 * 输出升级提醒。
 * 使用 stderr 是为了不污染 stdout，避免破坏脚本或 hook 协议。
 */
function printOutdatedMessageIfNeeded(state: VersionUpdateState): void {
  const messageLines = formatOutdatedVersionMessage(state.currentVersion, state.latestVersion);

  for (const line of messageLines) {
    console.error(line);
  }
}

/**
 * 生成版本检查状态。
 * 比较逻辑集中在这里，缓存命中和 registry 查询都能得到一致的菜单状态。
 */
function createVersionUpdateState(currentVersion: string, latestVersion: string): VersionUpdateState {
  return {
    currentVersion,
    latestVersion,
    outdated: compareVersions(currentVersion, latestVersion) < 0
  };
}

/**
 * 生成版本落后时的升级提示文案。
 * 调用方负责决定输出到 stderr 还是 stdout；交互提醒必须写 stderr，避免污染脚本和 hook 协议。
 */
export function formatOutdatedVersionMessage(currentVersion: string, latestVersion: string): string[] {
  if (compareVersions(currentVersion, latestVersion) >= 0) {
    return [];
  }

  return [
    `发现 code-helper 新版本：${latestVersion}（当前 ${currentVersion}）`,
    "主菜单顶部可选择“更新到最新版本”：会升级 npm 包并刷新当前项目 code-helper 入口、Skills 和 Hooks。"
  ];
}

/**
 * npm latest 接口地址。
 */
function getRegistryUrl(): string {
  return "https://registry.npmjs.org/@skrupellose/code-helper/latest";
}

/**
 * 判断当前工作目录是否为 code-helper 本包源码仓库。
 * 不能用目录名 endsWith("code-helper")：例如 my-code-helper 会误判并错误跳过版本检查。
 * 以 cwd 下 package.json 的 name 是否等于本包名为准；读失败则视为非本仓。
 *
 * @param cwd 可选，默认 process.cwd()，单测可注入临时目录
 */
export function isLocalDevelopmentRepository(cwd: string = process.cwd()): boolean {
  try {
    const packageJsonPath = join(cwd, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return packageJson.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * 提取版本号中的数字段。
 */
function parseVersion(version: string): number[] {
  return version.split(/[.-]/u).map((part) => Number.parseInt(part, 10)).map((part) => Number.isNaN(part) ? 0 : part);
}
