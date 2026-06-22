import { loadConfig } from "./config.js";
import { checkArchiveState } from "./checks/archive.js";
import { checkConfig, checkRawConfig } from "./checks/config.js";
import { checkChineseWorkbenchDocuments, checkPlanDirectories } from "./checks/documents.js";
import { checkEntryDocuments } from "./checks/entries.js";
import { checkRuleDocuments } from "./checks/rules.js";
import { checkTestingPolicy } from "./checks/testing-policy.js";
import { projectPath, writeText } from "./fs-utils.js";
import type { CheckIssue } from "./types.js";

/**
 * 运行项目协作规则检查。
 * 默认只读项目结构；需要持久化报告时由调用方显式传入 writeReport。
 */
export async function runChecks(projectRoot: string, options: { writeReport?: boolean } = {}): Promise<CheckIssue[]> {
  const rawConfigIssues = await checkRawConfig(projectRoot);
  if (rawConfigIssues.some((issue) => issue.code === "invalid-config-json" || issue.code === "invalid-config-shape")) {
    return rawConfigIssues;
  }

  const config = await loadConfig(projectRoot);
  const issues: CheckIssue[] = [];

  if (!config.features.checks.enabled) {
    return issues;
  }

  issues.push(...rawConfigIssues);
  issues.push(...(await checkConfig(config)));
  issues.push(...(await checkEntryDocuments(projectRoot, config)));
  issues.push(...(await checkRuleDocuments(projectRoot, config)));
  issues.push(...(await checkPlanDirectories(projectRoot, config)));
  issues.push(...(await checkChineseWorkbenchDocuments(projectRoot, config)));
  issues.push(...(await checkTestingPolicy(projectRoot, config)));
  issues.push(...(await checkArchiveState(projectRoot, config)));

  if (options.writeReport === true) {
    await writeText(
      projectPath(projectRoot, `${config.directories.workspace}/checks/latest.json`),
      `${JSON.stringify({ checkedAt: new Date().toISOString(), issues }, null, 2)}\n`
    );
  }

  return issues;
}
