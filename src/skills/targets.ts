import { join } from "node:path";

import { projectPath, readTextIfExists } from "../fs-utils.js";
import { directoryExists } from "./shared.js";

/**
 * 当前支持的项目级 skill 注册目标。
 * codex 写入 `.agents/skills`，claudecode 写入 `.claude/skills`，githubcopilot 写入 `.github/skills`。
 */
export type SkillRegistrationTarget = "codex" | "claudecode" | "githubcopilot";

/**
 * 所有支持的注册目标。
 * 显式传入 all 时才会使用完整列表，避免默认行为误注册未使用的 agent 工具。
 */
export const ALL_SKILL_REGISTRATION_TARGETS: SkillRegistrationTarget[] = [
  "codex",
  "claudecode",
  "githubcopilot"
];

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
 * 返回当前支持的项目级 skills 注册目标。
 * 调用方拿到副本，避免外部修改模块内的稳定顺序。
 */
export function listSupportedSkillRegistrationTargets(): SkillRegistrationTarget[] {
  return [...ALL_SKILL_REGISTRATION_TARGETS];
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
 * 根目录已有 AGENTS.md、CLAUDE.md 或 GitHub Copilot 入口时，以这些文件作为实际使用状态；完全没有入口文件时返回空数组，由调用方决定交互选择或保守跳过。
 */
export async function resolveSkillRegistrationTargets(projectRoot: string): Promise<SkillRegistrationTarget[]> {
  const agentsExists = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  const claudeExists = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;
  const copilotInstructionsExists =
    (await readTextIfExists(projectPath(projectRoot, ".github/copilot-instructions.md"))) !== undefined;
  const copilotSkillsExists = await directoryExists(projectPath(projectRoot, ".github/skills"));
  const targets: SkillRegistrationTarget[] = [];

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

/**
 * 校验注册目标。
 * 这个函数让公开 API 即使传入非字面量字符串也能得到明确错误。
 */
export function assertSupportedTarget(target: SkillRegistrationTarget): void {
  if (target !== "codex" && target !== "claudecode" && target !== "githubcopilot") {
    throw new Error(`不支持的 skills 注册目标：${target}。当前支持 codex、claudecode 或 githubcopilot。`);
  }
}

/**
 * 返回不同 agent 工具的项目级 skills 目录。
 */
export function getProjectSkillsDirectory(target: SkillRegistrationTarget): string {
  if (target === "codex") {
    return CODEX_PROJECT_SKILLS_DIRECTORY;
  }

  if (target === "claudecode") {
    return CLAUDE_CODE_PROJECT_SKILLS_DIRECTORY;
  }

  return GITHUB_COPILOT_PROJECT_SKILLS_DIRECTORY;
}

/**
 * 返回项目级 SKILL.md 绝对路径。
 */
export function getSkillFilePath(projectRoot: string, target: SkillRegistrationTarget, directoryName: string): string {
  return projectPath(projectRoot, join(getProjectSkillsDirectory(target), directoryName, "SKILL.md"));
}

/**
 * 返回面向用户展示的 agent 工具名称。
 */
export function formatSkillRegistrationTargetName(target: SkillRegistrationTarget): string {
  if (target === "codex") {
    return "Codex";
  }

  if (target === "claudecode") {
    return "Claude Code";
  }

  return "GitHub Copilot";
}
