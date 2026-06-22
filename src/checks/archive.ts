import { listTasks } from "../archive.js";
import { projectPath } from "../fs-utils.js";
import type { CheckIssue, CodeHelperConfig } from "../types.js";
import { safeReadDirectory } from "./shared.js";

/**
 * 检查文档归档目录和任务状态。
 * archive 中的任务视为已结束；同名任务同时存在 active 与 archive 时只提示 mixed 冲突，不自动清理。
 */
export async function checkArchiveState(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  if (!config.features.documentArchive.enabled) {
    return issues;
  }

  for (const directory of [
    `${config.directories.planDoc}/archive`,
    `${config.directories.resultDoc}/archive`,
    `${config.directories.statusDoc}/archive`
  ]) {
    const files = await safeReadDirectory(projectPath(projectRoot, directory));

    if (files === undefined) {
      issues.push({
        level: "error",
        code: "missing-archive-directory",
        message: `归档目录不存在：${directory}`,
        path: directory,
        suggestion: "运行 `npx @skrupellose/code-helper init` 创建文档归档目录。"
      });
    }
  }

  for (const task of await listTasks(projectRoot)) {
    if (task.status === "mixed") {
      issues.push({
        level: "warning",
        code: "mixed-task-archive-state",
        message: `任务同时存在活动文档和归档文档：${task.featureName}`,
        suggestion: "确认该任务是否已经结束；如果已结束，运行 `npx @skrupellose/code-helper archive <中文功能名>` 或手动补齐归档。"
      });
    }
  }

  return issues;
}
