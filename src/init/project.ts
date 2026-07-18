import { getConfigRelativePath, loadConfig, saveConfig } from "../config.js";
import { projectPath, readTextIfExists } from "../fs-utils.js";
import { resolveSkillRegistrationTargets } from "../skills.js";
import type { OperationResult } from "../types.js";
import {
  createDirectories,
  installHookTemplates,
  installRuleTemplates,
  installSkillTemplates,
  writeStateFile
} from "./assets.js";
import {
  applyExistingEntryFiles,
  disambiguateSharedAgentsTargets,
  detectEntryFiles,
  installEntryDocuments
} from "./entries.js";
import { migrateLegacyAgentWorkspace } from "./migrations.js";
import {
  installProjectAgentHooks,
  installProjectSkillRegistrations,
  listKnownSkillRegistrationTargets,
  resolveAgentHookTargets,
  updateExistingHooks,
  updateExistingProjectSkillRegistrations
} from "./registrations.js";
import type { InitializeOptions, InitializeResult, UpdateOptions, UpdateResult } from "./types.js";

/**
 * 旧版工作区配置路径（与 config.ts 中的 LEGACY 路径保持一致）。
 * 用于判断「是否已有配置」时，避免把仅存在 legacy 配置的项目误当成首次 init。
 */
const LEGACY_CONFIG_RELATIVE_PATH = ".agent/code-helper/config.json";

/**
 * 初始化项目中的 code-helper 工作区和协作规则。
 * 该流程默认是非破坏性的：已有专题文档只跳过，入口文档只更新受控区块。
 */
export async function initializeProject(options: InitializeOptions): Promise<InitializeResult> {
  // 必须在 loadConfig 之前判断：loadConfig 会在无文件时返回内存默认配置，无法区分「首次」与「已有」。
  // 新版 `.code-helper/config.json` 或旧版 `.agent/code-helper/config.json` 任一存在，都视为已有配置。
  const hadExistingConfig =
    (await readTextIfExists(projectPath(options.projectRoot, getConfigRelativePath()))) !== undefined ||
    (await readTextIfExists(projectPath(options.projectRoot, LEGACY_CONFIG_RELATIVE_PATH))) !== undefined;

  const config = await loadConfig(options.projectRoot);
  const operations: OperationResult[] = [];
  const inferredSkillRegistrationTargets = options.skillRegistrationTargets
    ?? await resolveSkillRegistrationTargets(options.projectRoot);
  // 再次 init 时优先延续受控注册的共享入口目标，防止 Grok-only 项目因 AGENTS.md 被扩展为 Codex。
  const skillRegistrationTargets = options.skillRegistrationTargets === undefined
    ? disambiguateSharedAgentsTargets(
      inferredSkillRegistrationTargets,
      await listKnownSkillRegistrationTargets(options.projectRoot)
    )
    : inferredSkillRegistrationTargets;
  const agentHookTargets = resolveAgentHookTargets(skillRegistrationTargets);

  await detectEntryFiles(options.projectRoot, config, skillRegistrationTargets);

  // 首次 init 且存在可装 Agent hooks 的目标（codex/claudecode）时默认打开开关并安装；Grok Build 本轮不安装 Hook。
  // 已有配置则尊重用户对 agentHooks 的开关（关闭后再次 init 不会强制重开）。
  // `hooks install` CLI 仍可单独安装并 setFeatureEnabled(true)，不依赖此处逻辑。
  if (agentHookTargets.length > 0 && !hadExistingConfig) {
    config.features.agentHooks.enabled = true;
  }

  operations.push(...(await migrateLegacyAgentWorkspace(options.projectRoot, config)));
  await createDirectories(options.projectRoot, config, operations);
  await saveConfig(options.projectRoot, config);
  operations.push({
    path: projectPath(options.projectRoot, `${config.directories.workspace}/config.json`),
    action: "updated",
    message: "已写入或刷新 code-helper 配置"
  });

  operations.push(...(await installEntryDocuments(options.projectRoot, config)));
  // 默认安全刷新未改动的内置规则；--refresh-rules 时强制覆盖内置文件名。
  operations.push(
    ...(await installRuleTemplates(options.projectRoot, config, {
      refreshRules: options.refreshRules === true
    }))
  );
  operations.push(...(await installSkillTemplates(options.projectRoot, config)));
  operations.push(...(await installProjectSkillRegistrations(options.projectRoot, config, skillRegistrationTargets)));
  operations.push(...(await installProjectAgentHooks(options.projectRoot, config, skillRegistrationTargets, agentHookTargets)));
  operations.push(...(await installHookTemplates(options.projectRoot, config)));
  operations.push(await writeStateFile(options.projectRoot, config));

  return { config, operations };
}

/**
 * 升级当前项目中 code-helper 管理的本地资产。
 * 与 init 不同，update 不根据默认配置创建新的 agent 入口，也不自动打开未启用的 skills 或 hooks。
 * 对 user-rules 内置规则默认做「未改动则整文件刷新、改动过只更新入口」的安全刷新。
 */
export async function updateProject(
  projectRoot: string,
  options: UpdateOptions = {}
): Promise<UpdateResult> {
  const config = await loadConfig(projectRoot);
  const operations: OperationResult[] = [];

  await applyExistingEntryFiles(projectRoot, config);

  operations.push(...(await migrateLegacyAgentWorkspace(projectRoot, config)));
  await createDirectories(projectRoot, config, operations);
  await saveConfig(projectRoot, config);
  operations.push({
    path: projectPath(projectRoot, `${config.directories.workspace}/config.json`),
    action: "updated",
    message: "已合并并刷新 code-helper 配置"
  });

  operations.push(...(await installEntryDocuments(projectRoot, config)));
  operations.push(
    ...(await installRuleTemplates(projectRoot, config, {
      refreshRules: options.refreshRules === true
    }))
  );
  operations.push(...(await installSkillTemplates(projectRoot, config)));
  operations.push(...(await installHookTemplates(projectRoot, config)));
  operations.push(...(await updateExistingProjectSkillRegistrations(projectRoot, config)));
  operations.push(...(await updateExistingHooks(projectRoot, config)));
  operations.push(await writeStateFile(projectRoot, config));

  return { config, operations };
}
