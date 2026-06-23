import { stdin as input, stdout as output } from "node:process";

import { archiveFeature, listTasks, type TaskRecord } from "../../archive.js";
import { createCompletionReview } from "../../completion.js";
import { normalizeDroppedPath } from "../../input-utils.js";
import { canUseInteractiveKeys } from "../../terminal-ui.js";
import { createManualTestDocument, createPlanWorkbench } from "../../workflows.js";
import { printCompletionReview, printOperations } from "../output.js";
import {
  getSelectableTasks,
  selectTaskFeatureNameForCommand
} from "../task-selection.js";

/**
 * plan 命令运行选项。
 * inputBasePath 表示命令原始 cwd，用于把相对需求路径转成项目根相对路径。
 */
export interface RunPlanOptions {
  inputBasePath?: string;
}

/**
 * 执行计划文档生成命令。
 * 参数：plan <需求文档相对路径> [功能名称]。
 * projectRoot 必须是输出根目录，不能被需求文档所在目录覆盖。
 */
export async function runPlan(projectRoot: string, args: string[], options: RunPlanOptions = {}): Promise<number> {
  const [requirementPath, featureName] = args;

  if (!requirementPath) {
    console.error("缺少需求文档路径。用法：code-helper plan <需求文档相对路径> [功能名称]");
    return 1;
  }

  const normalizedRequirementPath = normalizeDroppedPath(requirementPath, projectRoot, {
    inputBasePath: options.inputBasePath ?? projectRoot
  });
  const operations = await createPlanWorkbench({ projectRoot, requirementPath: normalizedRequirementPath, featureName });
  printOperations(operations);
  return 0;
}

/**
 * 手工测试文档命令。
 * 参数：manual-test <功能名称> [标题]。
 */
export async function runManualTest(projectRoot: string, args: string[]): Promise<number> {
  const [rawFeatureName, title] = args;
  const featureName = rawFeatureName ?? await selectTaskFeatureNameForCommand(
    projectRoot,
    "选择要生成手工测试模板的任务",
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
export async function runArchive(projectRoot: string, args: string[]): Promise<number> {
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const rawFeatureName = args.find((arg) => !arg.startsWith("--"));
  const featureName = rawFeatureName ?? await selectTaskFeatureNameForCommand(
    projectRoot,
    "选择要归档的任务",
    ["active", "mixed"]
  );

  if (!featureName) {
    console.error("缺少功能名称。用法：code-helper archive <中文功能名> [--resolve-mixed]");
    return 1;
  }

  printOperations(await archiveFeature(projectRoot, featureName, { resolveMixed: flags.has("--resolve-mixed") }));
  await runTasks(projectRoot, []);
  return 0;
}

/**
 * 功能完成检查命令。
 * 参数：finish [中文功能名] [--check-only] [--json]。
 */
export async function runFinish(projectRoot: string, args: string[]): Promise<number> {
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
 * 任务状态列表命令。
 * 参数：tasks [--json]。
 */
export async function runTasks(projectRoot: string, args: string[]): Promise<number> {
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
