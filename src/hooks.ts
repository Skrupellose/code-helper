import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { ensureTrailingNewline, projectPath, readTextIfExists, writeText } from "./fs-utils.js";
import type { OperationResult } from "./types.js";

/**
 * code-helper 支持安装的 hooks 目标。
 * git 是提交前兜底；codex 和 claudecode 是 agent 生命周期收尾检查。
 */
export type HookInstallTarget = "git" | "codex" | "claudecode";

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
 * code-helper 管理的 hook 标记。
 * 卸载时只删除带该命令特征的配置，避免误删用户自定义 hook。
 */
const CODE_HELPER_HOOK_COMMAND = "npx @skrupellose/code-helper finish --check-only";
const CODE_HELPER_HOOK_COMMAND_WINDOWS = "npx.cmd @skrupellose/code-helper finish --check-only";
const CODE_HELPER_HOOK_STATUS_MESSAGE = "运行 code-helper 完成检查";
const CODE_HELPER_GIT_HOOK_MARKER = "# code-helper:managed-pre-commit";

/**
 * 查看所有 hook 安装状态。
 */
export async function listHookInstallations(projectRoot: string): Promise<HookInstallationStatus[]> {
  const config = await loadConfig(projectRoot);

  return [
    {
      target: "git",
      label: "Git pre-commit",
      path: getGitHookPath(projectRoot),
      enabled: config.features.gitHooks.enabled,
      installed: await isGitHookInstalled(projectRoot)
    },
    {
      target: "codex",
      label: "Codex Stop hook",
      path: getCodexHooksPath(projectRoot),
      enabled: config.features.agentHooks.enabled,
      installed: await isJsonHookInstalled(projectRoot, "codex")
    },
    {
      target: "claudecode",
      label: "Claude Code Stop hook",
      path: getClaudeSettingsPath(projectRoot),
      enabled: config.features.agentHooks.enabled,
      installed: await isJsonHookInstalled(projectRoot, "claudecode")
    }
  ];
}

/**
 * 安装指定 hook。
 * 安装动作受对应功能开关控制，避免用户只想保留 sample 时被写入真实配置。
 */
export async function installHook(projectRoot: string, target: HookInstallTarget): Promise<OperationResult> {
  if (target === "git") {
    return installGitHook(projectRoot);
  }

  return installAgentHook(projectRoot, target);
}

/**
 * 卸载指定 hook。
 * 卸载不受功能开关限制，用户关闭开关后仍应能清理已安装配置。
 */
export async function uninstallHook(projectRoot: string, target: HookInstallTarget): Promise<OperationResult> {
  if (target === "git") {
    return uninstallGitHook(projectRoot);
  }

  return uninstallAgentHook(projectRoot, target);
}

/**
 * 解析 hooks CLI 的目标参数。
 */
export function parseHookTargets(value: string | undefined): HookInstallTarget[] {
  if (value === undefined || value === "" || value === "all") {
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
 * 安装 Git pre-commit hook。
 */
async function installGitHook(projectRoot: string): Promise<OperationResult> {
  await assertGitRepository(projectRoot);

  const targetPath = getGitHookPath(projectRoot);
  const existing = await readTextIfExists(targetPath);
  const content = renderGitHook();

  if (existing === content) {
    return {
      path: targetPath,
      action: "skipped",
      message: "Git pre-commit hook 已是最新内容"
    };
  }

  if (existing !== undefined && !existing.includes(CODE_HELPER_GIT_HOOK_MARKER)) {
    throw new Error(`已存在非 code-helper 管理的 Git hook：${targetPath}。请手动合并后再安装。`);
  }

  await writeText(targetPath, content);
  await chmod(targetPath, 0o755);

  return {
    path: targetPath,
    action: existing === undefined ? "created" : "updated",
    message: "已安装 Git pre-commit hook"
  };
}

/**
 * 确认当前目录是 Git 仓库。
 * 不存在 .git 时不主动创建，避免把普通目录误改成半成品 Git 结构。
 */
async function assertGitRepository(projectRoot: string): Promise<void> {
  try {
    const gitDirectory = await stat(projectPath(projectRoot, ".git"));

    if (!gitDirectory.isDirectory()) {
      throw new Error("当前项目的 .git 不是目录，无法安装 Git hook。");
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error("当前目录不是 Git 仓库，无法安装 Git hook。");
    }

    throw error;
  }
}

/**
 * 卸载 Git pre-commit hook。
 */
async function uninstallGitHook(projectRoot: string): Promise<OperationResult> {
  const targetPath = getGitHookPath(projectRoot);
  const existing = await readTextIfExists(targetPath);

  if (existing === undefined) {
    return {
      path: targetPath,
      action: "skipped",
      message: "Git pre-commit hook 不存在"
    };
  }

  if (!existing.includes(CODE_HELPER_GIT_HOOK_MARKER)) {
    return {
      path: targetPath,
      action: "skipped",
      message: "现有 Git hook 不是 code-helper 管理，已跳过"
    };
  }

  await writeText(targetPath, "");

  return {
    path: targetPath,
    action: "updated",
    message: "已清空 code-helper 管理的 Git pre-commit hook"
  };
}

/**
 * 安装 Codex 或 Claude Code 的 Stop hook。
 */
async function installAgentHook(projectRoot: string, target: Exclude<HookInstallTarget, "git">): Promise<OperationResult> {
  const targetPath = target === "codex" ? getCodexHooksPath(projectRoot) : getClaudeSettingsPath(projectRoot);
  const existingConfig = await readJsonObject(targetPath);
  const nextConfig = addCodeHelperStopHook(existingConfig, target);
  const existing = await readTextIfExists(targetPath);
  const nextContent = ensureTrailingNewline(JSON.stringify(nextConfig, null, 2));

  if (existing === nextContent) {
    return {
      path: targetPath,
      action: "skipped",
      message: `${formatTargetName(target)} hook 已是最新内容`
    };
  }

  await writeText(targetPath, nextContent);

  return {
    path: targetPath,
    action: existing === undefined ? "created" : "updated",
    message: `已安装 ${formatTargetName(target)} hook`
  };
}

/**
 * 卸载 Codex 或 Claude Code 的 Stop hook。
 */
async function uninstallAgentHook(projectRoot: string, target: Exclude<HookInstallTarget, "git">): Promise<OperationResult> {
  const targetPath = target === "codex" ? getCodexHooksPath(projectRoot) : getClaudeSettingsPath(projectRoot);
  const existingConfig = await readJsonObject(targetPath);
  const nextConfig = removeCodeHelperStopHook(existingConfig);
  const existing = await readTextIfExists(targetPath);

  if (existing === undefined) {
    return {
      path: targetPath,
      action: "skipped",
      message: `${formatTargetName(target)} hook 配置不存在`
    };
  }

  const nextContent = ensureTrailingNewline(JSON.stringify(nextConfig, null, 2));

  if (existing === nextContent) {
    return {
      path: targetPath,
      action: "skipped",
      message: `未发现 code-helper 管理的 ${formatTargetName(target)} hook`
    };
  }

  await writeText(targetPath, nextContent);

  return {
    path: targetPath,
    action: "updated",
    message: `已卸载 code-helper 管理的 ${formatTargetName(target)} hook`
  };
}

/**
 * 判断 Git hook 是否已安装。
 */
async function isGitHookInstalled(projectRoot: string): Promise<boolean> {
  return (await readTextIfExists(getGitHookPath(projectRoot)))?.includes(CODE_HELPER_GIT_HOOK_MARKER) === true;
}

/**
 * 判断 JSON 配置中是否存在 code-helper Stop hook。
 */
async function isJsonHookInstalled(projectRoot: string, target: Exclude<HookInstallTarget, "git">): Promise<boolean> {
  const targetPath = target === "codex" ? getCodexHooksPath(projectRoot) : getClaudeSettingsPath(projectRoot);
  const config = await readJsonObject(targetPath);
  return collectStopHandlers(config).some((handler) => isCodeHelperHookHandler(handler));
}

/**
 * 读取 JSON 对象。
 * 文件不存在时返回空对象；非对象 JSON 视为配置异常。
 */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const raw = await readTextIfExists(path);

  if (raw === undefined || raw.trim() === "") {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`JSON 配置必须是对象：${path}`);
  }

  return parsed as Record<string, unknown>;
}

/**
 * 给配置对象追加 code-helper Stop hook。
 * 已存在时先移除再追加，保证命令内容升级后能稳定刷新。
 */
function addCodeHelperStopHook(
  config: Record<string, unknown>,
  target: Exclude<HookInstallTarget, "git">
): Record<string, unknown> {
  const nextConfig = removeCodeHelperStopHook(config);
  const hooks = getOrCreateObject(nextConfig, "hooks");
  const stopGroups = getOrCreateArray(hooks, "Stop");
  const handler = target === "codex" ? renderCodexHookHandler() : renderClaudeHookHandler();

  stopGroups.push({
    hooks: [handler]
  });

  return nextConfig;
}

/**
 * 从配置对象中移除 code-helper Stop hook。
 */
function removeCodeHelperStopHook(config: Record<string, unknown>): Record<string, unknown> {
  const nextConfig = structuredClone(config) as Record<string, unknown>;
  const hooks = nextConfig.hooks;

  if (!isRecord(hooks)) {
    return nextConfig;
  }

  const stopGroups = hooks.Stop;
  if (!Array.isArray(stopGroups)) {
    return nextConfig;
  }

  hooks.Stop = stopGroups
    .map((group) => removeCodeHelperHandlersFromGroup(group))
    .filter((group) => group !== undefined);

  return nextConfig;
}

/**
 * 从单个 Stop matcher group 中移除 code-helper handler。
 */
function removeCodeHelperHandlersFromGroup(group: unknown): unknown | undefined {
  if (!isRecord(group)) {
    return group;
  }

  const handlers = group.hooks;
  if (!Array.isArray(handlers)) {
    return group;
  }

  const nextHandlers = handlers.filter((handler) => !isCodeHelperHookHandler(handler));

  if (nextHandlers.length === 0) {
    return undefined;
  }

  return {
    ...group,
    hooks: nextHandlers
  };
}

/**
 * 收集 Stop 事件下的所有 handler。
 */
function collectStopHandlers(config: Record<string, unknown>): unknown[] {
  const hooks = config.hooks;
  if (!isRecord(hooks) || !Array.isArray(hooks.Stop)) {
    return [];
  }

  return hooks.Stop.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return [];
    }

    return group.hooks;
  });
}

/**
 * 判断 handler 是否由 code-helper 管理。
 */
function isCodeHelperHookHandler(handler: unknown): boolean {
  if (!isRecord(handler)) {
    return false;
  }

  return typeof handler.command === "string"
    && handler.command.includes("@skrupellose/code-helper")
    && handler.command.includes("finish");
}

/**
 * 返回或创建对象字段。
 */
function getOrCreateObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = target[key];

  if (isRecord(existing)) {
    return existing;
  }

  const nextValue: Record<string, unknown> = {};
  target[key] = nextValue;
  return nextValue;
}

/**
 * 返回或创建数组字段。
 */
function getOrCreateArray(target: Record<string, unknown>, key: string): unknown[] {
  const existing = target[key];

  if (Array.isArray(existing)) {
    return existing;
  }

  const nextValue: unknown[] = [];
  target[key] = nextValue;
  return nextValue;
}

/**
 * 判断未知值是否是普通对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 渲染 Git pre-commit hook 内容。
 */
function renderGitHook(): string {
  return `#!/bin/sh
${CODE_HELPER_GIT_HOOK_MARKER}
npx @skrupellose/code-helper check
`;
}

/**
 * 渲染 Codex hook handler。
 */
function renderCodexHookHandler(): Record<string, unknown> {
  return {
    type: "command",
    command: CODE_HELPER_HOOK_COMMAND,
    commandWindows: CODE_HELPER_HOOK_COMMAND_WINDOWS,
    timeout: 30,
    statusMessage: CODE_HELPER_HOOK_STATUS_MESSAGE
  };
}

/**
 * 渲染 Claude Code hook handler。
 */
function renderClaudeHookHandler(): Record<string, unknown> {
  return {
    type: "command",
    command: CODE_HELPER_HOOK_COMMAND,
    timeout: 30,
    statusMessage: CODE_HELPER_HOOK_STATUS_MESSAGE
  };
}

/**
 * 格式化 hook 目标名称。
 */
function formatTargetName(target: Exclude<HookInstallTarget, "git">): string {
  return target === "codex" ? "Codex" : "Claude Code";
}

/**
 * Git hook 安装路径。
 */
function getGitHookPath(projectRoot: string): string {
  return projectPath(projectRoot, ".git/hooks/pre-commit");
}

/**
 * Codex 项目级 hooks 配置路径。
 */
function getCodexHooksPath(projectRoot: string): string {
  return projectPath(projectRoot, ".codex/hooks.json");
}

/**
 * Claude Code 项目级 settings 配置路径。
 */
function getClaudeSettingsPath(projectRoot: string): string {
  return projectPath(projectRoot, join(".claude", "settings.json"));
}
