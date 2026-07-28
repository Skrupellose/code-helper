import { stat } from "node:fs/promises";

import {
  COMPLETION_RECORD_KIND,
  COMPLETION_RECORD_LIFECYCLE,
  COMPLETION_RECORD_TRACKING_MODE,
  isValidCompletionRecordFileName,
  listCompletionRecordFiles,
  parseCompletionRecordFrontmatter
} from "../completion-record.js";
import { findTaskByFeatureName, listTasks } from "../archive.js";
import { COMPLETION_RECORD_DIRECTORY } from "../constants.js";
import { projectPath, readTextIfExists } from "../fs-utils.js";
import type { CheckIssue } from "../types.js";

/** 完成记录必须保留的精简复盘章节。 */
const REQUIRED_SECTIONS = [
  "任务背景",
  "实施总结",
  "实际改动",
  "验证结果",
  "未验证事项",
  "风险与后续"
] as const;

/**
 * 校验完成记录目录、中文命名、终态元数据与必要章节。
 *
 * 完成记录有独立契约，不能复用 plan/status/result 完整性检查，否则单独存在的
 * recorded 文件会再次被误判为 missing-docs。
 */
export async function checkCompletionRecords(projectRoot: string): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const marker = await readTextIfExists(
    projectPath(projectRoot, `${COMPLETION_RECORD_DIRECTORY}/.code-helper-keep`)
  );
  const records = await listCompletionRecordFiles(projectRoot);
  const planningTasks = await listTasks(projectRoot);

  // 初始化只需确保目录存在，不强制写占位文件；目录缺失时 list 返回空数组，
  // 额外通过 marker/目录探测区分“空目录”和“不存在”。
  if (marker === undefined && !(await completionRecordDirectoryExists(projectRoot))) {
    issues.push({
      level: "error",
      code: "missing-completion-record-directory",
      message: `完成记录目录不存在：${COMPLETION_RECORD_DIRECTORY}`,
      path: COMPLETION_RECORD_DIRECTORY,
      suggestion: "运行 `npx @skrupellose/code-helper init` 创建独立的完成记录目录。"
    });
    return issues;
  }

  for (const record of records) {
    if (!isValidCompletionRecordFileName(record.fileName)) {
      issues.push({
        level: "warning",
        code: "invalid-completion-record-name",
        message: `完成记录名称不符合 <中文功能名>-完成记录.md：${record.relativePath}`,
        path: record.relativePath,
        suggestion: "把文件重命名为包含中文功能名且以 -完成记录.md 结尾的名称。"
      });
    }

    const recordFeatureName = record.fileName.endsWith("-完成记录.md")
      ? record.fileName.slice(0, -"-完成记录.md".length)
      : record.fileName.replace(/\.md$/u, "");
    const matchingTask = findTaskByFeatureName(planningTasks, recordFeatureName);
    if (matchingTask !== undefined) {
      issues.push({
        level: "error",
        code: "completion-record-task-conflict",
        message: `完成记录与 ${matchingTask.status} 计划任务重名：${record.relativePath}`,
        path: record.relativePath,
        suggestion: "保留计划任务的 plan/status/result 生命周期，并移除或重命名冲突的完成记录。"
      });
    }

    const frontmatter = parseCompletionRecordFrontmatter(record.content);
    if (
      frontmatter?.["code-helper-kind"] !== COMPLETION_RECORD_KIND
      || frontmatter?.["tracking-mode"] !== COMPLETION_RECORD_TRACKING_MODE
      || frontmatter?.lifecycle !== COMPLETION_RECORD_LIFECYCLE
    ) {
      issues.push({
        level: "error",
        code: "invalid-completion-record-frontmatter",
        message: `完成记录缺少合法终态元数据：${record.relativePath}`,
        path: record.relativePath,
        suggestion: "设置 code-helper-kind: completion-record、tracking-mode: direct、lifecycle: recorded。"
      });
    }

    for (const section of REQUIRED_SECTIONS) {
      if (!record.content.includes(`## ${section}`)) {
        issues.push({
          level: "error",
          code: "missing-completion-record-section",
          message: `完成记录缺少必要章节“${section}”：${record.relativePath}`,
          path: record.relativePath,
          suggestion: `补充二级标题“## ${section}”及对应实施事实。`
        });
      }
    }
  }

  return issues;
}

/** 只探测完成记录目录本身，避免把空目录误判为缺失。 */
async function completionRecordDirectoryExists(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(projectPath(projectRoot, COMPLETION_RECORD_DIRECTORY))).isDirectory();
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}
