import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { normalizeDroppedPath } from "./input-utils.js";
import { canUseInteractiveKeys, promptSelect, TerminalCancelError } from "./terminal-ui.js";
import {
  maybeNotifyVersionUpdate,
  type VersionUpdateState
} from "./version-check.js";
import {
  buildMainMenuSelectOptions,
  formatMainMenuGroupTitle,
  formatMainMenuTextItemLines,
  formatVersionUpgradeTextItemLines,
  getMainMenuItemName,
  MAIN_MENU_GROUPS,
  normalizeMainMenuAnswer,
  QUICK_UPGRADE_MENU_VALUE
} from "./cli/main-menu.js";
import {
  askOptionalMenuInput,
  askQuestionOrDefault,
  askRequiredMenuInput,
  pauseAfterMenuAction,
  printInputHint
} from "./cli/menu-input.js";
import { runCodeHelperQuickUpgrade } from "./cli/quick-upgrade.js";
import {
  formatAgentHookTargetList,
  formatTargetList,
  selectAgentHookTargetsForMenu,
  selectSkillTargetsForMenu
} from "./cli/target-menu.js";
import {
  selectTaskFeatureNameForMenu
} from "./cli/task-selection.js";
import {
  runCheck,
  runFeatures,
  runInit,
  runNpmScripts,
  runSyncLocal,
  runUpdate,
  runVersion
} from "./cli/commands/core.js";
import {
  runArchive,
  runFinish,
  runManualTest,
  runPlan,
  runTasks
} from "./cli/commands/tasks.js";
import {
  applyAgentHooks,
  applyGitHook,
  applyProjectSkills,
  printApplyStatus,
  removeAgentHooks,
  removeGitHook,
  removeProjectSkills,
  runHooks,
  runSkills
} from "./cli/commands/tools.js";
import { printHelp } from "./cli/help.js";
import { resolveInitializedProjectRoot } from "./project-root.js";

export {
  buildMainMenuSelectOptions,
  formatMainMenuGroupTitle,
  formatMainMenuSelectItemLabel,
  formatMainMenuTextItemLines,
  formatVersionUpgradeSelectItemLabel,
  formatVersionUpgradeTextItemLines,
  getMainMenuGroups,
  MAIN_MENU_GROUPS,
  MAIN_MENU_NAME_COLUMN_WIDTH,
  QUICK_UPGRADE_MENU_VALUE,
  type MainMenuGroup,
  type MainMenuItem
} from "./cli/main-menu.js";
export {
  type CodeHelperQuickUpgradeOptions,
  type PackageUpgradeCommand,
  resolveCodeHelperUpdateCommand,
  resolveCodeHelperUpgradeCommand,
  runCodeHelperQuickUpgrade
} from "./cli/quick-upgrade.js";
export {
  parseAgentHookTargetMenuSelection,
  parseSkillTargetMenuSelection
} from "./cli/target-menu.js";

/**
 * CLI 主入口。
 * 支持子命令，也支持无参数时进入交互菜单。
 */
export async function runCli(argv: string[], projectRoot = process.cwd()): Promise<number> {
  const [command, ...args] = argv;

  try {
    const commandProjectRoot = await resolveProjectRootForCommand(command, projectRoot);
    const versionUpdateState = await maybeNotifyVersionUpdate(commandProjectRoot, command);

    switch (command) {
      case undefined:
      case "menu":
        // inputBasePath 保留原始 cwd，便于菜单内拖拽相对路径仍相对用户当前目录解析
        return runInteractiveMenu(commandProjectRoot, versionUpdateState, projectRoot);
      case "init":
        // init 始终使用调用方传入的目录（通常为 cwd），以便在尚未初始化的新目录创建工作区
        return runInit(projectRoot, args);
      case "update":
        return runUpdate(commandProjectRoot, args);
      case "version":
      case "--version":
      case "-v":
        return runVersion(args);
      case "npm-scripts":
        return runNpmScripts(projectRoot, args);
      case "sync-local":
        // 本仓开发刷新：在当前目录执行，不向上解析其它已初始化项目
        return runSyncLocal(projectRoot, args);
      case "check":
        return runCheck(commandProjectRoot, args);
      case "features":
        return runFeatures(commandProjectRoot, args);
      case "plan":
        return runPlan(commandProjectRoot, args, { inputBasePath: projectRoot });
      case "manual-test":
        return runManualTest(commandProjectRoot, args);
      case "archive":
        return runArchive(commandProjectRoot, args);
      case "finish":
        return runFinish(commandProjectRoot, args);
      case "tasks":
        return runTasks(commandProjectRoot, args);
      case "skills":
        return runSkills(commandProjectRoot, args);
      case "hooks":
        return runHooks(commandProjectRoot, args);
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      default:
        console.error(`未知命令：${command}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * 无参数时展示交互菜单。
 * 使用 Node 内置 readline，减少首版运行依赖和安装体积。
 * 菜单循环内业务错误只提示并继续，避免一次动作失败就结束整个会话。
 */
/**
 * 主菜单循环内可变状态。
 * 快捷升级成功后需要清空 versionUpdate 并重建 menuOptions，
 * 否则下一轮循环仍会显示“有更新”入口（文本菜单与 raw 菜单共用此状态）。
 */
interface InteractiveMenuState {
  versionUpdate?: VersionUpdateState;
  menuOptions: ReturnType<typeof buildMainMenuSelectOptions>;
}

async function runInteractiveMenu(
  projectRoot: string,
  versionUpdate?: VersionUpdateState,
  inputBasePath = projectRoot
): Promise<number> {
  const rl = createInterface({ input, output });
  // 循环内可变：升级成功后刷新顶部快捷升级项
  const menuState: InteractiveMenuState = {
    versionUpdate,
    menuOptions: buildMainMenuSelectOptions(versionUpdate)
  };

  try {
    let shouldExit = false;

    while (!shouldExit) {
      try {
        await runInteractiveMenuIteration({
          projectRoot,
          inputBasePath,
          menuState,
          rl,
          onExit: () => {
            shouldExit = true;
          }
        });
      } catch (error) {
        // 主菜单 Esc：取消本次选择，重新显示菜单，不退出进程
        if (error instanceof TerminalCancelError) {
          continue;
        }

        // stdin 关闭或 readline 已关闭：会话无法继续，向上抛出让 runCli 退出
        if (isFatalInteractiveMenuError(error)) {
          throw error;
        }

        // 其它可恢复业务错误：打印后回到菜单循环
        console.error(error instanceof Error ? error.message : String(error));
      }
    }

    return 0;
  } finally {
    rl.close();
  }
}

/**
 * 单次主菜单迭代：读取选择并执行对应动作。
 * 从 runInteractiveMenu 拆出，便于在循环层统一捕获可恢复错误。
 */
async function runInteractiveMenuIteration(options: {
  projectRoot: string;
  inputBasePath: string;
  menuState: InteractiveMenuState;
  rl: ReturnType<typeof createInterface>;
  onExit: () => void;
}): Promise<void> {
  const { projectRoot, inputBasePath, menuState, rl, onExit } = options;
  const versionUpdate = menuState.versionUpdate;
  const menuOptions = menuState.menuOptions;
  const useKeyMenu = canUseInteractiveKeys(input, output);
  const answer = useKeyMenu
    ? await promptSelect(input, output, "code-helper 操作菜单", menuOptions)
    : await askTextMenu(rl, versionUpdate);
  const menuAnswer = normalizeMainMenuAnswer(answer, versionUpdate);

  switch (menuAnswer) {
    case QUICK_UPGRADE_MENU_VALUE: {
      // 仅在升级成功时刷新菜单状态；失败时保留“有更新”入口便于重试
      const upgradeExitCode = await runMenuAction("更新到最新版本", () => runCodeHelperQuickUpgrade(projectRoot));

      if (upgradeExitCode === 0) {
        menuState.versionUpdate = undefined;
        menuState.menuOptions = buildMainMenuSelectOptions(undefined);
      }

      await pauseAfterMenuAction(useKeyMenu);
      break;
    }
    case "1":
      await runMenuAction(getMainMenuItemName(menuAnswer), () =>
        runInit(projectRoot, [], { showInteractiveCompletionHint: false })
      );
      await pauseAfterMenuAction(useKeyMenu);
      break;
    case "2": {
      printInputHint("生成任务计划模板需要需求文档路径，支持直接把文件拖到终端。输入 0 或直接回车返回。");
      const requirementPath = await askRequiredMenuInput(rl, "请输入或拖拽需求文档路径：");
      if (requirementPath === undefined) {
        console.log("已取消生成任务计划模板，返回主菜单。");
        break;
      }

      const featureName = await askOptionalMenuInput(rl, "请输入中文功能名称（可留空，默认取需求标题或中文文件名；输入 0 返回）：");
      if (featureName === undefined) {
        console.log("已取消生成任务计划模板，返回主菜单。");
        break;
      }

      await runMenuAction(getMainMenuItemName(menuAnswer), () =>
        runPlan(
          projectRoot,
          [normalizeDroppedPath(requirementPath, projectRoot, { inputBasePath }), featureName].filter(Boolean),
          { inputBasePath }
        )
      );
      await pauseAfterMenuAction(useKeyMenu);
      break;
    }
    case "3": {
      const featureName = await selectTaskFeatureNameForMenu(projectRoot, rl, {
        title: "选择要生成手工测试模板的任务",
        statuses: ["active", "mixed"],
        manualHint: "未找到合适任务或需要新建文档时，可手动输入功能名称。输入 0 或直接回车返回。",
        manualQuestion: "请输入功能名称："
      });
      if (featureName === undefined) {
        console.log("已取消生成手工测试模板，返回主菜单。");
        break;
      }

      const title = await askOptionalMenuInput(rl, "请输入测试文档标题（可留空；输入 0 返回）：");
      if (title === undefined) {
        console.log("已取消生成手工测试模板，返回主菜单。");
        break;
      }

      await runMenuAction(getMainMenuItemName(menuAnswer), () =>
        runManualTest(projectRoot, [featureName, title].filter(Boolean))
      );
      await pauseAfterMenuAction(useKeyMenu);
      break;
    }
    case "4": {
      const featureName = await selectTaskFeatureNameForMenu(projectRoot, rl, {
        title: "选择要检查完成情况的任务",
        statuses: ["active", "mixed"],
        manualHint: "未找到合适任务或需要兼容旧文档时，可手动输入功能名称。输入 0 或直接回车返回。",
        manualQuestion: "请输入要检查的功能名称："
      });
      if (featureName === undefined) {
        console.log("已取消检查功能完成情况，返回主菜单。");
        break;
      }

      await runMenuAction(getMainMenuItemName(menuAnswer), () => runFinish(projectRoot, [featureName]));
      await pauseAfterMenuAction(useKeyMenu);
      break;
    }
    case "5":
      await runMenuAction(getMainMenuItemName(menuAnswer), () => runTasks(projectRoot, []));
      await pauseAfterMenuAction(useKeyMenu);
      break;
    case "6": {
      const featureName = await selectTaskFeatureNameForMenu(projectRoot, rl, {
        title: "选择要归档的任务",
        statuses: ["active", "mixed"],
        manualHint: "未找到合适任务或需要兼容旧文档时，可手动输入功能名称。输入 0 或直接回车返回。",
        manualQuestion: "请输入要归档的功能名称："
      });
      if (featureName === undefined) {
        console.log("已取消归档已完成任务，返回主菜单。");
        break;
      }

      await runMenuAction(getMainMenuItemName(menuAnswer), () => runArchive(projectRoot, [featureName]));
      await pauseAfterMenuAction(useKeyMenu);
      break;
    }
    case "7":
      await runMenuAction(getMainMenuItemName(menuAnswer), () => runCheck(projectRoot));
      await pauseAfterMenuAction(useKeyMenu);
      break;
    case "8":
      if (await runApplyMenu(projectRoot, rl)) {
        await pauseAfterMenuAction(useKeyMenu);
      }
      break;
    case "9":
      if (await runSkillMenu(projectRoot, rl)) {
        await pauseAfterMenuAction(useKeyMenu);
      }
      break;
    case "10":
      if (await runHooksMenu(projectRoot, rl)) {
        await pauseAfterMenuAction(useKeyMenu);
      }
      break;
    case "0":
      console.log("已退出 code-helper。");
      onExit();
      break;
    default:
      console.log("无效选择，请重新输入。");
  }
}

/**
 * 判断交互菜单是否遇到无法继续的致命错误。
 * stdin / readline 关闭后无法再读输入，应结束会话而不是假装回到菜单。
 */
function isFatalInteractiveMenuError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("readline was closed")
    || message.includes("the readline interface instance has been finished")
    || (message.includes("stdin") && (message.includes("close") || message.includes("closed")))
    || error.name === "AbortError";
}

/**
 * 需要读写已初始化工作区（.code-helper / code-helper-docs）的命令列表。
 * 从子目录执行这些命令时必须向上解析项目根，避免误写到子目录。
 */
const COMMANDS_NEEDING_INITIALIZED_ROOT = new Set<string | undefined>([
  undefined,
  "menu",
  "plan",
  "finish",
  "archive",
  "manual-test",
  "check",
  "tasks",
  "skills",
  "hooks",
  "update",
  "features"
]);

/**
 * 按命令解析应使用的项目根目录。
 * - 依赖已初始化工作区的命令：向上查找 .code-helper 或 code-helper-docs
 * - init：保持传入路径（cwd），以便在新目录初始化；勿强制上探到其它项目
 * - version / help / npm-scripts / sync-local 等：保持 cwd，无需项目根
 */
async function resolveProjectRootForCommand(command: string | undefined, projectRoot: string): Promise<string> {
  if (COMMANDS_NEEDING_INITIALIZED_ROOT.has(command)) {
    return resolveInitializedProjectRoot(projectRoot);
  }

  return projectRoot;
}

/**
 * 交互式项目 Skills 管理菜单。
 * 这里只管理 code-helper 自己的项目级 skill，不触碰用户自定义 skills。
 */
async function runSkillMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>
): Promise<boolean> {
  const useKeyMenu = canUseInteractiveKeys(input, output);
  const options = [
    { value: "1", label: "查看注册状态" },
    { value: "2", label: "按当前项目注册 Skills" },
    { value: "3", label: "按当前项目取消注册 Skills" },
    { value: "4", label: "仅注册 Codex" },
    { value: "5", label: "仅注册 Claude Code" },
    { value: "6", label: "仅注册 GitHub Copilot" },
    { value: "7", label: "注册全部" },
    { value: "8", label: "取消注册全部" },
    { value: "9", label: "Skills 质量检查" },
    { value: "10", label: "Skills 建议分析" },
    { value: "0", label: "返回" }
  ];

  let answer: string;
  try {
    answer = useKeyMenu
      ? await promptSelect(input, output, "管理项目 Skills", options)
      : await askTextSkillMenu(rl);
  } catch (error) {
    // 子菜单 Esc：返回主菜单，不退出进程
    if (error instanceof TerminalCancelError) {
      console.log("已返回主菜单。");
      return false;
    }
    throw error;
  }

  switch (answer.trim()) {
    case "1":
      await runMenuAction("查看 Skills 注册状态", () => runSkills(projectRoot, ["list"]));
      return true;
    case "2":
      await runMenuAction("按当前项目注册 Skills", () => runSkills(projectRoot, ["register"]));
      return true;
    case "3":
      await runMenuAction("按当前项目取消注册 Skills", () => runSkills(projectRoot, ["unregister"]));
      return true;
    case "4":
      await runMenuAction("注册 Codex 项目级 skills", () => runSkills(projectRoot, ["register", "codex"]));
      return true;
    case "5":
      await runMenuAction("注册 Claude Code 项目级 skills", () => runSkills(projectRoot, ["register", "claudecode"]));
      return true;
    case "6":
      await runMenuAction("注册 GitHub Copilot 项目级 skills", () => runSkills(projectRoot, ["register", "githubcopilot"]));
      return true;
    case "7":
      await runMenuAction("注册全部项目级 skills", () => runSkills(projectRoot, ["register", "all"]));
      return true;
    case "8":
      await runMenuAction("取消注册全部项目级 skills", () => runSkills(projectRoot, ["unregister", "all"]));
      return true;
    case "9":
      await runMenuAction("Skills 质量检查", () => runSkills(projectRoot, ["doctor"]));
      return true;
    case "10":
      await runMenuAction("Skills 建议分析", () => runSkills(projectRoot, ["audit"]));
      return true;
    case "0":
      console.log("已返回主菜单。");
      return false;
    default:
      console.log("无效选择，返回主菜单。");
      return false;
  }
}

/**
 * 交互式 Hooks 管理菜单。
 * hooks 安装动作受 gitHooks / agentHooks 开关控制，卸载动作不受开关限制。
 */
async function runHooksMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>
): Promise<boolean> {
  const useKeyMenu = canUseInteractiveKeys(input, output);
  const options = [
    { value: "1", label: "查看 Hooks 状态" },
    { value: "2", label: "安装 Git pre-commit hook" },
    { value: "3", label: "卸载 Git pre-commit hook" },
    { value: "4", label: "安装 Codex Agent hook" },
    { value: "5", label: "卸载 Codex Agent hook" },
    { value: "6", label: "安装 Claude Code Agent hook" },
    { value: "7", label: "卸载 Claude Code Agent hook" },
    { value: "8", label: "安装全部 Hooks" },
    { value: "9", label: "卸载全部 Hooks" },
    { value: "0", label: "返回" }
  ];

  let answer: string;
  try {
    answer = useKeyMenu
      ? await promptSelect(input, output, "管理 Hooks", options)
      : await askTextHooksMenu(rl);
  } catch (error) {
    // 子菜单 Esc：返回主菜单，不退出进程
    if (error instanceof TerminalCancelError) {
      console.log("已返回主菜单。");
      return false;
    }
    throw error;
  }

  switch (answer.trim()) {
    case "1":
      await runMenuAction("查看 Hooks 状态", () => runHooks(projectRoot, ["list"]));
      return true;
    case "2":
      await runMenuAction("安装 Git pre-commit hook", () => runHooks(projectRoot, ["install", "git"]));
      return true;
    case "3":
      await runMenuAction("卸载 Git pre-commit hook", () => runHooks(projectRoot, ["uninstall", "git"]));
      return true;
    case "4":
      await runMenuAction("安装 Codex Agent hook", () => runHooks(projectRoot, ["install", "codex"]));
      return true;
    case "5":
      await runMenuAction("卸载 Codex Agent hook", () => runHooks(projectRoot, ["uninstall", "codex"]));
      return true;
    case "6":
      await runMenuAction("安装 Claude Code Agent hook", () => runHooks(projectRoot, ["install", "claudecode"]));
      return true;
    case "7":
      await runMenuAction("卸载 Claude Code Agent hook", () => runHooks(projectRoot, ["uninstall", "claudecode"]));
      return true;
    case "8":
      await runMenuAction("安装全部 Hooks", () => runHooks(projectRoot, ["install", "all"]));
      return true;
    case "9":
      await runMenuAction("卸载全部 Hooks", () => runHooks(projectRoot, ["uninstall", "all"]));
      return true;
    case "0":
      console.log("已返回主菜单。");
      return false;
    default:
      console.log("无效选择，返回主菜单。");
      return false;
  }
}

/**
 * 功能管理菜单。
 * 面向用户的一级入口应直接应用或取消能力，不要求用户理解内部 feature key。
 */
async function runApplyMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>
): Promise<boolean> {
  const useKeyMenu = canUseInteractiveKeys(input, output);
  const options = [
    { value: "1", label: "应用项目级 Skills" },
    { value: "2", label: "取消项目级 Skills" },
    { value: "3", label: "应用 Agent hooks" },
    { value: "4", label: "取消 Agent hooks" },
    { value: "5", label: "应用 Git hook" },
    { value: "6", label: "取消 Git hook" },
    { value: "7", label: "刷新规则和模板" },
    { value: "8", label: "查看应用状态" },
    { value: "0", label: "返回" }
  ];

  let answer: string;
  try {
    answer = useKeyMenu
      ? await promptSelect(input, output, "功能管理", options)
      : await askTextApplyMenu(rl);
  } catch (error) {
    // 子菜单 Esc：返回主菜单，不退出进程
    if (error instanceof TerminalCancelError) {
      console.log("已返回主菜单。");
      return false;
    }
    throw error;
  }

  switch (answer.trim()) {
    case "1": {
      const selection = await selectSkillTargetsForMenu(projectRoot, rl, "选择要应用 Skills 的 agent 工具");
      if (selection === undefined) {
        console.log("已取消应用项目级 Skills，返回功能管理。");
        return false;
      }

      await runMenuAction(`应用项目级 Skills（${formatTargetList(selection.targets)}）`, () =>
        applyProjectSkills(projectRoot, selection.targets)
      );
      return true;
    }
    case "2": {
      const selection = await selectSkillTargetsForMenu(projectRoot, rl, "选择要取消 Skills 的 agent 工具");
      if (selection === undefined) {
        console.log("已取消项目级 Skills 取消操作，返回功能管理。");
        return false;
      }

      await runMenuAction(`取消项目级 Skills（${formatTargetList(selection.targets)}）`, () =>
        removeProjectSkills(projectRoot, selection.targets, selection.shouldDisableFeatureAfterRemove)
      );
      return true;
    }
    case "3": {
      const selection = await selectAgentHookTargetsForMenu(projectRoot, rl, "选择要应用 Agent hooks 的 agent 工具");
      if (selection === undefined) {
        console.log("已取消应用 Agent hooks，返回功能管理。");
        return false;
      }

      await runMenuAction(`应用 Agent hooks（${formatAgentHookTargetList(selection.targets)}）`, () =>
        applyAgentHooks(projectRoot, selection.targets)
      );
      return true;
    }
    case "4": {
      const selection = await selectAgentHookTargetsForMenu(projectRoot, rl, "选择要取消 Agent hooks 的 agent 工具");
      if (selection === undefined) {
        console.log("已取消 Agent hooks 取消操作，返回功能管理。");
        return false;
      }

      await runMenuAction(`取消 Agent hooks（${formatAgentHookTargetList(selection.targets)}）`, () =>
        removeAgentHooks(projectRoot, selection.targets, selection.shouldDisableFeatureAfterRemove)
      );
      return true;
    }
    case "5":
      await runMenuAction("应用 Git hook", () => applyGitHook(projectRoot));
      return true;
    case "6":
      await runMenuAction("取消 Git hook", () => removeGitHook(projectRoot));
      return true;
    case "7":
      await runMenuAction("刷新规则和模板", () =>
        runInit(projectRoot, [], { showInteractiveCompletionHint: false })
      );
      return true;
    case "8":
      await runMenuAction("查看应用状态", () => printApplyStatus(projectRoot));
      return true;
    case "0":
      console.log("已返回主菜单。");
      return false;
    default:
      console.log("无效选择，返回主菜单。");
      return false;
  }
}

/**
 * 包装菜单动作的执行回显。
 * 用户按回车确认后，会立即看到动作开始和完成状态，避免误以为没有响应。
 * 业务异常只打印错误并返回退出码，不向上抛出，避免一次失败结束整个交互会话。
 * 返回动作退出码，供调用方在成功后做菜单状态刷新等后续处理。
 */
async function runMenuAction(label: string, action: () => Promise<number>): Promise<number> {
  console.log(`\n▶ 开始：${label}`);

  try {
    const exitCode = await action();

    if (exitCode === 0) {
      console.log(`✓ 完成：${label}`);
    } else {
      console.log(`✗ 失败：${label}（退出码 ${exitCode}）`);
    }

    return exitCode;
  } catch (error) {
    console.log(`✗ 失败：${label}`);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * 非 TTY 环境下的文本菜单兜底。
 * 当终端不支持 raw mode 时，仍允许用户输入数字选择。
 */
async function askTextMenu(rl: ReturnType<typeof createInterface>, versionUpdate?: VersionUpdateState): Promise<string> {
  console.log("\ncode-helper 操作菜单");

  if (versionUpdate?.outdated) {
    console.log("\n【快捷升级】");
    for (const line of formatVersionUpgradeTextItemLines(versionUpdate)) {
      console.log(line);
    }
  }

  for (const group of MAIN_MENU_GROUPS) {
    console.log(`\n${formatMainMenuGroupTitle(group.title)}`);

    for (const item of group.items) {
      for (const line of formatMainMenuTextItemLines(item)) {
        console.log(line);
      }
    }
  }

  console.log("\n  0. 退出");
  console.log("      关闭 code-helper 菜单");

  return askQuestionOrDefault(rl, "请选择操作：", "0");
}

/**
 * 非 TTY 环境下的项目 Skills 管理菜单。
 * 输入 0 立即返回，避免用户误入子菜单后无法退出。
 */
async function askTextSkillMenu(rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log("\n管理项目 Skills");
  console.log("1. 查看注册状态");
  console.log("2. 按当前项目注册 Skills");
  console.log("3. 按当前项目取消注册 Skills");
  console.log("4. 仅注册 Codex");
  console.log("5. 仅注册 Claude Code");
  console.log("6. 仅注册 GitHub Copilot");
  console.log("7. 注册全部");
  console.log("8. 取消注册全部");
  console.log("9. Skills 质量检查");
  console.log("10. Skills 建议分析");
  console.log("0. 返回");

  return askQuestionOrDefault(rl, "请选择操作：", "0");
}

/**
 * 非 TTY 环境下的功能管理菜单。
 */
async function askTextApplyMenu(rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log("\n功能管理");
  console.log("1. 应用项目级 Skills");
  console.log("2. 取消项目级 Skills");
  console.log("3. 应用 Agent hooks");
  console.log("4. 取消 Agent hooks");
  console.log("5. 应用 Git hook");
  console.log("6. 取消 Git hook");
  console.log("7. 刷新规则和模板");
  console.log("8. 查看应用状态");
  console.log("0. 返回");

  return askQuestionOrDefault(rl, "请选择操作：", "0");
}

/**
 * 非 TTY 环境下的 Hooks 管理菜单。
 */
async function askTextHooksMenu(rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log("\n管理 Hooks");
  console.log("1. 查看 Hooks 状态");
  console.log("2. 安装 Git pre-commit hook");
  console.log("3. 卸载 Git pre-commit hook");
  console.log("4. 安装 Codex Agent hook");
  console.log("5. 卸载 Codex Agent hook");
  console.log("6. 安装 Claude Code Agent hook");
  console.log("7. 卸载 Claude Code Agent hook");
  console.log("8. 安装全部 Hooks");
  console.log("9. 卸载全部 Hooks");
  console.log("0. 返回");

  return askQuestionOrDefault(rl, "请选择操作：", "0");
}
