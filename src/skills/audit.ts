import { join } from "node:path";

import { projectPath, readTextIfExists } from "../fs-utils.js";
import { runSkillsDoctor } from "./doctor.js";
import { listProjectSkillRegistrations, type SkillRegistrationStatus } from "./registry.js";
import { directoryExists, readDirectoryIfExists } from "./shared.js";
import {
  ALL_SKILL_REGISTRATION_TARGETS,
  formatSkillRegistrationTargetName,
  resolveSkillRegistrationTargets
} from "./targets.js";

/**
 * skills audit 的推荐项。
 * 该结构只输出建议，不直接修改项目文件。
 */
export interface SkillAuditRecommendation {
  priority: "high" | "medium" | "low";
  code: string;
  message: string;
  suggestion: string;
}

/**
 * 根据当前项目状态给出 skills 管理建议。
 * audit 只输出建议，避免在用户未确认时自动安装或注册更多内容。
 */
export async function runSkillsAudit(projectRoot: string): Promise<SkillAuditRecommendation[]> {
  const recommendations: SkillAuditRecommendation[] = [];
  const inferredTargets = await resolveSkillRegistrationTargets(projectRoot);
  const allStatuses = (
    await Promise.all(ALL_SKILL_REGISTRATION_TARGETS.map((target) => listProjectSkillRegistrations(projectRoot, target)))
  ).flat();
  const registeredTargets = new Set(allStatuses.filter((status) => status.registered).map((status) => status.target));
  const hasUserRules = await directoryExists(projectPath(projectRoot, "code-helper-docs/user-rules"));
  const hasPlanDocs = await directoryExists(projectPath(projectRoot, "code-helper-docs/plan-doc"));
  const hasManualTestDocs = await hasManualTestDocument(projectRoot);
  const hasArchiveDocs =
    (await directoryExists(projectPath(projectRoot, "code-helper-docs/plan-doc/archive"))) ||
    (await directoryExists(projectPath(projectRoot, "code-helper-docs/result-doc/archive"))) ||
    (await directoryExists(projectPath(projectRoot, "code-helper-docs/status-doc/archive")));

  for (const target of inferredTargets) {
    if (!registeredTargets.has(target)) {
      recommendations.push({
        priority: "high",
        code: "missing-inferred-registration",
        message: `${formatSkillRegistrationTargetName(target)} 是当前项目已识别的 agent 工具，但尚未注册 code-helper skills。`,
        suggestion: `运行 \`code-helper skills register ${target}\` 注册对应项目级 skills。`
      });
    }
  }

  if (hasUserRules && !isSkillRegistered(allStatuses, "code-helper-memory-tuning")) {
    recommendations.push({
      priority: "high",
      code: "missing-memory-skill",
      message: "项目已经使用专题规则目录，但缺少项目记忆优化 skill 注册。",
      suggestion: "运行 `code-helper skills register`，让 agent 能自动发现记忆维护规则。"
    });
  }

  if (hasPlanDocs && !isSkillRegistered(allStatuses, "code-helper-plan-workbench")) {
    recommendations.push({
      priority: "medium",
      code: "missing-plan-skill",
      message: "项目已经使用计划文档目录，但缺少项目计划管理 skill 注册。",
      suggestion: "运行 `code-helper skills register`，让大型需求拆分时自动读取计划管理规则。"
    });
  }

  if (hasManualTestDocs && !isSkillRegistered(allStatuses, "code-helper-manual-test-workbench")) {
    recommendations.push({
      priority: "medium",
      code: "missing-manual-test-skill",
      message: "项目已经使用手工测试文档，但缺少手工测试生成 skill 注册。",
      suggestion: "运行 `code-helper skills register`，让 agent 能根据上下文补全手工测试步骤和验收清单。"
    });
  }

  if (hasArchiveDocs && !isSkillRegistered(allStatuses, "code-helper-document-archive")) {
    recommendations.push({
      priority: "medium",
      code: "missing-archive-skill",
      message: "项目已经使用归档目录，但缺少文档归档 skill 注册。",
      suggestion: "运行 `code-helper skills register`，让 agent 能识别 archive 中的已结束任务。"
    });
  }

  const doctorIssues = await runSkillsDoctor(projectRoot);
  const warningCount = doctorIssues.filter((issue) => issue.level === "warning").length;
  const errorCount = doctorIssues.filter((issue) => issue.level === "error").length;

  if (errorCount > 0 || warningCount > 0) {
    recommendations.push({
      priority: errorCount > 0 ? "high" : "low",
      code: "doctor-has-findings",
      message: `skills doctor 发现 ${errorCount} 个错误和 ${warningCount} 个提醒。`,
      suggestion: "运行 `code-helper skills doctor` 查看具体路径和修复建议。"
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      priority: "low",
      code: "skills-healthy",
      message: "当前项目 skills 注册和基础结构没有发现明显缺口。",
      suggestion: "后续引入新 agent 工具或新增长期规则后，再运行 `code-helper skills audit` 复查。"
    });
  }

  return recommendations;
}

/**
 * 判断某个 code-helper skill 是否已经至少在一个目标中注册。
 */
function isSkillRegistered(statuses: SkillRegistrationStatus[], name: string): boolean {
  return statuses.some((status) => status.name === name && status.registered);
}

/**
 * 判断 result-doc 中是否已经存在活动手工测试文档。
 * 归档目录不参与推荐依据，避免已结束任务持续提示当前项目缺少手工测试生成 skill。
 */
async function hasManualTestDocument(projectRoot: string): Promise<boolean> {
  const resultDocRoot = projectPath(projectRoot, "code-helper-docs/result-doc");
  const taskDirectories = await readDirectoryIfExists(resultDocRoot);

  if (taskDirectories === undefined) {
    return false;
  }

  for (const taskDirectory of taskDirectories) {
    if (taskDirectory === "archive") {
      continue;
    }

    const taskDirectoryPath = join(resultDocRoot, taskDirectory);

    if (!(await directoryExists(taskDirectoryPath))) {
      continue;
    }

    if ((await readTextIfExists(join(taskDirectoryPath, "手工测试.md"))) !== undefined) {
      return true;
    }
  }

  return false;
}
