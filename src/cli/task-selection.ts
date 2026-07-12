import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { listTasks, type TaskRecord, type TaskStatus } from "../archive.js";
import { canUseInteractiveKeys, promptSelect, TerminalCancelError } from "../terminal-ui.js";
import { askQuestionOrDefault, askRequiredMenuInput, printInputHint, type MenuReadline } from "./menu-input.js";

/**
 * 在菜单中选择一个任务功能名。
 * 优先从已有任务文档选择；没有合适任务或用户选择手动输入时，再回退到文本输入。
 */
export async function selectTaskFeatureNameForMenu(
  projectRoot: string,
  rl: MenuReadline,
  options: {
    title: string;
    statuses: TaskStatus[];
    manualHint: string;
    manualQuestion: string;
  }
): Promise<string | undefined> {
  const tasks = await getSelectableTasks(projectRoot, options.statuses);

  if (tasks.length > 0) {
    let answer: string;
    try {
      answer = canUseInteractiveKeys(input, output)
        ? await promptSelect(input, output, options.title, buildTaskSelectOptions(tasks, true))
        : await askTextTaskMenu(rl, options.title, tasks);
    } catch (error) {
      // Esc 取消任务选择，返回上级菜单
      if (error instanceof TerminalCancelError) {
        return undefined;
      }
      throw error;
    }

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
export async function selectTaskFeatureNameForCommand(
  projectRoot: string,
  title: string,
  statuses: TaskStatus[]
): Promise<string | undefined> {
  const tasks = await getSelectableTasks(projectRoot, statuses);

  if (tasks.length === 0) {
    console.error("缺少功能名称，且当前没有发现可选择的活动任务。");
    return undefined;
  }

  if (!input.isTTY || !output.isTTY) {
    console.error("缺少功能名称。可用任务：");
    for (const task of tasks) {
      console.error(`- ${task.featureName}（${task.status}）`);
    }
    return undefined;
  }

  if (!canUseInteractiveKeys(input, output)) {
    const rl = createInterface({ input, output });

    try {
      const answer = await askTextTaskMenu(rl, title, tasks);
      return resolveTaskSelectionForCommand(answer, tasks, rl);
    } finally {
      rl.close();
    }
  }

  let answer: string;
  try {
    answer = await promptSelect(input, output, title, buildTaskSelectOptions(tasks, true));
  } catch (error) {
    // 直接命令场景 Esc 视为取消选择，不退出进程
    if (error instanceof TerminalCancelError) {
      return undefined;
    }
    throw error;
  }

  const rl = createInterface({ input, output });

  try {
    return await resolveTaskSelectionForCommand(answer, tasks, rl);
  } finally {
    rl.close();
  }
}

/**
 * 读取可供动作选择的任务。
 * archived 任务已经结束，不会默认出现在生成手工测试和归档动作中。
 */
export async function getSelectableTasks(projectRoot: string, statuses: TaskStatus[]): Promise<TaskRecord[]> {
  const allowedStatuses = new Set(statuses);

  return (await listTasks(projectRoot)).filter((task) => allowedStatuses.has(task.status));
}

/**
 * 为任务选择菜单生成稳定 value。
 * value 使用数组下标，避免功能名中包含特殊字符时影响菜单控制项。
 */
export function buildTaskSelectOptions(
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
 * 将任务选择菜单结果解析为功能名。
 * 直接命令也保留手动输入入口，兼容旧文档或尚未生成完整任务记录的场景。
 */
async function resolveTaskSelectionForCommand(
  answer: string,
  tasks: TaskRecord[],
  rl: MenuReadline
): Promise<string | undefined> {

  if (answer === "__return__" || answer === "__manual__") {
    if (answer === "__manual__") {
      return askRequiredMenuInput(rl, "请输入功能名称：");
    }

    return undefined;
  }

  return tasks[Number.parseInt(answer, 10)]?.featureName;
}

/**
 * 非 raw mode 终端下的任务选择菜单。
 * 数字选择任务，M 表示手动输入，0 表示返回。
 */
async function askTextTaskMenu(
  rl: MenuReadline,
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
