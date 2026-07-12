import { join } from "node:path";

import { projectPath } from "../fs-utils.js";

/**
 * code-helper 支持安装的 hooks 目标。
 * git 是提交前兜底；codex 和 claudecode 是 agent 生命周期收尾检查。
 */
export type HookInstallTarget = "git" | "codex" | "claudecode";

/**
 * Agent hook 只覆盖支持 Stop hook 的 agent 目标。
 * Git hook 有独立生命周期，不能混入 JSON 配置处理。
 */
export type AgentHookInstallTarget = Exclude<HookInstallTarget, "git">;

/**
 * 单个 hook 目标的安装状态。
 * CLI 使用该结构展示开关状态和实际配置文件位置。
 */
export interface HookInstallationStatus {
  target: HookInstallTarget;
  label: string;
  path: string;
  enabled: boolean;
  installed: boolean;
}

/**
 * 解析 hooks CLI 的目标参数。
 * hooks 会真实写入 Git 或 agent 配置，因此不再把空目标解释成全部安装。
 */
export function parseHookTargets(value: string): HookInstallTarget[] {
  if (value === "all") {
    return ["git", "codex", "claudecode"];
  }

  if (value === "agent" || value === "agents" || value === "agentHooks") {
    return ["codex", "claudecode"];
  }

  if (value === "git" || value === "pre-commit") {
    return ["git"];
  }

  if (value === "codex") {
    return ["codex"];
  }

  if (value === "claudecode" || value === "claude-code" || value === "claude") {
    return ["claudecode"];
  }

  throw new Error(`不支持的 hooks 目标：${value}。当前支持 git、codex、claudecode、agent 或 all。`);
}

/**
 * 格式化 hook 目标名称。
 * 用户可见文案统一从这里生成，避免安装和卸载提示不一致。
 */
export function formatAgentTargetName(target: AgentHookInstallTarget): string {
  return target === "codex" ? "Codex" : "Claude Code";
}

/**
 * 默认 Git hook 安装路径（假定 .git 为普通目录）。
 * 实际安装/检测请优先使用 git.ts 的 resolveGitHookPath，以支持 worktree。
 */
export function getDefaultGitHookPath(projectRoot: string): string {
  return projectPath(projectRoot, ".git/hooks/pre-commit");
}

/**
 * @deprecated 请使用 getDefaultGitHookPath 或 resolveGitHookPath；保留别名避免外部误用时行为突变。
 * 同步返回默认路径，不解析 worktree。
 */
export function getGitHookPath(projectRoot: string): string {
  return getDefaultGitHookPath(projectRoot);
}

/**
 * Codex 项目级 hooks 配置路径。
 * Codex 使用固定的 .codex/hooks.json 保存项目级 Stop hook。
 */
export function getCodexHooksPath(projectRoot: string): string {
  return projectPath(projectRoot, ".codex/hooks.json");
}

/**
 * Claude Code 项目级 settings 配置路径。
 * 使用 node:path 的 join 生成嵌套路径，兼容 Windows 和 macOS。
 */
export function getClaudeSettingsPath(projectRoot: string): string {
  return projectPath(projectRoot, join(".claude", "settings.json"));
}

/**
 * 返回指定 Agent hook 的配置文件路径。
 * 调用方只需要关心目标类型，不重复编码各 agent 的文件布局。
 */
export function getAgentHookConfigPath(projectRoot: string, target: AgentHookInstallTarget): string {
  return target === "codex" ? getCodexHooksPath(projectRoot) : getClaudeSettingsPath(projectRoot);
}
