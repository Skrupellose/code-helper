import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { FEATURE_KEYS } from "./constants.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  ensureDirectory,
  projectPath,
  upsertManagedMarkdownBlock,
  upsertMarkdownSection,
  readTextIfExists,
  writeText,
  writeTextIfMissing
} from "./fs-utils.js";
import {
  installHook,
  listHookInstallations,
  type HookInstallTarget
} from "./hooks.js";
import {
  listProjectSkillRegistrations,
  listSupportedSkillRegistrationTargets,
  registerProjectSkills,
  resolveSkillRegistrationTargets,
  type SkillRegistrationTarget
} from "./skills.js";
import { getHookTemplates, getRuleTemplates, getSkillTemplates, renderEntryBlock } from "./templates.js";
import type { CodeHelperConfig, OperationResult } from "./types.js";

/**
 * 初始化 code-helper 的入参。
 * 目前只需要项目根目录，保留对象形式方便后续扩展 dry-run 等选项。
 */
export interface InitializeOptions {
  projectRoot: string;
  /**
   * init 要应用的 agent 工具目标。
   * 不传时仅根据初始化前已有入口文件推断；传空数组表示调用方已经确认应保守跳过项目级能力安装。
   */
  skillRegistrationTargets?: SkillRegistrationTarget[];
}

/**
 * 初始化结果。
 * CLI 根据该结构统一输出所有创建、更新和跳过项。
 */
export interface InitializeResult {
  config: CodeHelperConfig;
  operations: OperationResult[];
}

/**
 * 更新项目中已经使用的 code-helper 受控资产。
 * update 不开启新能力，只刷新当前项目已有入口、已注册 skills 和已安装 hooks。
 */
export interface UpdateResult {
  config: CodeHelperConfig;
  operations: OperationResult[];
}

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

/**
 * update 只维护当前真实存在的入口文件。
 * 这避免默认配置中的 AGENTS.md 开关在空目录里创建新的 agent 入口。
 */
async function applyExistingEntryFiles(projectRoot: string, config: CodeHelperConfig): Promise<void> {
  config.entryFiles.agents = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  config.entryFiles.claude = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;
  config.entryFiles.copilot =
    (await readTextIfExists(projectPath(projectRoot, ".github/copilot-instructions.md"))) !== undefined;
}

/**
 * 更新项目中已经注册或明确启用的 code-helper skills。
 * 仅存在 `.github/skills` 目录不能视为需要注册，避免把用户自定义 Copilot skills 误判为 code-helper 能力。
 */
async function updateExistingProjectSkillRegistrations(
  projectRoot: string,
  config: CodeHelperConfig
): Promise<OperationResult[]> {
  const registeredTargets = await listTargetsWithRegisteredCodeHelperSkills(projectRoot);
  const inferredTargets = getTargetsFromExistingEntryFiles(config);
  const targets = new Set<SkillRegistrationTarget>(registeredTargets);
  const operations: OperationResult[] = [];

  if (config.features.skillRegistration.enabled) {
    for (const target of inferredTargets) {
      targets.add(target);
    }
  }

  if (targets.size === 0) {
    return [
      {
        path: projectPath(projectRoot, `${config.directories.workspace}/skills`),
        action: "skipped",
        message: "未发现已注册的 code-helper skills，且当前项目未识别到可刷新入口，已跳过项目级 skills 更新"
      }
    ];
  }

  for (const target of targets) {
    operations.push(...(await registerProjectSkills(projectRoot, target, { respectFeatureToggle: false })));
  }

  return operations;
}

/**
 * 更新项目中已经安装或明确启用的 hooks。
 * update 不安装未使用的 agent hook，也不因为 Git hook 开关关闭而写入新的 pre-commit。
 */
async function updateExistingHooks(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const statuses = await listHookInstallations(projectRoot);
  const operations: OperationResult[] = [];
  const entryTargets = getTargetsFromExistingEntryFiles(config);
  const agentTargets = new Set<Exclude<HookInstallTarget, "git">>();

  for (const status of statuses) {
    if ((status.target === "codex" || status.target === "claudecode") && status.installed) {
      agentTargets.add(status.target);
    }
  }

  if (config.features.agentHooks.enabled) {
    for (const target of resolveAgentHookTargets(entryTargets)) {
      agentTargets.add(target);
    }
  }

  for (const target of agentTargets) {
    operations.push(await installHook(projectRoot, target));
  }

  const gitStatus = statuses.find((status) => status.target === "git");
  if (gitStatus?.installed === true || config.features.gitHooks.enabled) {
    operations.push(await installGitHookIfRepositoryExists(projectRoot, config));
  }

  if (operations.length === 0) {
    operations.push({
      path: projectPath(projectRoot, `${config.directories.workspace}/hooks`),
      action: "skipped",
      message: "未发现已安装的 code-helper hooks，且 hooks 能力未启用，已跳过 hooks 更新"
    });
  }

  return operations;
}

/**
 * Git hook 需要现有 Git 仓库；update 不负责把普通目录初始化为 Git 仓库。
 */
async function installGitHookIfRepositoryExists(
  projectRoot: string,
  config: CodeHelperConfig
): Promise<OperationResult> {
  const gitDirectory = await statIfExists(projectPath(projectRoot, ".git"));

  if (gitDirectory === undefined || !gitDirectory.isDirectory()) {
    return {
      path: projectPath(projectRoot, ".git/hooks/pre-commit"),
      action: "skipped",
      message: "未发现 Git 仓库，已跳过 Git hook 更新"
    };
  }

  if (!config.features.gitHooks.enabled) {
    const statuses = await listHookInstallations(projectRoot);
    const gitStatus = statuses.find((status) => status.target === "git");

    if (gitStatus?.installed !== true) {
      return {
        path: projectPath(projectRoot, ".git/hooks/pre-commit"),
        action: "skipped",
        message: "Git hook 能力未启用且未安装 code-helper 管理的 Git hook，已跳过"
      };
    }
  }

  return installHook(projectRoot, "git");
}

/**
 * 找出当前项目已经存在 code-helper 受控 skills 的目标。
 */
async function listTargetsWithRegisteredCodeHelperSkills(projectRoot: string): Promise<SkillRegistrationTarget[]> {
  const targets: SkillRegistrationTarget[] = [];

  for (const target of listSupportedSkillRegistrationTargets()) {
    const statuses = await listProjectSkillRegistrations(projectRoot, target);

    if (statuses.some((status) => status.registered)) {
      targets.push(target);
    }
  }

  return targets;
}

/**
 * 根据当前真实存在的入口文件推断 agent 目标。
 */
function getTargetsFromExistingEntryFiles(config: CodeHelperConfig): SkillRegistrationTarget[] {
  const targets: SkillRegistrationTarget[] = [];

  if (config.entryFiles.agents) {
    targets.push("codex");
  }

  if (config.entryFiles.claude) {
    targets.push("claudecode");
  }

  if (config.entryFiles.copilot) {
    targets.push("githubcopilot");
  }

  return targets;
}

/**
 * 注册项目级 skills。
 * 初始化按当前项目入口文件注册对应 agent；关闭功能开关时只展示跳过结果，便于用户理解 init 行为。
 */
async function installProjectSkillRegistrations(
  projectRoot: string,
  config: CodeHelperConfig,
  targets: SkillRegistrationTarget[]
): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];

  if (targets.length === 0) {
    return [
      {
        path: projectPath(projectRoot, `${config.directories.workspace}/skills`),
        action: "skipped",
        message: "未识别到明确的 agent 工具，已跳过项目级 skills 注册；请在交互式 init 中选择目标，或执行 `code-helper init codex|claudecode|githubcopilot|all`。"
      }
    ];
  }

  if (!config.features.skillRegistration.enabled) {
    const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();

    return statuses.map((status) => ({
      path: status.path,
      action: "skipped",
      message: "管理项目 Skills 功能已关闭，跳过项目级注册"
    }));
  }

  for (const target of targets) {
    operations.push(...(await registerProjectSkills(projectRoot, target)));
  }

  return operations;
}

/**
 * 根据 init 确定的同一批 agent 目标安装对应 Agent hooks。
 * 当前只有 Codex 和 Claude Code 有项目级 Agent hook 配置；GitHub Copilot skills 不触发 Git hook 或其他 hook。
 */
async function installProjectAgentHooks(
  projectRoot: string,
  config: CodeHelperConfig,
  skillTargets: SkillRegistrationTarget[],
  hookTargets: Array<Exclude<HookInstallTarget, "git">>
): Promise<OperationResult[]> {
  if (skillTargets.length === 0) {
    return [
      {
        path: projectPath(projectRoot, `${config.directories.workspace}/hooks`),
        action: "skipped",
        message: "未识别到明确的 agent 工具，已跳过 Agent hooks 安装"
      }
    ];
  }

  if (hookTargets.length === 0) {
    return [
      {
        path: projectPath(projectRoot, `${config.directories.workspace}/hooks`),
        action: "skipped",
        message: "当前选择的 agent 工具没有可安装的 Agent hook，已跳过；Git hook 不会在 init 中自动安装"
      }
    ];
  }

  const operations: OperationResult[] = [];

  for (const target of hookTargets) {
    operations.push(await installHook(projectRoot, target));
  }

  return operations;
}

/**
 * 从 skills 目标映射出支持 Agent hook 的目标。
 * GitHub Copilot 只支持项目级 skills 注册，不在这里映射为 Git hook。
 */
function resolveAgentHookTargets(targets: SkillRegistrationTarget[]): Array<Exclude<HookInstallTarget, "git">> {
  return targets.filter((target): target is Exclude<HookInstallTarget, "git"> =>
    target === "codex" || target === "claudecode"
  );
}

/**
 * 迁移旧版工作区到新版布局。
 * 内部状态保留在 `.code-helper`，可读协作文档迁移到 `code-helper-docs`。
 */
async function migrateLegacyAgentWorkspace(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const migrations = [
    { from: ".agent/code-helper", to: config.directories.workspace },
    { from: ".agent/user-rules", to: config.directories.userRules },
    { from: ".agent/plan-doc", to: config.directories.planDoc },
    { from: ".agent/result-doc", to: config.directories.resultDoc },
    { from: ".agent/status-doc", to: config.directories.statusDoc },
    { from: ".code-helper/user-rules", to: config.directories.userRules },
    { from: ".code-helper/plan-doc", to: config.directories.planDoc },
    { from: ".code-helper/result-doc", to: config.directories.resultDoc },
    { from: ".code-helper/status-doc", to: config.directories.statusDoc }
  ];
  const operations: OperationResult[] = [];

  for (const migration of migrations) {
    operations.push(...(await migratePath(projectRoot, migration.from, migration.to)));
  }

  await removeEmptyDirectoryIfPossible(projectPath(projectRoot, ".agent"));

  return operations;
}

/**
 * 迁移一个文件或目录。
 * 目标不存在时直接 rename；目标存在时递归合并，且遇到同名目标不覆盖。
 */
async function migratePath(projectRoot: string, fromRelativePath: string, toRelativePath: string): Promise<OperationResult[]> {
  const fromPath = projectPath(projectRoot, fromRelativePath);
  const toPath = projectPath(projectRoot, toRelativePath);
  const sourceStat = await statIfExists(fromPath);
  const operations: OperationResult[] = [];

  if (sourceStat === undefined) {
    return operations;
  }

  const targetStat = await statIfExists(toPath);

  if (targetStat === undefined) {
    await mkdir(dirname(toPath), { recursive: true });
    await rename(fromPath, toPath);
    operations.push({
      path: toPath,
      action: "updated",
      message: `已从旧路径迁移：${fromRelativePath}`
    });
    return operations;
  }

  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    const entries = await readdir(fromPath);

    for (const entry of entries) {
      operations.push(...(await migratePath(projectRoot, join(fromRelativePath, entry), join(toRelativePath, entry))));
    }

    await removeEmptyDirectoryIfPossible(fromPath);
    return operations;
  }

  operations.push({
    path: fromPath,
    action: "skipped",
    message: `迁移目标已存在，为避免覆盖已保留旧路径：${toRelativePath}`
  });
  return operations;
}

/**
 * 安全读取路径状态。
 * 不存在时返回 undefined，其他错误继续抛出。
 */
async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/**
 * 尝试删除空目录。
 * 如果目录不存在或非空，保持现状，避免误删用户未知内容。
 */
async function removeEmptyDirectoryIfPossible(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // 目录不存在、非空或被系统占用时都不处理，迁移逻辑不应破坏用户文件。
  }
}

/**
 * 创建所有固定目录。
 * 目录创建本身幂等，因此统一标记为 updated，表示已确保存在。
 */
async function createDirectories(
  projectRoot: string,
  config: CodeHelperConfig,
  operations: OperationResult[]
): Promise<void> {
  const directories = [
    config.directories.workspace,
    `${config.directories.workspace}/templates`,
    `${config.directories.workspace}/skills`,
    `${config.directories.workspace}/hooks`,
    `${config.directories.workspace}/checks`,
    `${config.directories.workspace}/archives`,
    config.directories.userRules,
    config.directories.planDoc,
    `${config.directories.planDoc}/archive`,
    config.directories.resultDoc,
    `${config.directories.resultDoc}/archive`,
    config.directories.statusDoc,
    `${config.directories.statusDoc}/archive`
  ];

  for (const directory of directories) {
    const absolutePath = projectPath(projectRoot, directory);
    await ensureDirectory(absolutePath);
    operations.push({
      path: absolutePath,
      action: "updated",
      message: "已确保目录存在"
    });
  }
}

/**
 * 安装或更新各 agent 工具的入口记忆文档。
 * 已存在文档只替换 code-helper 管理区块，不触碰用户其他内容。
 */
async function installEntryDocuments(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];
  const entryBlock = renderEntryBlock(config);

  if (config.entryFiles.agents) {
    operations.push(await upsertManagedMarkdownBlock(projectPath(projectRoot, "AGENTS.md"), entryBlock));
  }

  if (config.entryFiles.claude) {
    operations.push(await upsertManagedMarkdownBlock(projectPath(projectRoot, "CLAUDE.md"), entryBlock));
  }

  if (config.entryFiles.copilot) {
    operations.push(await upsertManagedMarkdownBlock(projectPath(projectRoot, ".github/copilot-instructions.md"), entryBlock));
  }

  return operations;
}

/**
 * 安装专题规则模板。
 * 老项目已有同名规则时不会覆盖，避免丢失用户维护的规则。
 */
async function installRuleTemplates(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];

  for (const template of getRuleTemplates(config)) {
    const targetPath = projectPath(projectRoot, join(config.directories.userRules, template.fileName));
    operations.push(
      await upsertMarkdownSection(
        targetPath,
        "## 调用入口文件",
        renderEntryFileList(config),
        template.content
      )
    );
  }

  return operations;
}

/**
 * 检测用户已经手动创建的入口文件，并按 init 目标补齐需要维护的入口。
 * 完全没有入口文件且没有选择目标时，不创建 agent 入口，避免后续 init 误判项目工具。
 */
async function detectEntryFiles(
  projectRoot: string,
  config: CodeHelperConfig,
  targets: SkillRegistrationTarget[]
): Promise<void> {
  const agentsExists = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  const claudeExists = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;
  const copilotExists = (await readTextIfExists(projectPath(projectRoot, ".github/copilot-instructions.md"))) !== undefined;

  if (agentsExists || claudeExists || copilotExists) {
    config.entryFiles.agents = agentsExists || targets.includes("codex");
    config.entryFiles.claude = claudeExists || targets.includes("claudecode");
    config.entryFiles.copilot = copilotExists || targets.includes("githubcopilot");
    return;
  }

  config.entryFiles.agents = targets.includes("codex");
  config.entryFiles.claude = targets.includes("claudecode");
  config.entryFiles.copilot = targets.includes("githubcopilot");
}

/**
 * 渲染专题规则中的调用入口文件列表。
 * 该段会在 init 时同步到已有规则文件，确保手动新增 CLAUDE.md 后规则入口也一致。
 */
function renderEntryFileList(config: CodeHelperConfig): string {
  const entries = [
    config.entryFiles.agents ? "- `AGENTS.md`" : undefined,
    config.entryFiles.claude ? "- `CLAUDE.md`" : undefined,
    config.entryFiles.copilot ? "- `.github/copilot-instructions.md`" : undefined
  ].filter((entry): entry is string => entry !== undefined);

  return entries.join("\n");
}

/**
 * 安装内置 skill 模板副本。
 * 这些文件是 code-helper 工作区资产，可以在新版本初始化时安全刷新。
 */
async function installSkillTemplates(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];

  for (const template of getSkillTemplates()) {
    const targetPath = projectPath(projectRoot, join(config.directories.workspace, "skills", template.fileName));
    await writeText(targetPath, template.content);
    operations.push({
      path: targetPath,
      action: "updated",
      message: "已刷新内置 skill 模板"
    });
  }

  return operations;
}

/**
 * 安装可选 hook 模板。
 * 即使 gitHooks 功能关闭，也只生成 sample 文件，不写入 .git/hooks。
 */
async function installHookTemplates(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];

  for (const template of getHookTemplates()) {
    const targetPath = projectPath(projectRoot, join(config.directories.workspace, "hooks", template.fileName));
    const enabled = config.features[template.feature].enabled;

    await writeText(targetPath, template.content);
    operations.push({
      path: targetPath,
      action: enabled ? "updated" : "skipped",
      message: enabled
        ? `已刷新可选 ${template.feature === "gitHooks" ? "Git hook" : "Agent hook"} 模板`
        : `${template.feature === "gitHooks" ? "Git hooks" : "Agent hooks"} 默认关闭，仅保留 sample 模板`
    });
  }

  return operations;
}

/**
 * 写入 code-helper 状态文件。
 * 该文件记录工具自身最近一次初始化状态，不替代业务项目 status-doc。
 */
async function writeStateFile(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult> {
  const enabledFeatures = FEATURE_KEYS.filter((feature) => config.features[feature].enabled);
  const targetPath = projectPath(projectRoot, `${config.directories.workspace}/state.json`);
  const state = {
    initializedAt: new Date().toISOString(),
    enabledFeatures,
    note: "此文件由 code-helper 维护，仅记录工具状态，不承载业务项目状态。"
  };

  await writeText(targetPath, `${JSON.stringify(state, null, 2)}\n`);

  return {
    path: targetPath,
    action: "updated",
    message: "已刷新 code-helper 运行状态"
  };
}
