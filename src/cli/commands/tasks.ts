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
 * 解析命令所需功能名：已传参直接使用；否则进入任务选择。
 * cancelled → 打印「已取消。」并返回 exitCode 0；
 * missing → 选择流程内部已打印缺参/无任务提示，返回 exitCode 1（不重复用法）；
 * selected → 返回功能名供后续业务继续。
 */
async function resolveFeatureNameForTaskCommand(
  projectRoot: string,
  rawFeatureName: string | undefined,
  title: string
): Promise<{ featureName: string } | { exitCode: number }> {
  if (rawFeatureName) {
    return { featureName: rawFeatureName };
  }

  const selection = await selectTaskFeatureNameForCommand(projectRoot, title, ["active", "mixed"]);

  if (selection.status === "cancelled") {
    console.log("已取消。");
    return { exitCode: 0 };
  }

  if (selection.status === "missing") {
    // selectTaskFeatureNameForCommand 内部已打印「缺少功能名称…」，此处不再重复用法
    return { exitCode: 1 };
  }

  return { featureName: selection.featureName };
}

/**
 * 手工测试文档命令。
 * 参数：manual-test <功能名称> [标题]。
 */
export async function runManualTest(projectRoot: string, args: string[]): Promise<number> {
  const [rawFeatureName, title] = args;
  const resolved = await resolveFeatureNameForTaskCommand(
    projectRoot,
    rawFeatureName,
    "选择要生成手工测试模板的任务"
  );

  if ("exitCode" in resolved) {
    return resolved.exitCode;
  }

  printOperations([await createManualTestDocument({ projectRoot, featureName: resolved.featureName, title })]);
  return 0;
}

/**
 * 文档归档命令。
 * 参数：archive <功能名称>。
 */
export async function runArchive(projectRoot: string, args: string[]): Promise<number> {
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const rawFeatureName = args.find((arg) => !arg.startsWith("--"));
  const resolved = await resolveFeatureNameForTaskCommand(
    projectRoot,
    rawFeatureName,
    "选择要归档的任务"
  );

  if ("exitCode" in resolved) {
    return resolved.exitCode;
  }

  printOperations(
    await archiveFeature(projectRoot, resolved.featureName, { resolveMixed: flags.has("--resolve-mixed") })
  );
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

  const resolved = await resolveFeatureNameForTaskCommand(
    projectRoot,
    rawFeatureName,
    "选择要检查完成情况的任务"
  );

  if ("exitCode" in resolved) {
    return resolved.exitCode;
  }

  const review = await createCompletionReview(projectRoot, resolved.featureName);

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
