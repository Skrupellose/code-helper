import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "./config.js";
import { projectPath, readTextIfExists, writeText } from "./fs-utils.js";
import { getSkillTemplates } from "./templates.js";
import type { OperationResult } from "./types.js";

/**
 * 当前支持的项目级 skill 注册目标。
 * codex 写入 `.agents/skills`，claudecode 写入 `.claude/skills`，githubcopilot 写入 `.github/skills`。
 */
export type SkillRegistrationTarget = "codex" | "claudecode" | "githubcopilot";

/**
 * 所有支持的注册目标。
 * 显式传入 all 时才会使用完整列表，避免默认行为误注册未使用的 agent 工具。
 */
const ALL_SKILL_REGISTRATION_TARGETS: SkillRegistrationTarget[] = ["codex", "claudecode", "githubcopilot"];

/**
 * code-helper 内置 skill 到项目级目录的映射。
 * directoryName 使用 skill frontmatter 中的 name，便于不同 agent 工具直接识别。
 */
const CODE_HELPER_SKILL_REGISTRATIONS = [
  {
    templateFileName: "memory-tuning.SKILL.md",
    directoryName: "code-helper-memory-tuning"
  },
  {
    templateFileName: "plan-workbench.SKILL.md",
    directoryName: "code-helper-plan-workbench"
  },
  {
    templateFileName: "document-archive.SKILL.md",
    directoryName: "code-helper-document-archive"
  },
  {
    templateFileName: "completion-review.SKILL.md",
    directoryName: "code-helper-completion-review"
  }
] as const;

/**
 * Codex 项目级 skills 根目录。
 * 该目录只影响当前项目，不会注册到用户全局 skills。
 */
const CODEX_PROJECT_SKILLS_DIRECTORY = ".agents/skills";

/**
 * Claude Code 项目级 skills 根目录。
 * 该目录只影响当前项目，不会注册到用户全局 `~/.claude/skills`。
 */
const CLAUDE_CODE_PROJECT_SKILLS_DIRECTORY = ".claude/skills";

/**
 * GitHub Copilot Agent Skills 项目级目录。
 * 该目录遵循 GitHub 当前 skills 目录约定，只在当前仓库内生效。
 */
const GITHUB_COPILOT_PROJECT_SKILLS_DIRECTORY = ".github/skills";

/**
 * 单个项目级 skill 的注册状态。
 * CLI 用它展示当前项目是否已经注册 code-helper skills。
 */
export interface SkillRegistrationStatus {
  target: SkillRegistrationTarget;
  name: string;
  path: string;
  registered: boolean;
}

/**
 * skills doctor 的检查结果。
 * warning 用于可改进项，error 用于会导致 skill 无法被识别的结构问题。
 */
export interface SkillDoctorIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  path: string;
  suggestion: string;
}

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
 * 注册 code-helper 内置 skills 到当前项目。
 * 注册结果按目标写入对应项目级 skills 目录，只影响当前项目。
 */
export async function registerProjectSkills(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex"
): Promise<OperationResult[]> {
  assertSupportedTarget(target);

  const config = await loadConfig(projectRoot);
  if (!config.features.skillRegistration.enabled) {
    throw new Error("Skills 管理功能已关闭，请先执行 `code-helper features enable skillRegistration`。");
  }

  const operations: OperationResult[] = [];
  const templates = getSkillTemplates();

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const template = templates.find((item) => item.fileName === registration.templateFileName);

    if (template === undefined) {
      throw new Error(`缺少内置 skill 模板：${registration.templateFileName}`);
    }

    const targetPath = getSkillFilePath(projectRoot, target, registration.directoryName);
    const existing = await readTextIfExists(targetPath);

    if (existing === template.content) {
      operations.push({
        path: targetPath,
        action: "skipped",
        message: "项目级 skill 已是最新内容"
      });
      continue;
    }

    await writeText(targetPath, template.content);
    operations.push({
      path: targetPath,
      action: existing === undefined ? "created" : "updated",
      message: `已注册 ${formatTargetName(target)} 项目级 skill`
    });
  }

  return operations;
}

/**
 * 取消注册 code-helper 项目级 skills。
 * 只删除各目标目录下的 `code-helper-*` 受控目录，不触碰用户自己的 skills。
 */
export async function unregisterProjectSkills(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex"
): Promise<OperationResult[]> {
  assertSupportedTarget(target);

  const operations: OperationResult[] = [];

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const targetDirectory = projectPath(projectRoot, join(getProjectSkillsDirectory(target), registration.directoryName));
    const targetPath = join(targetDirectory, "SKILL.md");
    const existing = await readTextIfExists(targetPath);

    if (existing === undefined) {
      operations.push({
        path: targetPath,
        action: "skipped",
        message: "项目级 skill 未注册"
      });
      continue;
    }

    await rm(targetDirectory, { recursive: true, force: true });
    operations.push({
      path: targetDirectory,
      action: "updated",
      message: `已取消注册 ${formatTargetName(target)} 项目级 skill`
    });
  }

  const targetRoot = getProjectSkillsDirectory(target);
  await removeEmptyDirectory(projectPath(projectRoot, targetRoot));
  await removeEmptyDirectory(projectPath(projectRoot, dirname(targetRoot)));

  return operations;
}

/**
 * 查看 code-helper 项目级 skills 注册状态。
 * 该函数只检查 code-helper 管理的 skill 名称，不扫描用户自定义 skills。
 */
export async function listProjectSkillRegistrations(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex"
): Promise<SkillRegistrationStatus[]> {
  assertSupportedTarget(target);

  const statuses: SkillRegistrationStatus[] = [];

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const targetPath = getSkillFilePath(projectRoot, target, registration.directoryName);
    statuses.push({
      target,
      name: registration.directoryName,
      path: targetPath,
      registered: (await readTextIfExists(targetPath)) !== undefined
    });
  }

  return statuses;
}

/**
 * 解析 CLI 输入中的注册目标。
 * 不带值时只返回 Codex；交互命令的“按当前项目注册”会使用 resolveSkillRegistrationTargets 单独推断。
 */
export function parseSkillRegistrationTargets(value: string | undefined): SkillRegistrationTarget[] {
  if (value === undefined || value === "" || value === "codex") {
    return ["codex"];
  }

  if (value === "claudecode" || value === "claude-code" || value === "claude") {
    return ["claudecode"];
  }

  if (value === "githubcopilot" || value === "github-copilot" || value === "copilot" || value === "github") {
    return ["githubcopilot"];
  }

  if (value === "all") {
    return [...ALL_SKILL_REGISTRATION_TARGETS];
  }

  throw new Error(`不支持的 skills 注册目标：${value}。当前支持 codex、claudecode、githubcopilot 或 all。`);
}

/**
 * 根据当前项目实际入口文件推断需要注册的 agent 工具。
 * 根目录已有 AGENTS.md、CLAUDE.md 或 GitHub Copilot 入口时，以这些文件作为实际使用状态；完全没有入口文件的新项目默认注册全部。
 */
export async function resolveSkillRegistrationTargets(
  projectRoot: string
): Promise<SkillRegistrationTarget[]> {
  const agentsExists = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  const claudeExists = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;
  const copilotInstructionsExists =
    (await readTextIfExists(projectPath(projectRoot, ".github/copilot-instructions.md"))) !== undefined;
  const copilotSkillsExists = (await directoryExists(projectPath(projectRoot, ".github/skills")));
  const targets: SkillRegistrationTarget[] = [];

  if (agentsExists || claudeExists || copilotInstructionsExists || copilotSkillsExists) {
    if (agentsExists) {
      targets.push("codex");
    }

    if (claudeExists) {
      targets.push("claudecode");
    }

    if (copilotInstructionsExists || copilotSkillsExists) {
      targets.push("githubcopilot");
    }

    return targets;
  }

  return [...ALL_SKILL_REGISTRATION_TARGETS];
}

/**
 * 检查当前项目 skills 的结构和质量。
 * 该函数只做静态检查，不执行任何 skill 中的脚本或命令。
 */
export async function runSkillsDoctor(projectRoot: string): Promise<SkillDoctorIssue[]> {
  const issues: SkillDoctorIssue[] = [];

  for (const target of ALL_SKILL_REGISTRATION_TARGETS) {
    issues.push(...(await checkCodeHelperRegistration(projectRoot, target)));
    issues.push(...(await checkSkillDirectory(projectRoot, target)));
  }

  return issues;
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
  const hasArchiveDocs =
    await directoryExists(projectPath(projectRoot, "code-helper-docs/plan-doc/archive")) ||
    await directoryExists(projectPath(projectRoot, "code-helper-docs/result-doc/archive")) ||
    await directoryExists(projectPath(projectRoot, "code-helper-docs/status-doc/archive"));

  for (const target of inferredTargets) {
    if (!registeredTargets.has(target)) {
      recommendations.push({
        priority: "high",
        code: "missing-inferred-registration",
        message: `${formatTargetName(target)} 是当前项目已识别的 agent 工具，但尚未注册 code-helper skills。`,
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
 * 返回项目级 SKILL.md 绝对路径。
 */
function getSkillFilePath(projectRoot: string, target: SkillRegistrationTarget, directoryName: string): string {
  return projectPath(projectRoot, join(getProjectSkillsDirectory(target), directoryName, "SKILL.md"));
}

/**
 * 校验注册目标。
 * 这个函数让公开 API 即使传入非字面量字符串也能得到明确错误。
 */
function assertSupportedTarget(target: SkillRegistrationTarget): void {
  if (target !== "codex" && target !== "claudecode" && target !== "githubcopilot") {
    throw new Error(`不支持的 skills 注册目标：${target}。当前支持 codex、claudecode 或 githubcopilot。`);
  }
}

/**
 * 返回不同 agent 工具的项目级 skills 目录。
 */
function getProjectSkillsDirectory(target: SkillRegistrationTarget): string {
  if (target === "codex") {
    return CODEX_PROJECT_SKILLS_DIRECTORY;
  }

  if (target === "claudecode") {
    return CLAUDE_CODE_PROJECT_SKILLS_DIRECTORY;
  }

  return GITHUB_COPILOT_PROJECT_SKILLS_DIRECTORY;
}

/**
 * 返回面向用户展示的 agent 工具名称。
 */
function formatTargetName(target: SkillRegistrationTarget): string {
  if (target === "codex") {
    return "Codex";
  }

  if (target === "claudecode") {
    return "Claude Code";
  }

  return "GitHub Copilot";
}

/**
 * 删除空目录。
 * 目录不存在或非空时保持现状，避免误删用户自定义 skills。
 */
async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    const entries = await readdir(path);

    if (entries.length === 0) {
      await rm(path, { recursive: false, force: true });
    }
  } catch {
    // 目录不存在或不可删除时不处理，取消注册不应影响用户文件。
  }
}

/**
 * 检查 code-helper 管理的 skill 是否缺失或过期。
 */
async function checkCodeHelperRegistration(
  projectRoot: string,
  target: SkillRegistrationTarget
): Promise<SkillDoctorIssue[]> {
  const issues: SkillDoctorIssue[] = [];
  const templates = getSkillTemplates();

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const template = templates.find((item) => item.fileName === registration.templateFileName);
    const skillPath = getSkillFilePath(projectRoot, target, registration.directoryName);
    const existing = await readTextIfExists(skillPath);

    if (existing === undefined) {
      continue;
    }

    if (template !== undefined && existing !== template.content) {
      issues.push({
        level: "warning",
        code: "outdated-code-helper-skill",
        message: `${formatTargetName(target)} 中的 ${registration.directoryName} 与当前内置模板不一致。`,
        path: skillPath,
        suggestion: `运行 \`code-helper skills register ${target}\` 刷新 code-helper 管理的 skill。`
      });
    }
  }

  return issues;
}

/**
 * 检查指定 agent skills 目录下的所有 SKILL.md。
 */
async function checkSkillDirectory(projectRoot: string, target: SkillRegistrationTarget): Promise<SkillDoctorIssue[]> {
  const issues: SkillDoctorIssue[] = [];
  const skillsRoot = projectPath(projectRoot, getProjectSkillsDirectory(target));
  const entries = await readDirectoryIfExists(skillsRoot);

  if (entries === undefined) {
    return issues;
  }

  for (const entry of entries) {
    const skillPath = join(skillsRoot, entry, "SKILL.md");
    const content = await readSkillDocumentIfExists(skillPath);

    if (content === undefined) {
      issues.push({
        level: "error",
        code: "missing-skill-md",
        message: `${formatTargetName(target)} skill 目录缺少 SKILL.md：${entry}`,
        path: join(skillsRoot, entry),
        suggestion: "补齐 SKILL.md，或删除空的 skill 目录。"
      });
      continue;
    }

    issues.push(...checkSkillDocument(target, entry, skillPath, content));
  }

  return issues;
}

/**
 * 检查单个 SKILL.md 的基本结构。
 */
function checkSkillDocument(
  target: SkillRegistrationTarget,
  directoryName: string,
  skillPath: string,
  content: string
): SkillDoctorIssue[] {
  const issues: SkillDoctorIssue[] = [];
  const frontmatter = parseSkillFrontmatter(content);

  if (frontmatter === undefined) {
    issues.push({
      level: "error",
      code: "missing-frontmatter",
      message: `${formatTargetName(target)} skill 缺少 YAML frontmatter：${directoryName}`,
      path: skillPath,
      suggestion: "在文件开头补充包含 name 和 description 的 frontmatter。"
    });
    return issues;
  }

  if (frontmatter.name === undefined || frontmatter.name.trim() === "") {
    issues.push({
      level: "error",
      code: "missing-skill-name",
      message: `${formatTargetName(target)} skill 缺少 name：${directoryName}`,
      path: skillPath,
      suggestion: "在 frontmatter 中补充稳定的 name 字段。"
    });
  } else if (frontmatter.name !== directoryName) {
    issues.push({
      level: "warning",
      code: "skill-name-directory-mismatch",
      message: `${formatTargetName(target)} skill 的 name 与目录名不一致：${directoryName}`,
      path: skillPath,
      suggestion: "优先保持目录名与 frontmatter name 一致，降低不同 agent 工具识别差异。"
    });
  }

  if (frontmatter.description === undefined || frontmatter.description.trim().length < 20) {
    issues.push({
      level: "warning",
      code: "weak-skill-description",
      message: `${formatTargetName(target)} skill 的 description 过短或缺失：${directoryName}`,
      path: skillPath,
      suggestion: "补充包含触发场景、输入条件和输出目标的 description。"
    });
  }

  if (!content.includes("## ")) {
    issues.push({
      level: "warning",
      code: "missing-skill-sections",
      message: `${formatTargetName(target)} skill 缺少二级标题结构：${directoryName}`,
      path: skillPath,
      suggestion: "至少补充目标、适用场景、流程或边界规则等小节，便于 agent 按需读取。"
    });
  }

  return issues;
}

/**
 * 解析 skill frontmatter 中的 name 和 description。
 * 这里只做轻量解析，避免为了静态检查引入 YAML 依赖。
 */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);

  if (match === null) {
    return undefined;
  }

  const result: { name?: string; description?: string } = {};

  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^(name|description):\s*(.*)$/u.exec(line);

    if (field !== null) {
      result[field[1] as "name" | "description"] = field[2].trim();
    }
  }

  return result;
}

/**
 * 判断某个 code-helper skill 是否已经至少在一个目标中注册。
 */
function isSkillRegistered(statuses: SkillRegistrationStatus[], name: string): boolean {
  return statuses.some((status) => status.name === name && status.registered);
}

/**
 * 安全判断目录是否存在。
 */
async function directoryExists(path: string): Promise<boolean> {
  return (await readDirectoryIfExists(path)) !== undefined;
}

/**
 * 安全读取目录；目录不存在或不是目录时返回 undefined。
 */
async function readDirectoryIfExists(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }

    throw error;
  }
}

/**
 * 安全读取单个 SKILL.md。
 * skills 根目录下混入普通文件时，`目录名/SKILL.md` 会触发 ENOTDIR，这里把它归为结构缺失问题。
 */
async function readSkillDocumentIfExists(path: string): Promise<string | undefined> {
  try {
    return await readTextIfExists(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR") {
      return undefined;
    }

    throw error;
  }
}
