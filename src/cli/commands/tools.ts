import { setFeatureEnabled } from "../../config.js";
import {
  installHook,
  listHookInstallations,
  parseHookTargets,
  uninstallHook,
  type HookInstallTarget
} from "../../hooks.js";
import {
  listProjectSkillRegistrations,
  parseSkillRegistrationTargets,
  registerProjectSkillsForTargets,
  resolveSkillRegistrationTargets,
  runSkillsAudit,
  runSkillsDoctor,
  type SkillRegistrationTarget,
  unregisterProjectSkillsForTargets
} from "../../skills.js";
import type { OperationResult } from "../../types.js";
import { printHooksHelp, printSkillsHelp } from "../help.js";
import {
  printHookInstallationStatus,
  printOperations,
  printSkillAuditRecommendations,
  printSkillDoctorIssues,
  printSkillRegistrationStatus
} from "../output.js";

/**
 * 应用项目级 Skills。
 * 功能管理菜单已经完成目标选择，这里按显式目标写入对应 agent 的项目级 skills。
 */
export async function applyProjectSkills(projectRoot: string, targets: SkillRegistrationTarget[]): Promise<number> {
  // 直接应用命令允许从关闭状态重新启用，但只有整批目标写入成功后才更新配置。
  const operations = await registerProjectSkillsForTargets(projectRoot, targets, { respectFeatureToggle: false });
  await setFeatureEnabled(projectRoot, "skillRegistration", true);
  const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();

  printOperations(operations);
  printSkillRegistrationStatus(statuses);
  return 0;
}

/**
 * 取消项目级 Skills。
 * 只删除目标 agent 下 code-helper 管理的 skills；按当前项目或全部取消时同步关闭后续自动注册。
 */
export async function removeProjectSkills(
  projectRoot: string,
  targets: SkillRegistrationTarget[],
  shouldDisableFeatureAfterRemove: boolean
): Promise<number> {
  const operations = await unregisterProjectSkillsForTargets(projectRoot, targets);
  const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();

  if (shouldDisableFeatureAfterRemove) {
    await setFeatureEnabled(projectRoot, "skillRegistration", false);
    console.log("已关闭后续初始化时的项目级 Skills 自动注册。");
  }

  printOperations(operations);
  printSkillRegistrationStatus(statuses);
  return 0;
}

/**
 * 应用 Agent hooks。
 * Agent hooks 安装到 Codex / Claude Code 项目级配置，只运行 finish --check-only。
 */
export async function applyAgentHooks(projectRoot: string, targets: Array<Exclude<HookInstallTarget, "git">>): Promise<number> {
  const operations: OperationResult[] = [];

  for (const target of targets) {
    operations.push(await installHook(projectRoot, target));
  }

  await setFeatureEnabled(projectRoot, "agentHooks", true);
  printOperations(operations);
  printHookInstallationStatus(await listHookInstallations(projectRoot));
  return 0;
}

/**
 * 取消 Agent hooks。
 * 只卸载目标 agent 的 code-helper hook；按当前项目或全部取消时同步关闭后续安装入口。
 */
export async function removeAgentHooks(
  projectRoot: string,
  targets: Array<Exclude<HookInstallTarget, "git">>,
  shouldDisableFeatureAfterRemove: boolean
): Promise<number> {
  const operations: OperationResult[] = [];

  for (const target of targets) {
    operations.push(await uninstallHook(projectRoot, target));
  }

  if (shouldDisableFeatureAfterRemove) {
    await setFeatureEnabled(projectRoot, "agentHooks", false);
    console.log("已关闭 Agent hooks 应用能力。");
  }

  printOperations(operations);
  printHookInstallationStatus(await listHookInstallations(projectRoot));
  return 0;
}

/**
 * 应用 Git pre-commit hook。
 */
export async function applyGitHook(projectRoot: string): Promise<number> {
  return runHooks(projectRoot, ["install", "git"]);
}

/**
 * 取消 Git pre-commit hook。
 */
export async function removeGitHook(projectRoot: string): Promise<number> {
  const exitCode = await runHooks(projectRoot, ["uninstall", "git"]);
  await setFeatureEnabled(projectRoot, "gitHooks", false);
  console.log("已关闭 Git hook 应用能力。");
  return exitCode;
}

/**
 * 查看功能管理状态。
 */
export async function printApplyStatus(projectRoot: string): Promise<number> {
  console.log("Skills 状态：");
  await runSkills(projectRoot, ["list"]);
  console.log("");
  console.log("Hooks 状态：");
  await runHooks(projectRoot, ["list"]);
  return 0;
}

/**
 * 项目级 skills 注册命令。
 * 支持：skills list、skills register [target]、skills unregister [target]、skills doctor、skills audit。
 * register/unregister 不带 target 时按当前项目入口文件推断目标，只有显式 all 才处理全部 agent。
 */
export async function runSkills(projectRoot: string, args: string[]): Promise<number> {
  const [action = "list", rawTarget] = args;

  if (action === "help" || action === "--help" || action === "-h") {
    printSkillsHelp();
    return 0;
  }

  if (action === "list") {
    const targets = await resolveTargetsForSkillAction(projectRoot, action, rawTarget);
    const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();
    printSkillRegistrationStatus(statuses);
    return 0;
  }

  if (action === "register") {
    const targets = await resolveTargetsForSkillAction(projectRoot, action, rawTarget);
    if (targets.length === 0) {
      printNoInferredSkillTargets(projectRoot, "注册");
      return 0;
    }
    // 显式 register 可以重新启用功能；配置写入必须晚于整批文件事务成功。
    const operations = await registerProjectSkillsForTargets(projectRoot, targets, { respectFeatureToggle: false });
    await setFeatureEnabled(projectRoot, "skillRegistration", true);
    const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();
    printOperations(operations);
    printSkillRegistrationStatus(statuses);
    return 0;
  }

  if (action === "unregister") {
    const targets = await resolveTargetsForSkillAction(projectRoot, action, rawTarget);
    if (targets.length === 0) {
      printNoInferredSkillTargets(projectRoot, "取消注册");
      return 0;
    }
    const operations = await unregisterProjectSkillsForTargets(projectRoot, targets);
    if (rawTarget === undefined || rawTarget === "all") {
      await setFeatureEnabled(projectRoot, "skillRegistration", false);
    }
    const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();
    printOperations(operations);
    printSkillRegistrationStatus(statuses);
    return 0;
  }

  if (action === "doctor") {
    const issues = await runSkillsDoctor(projectRoot);
    printSkillDoctorIssues(issues);
    return issues.some((issue) => issue.level === "error") ? 1 : 0;
  }

  if (action === "audit") {
    printSkillAuditRecommendations(await runSkillsAudit(projectRoot));
    return 0;
  }

  printSkillsHelp();
  return 1;
}

/**
 * Hooks 管理命令。
 * 支持：hooks list、hooks install <target>、hooks uninstall <target>。
 */
export async function runHooks(projectRoot: string, args: string[]): Promise<number> {
  const [action = "list", rawTarget] = args;

  if (action === "help" || action === "--help" || action === "-h") {
    printHooksHelp();
    return 0;
  }

  if (action === "list") {
    printHookInstallationStatus(await listHookInstallations(projectRoot));
    return 0;
  }

  if (action === "install" || action === "uninstall") {
    if (rawTarget === undefined) {
      console.error(`缺少 hooks 目标。用法：code-helper hooks ${action} <git|codex|claudecode|agent|all>`);
      printHooksHelp();
      return 1;
    }

    const targets = parseHookTargets(rawTarget);
    const operations: OperationResult[] = [];

    for (const target of targets) {
      if (action === "install") {
        operations.push(await installHook(projectRoot, target));
        await setFeatureEnabled(projectRoot, target === "git" ? "gitHooks" : "agentHooks", true);
      } else {
        operations.push(await uninstallHook(projectRoot, target));
        if (target === "git" || rawTarget === undefined || rawTarget === "all" || rawTarget === "agent" || rawTarget === "agents" || rawTarget === "agentHooks") {
          await setFeatureEnabled(projectRoot, target === "git" ? "gitHooks" : "agentHooks", false);
        }
      }
    }

    printOperations(operations);
    printHookInstallationStatus(await listHookInstallations(projectRoot));
    return 0;
  }

  printHooksHelp();
  return 1;
}

/**
 * skills register/unregister 无法从入口文件推断目标时，输出可理解的跳过结果。
 * 这里不默认处理全部目标，避免在 CI 或新项目里误写入多个 agent 的项目级目录。
 */
function printNoInferredSkillTargets(projectRoot: string, actionLabel: string): void {
  printOperations([
    {
      path: projectRoot,
      action: "skipped",
      message: `未识别到明确的 agent 工具，已跳过项目级 skills ${actionLabel}；请显式传入 codex、claudecode、githubcopilot 或 all。`
    }
  ]);
}

/**
 * 解析 skills 子命令的目标范围。
 * list 默认展示全部状态；register 和 unregister 默认按当前项目实际入口文件处理。
 */
async function resolveTargetsForSkillAction(
  projectRoot: string,
  action: string,
  rawTarget: string | undefined
): Promise<ReturnType<typeof parseSkillRegistrationTargets>> {
  if (rawTarget !== undefined) {
    return parseSkillRegistrationTargets(rawTarget);
  }

  if (action === "register" || action === "unregister") {
    return resolveSkillRegistrationTargets(projectRoot);
  }

  return parseSkillRegistrationTargets("all");
}
