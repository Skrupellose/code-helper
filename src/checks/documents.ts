import { portablePath, projectPath, readTextIfExists } from "../fs-utils.js";
import type { CheckIssue, CodeHelperConfig } from "../types.js";
import { containsChinese, createChineseNameIssue, safeReadDirectory } from "./shared.js";

/**
 * 检查计划、结果和状态目录是否存在。
 * 这些目录是项目计划文档的固定落点。
 */
export async function checkPlanDirectories(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  if (!config.features.planWorkbench.enabled && !config.features.resultSummary.enabled) {
    return issues;
  }

  for (const directory of [config.directories.planDoc, config.directories.resultDoc, config.directories.statusDoc]) {
    const marker = await readTextIfExists(projectPath(projectRoot, `${directory}/.code-helper-keep`));
    const files = await safeReadDirectory(projectPath(projectRoot, directory));

    if (marker === undefined && files === undefined) {
      issues.push({
        level: "error",
        code: "missing-workbench-directory",
        message: `计划文档目录不存在：${directory}`,
        path: directory,
        suggestion: "运行 `npx @skrupellose/code-helper init` 创建计划、结果和状态目录。"
      });
    }
  }

  return issues;
}

/**
 * 检查计划、结果、状态和测试文档是否遵守中文命名规则。
 * 生成端已经强制中文命名；检查端负责发现用户手动创建或旧文档残留。
 */
export async function checkChineseWorkbenchDocuments(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  if (!config.features.planWorkbench.enabled && !config.features.resultSummary.enabled) {
    return issues;
  }

  issues.push(...(await checkPlanDocumentNames(projectRoot, config.directories.planDoc)));
  issues.push(...(await checkPlanDocumentNames(projectRoot, portablePath(config.directories.planDoc, "archive"))));
  issues.push(...(await checkResultDocumentNames(projectRoot, config.directories.resultDoc)));
  issues.push(...(await checkResultDocumentNames(projectRoot, portablePath(config.directories.resultDoc, "archive"))));
  issues.push(...(await checkStatusDocumentNames(projectRoot, config.directories.statusDoc)));
  issues.push(...(await checkStatusDocumentNames(projectRoot, portablePath(config.directories.statusDoc, "archive"))));

  return issues;
}

/**
 * 检查 plan-doc 下的计划文件名。
 * 计划文件必须是 `<中文功能名>.md`，archive 目录本身会跳过。
 */
async function checkPlanDocumentNames(projectRoot: string, relativeDirectory: string): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const files = await safeReadDirectory(projectPath(projectRoot, relativeDirectory));

  if (files === undefined) {
    return issues;
  }

  for (const file of files) {
    if (file === "archive" || file === ".code-helper-keep" || !file.endsWith(".md")) {
      continue;
    }

    const featureName = file.slice(0, -".md".length);
    if (!containsChinese(featureName)) {
      issues.push(createChineseNameIssue(portablePath(relativeDirectory, file), "计划文档必须使用中文功能名，例如 订单管理升级.md。"));
    }
  }

  return issues;
}

/**
 * 检查 result-doc 下的任务目录和结果文件。
 * 任务目录必须是中文功能名，目录内固定使用 实施记录.md 与 手工测试.md。
 */
async function checkResultDocumentNames(projectRoot: string, relativeDirectory: string): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const entries = await safeReadDirectory(projectPath(projectRoot, relativeDirectory));

  if (entries === undefined) {
    return issues;
  }

  for (const entry of entries) {
    if (entry === "archive" || entry === ".code-helper-keep" || entry.startsWith(".")) {
      continue;
    }

    const taskDirectory = portablePath(relativeDirectory, entry);
    if (!containsChinese(entry)) {
      issues.push(createChineseNameIssue(taskDirectory, "结果目录必须使用中文功能名，例如 订单管理升级/。"));
    }

    const files = await safeReadDirectory(projectPath(projectRoot, taskDirectory));
    if (files === undefined) {
      continue;
    }

    for (const file of files) {
      if (file.startsWith(".") || !file.endsWith(".md")) {
        continue;
      }

      if (file !== "实施记录.md" && file !== "手工测试.md") {
        issues.push(createChineseNameIssue(portablePath(taskDirectory, file), "结果文件必须使用中文命名，固定使用 实施记录.md 或 手工测试.md。"));
      }
    }
  }

  return issues;
}

/**
 * 检查 status-doc 下的状态文件名。
 * 状态文件必须是 `<中文功能名>-状态.md`，旧版 `-status.md` 会被识别为不合规。
 */
async function checkStatusDocumentNames(projectRoot: string, relativeDirectory: string): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const files = await safeReadDirectory(projectPath(projectRoot, relativeDirectory));

  if (files === undefined) {
    return issues;
  }

  for (const file of files) {
    if (file === "archive" || file === ".code-helper-keep" || !file.endsWith(".md")) {
      continue;
    }

    if (!file.endsWith("-状态.md")) {
      issues.push(createChineseNameIssue(portablePath(relativeDirectory, file), "状态文档必须使用 <中文功能名>-状态.md。"));
      continue;
    }

    const featureName = file.slice(0, -"-状态.md".length);
    if (!containsChinese(featureName)) {
      issues.push(createChineseNameIssue(portablePath(relativeDirectory, file), "状态文档的功能名必须包含中文。"));
    }
  }

  return issues;
}
