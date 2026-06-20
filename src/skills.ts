import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "./config.js";
import { projectPath, readTextIfExists, writeText } from "./fs-utils.js";
import { getSkillTemplates } from "./templates.js";
import type { OperationResult } from "./types.js";

/**
 * 当前支持的项目级 skill 注册目标。
 * codex 写入 `.agents/skills`，claudecode 写入 `.claude/skills`。
 */
export type SkillRegistrationTarget = "codex" | "claudecode";

/**
 * 所有支持的注册目标。
 * 显式传入 all 时才会使用完整列表，避免默认行为误注册未使用的 agent 工具。
 */
const ALL_SKILL_REGISTRATION_TARGETS: SkillRegistrationTarget[] = ["codex", "claudecode"];

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
 * 注册 code-helper 内置 skills 到当前项目。
 * 注册结果按目标写入 `.agents/skills` 或 `.claude/skills`，只影响当前项目。
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
 * 只删除 `.agents/skills/code-helper-*` 或 `.claude/skills/code-helper-*` 受控目录，不触碰用户自己的 skills。
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

  if (value === "all") {
    return [...ALL_SKILL_REGISTRATION_TARGETS];
  }

  throw new Error(`不支持的 skills 注册目标：${value}。当前支持 codex、claudecode 或 all。`);
}

/**
 * 根据当前项目实际入口文件推断需要注册的 agent 工具。
 * 根目录已有 AGENTS.md 或 CLAUDE.md 时，以这些文件作为实际使用状态；完全没有入口文件的新项目默认注册全部。
 */
export async function resolveSkillRegistrationTargets(
  projectRoot: string
): Promise<SkillRegistrationTarget[]> {
  const agentsExists = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  const claudeExists = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;
  const targets: SkillRegistrationTarget[] = [];

  if (agentsExists || claudeExists) {
    if (agentsExists) {
      targets.push("codex");
    }

    if (claudeExists) {
      targets.push("claudecode");
    }

    return targets;
  }

  return [...ALL_SKILL_REGISTRATION_TARGETS];
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
  if (target !== "codex" && target !== "claudecode") {
    throw new Error(`不支持的 skills 注册目标：${target}。当前支持 codex 或 claudecode。`);
  }
}

/**
 * 返回不同 agent 工具的项目级 skills 目录。
 */
function getProjectSkillsDirectory(target: SkillRegistrationTarget): string {
  return target === "codex" ? CODEX_PROJECT_SKILLS_DIRECTORY : CLAUDE_CODE_PROJECT_SKILLS_DIRECTORY;
}

/**
 * 返回面向用户展示的 agent 工具名称。
 */
function formatTargetName(target: SkillRegistrationTarget): string {
  return target === "codex" ? "Codex" : "Claude Code";
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
