import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { FEATURE_KEYS, FEATURE_LABELS } from "./constants.js";
import { archiveFeature, listTasks, type TaskRecord, type TaskStatus } from "./archive.js";
import { loadConfig, setFeatureEnabled } from "./config.js";
import { runChecks } from "./checks.js";
import { initializeProject } from "./init.js";
import { normalizeDroppedPath } from "./input-utils.js";
import {
  listProjectSkillRegistrations,
  parseSkillRegistrationTargets,
  registerProjectSkills,
  resolveSkillRegistrationTargets,
  runSkillsAudit,
  runSkillsDoctor,
  unregisterProjectSkills
} from "./skills.js";
import { canUseInteractiveKeys, promptContinue, promptMultiSelect, promptSelect } from "./terminal-ui.js";
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
        return runInit(projectRoot);
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
      case "tasks":
        return runTasks(projectRoot, args);
      case "skills":
        return runSkills(projectRoot, args);
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
 */
async function runInteractiveMenu(projectRoot: string): Promise<number> {
  const rl = createInterface({ input, output });
  const menuOptions = [
    { value: "1", label: "初始化项目" },
    { value: "2", label: "项目记忆规则优化" },
    { value: "3", label: "项目计划优化" },
    { value: "4", label: "生成人工页面测试文档" },
    { value: "5", label: "功能开关管理" },
    { value: "6", label: "项目规则检查" },
    { value: "7", label: "文档归档" },
    { value: "8", label: "查看任务状态" },
    { value: "9", label: "Skills 管理" },
    { value: "0", label: "退出" }
  ];

  try {
    let shouldExit = false;

    while (!shouldExit) {
      const useKeyMenu = canUseInteractiveKeys(input, output);
      const answer = useKeyMenu
        ? await promptSelect(input, output, "code-helper 操作菜单", menuOptions)
        : await askTextMenu(rl);

      switch (answer.trim()) {
        case "1":
          await runMenuAction("初始化项目", () => runInit(projectRoot));
          await pauseAfterMenuAction(useKeyMenu);
          break;
        case "2":
          await runMenuAction("项目记忆规则优化", async () => {
            await runInit(projectRoot);
            console.log("已刷新项目记忆规则模板。请根据当前变更定向修改 code-helper-docs/user-rules/ 中的专题规则。");
            return 0;
          });
          await pauseAfterMenuAction(useKeyMenu);
          break;
        case "3": {
          printInputHint("项目计划优化需要需求文档路径，支持直接把文件拖到终端。输入 0 或直接回车返回。");
          const requirementPath = await askRequiredMenuInput(rl, "请输入或拖拽需求文档路径：");
          if (requirementPath === undefined) {
            console.log("已取消项目计划优化，返回主菜单。");
            break;
          }

          const featureName = await askOptionalMenuInput(rl, "请输入中文功能名称（可留空，默认取需求标题或中文文件名；输入 0 返回）：");
          if (featureName === undefined) {
            console.log("已取消项目计划优化，返回主菜单。");
            break;
          }

          await runMenuAction("项目计划优化", () =>
            runPlan(projectRoot, [normalizeDroppedPath(requirementPath, projectRoot), featureName].filter(Boolean))
          );
          await pauseAfterMenuAction(useKeyMenu);
          break;
        }
        case "4": {
          const featureName = await selectTaskFeatureNameForMenu(projectRoot, rl, {
            title: "选择要生成手工测试文档的任务",
            statuses: ["active", "mixed"],
            manualHint: "未找到合适任务或需要新建文档时，可手动输入功能名称。输入 0 或直接回车返回。",
            manualQuestion: "请输入功能名称："
          });
          if (featureName === undefined) {
            console.log("已取消生成人工页面测试文档，返回主菜单。");
            break;
          }

          const title = await askOptionalMenuInput(rl, "请输入测试文档标题（可留空；输入 0 返回）：");
          if (title === undefined) {
            console.log("已取消生成人工页面测试文档，返回主菜单。");
            break;
          }

          await runMenuAction("生成人工页面测试文档", () =>
            runManualTest(projectRoot, [featureName, title].filter(Boolean))
          );
          await pauseAfterMenuAction(useKeyMenu);
          break;
        }
        case "5":
          if (await runFeatureMenu(projectRoot, rl)) {
            await pauseAfterMenuAction(useKeyMenu);
          }
          break;
        case "6":
          await runMenuAction("项目规则检查", () => runCheck(projectRoot));
          await pauseAfterMenuAction(useKeyMenu);
          break;
        case "7": {
          const featureName = await selectTaskFeatureNameForMenu(projectRoot, rl, {
            title: "选择要归档的任务",
            statuses: ["active", "mixed"],
            manualHint: "未找到合适任务或需要兼容旧文档时，可手动输入功能名称。输入 0 或直接回车返回。",
            manualQuestion: "请输入要归档的功能名称："
          });
          if (featureName === undefined) {
            console.log("已取消文档归档，返回主菜单。");
            break;
          }

          await runMenuAction("文档归档", () => runArchive(projectRoot, [featureName]));
          await pauseAfterMenuAction(useKeyMenu);
          break;
        }
        case "8":
          await runMenuAction("查看任务状态", () => runTasks(projectRoot, []));
          await pauseAfterMenuAction(useKeyMenu);
          break;
        case "9":
          if (await runSkillMenu(projectRoot, rl)) {
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
 * 交互式 Skills 管理菜单。
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
    ? await promptSelect(input, output, "Skills 管理", options)
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
async function runInit(projectRoot: string): Promise<number> {
  const result = await initializeProject({ projectRoot });
  printOperations(result.operations);
  return 0;
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
 * 交互式功能开关菜单。
 * 修改后只保存配置，不自动重写模板；用户可再执行初始化刷新模板。
 */
async function runFeatureMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>
): Promise<boolean> {
  const config = await loadConfig(projectRoot);

  if (canUseInteractiveKeys(input, output)) {
    const selectedFeatures = await promptMultiSelect(
      input,
      output,
      "功能开关管理",
      FEATURE_KEYS.map((feature) => ({
        value: feature,
        label: `${feature} - ${FEATURE_LABELS[feature]}`,
        checked: config.features[feature].enabled
      }))
    );

    if (selectedFeatures.cancelled) {
      console.log("已取消功能开关修改，返回主菜单。");
      return false;
    }

    console.log(`\n▶ 开始：功能开关管理`);
    let changedCount = 0;

    for (const feature of selectedFeatures.options) {
      if (config.features[feature.value].enabled !== feature.checked) {
        await setFeatureEnabled(projectRoot, feature.value, feature.checked);
        changedCount += 1;
      }
    }

    console.log(`已保存功能开关，变更 ${changedCount} 项。`);
    printFeatureList(await loadConfig(projectRoot));
    console.log(`✓ 完成：功能开关管理`);
    return true;
  }

  await runTextFeatureMenu(projectRoot, rl);
  return false;
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
 * 非 TTY 环境下的数字功能开关菜单。
 * 输入 1..N 切换对应功能，输入 0 返回上一级。
 */
async function runTextFeatureMenu(
  projectRoot: string,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  let shouldReturn = false;

  while (!shouldReturn) {
    const config = await loadConfig(projectRoot);

    console.log("\n功能开关管理");
    FEATURE_KEYS.forEach((feature, index) => {
      const status = config.features[feature].enabled ? "启用" : "关闭";
      console.log(`${index + 1}. ${FEATURE_LABELS[feature]}（${feature}）：${status}`);
    });
    console.log("0. 返回");

    const answer = await askQuestionOrDefault(rl, "请输入数字切换功能，或输入 0 返回：", "0");
    const selectedIndex = Number.parseInt(answer.trim(), 10);

    if (selectedIndex === 0) {
      shouldReturn = true;
      continue;
    }

    if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > FEATURE_KEYS.length) {
      console.log("无效选择，请输入列表中的数字。");
      continue;
    }

    const selectedFeature = FEATURE_KEYS[selectedIndex - 1];
    const current = config.features[selectedFeature].enabled;

    await setFeatureEnabled(projectRoot, selectedFeature, !current);
    console.log(`已${current ? "关闭" : "启用"}：${FEATURE_LABELS[selectedFeature]}`);
  }
}

/**
 * 非 TTY 环境下的文本菜单兜底。
 * 当终端不支持 raw mode 时，仍允许用户输入数字选择。
 */
async function askTextMenu(rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log("\ncode-helper 操作菜单");
  console.log("1. 初始化项目");
  console.log("2. 项目记忆规则优化");
  console.log("3. 项目计划优化");
  console.log("4. 生成人工页面测试文档");
  console.log("5. 功能开关管理");
  console.log("6. 项目规则检查");
  console.log("7. 文档归档");
  console.log("8. 查看任务状态");
  console.log("9. Skills 管理");
  console.log("0. 退出");

  return askQuestionOrDefault(rl, "请选择操作：", "0");
}

/**
 * 非 TTY 环境下的 Skills 管理菜单。
 * 输入 0 立即返回，避免用户误入子菜单后无法退出。
 */
async function askTextSkillMenu(rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log("\nSkills 管理");
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
    const operations = (await Promise.all(targets.map((target) => registerProjectSkills(projectRoot, target)))).flat();
    const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();
    printOperations(operations);
    printSkillRegistrationStatus(statuses);
    return 0;
  }

  if (action === "unregister") {
    const targets = await resolveTargetsForSkillAction(projectRoot, action, rawTarget);
    const operations = (await Promise.all(targets.map((target) => unregisterProjectSkills(projectRoot, target)))).flat();
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
 * 打印操作结果。
 * 路径可能是绝对路径，保留原样方便用户定位。
 */
function printOperations(operations: OperationResult[]): void {
  for (const operation of operations) {
    console.log(`[${operation.action}] ${operation.path} - ${operation.message}`);
  }
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
  console.log("说明：register/unregister 不带 target 时按当前项目已有 AGENTS.md / CLAUDE.md / GitHub Copilot 入口自动选择目标。");
}

/**
 * 打印 CLI 帮助。
 * 所有子命令都提供非交互入口，便于测试和集成到脚本。
 */
function printHelp(): void {
  console.log(`code-helper

用法：
  code-helper                         打开交互菜单
  code-helper init                    初始化项目规则和工作区
  code-helper check                   检查协作文档结构
  code-helper features list           查看功能开关
  code-helper features enable <key>   启用功能
  code-helper features disable <key>  关闭功能
  code-helper plan <需求文档> [中文功能名] 生成项目计划文档
  code-helper manual-test <中文功能名> [标题] 生成页面手工测试文档
  code-helper archive <中文功能名>       将功能文档移动到 archive 并识别为已结束
  code-helper tasks [--json]           查看 active / archived / mixed 任务
  code-helper skills list              查看项目级 skills 注册状态
  code-helper skills register [target] 按项目入口或指定 target 注册项目级 skills
  code-helper skills unregister [target] 按项目入口或指定 target 取消注册项目级 skills
  code-helper skills doctor            检查项目级 skills 结构和质量
  code-helper skills audit             根据项目状态给出 skills 建议
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
