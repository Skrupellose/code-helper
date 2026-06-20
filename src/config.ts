import { DEFAULT_CONFIG, FEATURE_KEYS } from "./constants.js";
import { ensureTrailingNewline, projectPath, readTextIfExists, writeText } from "./fs-utils.js";
import type { CodeHelperConfig, FeatureKey } from "./types.js";

/**
 * 返回 code-helper 配置文件相对路径。
 * 该路径固定在工作区下，方便用户清楚区分工具状态和业务文档。
 */
export function getConfigRelativePath(): string {
  return `${DEFAULT_CONFIG.directories.workspace}/config.json`;
}

/**
 * 读取并合并项目配置。
 * 老配置缺字段时会自动补默认值，但不会在读取阶段写回磁盘。
 */
export async function loadConfig(projectRoot: string): Promise<CodeHelperConfig> {
  const configPath = projectPath(projectRoot, getConfigRelativePath());
  const raw = await readTextIfExists(configPath);

  if (raw === undefined) {
    return cloneDefaultConfig();
  }

  const parsed = JSON.parse(raw) as Partial<CodeHelperConfig>;
  return mergeConfig(parsed);
}

/**
 * 保存项目配置。
 * 输出使用两个空格缩进，便于用户手工审阅和修改。
 */
export async function saveConfig(projectRoot: string, config: CodeHelperConfig): Promise<void> {
  const configPath = projectPath(projectRoot, getConfigRelativePath());
  await writeText(configPath, ensureTrailingNewline(JSON.stringify(mergeConfig(config), null, 2)));
}

/**
 * 修改单个功能开关。
 * 调用方传入 feature key 和目标状态，本函数负责保留其他配置。
 */
export async function setFeatureEnabled(
  projectRoot: string,
  feature: FeatureKey,
  enabled: boolean
): Promise<CodeHelperConfig> {
  const config = await loadConfig(projectRoot);
  config.features[feature] = { enabled };
  await saveConfig(projectRoot, config);
  return config;
}

/**
 * 合并配置对象。
 * 这样即使用户删除了某些字段，下一次 CLI 运行也能恢复到可用状态。
 */
export function mergeConfig(input: Partial<CodeHelperConfig>): CodeHelperConfig {
  const merged = cloneDefaultConfig();

  merged.version = typeof input.version === "number" ? input.version : merged.version;
  merged.entryFiles = {
    ...merged.entryFiles,
    ...input.entryFiles
  };
  merged.directories = {
    ...merged.directories,
    ...input.directories
  };

  for (const feature of FEATURE_KEYS) {
    merged.features[feature] = {
      enabled: input.features?.[feature]?.enabled ?? merged.features[feature].enabled
    };
  }

  return merged;
}

/**
 * 深拷贝默认配置。
 * 防止测试或运行时修改 DEFAULT_CONFIG 常量对象。
 */
function cloneDefaultConfig(): CodeHelperConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CodeHelperConfig;
}
