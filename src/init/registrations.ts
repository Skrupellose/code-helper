import { projectPath } from "../fs-utils.js";
import {
  installHook,
  listHookInstallations,
  type HookInstallTarget
} from "../hooks.js";
import {
  listProjectSkillRegistrations,
  listSupportedSkillRegistrationTargets,
  registerProjectSkills,
  type SkillRegistrationTarget
} from "../skills.js";
import type { CodeHelperConfig, OperationResult } from "../types.js";
import { getTargetsFromExistingEntryFiles } from "./entries.js";
import { statIfExists } from "./migrations.js";

/**
 * 更新项目中已经注册或明确启用的 code-helper skills。
 * 仅存在 `.github/skills` 目录不能视为需要注册，避免把用户自定义 Copilot skills 误判为 code-helper 能力。
 */
export async function updateExistingProjectSkillRegistrations(
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
export async function updateExistingHooks(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
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
 * 注册项目级 skills。
 * 初始化按当前项目入口文件注册对应 agent；关闭功能开关时只展示跳过结果，便于用户理解 init 行为。
 */
export async function installProjectSkillRegistrations(
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
export async function installProjectAgentHooks(
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
export function resolveAgentHookTargets(targets: SkillRegistrationTarget[]): Array<Exclude<HookInstallTarget, "git">> {
  return targets.filter((target): target is Exclude<HookInstallTarget, "git"> =>
    target === "codex" || target === "claudecode"
  );
}
