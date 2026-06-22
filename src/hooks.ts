import { loadConfig } from "./config.js";
import type { OperationResult } from "./types.js";

import { installAgentHook, isAgentHookInstalled, uninstallAgentHook } from "./hooks/agent.js";
import { installGitHook, isGitHookInstalled, uninstallGitHook } from "./hooks/git.js";
import {
  getAgentHookConfigPath,
  getGitHookPath,
  parseHookTargets,
  type AgentHookInstallTarget,
  type HookInstallationStatus,
  type HookInstallTarget
} from "./hooks/targets.js";

export { parseHookTargets, type HookInstallationStatus, type HookInstallTarget };

/**
 * 查看所有 hook 安装状态。
 * 该兼容门面保留原有导出，具体 Git 与 Agent 状态检测交给子模块处理。
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
      path: getAgentHookConfigPath(projectRoot, "codex"),
      enabled: config.features.agentHooks.enabled,
      installed: await isAgentHookInstalled(projectRoot, "codex")
    },
    {
      target: "claudecode",
      label: "Claude Code Stop hook",
      path: getAgentHookConfigPath(projectRoot, "claudecode"),
      enabled: config.features.agentHooks.enabled,
      installed: await isAgentHookInstalled(projectRoot, "claudecode")
    }
  ];
}

/**
 * 安装指定 hook。
 * Git hook 和 Agent hook 分开管理，避免提交前检查与 Stop hook JSON 配置互相影响。
 */
export async function installHook(projectRoot: string, target: HookInstallTarget): Promise<OperationResult> {
  if (target === "git") {
    return installGitHook(projectRoot);
  }

  return installAgentHook(projectRoot, target satisfies AgentHookInstallTarget);
}

/**
 * 卸载指定 hook。
 * 卸载不受功能开关限制，用户关闭开关后仍应能清理已安装配置。
 */
export async function uninstallHook(projectRoot: string, target: HookInstallTarget): Promise<OperationResult> {
  if (target === "git") {
    return uninstallGitHook(projectRoot);
  }

  return uninstallAgentHook(projectRoot, target satisfies AgentHookInstallTarget);
}
