import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { FEATURE_KEYS, FEATURE_LABELS } from "./constants.js";
import { archiveFeature, listTasks, type TaskRecord, type TaskStatus } from "./archive.js";
import { createCompletionReview, type CompletionReview } from "./completion.js";
import { loadConfig, setFeatureEnabled } from "./config.js";
import { runChecks } from "./checks.js";
import { installHook, listHookInstallations, parseHookTargets, uninstallHook, type HookInstallTarget } from "./hooks.js";
import { initializeProject } from "./init.js";
import { normalizeDroppedPath } from "./input-utils.js";
import {
  formatSkillRegistrationTargetName,
  listProjectSkillRegistrations,
  listSupportedSkillRegistrationTargets,
  parseSkillRegistrationTargets,
  registerProjectSkills,
  resolveSkillRegistrationTargets,
  runSkillsAudit,
  runSkillsDoctor,
  type SkillRegistrationTarget,
  unregisterProjectSkills
} from "./skills.js";
import { canUseInteractiveKeys, promptContinue, promptMultiSelect, promptSelect, type SelectOption } from "./terminal-ui.js";
import { createManualTestDocument, createPlanWorkbench } from "./workflows.js";
import type { FeatureKey, OperationResult } from "./types.js";

/**
 * CLI 主入口。
 * 支持子命令，也支持无参数时进入交互菜单。
 */
export async function runCli(argv: string[], projectRoot = process.cwd()): Promise<number> {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case undefined:
      case "menu":
        return runInteractiveMenu(projectRoot);
      case "init":
        return runInit(projectRoot, args);
      case "check":
        return runCheck(projectRoot);
      case "features":
        return runFeatures(projectRoot, args);
      case "plan":
        return runPlan(projectRoot, args);
      case "manual-test":
        return runManualTest(projectRoot, args);
      case "archive":
        return runArchive(projectRoot, args);
      case "finish":
        return runFinish(projectRoot, args);
      case "tasks":
        return runTasks(projectRoot, args);
      case "skills":
        return runSkills(projectRoot, args);
      case "hooks":
        return runHooks(projectRoot, args);
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
 * 主菜单条目。
 * value 是数字兜底菜单和 switch 分发共用的稳定值，name 与 description 共同组成用户可见文案。
 */
export interface MainMenuItem {
  value: string;
  name: string;
  description: string;
}

/**
 * 主菜单分组。
 * 交互式 raw mode 菜单和非 raw mode 数字菜单都从这里生成，避免两套文案不同步。
 */
export interface MainMenuGroup {
  title: string;
  items: MainMenuItem[];
}

/**
 * 主菜单信息架构。
 * 分组按用户完成一次协作任务的常见顺序排列：准备项目、推进任务、维护文档，再管理工具能力。
 */
const MAIN_MENU_GROUPS: MainMenuGroup[] = [
  {
    title: "项目准备",
    items: [
      {
        value: "1",
        name: "初始化/刷新项目配置",
        description: "创建或更新工作区、入口索引、规则模板、Skills 和可用 hooks"
      }
    ]
  },
  {
    title: "任务推进",
    items: [
      {
        value: "2",
        name: "生成任务计划",
        description: "根据需求文档生成计划、状态记录和执行记录入口"
      },
      {
        value: "3",
        name: "生成手工测试文档",
        description: "为页面或交互验收生成需要人工执行的测试文档"
      },
      {
        value: "4",
        name: "检查功能完成情况",
        description: "检查当前任务是否满足完成条件，并提示后续动作"
      }
    ]
  },
  {
    title: "项目维护",
    items: [
      {
        value: "5",
        name: "查看任务列表",
        description: "查看 active、archived 和 mixed 状态的任务文档"
      },
      {
        value: "6",
        name: "归档已完成任务",
        description: "将已结束任务的计划、结果和状态文档移动到 archive"
      },
      {
        value: "7",
        name: "检查协作规范",
        description: "检查入口文档、规则目录、计划和归档结构是否完整"
      }
    ]
  },
  {
    title: "工具设置",
    items: [
      {
        value: "8",
        name: "功能管理",
        description: "应用或取消项目级 Skills、Agent hooks 和 Git hook"
      },
      {
        value: "9",
        name: "管理项目 Skills",
        description: "查看、注册、取消注册、检查或分析项目级 Skills"
      },
      {
        value: "10",
        name: "管理 Hooks",
        description: "查看、安装或卸载 code-helper 管理的 Git / Agent hooks"
      }
    ]
  }
];

const MAIN_MENU_NAME_COLUMN_WIDTH = 24;

/**
 * 导出主菜单分组，供测试锁定菜单分组、命名和说明。
 */
export function getMainMenuGroups(): MainMenuGroup[] {
  return MAIN_MENU_GROUPS.map((group) => ({
    title: group.title,
    items: group.items.map((item) => ({ ...item }))
  }));
}

/**
 * 渲染主菜单分组标题。
 * 标题使用中文常见的书名号式括号，和功能项形成明确视觉区分，且不依赖 ANSI 样式。
 */
export function formatMainMenuGroupTitle(title: string): string {
  return `【${title}】`;
}

/**
 * 渲染 raw mode 菜单中的单行功能项。
 * 功能名按终端显示宽度补齐，保证说明从稳定列开始，便于快速扫描。
 */
export function formatMainMenuSelectItemLabel(item: MainMenuItem): string {
  return `  ${item.value.padStart(2, " ")}. ${padMenuText(item.name, MAIN_MENU_NAME_COLUMN_WIDTH)} ${item.description}`;
}

/**
 * 渲染数字兜底菜单中的功能项。
 * 数字兜底没有高亮能力，因此把功能名和说明拆成两行，避免长说明挤在同一行。
 */
export function formatMainMenuTextItemLines(item: MainMenuItem): string[] {
  return [`  ${item.value.padStart(2, " ")}. ${item.name}`, `      ${item.description}`];
}

/**
 * 按终端显示宽度补齐文本。
 * 中文字符通常占两个终端列，这里做轻量宽字符判断，避免主菜单说明列明显错位。
 */
function padMenuText(text: string, width: number): string {
  const paddingLength = Math.max(width - getMenuTextWidth(text), 0);
  return `${text}${" ".repeat(paddingLength)}`;
}

/**
 * 计算菜单文本在常见等宽终端中的显示宽度。
 * 该函数只用于菜单排版，不参与业务逻辑；宽字符范围覆盖中文、日文、韩文和全角符号。
 */
function getMenuTextWidth(text: string): number {
  return Array.from(text).reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return width + (isWideMenuCharacter(codePoint) ? 2 : 1);
  }, 0);
}

/**
 * 判断字符是否通常按双列宽度显示。
 * 范围参考 Unicode 中常见 CJK 和全角字符区间，避免引入额外依赖。
 */
function isWideMenuCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

/**
 * 构造 raw mode 单选菜单。
 * 分组标题和分组间空行作为 disabled 选项展示，方向键会自动跳过。
 */
export function buildMainMenuSelectOptions(): Array<SelectOption<string>> {
  const options: Array<SelectOption<string>> = [];

  for (const [groupIndex, group] of MAIN_MENU_GROUPS.entries()) {
    if (groupIndex > 0) {
      options.push({
        value: `__spacer_${group.title}`,
        label: "",
        disabled: true
      });
    }

    options.push({
      value: `__group_${group.title}`,
      label: formatMainMenuGroupTitle(group.title),
      disabled: true
    });

    for (const item of group.items) {
      options.push({
        value: item.value,
        label: formatMainMenuSelectItemLabel(item)
      });
    }
  }

  options.push({ value: "__spacer_exit", label: "", disabled: true });
  options.push({ value: "0", label: "   0. 退出                 关闭 code-helper 菜单" });
  return options;
}

/**
 * 根据主菜单数字取回用户可见功能名。
 * 菜单动作回显复用这里的名称，避免旧文案散落在 switch 分支里。
 */
function getMainMenuItemName(value: string): string {
  return MAIN_MENU_GROUPS.flatMap((group) => group.items).find((item) => item.value === value)?.name ?? value;
}

/**
 * 无参数时展示交互菜单。
 * 使用 Node 内置 readline，减少首版运行依赖和安装体积。
 */
async function runInteractiveMenu(projectRoot: string): Promise<number> {
  const rl = createInterface({ input, output });
  const menuOptions = buildMainMenuSelectOptions();

  try {
    let shouldExit = false;

    while (!shouldExit) {
      const useKeyMenu = canUseInteractiveKeys(input, output);
      const answer = useKeyMenu
        ? await promptSelect(input, output, "code-helper 操作菜单", menuOptions)
        : await askTextMenu(rl);

      switch (answer.trim()) {
        case "1":
          await runMenuAction(getMainMenuItemName(answer), () => runInit(projectRoot));
          await pauseAfterMenuAction(useKeyMenu);
          break;
        case "2": {
          printInputHint("生成任务计划需要需求文档路径，支持直接把文件拖到终端。输入 0 或直接回车返回。");
          const requirementPath = await askRequiredMenuInput(rl, "请输入或拖拽需求文档路径：");
          if (requirementPath === undefined) {
            console.log("已取消生成任务计划，返回主菜单。");
            break;
          }

          const featureName = await askOptionalMenuInput(rl, "请输入中文功能名称（可留空，默认取需求标题或中文文件名；输入 0 返回）：");
          if (featureName === undefined) {
            console.log("已取消生成任务计划，返回主菜单。");
            break;
          }

          await runMenuAction(getMainMenuItemName(answer), () =>
            runPlan(projectRoot, [normalizeDroppedPath(requirementPath, projectRoot), featureName].filter(Boolean))
          );
          await pauseAfterMenuAction(useKeyMenu);
          break;
        }
        case "3": {
          const featureName = await selectTaskFeatureNameForMenu(projectRoot, rl, {
            title: "选择要生成手工测试文档的任务",
            statuses: ["active", "mixed"],
            manualHint: "未找到合适任务或需要新建文档时，可手动输入功能名称。输入 0 或直接回车返回。",
            manualQuestion: "请输入功能名称："
          });
          if (featureName === undefined) {
            console.log("已取消生成手工测试文档，返回主菜单。");
            break;
          }

          const title = await askOptionalMenuInput(rl, "请输入测试文档标题（可留空；输入 0 返回）：");
          if (title === undefined) {
            console.log("已取消生成手工测试文档，返回主菜单。");
            break;
          }

          await runMenuAction(getMainMenuItemName(answer), () =>
            runManualTest(projectRoot, [featureName, title].filter(Boolean))
          );
          await pauseAfterMenuAction(useKeyMenu);
          break;
        }
        case "4":
          {
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

            await runMenuAction(getMainMenuItemName(answer), () => runFinish(projectRoot, [featureName]));
            await pauseAfterMenuAction(useKeyMenu);
            break;
          }
        case "5":
          await runMenuAction(getMainMenuItemName(answer), () => runTasks(projectRoot, []));
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

          await runMenuAction(getMainMenuItemName(answer), () => runArchive(projectRoot, [featureName]));
          await pauseAfterMenuAction(useKeyMenu);
          break;
        }
        case "7":
          await runMenuAction(getMainMenuItemName(answer), () => runCheck(projectRoot));
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
          shouldExit = true;
          break;
        default:
          console.log("无效选择，请重新输入。");
      }
    }

    return 0;
  } finally {
    rl.close();
  }
}

/**
 * 在菜单中选择一个任务功能名。
 * 优先从已有任务文档选择；没有合适任务或用户选择手动输入时，再回退到文本输入。
 */
async function selectTaskFeatureNameForMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>,
  options: {
    title: string;
    statuses: TaskStatus[];
    manualHint: string;
    manualQuestion: string;
  }
): Promise<string | undefined> {
  const tasks = await getSelectableTasks(projectRoot, options.statuses);

  if (tasks.length > 0) {
    const answer = canUseInteractiveKeys(input, output)
      ? await promptSelect(input, output, options.title, buildTaskSelectOptions(tasks, true))
      : await askTextTaskMenu(rl, options.title, tasks);

    if (answer === "__return__") {
      return undefined;
    }

    if (answer !== "__manual__") {
      return tasks[Number.parseInt(answer, 10)]?.featureName;
    }
  } else {
    console.log("当前没有发现可选择的活动任务。");
  }

  printInputHint(options.manualHint);
  return askRequiredMenuInput(rl, options.manualQuestion);
}

/**
 * 直接命令缺少功能名时，从已有任务中选择。
 * 非 TTY 场景不进入交互，只打印可用任务和正确用法。
 */
async function selectTaskFeatureNameForCommand(
  projectRoot: string,
  title: string,
  statuses: TaskStatus[]
): Promise<string | undefined> {
  const tasks = await getSelectableTasks(projectRoot, statuses);

  if (tasks.length === 0) {
    console.error("缺少功能名称，且当前没有发现可选择的活动任务。");
    return undefined;
  }

  if (!canUseInteractiveKeys(input, output)) {
    console.error("缺少功能名称。可用任务：");
    for (const task of tasks) {
      console.error(`- ${task.featureName}（${task.status}）`);
    }
    return undefined;
  }

  const answer = await promptSelect(input, output, title, buildTaskSelectOptions(tasks, false));

  if (answer === "__return__" || answer === "__manual__") {
    return undefined;
  }

  return tasks[Number.parseInt(answer, 10)]?.featureName;
}

/**
 * 读取可供动作选择的任务。
 * archived 任务已经结束，不会默认出现在生成手工测试和归档动作中。
 */
async function getSelectableTasks(projectRoot: string, statuses: TaskStatus[]): Promise<TaskRecord[]> {
  const allowedStatuses = new Set(statuses);

  return (await listTasks(projectRoot)).filter((task) => allowedStatuses.has(task.status));
}

/**
 * 为任务选择菜单生成稳定 value。
 * value 使用数组下标，避免功能名中包含特殊字符时影响菜单控制项。
 */
function buildTaskSelectOptions(
  tasks: TaskRecord[],
  includeManualInput: boolean
): Array<{ value: string; label: string }> {
  const options = tasks.map((task, index) => ({
    value: String(index),
    label: `${task.featureName}（${task.status}）`
  }));

  if (includeManualInput) {
    options.push({ value: "__manual__", label: "手动输入功能名称" });
  }

  options.push({ value: "__return__", label: "返回" });
  return options;
}

/**
 * 非 raw mode 终端下的任务选择菜单。
 * 数字选择任务，M 表示手动输入，0 表示返回。
 */
async function askTextTaskMenu(
  rl: ReturnType<typeof createInterface>,
  title: string,
  tasks: TaskRecord[]
): Promise<string> {
  console.log(`\n${title}`);
  tasks.forEach((task, index) => {
    console.log(`${index + 1}. ${task.featureName}（${task.status}）`);
  });
  console.log("M. 手动输入功能名称");
  console.log("0. 返回");

  const answer = (await askQuestionOrDefault(rl, "请选择任务：", "0")).trim();

  if (answer === "0" || answer === "") {
    return "__return__";
  }

  if (answer.toLowerCase() === "m") {
    return "__manual__";
  }

  const selectedIndex = Number.parseInt(answer, 10);

  if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= tasks.length) {
    return String(selectedIndex - 1);
  }

  console.log("无效选择，返回上一级。");
  return "__return__";
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
  const answer = useKeyMenu
    ? await promptSelect(input, output, "管理项目 Skills", options)
    : await askTextSkillMenu(rl);

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
  const answer = useKeyMenu
    ? await promptSelect(input, output, "管理 Hooks", options)
    : await askTextHooksMenu(rl);

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
  const answer = useKeyMenu
    ? await promptSelect(input, output, "功能管理", options)
    : await askTextApplyMenu(rl);

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
      await runMenuAction("刷新规则和模板", () => runInit(projectRoot));
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
 * 功能管理菜单中的目标选择结果。
 * shouldDisableFeatureAfterRemove 用于保留现有命令语义：按当前项目或全部取消时，同步关闭后续自动应用能力。
 */
interface MenuTargetSelection<TTarget extends string> {
  targets: TTarget[];
  shouldDisableFeatureAfterRemove: boolean;
}

/**
 * 选择 Skills 应用或取消的 agent 工具目标。
 * 优先提供“按当前项目”默认项；用户也可以显式选择单个 agent 或全部 agent。
 */
async function selectSkillTargetsForMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>,
  title: string
): Promise<MenuTargetSelection<SkillRegistrationTarget> | undefined> {
  const inferredTargets = await resolveSkillRegistrationTargets(projectRoot);
  const useKeyMenu = canUseInteractiveKeys(input, output);

  if (useKeyMenu) {
    const answer = await promptSelect(input, output, title, buildSkillTargetSelectOptions(inferredTargets));
    return resolveSkillTargetMenuAnswer(answer, inferredTargets);
  }

  const answer = await askTextSkillTargetMenu(rl, title, inferredTargets);
  return resolveSkillTargetMenuAnswer(answer.trim(), inferredTargets);
}

/**
 * 选择 Agent hooks 应用或取消的 agent 工具目标。
 * GitHub Copilot 没有可安装的 Agent hook，因此只把 Codex 和 Claude Code 列为可选项。
 */
async function selectAgentHookTargetsForMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>,
  title: string
): Promise<MenuTargetSelection<Exclude<HookInstallTarget, "git">> | undefined> {
  const inferredSkillTargets = await resolveSkillRegistrationTargets(projectRoot);
  const inferredHookTargets = toAgentHookTargets(inferredSkillTargets);

  if (inferredSkillTargets.length > 0 && inferredHookTargets.length === 0) {
    console.log("当前项目只识别到 GitHub Copilot；GitHub Copilot 不支持 Agent hook，请选择 Codex 或 Claude Code。");
  }

  if (canUseInteractiveKeys(input, output)) {
    const answer = await promptSelect(input, output, title, buildAgentHookTargetSelectOptions(inferredSkillTargets));
    return resolveAgentHookTargetMenuAnswer(answer, inferredSkillTargets);
  }

  const answer = await askTextAgentHookTargetMenu(rl, title, inferredSkillTargets);
  return resolveAgentHookTargetMenuAnswer(answer.trim(), inferredSkillTargets);
}

/**
 * raw mode 菜单中的 Skills 目标选项。
 * 默认项放在第一位，让已能识别 agent 工具的项目可以直接回车确认。
 */
function buildSkillTargetSelectOptions(
  inferredTargets: SkillRegistrationTarget[]
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];

  if (inferredTargets.length > 0) {
    options.push({
      value: "default",
      label: `按当前项目（${formatTargetList(inferredTargets)}）`
    });
  }

  options.push(
    { value: "codex", label: "Codex" },
    { value: "claudecode", label: "Claude Code" },
    { value: "githubcopilot", label: "GitHub Copilot" },
    { value: "all", label: "全部" },
    { value: "0", label: "返回" }
  );

  return options;
}

/**
 * raw mode 菜单中的 Agent hook 目标选项。
 * 默认项只包含支持 Agent hook 的目标，自动忽略 GitHub Copilot。
 */
function buildAgentHookTargetSelectOptions(
  inferredSkillTargets: SkillRegistrationTarget[]
): Array<{ value: string; label: string }> {
  const inferredHookTargets = toAgentHookTargets(inferredSkillTargets);
  const options: Array<{ value: string; label: string }> = [];

  if (inferredHookTargets.length > 0) {
    options.push({
      value: "default",
      label: `按当前项目（${formatAgentHookTargetList(inferredHookTargets)}）`
    });
  }

  options.push(
    { value: "codex", label: "Codex" },
    { value: "claudecode", label: "Claude Code" },
    { value: "all", label: "全部可用 Agent hooks" },
    { value: "0", label: "返回" }
  );

  return options;
}

/**
 * 非 raw mode 终端中的 Skills 目标菜单。
 * 除数字外也支持输入 codex、claudecode、githubcopilot、all 和 default。
 */
async function askTextSkillTargetMenu(
  rl: ReturnType<typeof createInterface>,
  title: string,
  inferredTargets: SkillRegistrationTarget[]
): Promise<string> {
  console.log(`\n${title}`);
  if (inferredTargets.length > 0) {
    console.log(`D. 按当前项目（${formatTargetList(inferredTargets)}）`);
  }
  console.log("1. Codex");
  console.log("2. Claude Code");
  console.log("3. GitHub Copilot");
  console.log("A. 全部");
  console.log("0. 返回");
  console.log("可输入编号或名称，例如：1、codex、githubcopilot、all。");

  return askQuestionOrDefault(rl, "请选择 agent 工具：", "0");
}

/**
 * 非 raw mode 终端中的 Agent hook 目标菜单。
 * 菜单不列出 GitHub Copilot，避免用户误以为它支持 Agent hook。
 */
async function askTextAgentHookTargetMenu(
  rl: ReturnType<typeof createInterface>,
  title: string,
  inferredSkillTargets: SkillRegistrationTarget[]
): Promise<string> {
  const inferredHookTargets = toAgentHookTargets(inferredSkillTargets);

  console.log(`\n${title}`);
  if (inferredHookTargets.length > 0) {
    console.log(`D. 按当前项目（${formatAgentHookTargetList(inferredHookTargets)}）`);
  }
  console.log("1. Codex");
  console.log("2. Claude Code");
  console.log("A. 全部可用 Agent hooks");
  console.log("0. 返回");
  console.log("GitHub Copilot 不支持 Agent hook，因此不在这里安装或取消。");
  console.log("可输入编号或名称，例如：1、codex、claudecode、all。");

  return askQuestionOrDefault(rl, "请选择 agent 工具：", "0");
}

/**
 * 把 Skills 菜单答案解析成目标列表。
 * 返回 undefined 表示用户返回；抛错表示输入了不支持的目标。
 */
function resolveSkillTargetMenuAnswer(
  answer: string,
  inferredTargets: SkillRegistrationTarget[]
): MenuTargetSelection<SkillRegistrationTarget> | undefined {
  const targets = parseSkillTargetMenuSelection(answer, inferredTargets);

  if (targets.length === 0) {
    return undefined;
  }

  return {
    targets,
    shouldDisableFeatureAfterRemove: isDefaultOrAllTargetAnswer(answer)
  };
}

/**
 * 把 Agent hook 菜单答案解析成目标列表。
 * 返回 undefined 表示用户返回；GitHub Copilot 输入会得到明确错误。
 */
function resolveAgentHookTargetMenuAnswer(
  answer: string,
  inferredSkillTargets: SkillRegistrationTarget[]
): MenuTargetSelection<Exclude<HookInstallTarget, "git">> | undefined {
  const targets = parseAgentHookTargetMenuSelection(answer, inferredSkillTargets);

  if (targets.length === 0) {
    return undefined;
  }

  return {
    targets,
    shouldDisableFeatureAfterRemove: isDefaultOrAllTargetAnswer(answer)
  };
}

/**
 * 解析功能管理中 Skills 目标文本。
 * 该函数导出给单元测试使用，确保非 raw mode 菜单和 raw mode 菜单使用同一套目标规则。
 */
export function parseSkillTargetMenuSelection(
  value: string,
  inferredTargets: SkillRegistrationTarget[] = []
): SkillRegistrationTarget[] {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "" || normalizedValue === "0") {
    return [];
  }

  if (normalizedValue === "d" || normalizedValue === "default" || normalizedValue === "current") {
    return [...inferredTargets];
  }

  const targets = new Set<SkillRegistrationTarget>();
  const tokens = normalizedValue.split(/[,\s]+/u).filter(Boolean);

  for (const token of tokens) {
    if (token === "a" || token === "all") {
      return listSupportedSkillRegistrationTargets();
    }

    if (token === "1") {
      targets.add("codex");
      continue;
    }

    if (token === "2") {
      targets.add("claudecode");
      continue;
    }

    if (token === "3") {
      targets.add("githubcopilot");
      continue;
    }

    for (const target of parseSkillRegistrationTargets(token)) {
      targets.add(target);
    }
  }

  return [...targets];
}

/**
 * 解析功能管理中 Agent hook 目标文本。
 * GitHub Copilot 没有 Agent hook 安装位置，因此输入相关别名时直接给出清晰错误。
 */
export function parseAgentHookTargetMenuSelection(
  value: string,
  inferredSkillTargets: SkillRegistrationTarget[] = []
): Array<Exclude<HookInstallTarget, "git">> {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "" || normalizedValue === "0") {
    return [];
  }

  if (normalizedValue === "d" || normalizedValue === "default" || normalizedValue === "current") {
    return toAgentHookTargets(inferredSkillTargets);
  }

  const targets = new Set<Exclude<HookInstallTarget, "git">>();
  const tokens = normalizedValue.split(/[,\s]+/u).filter(Boolean);

  for (const token of tokens) {
    if (token === "a" || token === "all" || token === "agent" || token === "agents") {
      return ["codex", "claudecode"];
    }

    if (token === "1" || token === "codex") {
      targets.add("codex");
      continue;
    }

    if (token === "2" || token === "claudecode" || token === "claude-code" || token === "claude") {
      targets.add("claudecode");
      continue;
    }

    if (token === "3" || token === "githubcopilot" || token === "github-copilot" || token === "copilot" || token === "github") {
      throw new Error("GitHub Copilot 不支持 Agent hook，请选择 Codex、Claude Code 或全部可用 Agent hooks。");
    }

    throw new Error(`不支持的 Agent hook 目标：${token}。当前支持 codex、claudecode 或 all。`);
  }

  return [...targets];
}

/**
 * 从 Skills 目标中过滤出支持 Agent hook 的目标。
 * GitHub Copilot 只支持项目级 Skills，不映射到任何 hook。
 */
function toAgentHookTargets(
  targets: SkillRegistrationTarget[]
): Array<Exclude<HookInstallTarget, "git">> {
  return targets.filter((target): target is Exclude<HookInstallTarget, "git"> =>
    target === "codex" || target === "claudecode"
  );
}

/**
 * 判断菜单答案是否代表“按当前项目”或“全部”。
 * 这些范围取消后会同步关闭对应功能开关，保持原有菜单行为。
 */
function isDefaultOrAllTargetAnswer(answer: string): boolean {
  const normalizedAnswer = answer.trim().toLowerCase();
  return normalizedAnswer === "default"
    || normalizedAnswer === "d"
    || normalizedAnswer === "current"
    || normalizedAnswer === "all"
    || normalizedAnswer === "a";
}

/**
 * 格式化 Skills 目标列表，用于菜单动作回显。
 */
function formatTargetList(targets: SkillRegistrationTarget[]): string {
  return targets.map((target) => formatSkillRegistrationTargetName(target)).join("、");
}

/**
 * 格式化 Agent hook 目标列表，用于菜单动作回显。
 */
function formatAgentHookTargetList(targets: Array<Exclude<HookInstallTarget, "git">>): string {
  return targets.map((target) => target === "codex" ? "Codex" : "Claude Code").join("、");
}

/**
 * TTY 菜单动作结束后暂停，避免下一轮菜单清屏导致结果一闪而过。
 * 非 TTY 兜底模式不暂停，保证管道和脚本执行不会被阻塞。
 */
async function pauseAfterMenuAction(enabled: boolean): Promise<void> {
  if (enabled && canUseInteractiveKeys(input, output)) {
    await promptContinue(input, output);
  }
}

/**
 * 包装菜单动作的执行回显。
 * 用户按回车确认后，会立即看到动作开始和完成状态，避免误以为没有响应。
 */
async function runMenuAction(label: string, action: () => Promise<number>): Promise<void> {
  console.log(`\n▶ 开始：${label}`);

  try {
    const exitCode = await action();

    if (exitCode === 0) {
      console.log(`✓ 完成：${label}`);
    } else {
      console.log(`✗ 失败：${label}（退出码 ${exitCode}）`);
    }
  } catch (error) {
    console.log(`✗ 失败：${label}`);
    throw error;
  }
}

/**
 * 打印需要用户输入的动作提示。
 * 这让用户能区分“正在等待输入”和“程序没有响应”。
 */
function printInputHint(message: string): void {
  console.log(`\n请输入信息：${message}`);
}

/**
 * 初始化命令实现。
 * 输出所有操作结果，便于用户看清哪些文件被创建、更新或跳过。
 */
async function runInit(projectRoot: string, args: string[] = []): Promise<number> {
  if (args.length > 1) {
    console.error("init 只接受一个可选 agent 目标。用法：code-helper init [all|codex|claudecode|githubcopilot]");
    return 1;
  }

  const skillRegistrationTargets = args[0] === undefined
    ? await resolveInitSkillRegistrationTargets(projectRoot)
    : parseSkillRegistrationTargets(args[0]);
  const result = await initializeProject({ projectRoot, skillRegistrationTargets });
  printOperations(result.operations);
  return 0;
}

/**
 * 为 init 解析要应用的 agent 工具目标。
 * 已有入口文件可以直接推断；完全无法判断时，交互终端让用户选择，非交互场景保守跳过。
 */
async function resolveInitSkillRegistrationTargets(projectRoot: string): Promise<SkillRegistrationTarget[]> {
  const inferredTargets = await resolveSkillRegistrationTargets(projectRoot);
  const canUseTextMenu = Boolean(input.isTTY && output.isTTY);

  if (inferredTargets.length > 0) {
    return inferredTargets;
  }

  if (canUseInteractiveKeys(input, output)) {
    const result = await promptMultiSelect(
      input,
      output,
      "选择 init 要应用的 agent 工具",
      listSupportedSkillRegistrationTargets().map((target) => ({
        value: target,
        label: formatSkillRegistrationTargetName(target),
        checked: false
      }))
    );
    const selectedTargets = result.cancelled
      ? []
      : result.options.filter((option) => option.checked).map((option) => option.value);

    if (selectedTargets.length === 0) {
      console.log("未选择 agent 工具，init 将只刷新 code-helper 工作区和规则模板，跳过项目级 skills 与 Agent hooks。");
    }

    return selectedTargets;
  }

  if (canUseTextMenu) {
    const rl = createInterface({ input, output });

    try {
      return await askTextInitTargetMenu(rl);
    } finally {
      rl.close();
    }
  }

  console.log("未发现 AGENTS.md、CLAUDE.md 或 GitHub Copilot 入口；非交互模式不会默认全量安装项目级 skills 或 Agent hooks。");
  console.log("如需应用能力，请改用 `code-helper init codex|claudecode|githubcopilot|all`，或先创建对应入口文件后再运行 init。");
  return [];
}

/**
 * raw mode 不可用但仍是 TTY 时，使用数字输入选择 init 目标。
 * 空回车或 0 表示跳过，避免用户误入流程后无法退出。
 */
async function askTextInitTargetMenu(
  rl: ReturnType<typeof createInterface>
): Promise<SkillRegistrationTarget[]> {
  console.log("\n选择 init 要应用的 agent 工具");
  console.log("1. Codex");
  console.log("2. Claude Code");
  console.log("3. GitHub Copilot");
  console.log("A. 全部");
  console.log("0. 跳过项目级 skills 与 Agent hooks");
  console.log("可输入多个编号或名称，例如：1,2 或 codex,claudecode。");

  const answer = (await askQuestionOrDefault(rl, "请选择 agent 工具：", "0")).trim();
  const targets = parseInitTargetSelection(answer);

  if (targets.length === 0) {
    console.log("未选择 agent 工具，init 将只刷新 code-helper 工作区和规则模板，跳过项目级 skills 与 Agent hooks。");
  }

  return targets;
}

/**
 * 解析 init 文本兜底菜单的多目标输入。
 * 同时支持数字、英文目标名和 all，方便 macOS / Windows 终端复制粘贴。
 */
function parseInitTargetSelection(value: string): SkillRegistrationTarget[] {
  if (value === "" || value === "0") {
    return [];
  }

  const targets = new Set<SkillRegistrationTarget>();
  const tokens = value.toLowerCase().split(/[,\s]+/u).filter(Boolean);

  for (const token of tokens) {
    if (token === "a" || token === "all") {
      return listSupportedSkillRegistrationTargets();
    }

    if (token === "1") {
      targets.add("codex");
      continue;
    }

    if (token === "2") {
      targets.add("claudecode");
      continue;
    }

    if (token === "3") {
      targets.add("githubcopilot");
      continue;
    }

    for (const target of parseSkillRegistrationTargets(token)) {
      targets.add(target);
    }
  }

  return [...targets];
}

/**
 * 检查命令实现。
 * 存在 error 时返回 1，方便 CI 或 hook 使用。
 */
async function runCheck(projectRoot: string): Promise<number> {
  const issues = await runChecks(projectRoot);

  if (issues.length === 0) {
    console.log("code-helper check 通过：未发现协作文档结构问题。");
    return 0;
  }

  for (const issue of issues) {
    console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
    if (issue.path) {
      console.log(`  路径：${issue.path}`);
    }
    console.log(`  建议：${issue.suggestion}`);
  }

  return issues.some((issue) => issue.level === "error") ? 1 : 0;
}

/**
 * 应用项目级 Skills。
 * 功能管理菜单已经完成目标选择，这里按显式目标写入对应 agent 的项目级 skills。
 */
async function applyProjectSkills(projectRoot: string, targets: SkillRegistrationTarget[]): Promise<number> {
  await setFeatureEnabled(projectRoot, "skillRegistration", true);
  const operations = (await Promise.all(targets.map((target) => registerProjectSkills(projectRoot, target)))).flat();
  const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();

  printOperations(operations);
  printSkillRegistrationStatus(statuses);
  return 0;
}

/**
 * 取消项目级 Skills。
 * 只删除目标 agent 下 code-helper 管理的 skills；按当前项目或全部取消时同步关闭后续自动注册。
 */
async function removeProjectSkills(
  projectRoot: string,
  targets: SkillRegistrationTarget[],
  shouldDisableFeatureAfterRemove: boolean
): Promise<number> {
  const operations = (await Promise.all(targets.map((target) => unregisterProjectSkills(projectRoot, target)))).flat();
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
async function applyAgentHooks(projectRoot: string, targets: Array<Exclude<HookInstallTarget, "git">>): Promise<number> {
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
async function removeAgentHooks(
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
async function applyGitHook(projectRoot: string): Promise<number> {
  return runHooks(projectRoot, ["install", "git"]);
}

/**
 * 取消 Git pre-commit hook。
 */
async function removeGitHook(projectRoot: string): Promise<number> {
  const exitCode = await runHooks(projectRoot, ["uninstall", "git"]);
  await setFeatureEnabled(projectRoot, "gitHooks", false);
  console.log("已关闭 Git hook 应用能力。");
  return exitCode;
}

/**
 * 查看功能管理状态。
 */
async function printApplyStatus(projectRoot: string): Promise<number> {
  console.log("Skills 状态：");
  await runSkills(projectRoot, ["list"]);
  console.log("");
  console.log("Hooks 状态：");
  await runHooks(projectRoot, ["list"]);
  return 0;
}

/**
 * 非交互功能开关命令。
 * 支持：features list、features enable <key>、features disable <key>。
 */
async function runFeatures(projectRoot: string, args: string[]): Promise<number> {
  const [action, feature] = args;

  if (action === undefined || action === "list") {
    printFeatureList(await loadConfig(projectRoot));
    return 0;
  }

  if (!isFeatureKey(feature)) {
    console.error(`无效功能 key：${feature ?? ""}`);
    printFeatureHelp();
    return 1;
  }

  if (action === "enable" || action === "disable") {
    const config = await setFeatureEnabled(projectRoot, feature, action === "enable");
    printFeatureList(config);
    return 0;
  }

  printFeatureHelp();
  return 1;
}

/**
 * 读取必填菜单输入。
 * 空回车或输入 0 都表示返回上一级，避免用户误入流程后无法退出。
 */
async function askRequiredMenuInput(
  rl: ReturnType<typeof createInterface>,
  question: string
): Promise<string | undefined> {
  const answer = (await askQuestionOrDefault(rl, question, "0")).trim();

  if (answer === "" || answer === "0") {
    return undefined;
  }

  return answer;
}

/**
 * 读取可选菜单输入。
 * 空回车表示接受默认值，输入 0 表示返回上一级。
 */
async function askOptionalMenuInput(
  rl: ReturnType<typeof createInterface>,
  question: string
): Promise<string | undefined> {
  const answer = (await askQuestionOrDefault(rl, question, "")).trim();

  if (answer === "0") {
    return undefined;
  }

  return answer;
}

/**
 * 非 TTY 环境下的文本菜单兜底。
 * 当终端不支持 raw mode 时，仍允许用户输入数字选择。
 */
async function askTextMenu(rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log("\ncode-helper 操作菜单");

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

/**
 * 安全读取用户输入。
 * 当 stdin 已关闭或管道输入提前结束时，返回默认值，避免兜底交互崩溃。
 */
async function askQuestionOrDefault(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultAnswer: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    /**
     * stdin 提前结束时，readline 在部分 Node 版本不会让 question promise settle。
     * 这里主动监听 close，并用默认值返回，避免交互流程悬挂。
     */
    const onClose = (): void => {
      if (!settled) {
        settled = true;
        resolve(defaultAnswer);
      }
    };

    rl.once("close", onClose);

    rl.question(question)
      .then((answer) => {
        if (!settled) {
          settled = true;
          rl.off("close", onClose);
          resolve(answer);
        }
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        rl.off("close", onClose);

        if (error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE") {
          resolve(defaultAnswer);
          return;
        }

        reject(error);
      });
  });
}

/**
 * 计划文档命令。
 * 参数：plan <需求文档相对路径> [功能名称]。
 */
async function runPlan(projectRoot: string, args: string[]): Promise<number> {
  const [requirementPath, featureName] = args;

  if (!requirementPath) {
    console.error("缺少需求文档路径。用法：code-helper plan <需求文档相对路径> [功能名称]");
    return 1;
  }

  const normalizedRequirementPath = normalizeDroppedPath(requirementPath, projectRoot);
  const operations = await createPlanWorkbench({ projectRoot, requirementPath: normalizedRequirementPath, featureName });
  printOperations(operations);
  return 0;
}

/**
 * 手工测试文档命令。
 * 参数：manual-test <功能名称> [标题]。
 */
async function runManualTest(projectRoot: string, args: string[]): Promise<number> {
  const [rawFeatureName, title] = args;
  const featureName = rawFeatureName ?? await selectTaskFeatureNameForCommand(
    projectRoot,
    "选择要生成手工测试文档的任务",
    ["active", "mixed"]
  );

  if (!featureName) {
    console.error("缺少功能名称。用法：code-helper manual-test <中文功能名> [标题]");
    return 1;
  }

  printOperations([await createManualTestDocument({ projectRoot, featureName, title })]);
  return 0;
}

/**
 * 文档归档命令。
 * 参数：archive <功能名称>。
 */
async function runArchive(projectRoot: string, args: string[]): Promise<number> {
  const [rawFeatureName] = args;
  const featureName = rawFeatureName ?? await selectTaskFeatureNameForCommand(
    projectRoot,
    "选择要归档的任务",
    ["active", "mixed"]
  );

  if (!featureName) {
    console.error("缺少功能名称。用法：code-helper archive <中文功能名>");
    return 1;
  }

  printOperations(await archiveFeature(projectRoot, featureName));
  await runTasks(projectRoot, []);
  return 0;
}

/**
 * 功能完成检查命令。
 * 参数：finish [中文功能名] [--check-only] [--json]。
 */
async function runFinish(projectRoot: string, args: string[]): Promise<number> {
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const rawFeatureName = args.find((arg) => !arg.startsWith("--"));

  if (rawFeatureName === undefined && flags.has("--check-only") && !canUseInteractiveKeys(input, output)) {
    printFinishCheckOnlyCandidates(await getSelectableTasks(projectRoot, ["active", "mixed"]));
    return 0;
  }

  const featureName = rawFeatureName ?? await selectTaskFeatureNameForCommand(
    projectRoot,
    "选择要检查完成情况的任务",
    ["active", "mixed"]
  );

  if (!featureName) {
    console.error("缺少功能名称。用法：code-helper finish <中文功能名> [--check-only] [--json]");
    return 1;
  }

  const review = await createCompletionReview(projectRoot, featureName);

  if (flags.has("--json")) {
    console.log(JSON.stringify(review, null, 2));
    return 0;
  }

  printCompletionReview(review, flags.has("--check-only"));
  return 0;
}

/**
 * Agent hook 常用 check-only 模式没有明确功能名。
 * 这时只提示候选任务并返回成功，避免 hook 把正常收尾流程误判为命令失败。
 */
function printFinishCheckOnlyCandidates(tasks: TaskRecord[]): void {
  if (tasks.length === 0) {
    console.log("功能完成检查：当前没有发现活动任务。");
    console.log("如果本轮变更形成长期规则，请询问用户是否更新项目记忆。");
    return;
  }

  console.log("功能完成检查：检测到活动任务，请 agent 选择当前任务后运行更精确的检查。");
  for (const task of tasks) {
    console.log(`- ${task.featureName}（${task.status}）`);
  }
  console.log("建议命令：code-helper finish <中文功能名> --check-only");
}

/**
 * 任务状态列表命令。
 * 参数：tasks [--json]。
 */
async function runTasks(projectRoot: string, args: string[]): Promise<number> {
  const tasks = await listTasks(projectRoot);

  if (args.includes("--json")) {
    console.log(JSON.stringify(tasks, null, 2));
    return 0;
  }

  if (tasks.length === 0) {
    console.log("当前没有发现 plan/result/status 任务文档。");
    return 0;
  }

  for (const task of tasks) {
    console.log(`${task.featureName}: ${task.status}`);
    if (task.activeArtifacts.length > 0) {
      console.log(`  active: ${task.activeArtifacts.join(", ")}`);
    }
    if (task.archivedArtifacts.length > 0) {
      console.log(`  archived: ${task.archivedArtifacts.join(", ")}`);
    }
  }

  return 0;
}

/**
 * 项目级 skills 注册命令。
 * 支持：skills list、skills register [target]、skills unregister [target]、skills doctor、skills audit。
 * register/unregister 不带 target 时按当前项目入口文件推断目标，只有显式 all 才处理全部 agent。
 */
async function runSkills(projectRoot: string, args: string[]): Promise<number> {
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
    await setFeatureEnabled(projectRoot, "skillRegistration", true);
    const operations = (await Promise.all(targets.map((target) => registerProjectSkills(projectRoot, target)))).flat();
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
    const operations = (await Promise.all(targets.map((target) => unregisterProjectSkills(projectRoot, target)))).flat();
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
 * Hooks 管理命令。
 * 支持：hooks list、hooks install <target>、hooks uninstall <target>。
 */
async function runHooks(projectRoot: string, args: string[]): Promise<number> {
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
 * 打印操作结果。
 * 路径可能是绝对路径，保留原样方便用户定位。
 */
function printOperations(operations: OperationResult[]): void {
  for (const operation of operations) {
    console.log(`[${operation.action}] ${operation.path} - ${operation.message}`);
  }
}

/**
 * 打印功能完成检查结果。
 * checkOnly 模式用于 agent hook，输出更强调“下一步必须判断什么”。
 */
function printCompletionReview(review: CompletionReview, checkOnly: boolean): void {
  console.log(`功能完成检查：${review.featureName}`);
  console.log(`任务状态：${review.taskStatus}`);
  console.log(`检查结论：${formatCompletionReviewStatus(review.reviewStatus)}`);
  console.log(`运行模式：${checkOnly ? "仅检查，不修改文件" : "检查并给出下一步建议"}`);
  console.log("");
  console.log("文档状态：");
  console.log(`- 计划文档：${formatDocumentPresence(review.documents.plan)}`);
  console.log(`- 实施记录：${formatDocumentPresence(review.documents.result)}`);
  console.log(`- 状态记录：${formatDocumentPresence(review.documents.status)}`);
  console.log(`- 手工测试：${formatDocumentPresence(review.documents.manualTest)}`);
  console.log("");
  console.log("状态枚举：");
  console.log(`- 未开始：${review.statusCounts.notStarted}`);
  console.log(`- 进行中：${review.statusCounts.inProgress}`);
  console.log(`- 部分完成：${review.statusCounts.partial}`);
  console.log(`- 被阻塞：${review.statusCounts.blocked}`);
  console.log(`- 已完成：${review.statusCounts.done}`);
  console.log("");
  console.log(`当前执行节点：${review.hasCurrentExecutionNode ? "已存在" : "缺失"}`);
  console.log(`子计划队列：${review.hasSubPlanQueue ? "已存在" : "缺失"}`);
  console.log(`建议询问更新记忆：${review.shouldAskMemoryUpdate ? "是" : "否"}`);
  console.log(`建议询问归档：${review.shouldAskArchive ? "是" : "否"}`);
  console.log("");
  console.log("下一步建议：");
  review.recommendations.forEach((recommendation, index) => {
    console.log(`${index + 1}. ${recommendation}`);
  });

  if (review.changedPaths.length > 0) {
    console.log("");
    console.log("检测到的当前变更：");
    review.changedPaths.forEach((path) => {
      console.log(`- ${path}`);
    });
  }
}

/**
 * 把完成检查状态转成中文文案。
 */
function formatCompletionReviewStatus(status: CompletionReview["reviewStatus"]): string {
  const labels: Record<CompletionReview["reviewStatus"], string> = {
    "needs-work": "当前任务仍需继续推进",
    blocked: "当前任务存在阻塞",
    "node-review": "需要先补齐当前执行节点",
    "ready-to-archive": "可在用户确认后归档",
    "missing-docs": "缺少必要协作文档"
  };

  return labels[status];
}

/**
 * 把文档存在状态转成稳定中文输出。
 */
function formatDocumentPresence(document: CompletionReview["documents"]["plan"]): string {
  return `${document.exists ? "已存在" : "缺失"} - ${document.relativePath}`;
}

/**
 * 打印功能开关列表。
 * key 直接展示给用户，便于配合非交互命令使用。
 */
function printFeatureList(config: Awaited<ReturnType<typeof loadConfig>>): void {
  for (const feature of FEATURE_KEYS) {
    const status = config.features[feature].enabled ? "启用" : "关闭";
    console.log(`${feature}: ${status} - ${FEATURE_LABELS[feature]}`);
  }
}

/**
 * 打印项目级 skills 注册状态。
 * 路径使用绝对路径，方便用户排查对应 agent 是否能扫描到文件。
 */
function printSkillRegistrationStatus(
  statuses: Awaited<ReturnType<typeof listProjectSkillRegistrations>>
): void {
  for (const status of statuses) {
    console.log(`${status.target}/${status.name}: ${status.registered ? "已注册" : "未注册"}`);
    console.log(`  path: ${status.path}`);
  }
}

/**
 * 打印 hooks 安装状态。
 */
function printHookInstallationStatus(
  statuses: Awaited<ReturnType<typeof listHookInstallations>>
): void {
  for (const status of statuses) {
    console.log(`${status.target}: ${status.installed ? "已安装" : "未安装"} - ${status.label}`);
    console.log(`  开关：${status.enabled ? "启用" : "关闭"}`);
    console.log(`  path: ${status.path}`);
  }
}

/**
 * 打印 skills doctor 检查结果。
 * 没有问题时输出明确结论，避免用户误以为空命令失败。
 */
function printSkillDoctorIssues(issues: Awaited<ReturnType<typeof runSkillsDoctor>>): void {
  if (issues.length === 0) {
    console.log("skills doctor 通过：未发现项目级 skills 结构问题。");
    return;
  }

  for (const issue of issues) {
    console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
    console.log(`  路径：${issue.path}`);
    console.log(`  建议：${issue.suggestion}`);
  }
}

/**
 * 打印 skills audit 推荐项。
 * audit 是建议型命令，始终返回 0。
 */
function printSkillAuditRecommendations(recommendations: Awaited<ReturnType<typeof runSkillsAudit>>): void {
  for (const recommendation of recommendations) {
    console.log(`[${recommendation.priority}] ${recommendation.code}: ${recommendation.message}`);
    console.log(`  建议：${recommendation.suggestion}`);
  }
}

/**
 * 判断字符串是否是合法 FeatureKey。
 * 运行时 CLI 参数需要显式校验，不能只依赖 TypeScript 类型。
 */
function isFeatureKey(value: string | undefined): value is FeatureKey {
  return FEATURE_KEYS.includes(value as FeatureKey);
}

/**
 * 打印功能开关帮助。
 * 保持简短，避免交互和自动化场景输出过重。
 */
function printFeatureHelp(): void {
  console.log("用法：");
  console.log("  code-helper features list");
  console.log("  code-helper features enable <featureKey>");
  console.log("  code-helper features disable <featureKey>");
}

/**
 * 打印项目级 skills 命令帮助。
 */
function printSkillsHelp(): void {
  console.log("用法：");
  console.log("  code-helper skills list");
  console.log("  code-helper skills register [all|codex|claudecode|githubcopilot]");
  console.log("  code-helper skills unregister [all|codex|claudecode|githubcopilot]");
  console.log("  code-helper skills doctor");
  console.log("  code-helper skills audit");
  console.log("说明：register/unregister 不带 target 时按当前项目已有 AGENTS.md / CLAUDE.md / GitHub Copilot 入口自动选择目标；无法识别时会跳过，请显式传 target。");
}

/**
 * 打印 hooks 命令帮助。
 */
function printHooksHelp(): void {
  console.log("用法：");
  console.log("  code-helper hooks list");
  console.log("  code-helper hooks install [git|codex|claudecode|agent|all]");
  console.log("  code-helper hooks uninstall [git|codex|claudecode|agent|all]");
  console.log("说明：hooks install 会直接应用对应 hook，并同步内部开关；init 只会安装选中 agent 对应的 Agent hooks，不会安装 Git hook。");
}

/**
 * 打印 CLI 帮助。
 * 所有子命令都提供非交互入口，便于测试和集成到脚本。
 */
function printHelp(): void {
  console.log(`code-helper

用法：
  code-helper                         打开交互菜单
  code-helper init [target]           初始化项目规则和工作区，可指定 all|codex|claudecode|githubcopilot
  code-helper check                   检查协作文档结构
  code-helper features list           查看高级功能配置
  code-helper features enable <key>   启用高级功能配置
  code-helper features disable <key>  关闭高级功能配置
  code-helper plan <需求文档> [中文功能名] 生成项目计划文档
  code-helper manual-test <中文功能名> [标题] 生成页面手工测试文档
  code-helper archive <中文功能名>       将功能文档移动到 archive 并识别为已结束
  code-helper finish [中文功能名]        检查当前功能是否完成并提示后续动作
  code-helper tasks [--json]           查看 active / archived / mixed 任务
  code-helper skills list              查看项目级 skills 注册状态
  code-helper skills register [target] 按项目入口或指定 target 注册项目级 skills
  code-helper skills unregister [target] 按项目入口或指定 target 取消注册项目级 skills
  code-helper skills doctor            检查项目级 skills 结构和质量
  code-helper skills audit             根据项目状态给出 skills 建议
  code-helper hooks list               查看 Git / Agent hooks 安装状态
  code-helper hooks install [target]   安装 Git / Agent hooks
  code-helper hooks uninstall [target] 卸载 code-helper 管理的 hooks
`);
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
