import { DEFAULT_CONFIG, FEATURE_KEYS, SKILL_MODULES, SKILL_PROFILES } from "./constants.js";
import { ensureTrailingNewline, projectPath, readTextIfExists, writeText } from "./fs-utils.js";
import type { CodeHelperConfig, FeatureKey, SkillModule, SkillProfile, SkillSelection } from "./types.js";

/**
 * 旧版工具工作区配置路径。
 * 新版把内部状态和默认过程文档保留在 `.code-helper`；`code-helper-docs` 仅保留长期规则和旧版兼容来源。
 */
const LEGACY_WORKSPACE_DIRECTORY = ".agent/code-helper";

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
  const raw = await readTextIfExists(configPath)
    ?? await readTextIfExists(projectPath(projectRoot, `${LEGACY_WORKSPACE_DIRECTORY}/config.json`));

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
  const merged = mergeConfig(config);
  // 保存属于显式写操作，必须拒绝非法选择，避免把无法解析的状态持久化到项目。
  merged.skills = normalizeSkillSelection(config.skills, true);
  await writeText(configPath, ensureTrailingNewline(JSON.stringify(merged, null, 2)));
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

  // 读取旧版本后始终提升到当前结构版本；真正写盘仍只发生在 init/update/显式配置操作。
  merged.version = DEFAULT_CONFIG.version;
  merged.entryFiles = {
    ...merged.entryFiles,
    ...input.entryFiles
  };
  merged.directories = {
    ...merged.directories,
    ...input.directories
  };
  /**
   * code-helper 目录采用新布局。
   * 旧配置中的 `.agent/*` 或早期 `.code-helper/*` 文档路径只作为迁移输入，不继续作为写入目标。
   */
  merged.directories = {
    ...merged.directories,
    ...DEFAULT_CONFIG.directories
  };

  for (const feature of FEATURE_KEYS) {
    merged.features[feature] = {
      enabled: input.features?.[feature]?.enabled ?? merged.features[feature].enabled
    };
  }

  // 老配置没有 skills 字段时保留历史全量注册语义；损坏的旧值也采用保守全量回退。
  merged.skills = normalizeSkillSelection(input.skills, false);

  return merged;
}

/**
 * 校验并按稳定顺序规范化 Skills 选择。
 * strict 用于显式保存；兼容读取时非法旧值回退到 full，避免静默卸载已注册 Skills。
 */
export function normalizeSkillSelection(input: unknown, strict: boolean): SkillSelection {
  const fail = (message: string): SkillSelection => {
    if (strict) throw new Error(message);
    return { mode: "profile", profile: "full" };
  };

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input === undefined
      ? { mode: "profile", profile: "full" }
      : fail("Skills 选择必须是 profile 或 modules 对象。");
  }

  const record = input as Record<string, unknown>;
  if (record.mode === "profile") {
    if (typeof record.profile !== "string" || !SKILL_PROFILES.includes(record.profile as SkillProfile)) {
      return fail(`不支持的 Skills profile：${String(record.profile)}`);
    }
    return { mode: "profile", profile: record.profile as SkillProfile };
  }

  if (record.mode === "modules") {
    if (!Array.isArray(record.modules) || record.modules.length === 0) {
      return fail("Skills modules 至少需要选择一个模块。");
    }
    const invalid = record.modules.find(
      (item) => typeof item !== "string" || !SKILL_MODULES.includes(item as SkillModule)
    );
    if (invalid !== undefined) return fail(`不支持的 Skills 模块：${String(invalid)}`);
    const selected = new Set(record.modules as SkillModule[]);
    return { mode: "modules", modules: SKILL_MODULES.filter((module) => selected.has(module)) };
  }

  return fail(`不支持的 Skills 选择模式：${String(record.mode)}`);
}

/**
 * 深拷贝默认配置。
 * 防止测试或运行时修改 DEFAULT_CONFIG 常量对象。
 */
function cloneDefaultConfig(): CodeHelperConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CodeHelperConfig;
}
