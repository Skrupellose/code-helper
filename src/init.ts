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
  listProjectSkillRegistrations,
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
 * 初始化项目中的 code-helper 工作区和协作规则。
 * 该流程默认是非破坏性的：已有专题文档只跳过，入口文档只更新受控区块。
 */
export async function initializeProject(options: InitializeOptions): Promise<InitializeResult> {
  const config = await loadConfig(options.projectRoot);
  const operations: OperationResult[] = [];

  await detectEntryFiles(options.projectRoot, config);
  const skillRegistrationTargets = await resolveSkillRegistrationTargets(options.projectRoot);

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
  operations.push(...(await installHookTemplates(options.projectRoot, config)));
  operations.push(await writeStateFile(options.projectRoot, config));

  return { config, operations };
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

  if (!config.features.skillRegistration.enabled) {
    const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();

    return statuses.map((status) => ({
      path: status.path,
      action: "skipped",
      message: "Skills 管理功能已关闭，跳过项目级注册"
    }));
  }

  for (const target of targets) {
    operations.push(...(await registerProjectSkills(projectRoot, target)));
  }

  return operations;
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
 * 安装或更新 AGENTS.md / CLAUDE.md 入口文档。
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
 * 检测用户已经手动创建的入口文件。
 * 已有入口文件优先代表当前项目实际使用的 agent；完全没有入口文件的新项目才默认维护 AGENTS.md。
 */
async function detectEntryFiles(projectRoot: string, config: CodeHelperConfig): Promise<void> {
  const agentsExists = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  const claudeExists = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;

  if (agentsExists || claudeExists) {
    config.entryFiles.agents = agentsExists;
    config.entryFiles.claude = claudeExists;
    return;
  }

  if (!config.entryFiles.agents && !config.entryFiles.claude) {
    config.entryFiles.agents = true;
  }
}

/**
 * 渲染专题规则中的调用入口文件列表。
 * 该段会在 init 时同步到已有规则文件，确保手动新增 CLAUDE.md 后规则入口也一致。
 */
function renderEntryFileList(config: CodeHelperConfig): string {
  const entries = [
    config.entryFiles.agents ? "- `AGENTS.md`" : undefined,
    config.entryFiles.claude ? "- `CLAUDE.md`" : undefined
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
    await writeText(targetPath, template.content);
    operations.push({
      path: targetPath,
      action: config.features.gitHooks.enabled ? "updated" : "skipped",
      message: config.features.gitHooks.enabled
        ? "已刷新可选 Git hook 模板"
        : "Git hooks 默认关闭，仅保留 sample 模板"
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
