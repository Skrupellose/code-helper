import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { FEATURE_KEYS, FEATURE_LABELS } from "./constants.js";
import { archiveFeature, listTasks } from "./archive.js";
import { loadConfig, setFeatureEnabled } from "./config.js";
import { runChecks } from "./checks.js";
import { initializeProject } from "./init.js";
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

  try {
    let shouldExit = false;

    while (!shouldExit) {
      console.log("\ncode-helper 操作菜单");
      console.log("1. 初始化项目");
      console.log("2. 项目记忆规则优化");
      console.log("3. 项目计划优化");
      console.log("4. 生成人工页面测试文档");
      console.log("5. 功能开关管理");
      console.log("6. 项目规则检查");
      console.log("7. 文档归档");
      console.log("8. 查看任务状态");
      console.log("0. 退出");

      const answer = await rl.question("请选择操作：");

      switch (answer.trim()) {
        case "1":
          await runInit(projectRoot);
          break;
        case "2":
          await runInit(projectRoot);
          console.log("已刷新项目记忆规则模板。请根据当前变更定向修改 .agent/user-rules/ 中的专题规则。");
          break;
        case "3": {
          const requirementPath = await rl.question("请输入需求文档相对路径：");
          const featureName = await rl.question("请输入功能名称（可留空，默认取需求文件名）：");
          await runPlan(projectRoot, [requirementPath.trim(), featureName.trim()].filter(Boolean));
          break;
        }
        case "4": {
          const featureName = await rl.question("请输入功能名称：");
          const title = await rl.question("请输入测试文档标题（可留空）：");
          await runManualTest(projectRoot, [featureName.trim(), title.trim()].filter(Boolean));
          break;
        }
        case "5":
          await runFeatureMenu(projectRoot, rl);
          break;
        case "6":
          await runCheck(projectRoot);
          break;
        case "7": {
          const featureName = await rl.question("请输入要归档的功能名称：");
          await runArchive(projectRoot, [featureName.trim()].filter(Boolean));
          break;
        }
        case "8":
          await runTasks(projectRoot, []);
          break;
        case "0":
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
): Promise<void> {
  const config = await loadConfig(projectRoot);
  printFeatureList(config);
  const feature = await rl.question("请输入要切换的功能 key：");
  const selectedFeature = feature.trim();

  if (!isFeatureKey(selectedFeature)) {
    console.log("无效功能 key。");
    return;
  }

  const current = config.features[selectedFeature].enabled;
  await setFeatureEnabled(projectRoot, selectedFeature, !current);
  console.log(`已${current ? "关闭" : "启用"}：${FEATURE_LABELS[selectedFeature]}`);
}

/**
 * 计划工作台命令。
 * 参数：plan <需求文档相对路径> [功能名称]。
 */
async function runPlan(projectRoot: string, args: string[]): Promise<number> {
  const [requirementPath, featureName] = args;

  if (!requirementPath) {
    console.error("缺少需求文档路径。用法：code-helper plan <需求文档相对路径> [功能名称]");
    return 1;
  }

  const operations = await createPlanWorkbench({ projectRoot, requirementPath, featureName });
  printOperations(operations);
  return 0;
}

/**
 * 手工测试文档命令。
 * 参数：manual-test <功能名称> [标题]。
 */
async function runManualTest(projectRoot: string, args: string[]): Promise<number> {
  const [featureName, title] = args;

  if (!featureName) {
    console.error("缺少功能名称。用法：code-helper manual-test <功能名称> [标题]");
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
  const [featureName] = args;

  if (!featureName) {
    console.error("缺少功能名称。用法：code-helper archive <功能名称>");
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
  code-helper plan <需求文档> [名称]   生成项目计划工作台
  code-helper manual-test <名称> [标题] 生成页面手工测试文档
  code-helper archive <名称>           将功能文档移动到 archive 并识别为已结束
  code-helper tasks [--json]           查看 active / archived / mixed 任务
`);
}
