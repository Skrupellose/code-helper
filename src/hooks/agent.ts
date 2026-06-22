import { chmod } from "node:fs/promises";

import { ensureTrailingNewline, projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import type { OperationResult } from "../types.js";

import {
  addCodeHelperStopHook,
  collectStopHandlers,
  isCodeHelperHookHandler,
  readJsonObject,
  removeCodeHelperStopHook
} from "./json-config.js";
import { CODE_HELPER_AGENT_HOOK_SCRIPT, renderAgentFinishCheckScript } from "./renderers.js";
import { formatAgentTargetName, getAgentHookConfigPath, type AgentHookInstallTarget } from "./targets.js";

/**
 * 安装 Codex 或 Claude Code 的 Stop hook。
 * 安装时同步写入包装脚本，确保 Stop hook stdout 只输出合法 JSON。
 */
export async function installAgentHook(
  projectRoot: string,
  target: AgentHookInstallTarget
): Promise<OperationResult> {
  const targetPath = getAgentHookConfigPath(projectRoot, target);
  const existingConfig = await readJsonObject(targetPath);
  const nextConfig = addCodeHelperStopHook(existingConfig, target);
  const existing = await readTextIfExists(targetPath);
  const nextContent = ensureTrailingNewline(JSON.stringify(nextConfig, null, 2));
  await ensureAgentFinishCheckScript(projectRoot);

  if (existing === nextContent) {
    return {
      path: targetPath,
      action: "skipped",
      message: `${formatAgentTargetName(target)} hook 已是最新内容`
    };
  }

  await writeText(targetPath, nextContent);

  return {
    path: targetPath,
    action: existing === undefined ? "created" : "updated",
    message: `已安装 ${formatAgentTargetName(target)} hook`
  };
}

/**
 * 卸载 Codex 或 Claude Code 的 Stop hook。
 * 只移除 code-helper 管理的 handler，保留同文件中的用户自定义配置。
 */
export async function uninstallAgentHook(
  projectRoot: string,
  target: AgentHookInstallTarget
): Promise<OperationResult> {
  const targetPath = getAgentHookConfigPath(projectRoot, target);
  const existingConfig = await readJsonObject(targetPath);
  const nextConfig = removeCodeHelperStopHook(existingConfig);
  const existing = await readTextIfExists(targetPath);

  if (existing === undefined) {
    return {
      path: targetPath,
      action: "skipped",
      message: `${formatAgentTargetName(target)} hook 配置不存在`
    };
  }

  const nextContent = ensureTrailingNewline(JSON.stringify(nextConfig, null, 2));

  if (existing === nextContent) {
    return {
      path: targetPath,
      action: "skipped",
      message: `未发现 code-helper 管理的 ${formatAgentTargetName(target)} hook`
    };
  }

  await writeText(targetPath, nextContent);

  return {
    path: targetPath,
    action: "updated",
    message: `已卸载 code-helper 管理的 ${formatAgentTargetName(target)} hook`
  };
}

/**
 * 判断 JSON 配置中是否存在 code-helper Stop hook。
 * 状态检测复用 JSON 配置识别逻辑，兼容旧版直连 npx 命令。
 */
export async function isAgentHookInstalled(projectRoot: string, target: AgentHookInstallTarget): Promise<boolean> {
  const targetPath = getAgentHookConfigPath(projectRoot, target);
  const config = await readJsonObject(targetPath);
  return collectStopHandlers(config).some((handler) => isCodeHelperHookHandler(handler));
}

/**
 * 确保 Agent Stop hook 使用包装脚本执行。
 * Codex Stop hook 会把 stdout 当 JSON 解析，因此不能直接运行会输出中文文本的 CLI。
 */
async function ensureAgentFinishCheckScript(projectRoot: string): Promise<void> {
  const targetPath = projectPath(projectRoot, CODE_HELPER_AGENT_HOOK_SCRIPT);
  await writeText(targetPath, renderAgentFinishCheckScript());
  await chmod(targetPath, 0o755);
}
