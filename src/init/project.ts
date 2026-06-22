import { loadConfig, saveConfig } from "../config.js";
import { projectPath } from "../fs-utils.js";
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
  detectEntryFiles,
  installEntryDocuments
} from "./entries.js";
import { migrateLegacyAgentWorkspace } from "./migrations.js";
import {
  installProjectAgentHooks,
  installProjectSkillRegistrations,
  resolveAgentHookTargets,
  updateExistingHooks,
  updateExistingProjectSkillRegistrations
} from "./registrations.js";
import type { InitializeOptions, InitializeResult, UpdateResult } from "./types.js";

/**
 * 初始化项目中的 code-helper 工作区和协作规则。
 * 该流程默认是非破坏性的：已有专题文档只跳过，入口文档只更新受控区块。
 */
export async function initializeProject(options: InitializeOptions): Promise<InitializeResult> {
  const config = await loadConfig(options.projectRoot);
  const operations: OperationResult[] = [];
  const skillRegistrationTargets = options.skillRegistrationTargets
    ?? await resolveSkillRegistrationTargets(options.projectRoot);
  const agentHookTargets = resolveAgentHookTargets(skillRegistrationTargets);

  await detectEntryFiles(options.projectRoot, config, skillRegistrationTargets);
  if (agentHookTargets.length > 0) {
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
  operations.push(...(await installRuleTemplates(options.projectRoot, config)));
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
 */
export async function updateProject(projectRoot: string): Promise<UpdateResult> {
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
  operations.push(...(await installRuleTemplates(projectRoot, config)));
  operations.push(...(await installSkillTemplates(projectRoot, config)));
  operations.push(...(await installHookTemplates(projectRoot, config)));
  operations.push(...(await updateExistingProjectSkillRegistrations(projectRoot, config)));
  operations.push(...(await updateExistingHooks(projectRoot, config)));
  operations.push(await writeStateFile(projectRoot, config));

  return { config, operations };
}
