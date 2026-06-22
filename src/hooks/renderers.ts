/**
 * code-helper 管理的 Agent hook 命令。
 * 卸载和状态识别依赖这些标记，新增兼容命令时必须同步更新 JSON 配置处理。
 */
export const CODE_HELPER_HOOK_COMMAND = "node .code-helper/hooks/agent-finish-check.mjs";
export const CODE_HELPER_HOOK_COMMAND_WINDOWS = "node .code-helper\\hooks\\agent-finish-check.mjs";
export const CODE_HELPER_LEGACY_HOOK_COMMAND = "npx @skrupellose/code-helper finish --check-only";
export const CODE_HELPER_LEGACY_HOOK_COMMAND_WINDOWS = "npx.cmd @skrupellose/code-helper finish --check-only";
export const CODE_HELPER_AGENT_HOOK_SCRIPT = ".code-helper/hooks/agent-finish-check.mjs";
export const CODE_HELPER_HOOK_STATUS_MESSAGE = "运行 code-helper 完成检查";
export const CODE_HELPER_GIT_HOOK_MARKER = "# code-helper:managed-pre-commit";

/**
 * 渲染 Git pre-commit hook 内容。
 * Git hook 是提交前兜底检查，和 Agent Stop hook 的 JSON 协议完全分离。
 */
export function renderGitHook(): string {
  return `#!/bin/sh
${CODE_HELPER_GIT_HOOK_MARKER}
npx @skrupellose/code-helper check
`;
}

/**
 * 渲染 Agent Stop hook 包装脚本。
 * Codex Stop hook 会解析 stdout 为 JSON，因此所有检查文本都必须写入 stderr。
 */
export function renderAgentFinishCheckScript(): string {
  return `#!/usr/bin/env node
/**
 * code-helper Agent Stop hook 包装脚本。
 * Codex Stop hook 会解析 stdout 为 JSON，因此所有检查文本都必须写入 stderr。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const invocation = resolveCodeHelperInvocation();
const result = spawnSync(invocation.command, invocation.args, {
  cwd: process.cwd(),
  encoding: "utf8"
});

// 把 code-helper 的人类可读输出转到 stderr，避免污染 Stop hook 的 JSON stdout。
for (const chunk of [result.stdout, result.stderr]) {
  const text = chunk.trim();
  if (text !== "") {
    console.error(text);
  }
}

// Stop hook stdout 必须始终是合法 JSON；空对象表示不阻止 agent 停止。
process.stdout.write("{}\\n");
process.exit(result.status ?? 0);

function resolveCodeHelperInvocation() {
  const localEntry = join(process.cwd(), "dist", "index.js");

  if (isCodeHelperRepository() && existsSync(localEntry)) {
    return {
      command: process.execPath,
      args: [localEntry, "finish", "--check-only"]
    };
  }

  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["@skrupellose/code-helper", "finish", "--check-only"]
  };
}

function isCodeHelperRepository() {
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return packageJson.name === "@skrupellose/code-helper";
  } catch {
    return false;
  }
}
`;
}

/**
 * 渲染 Codex hook handler。
 * Codex 支持 commandWindows，因此这里同时写入 Windows 专用命令。
 */
export function renderCodexHookHandler(): Record<string, unknown> {
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
 * Claude Code 当前只需要通用 command 字段。
 */
export function renderClaudeHookHandler(): Record<string, unknown> {
  return {
    type: "command",
    command: CODE_HELPER_HOOK_COMMAND,
    timeout: 30,
    statusMessage: CODE_HELPER_HOOK_STATUS_MESSAGE
  };
}
