import { SKILL_MODULES, SKILL_PROFILES, SKILL_PROFILE_MODULES } from "../constants.js";
import { loadConfig, saveConfig } from "../config.js";
import { getSkillManifest } from "../templates.js";
import type { SkillTemplate } from "../templates/skills/types.js";
import type { CodeHelperConfig, SkillModule, SkillProfile, SkillSelection } from "../types.js";

/** 每个内置 Skill 只归属一个稳定模块，避免 profile 组合产生重复条目。 */
const SKILL_MODULE_BY_NAME: Readonly<Record<string, SkillModule>> = {
  "code-helper-agent-collaboration": "collaboration",
  "code-helper-memory-tuning": "memory",
  "code-helper-requirement-clarification": "core",
  "code-helper-plan-workbench": "core",
  "code-helper-manual-test-workbench": "quality",
  "code-helper-review-fix": "quality",
  "code-helper-semantic-analysis": "quality",
  "code-helper-document-archive": "core",
  "code-helper-completion-record": "core",
  "code-helper-completion-review": "quality"
};

/** 返回所有稳定模块。 */
export function listSkillModules(): readonly SkillModule[] {
  return SKILL_MODULES;
}

/** 返回所有内置 profile 及其模块。 */
export function listSkillProfiles(): Array<{ name: SkillProfile; modules: readonly SkillModule[] }> {
  return SKILL_PROFILES.map((name) => ({ name, modules: SKILL_PROFILE_MODULES[name] }));
}

/** 把 profile 或显式模块选择解析为确定性模块列表。 */
export function resolveSelectedSkillModules(selection: SkillSelection): readonly SkillModule[] {
  return selection.mode === "profile" ? SKILL_PROFILE_MODULES[selection.profile] : selection.modules;
}

/** 根据配置返回当前期望注册的内置 Skill manifest。 */
export function resolveExpectedSkillManifest(config: CodeHelperConfig): readonly Readonly<SkillTemplate>[] {
  const selectedModules = new Set(resolveSelectedSkillModules(config.skills));
  const manifest = getSkillManifest();

  // 清单新增 Skill 时若遗漏模块映射必须立即失败，不能在注册时静默忽略。
  for (const skill of manifest) {
    if (SKILL_MODULE_BY_NAME[skill.directoryName] === undefined) {
      throw new Error(`内置 Skill 缺少模块映射：${skill.directoryName}`);
    }
  }

  return manifest.filter((skill) => selectedModules.has(SKILL_MODULE_BY_NAME[skill.directoryName]));
}

/** 显式选择内置 profile 并保存到项目配置。 */
export async function selectSkillProfile(projectRoot: string, profile: SkillProfile): Promise<CodeHelperConfig> {
  if (!SKILL_PROFILES.includes(profile)) throw new Error(`不支持的 Skills profile：${profile}`);
  const config = await loadConfig(projectRoot);
  config.skills = { mode: "profile", profile };
  await saveConfig(projectRoot, config);
  return config;
}

/** 显式选择一个或多个模块并保存到项目配置。 */
export async function selectSkillModules(projectRoot: string, modules: SkillModule[]): Promise<CodeHelperConfig> {
  if (modules.length === 0) throw new Error("Skills modules 至少需要选择一个模块。");
  const invalid = modules.find((module) => !SKILL_MODULES.includes(module));
  if (invalid !== undefined) throw new Error(`不支持的 Skills 模块：${invalid}`);
  const selected = new Set(modules);
  const config = await loadConfig(projectRoot);
  config.skills = { mode: "modules", modules: SKILL_MODULES.filter((module) => selected.has(module)) };
  await saveConfig(projectRoot, config);
  return config;
}

/** 解析逗号分隔的模块参数，并保留内置稳定顺序。 */
export function parseSkillModules(raw: string): SkillModule[] {
  const values = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  const invalid = values.find((item) => !SKILL_MODULES.includes(item as SkillModule));
  if (invalid !== undefined) throw new Error(`不支持的 Skills 模块：${invalid}`);
  const selected = new Set(values as SkillModule[]);
  const result = SKILL_MODULES.filter((module) => selected.has(module));
  if (result.length === 0) throw new Error("Skills modules 至少需要选择一个模块。");
  return result;
}
