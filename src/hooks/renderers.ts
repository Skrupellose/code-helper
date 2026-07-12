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
 *
 * 解析顺序：
 * 1. 项目 node_modules 中的 code-helper 二进制（用户项目最常见）
 * 2. 本仓库开发态：package.json 名为 @skrupellose/code-helper 且存在 dist/index.js
 * 3. 已安装包的 dist 入口（无 .bin 链接时）
 * 4. 回退 npx（可能触网；在 code-helper 源码仓内单独依赖 npx 会找不到本地 bin）
 */
export function renderGitHook(): string {
  return `#!/bin/sh
${CODE_HELPER_GIT_HOOK_MARKER}
if [ -f "./node_modules/.bin/code-helper" ]; then
  exec ./node_modules/.bin/code-helper check
fi
if [ -f "./dist/index.js" ] && [ -f "./package.json" ] && grep -q '"name": "@skrupellose/code-helper"' ./package.json 2>/dev/null; then
  exec node ./dist/index.js check
fi
if [ -f "./node_modules/@skrupellose/code-helper/dist/index.js" ]; then
  exec node ./node_modules/@skrupellose/code-helper/dist/index.js check
fi
exec npx --yes @skrupellose/code-helper check
`;
}

/**
 * 渲染 Agent Stop hook 包装脚本。
 * Codex Stop hook 会解析 stdout 为 JSON，因此所有检查文本都必须写入 stderr。
 * 任意失败路径仍保证 stdout 输出合法 JSON `{}`，再以非 0 退出码表示检查未通过或未跑完。
 */
export function renderAgentFinishCheckScript(): string {
  return `#!/usr/bin/env node
/**
 * code-helper Agent Stop hook 包装脚本。
 * Codex Stop hook 会解析 stdout 为 JSON，因此所有检查文本都必须写入 stderr。
 * 任意失败路径仍保证 stdout 输出合法 JSON {}，再以非 0 退出码表示检查未通过或未跑完。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let exitCode = 1;

try {
  const invocation = resolveCodeHelperInvocation();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  // spawnSync 在部分失败场景下 stdout/stderr 可能为 null，必须先规范化再 trim。
  for (const chunk of [result.stdout, result.stderr]) {
    const text = (chunk ?? "").trim();
    if (text !== "") {
      console.error(text);
    }
  }

  if (result.error) {
    // 子进程未能启动（例如命令不存在），finish 检查未真正跑完。
    console.error(\`code-helper finish 检查启动失败：\${result.error.message}\`);
    exitCode = 1;
  } else if (result.signal) {
    // 被信号打断时 status 常为 null，不能按成功处理。
    console.error(\`code-helper finish 检查被信号中断：\${result.signal}\`);
    exitCode = 1;
  } else if (result.status === null) {
    // status 为 null 且无 error/signal 时仍视为未正常结束，避免假成功。
    console.error("code-helper finish 检查未正常结束（exit status 为空）");
    exitCode = 1;
  } else {
    exitCode = result.status;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(\`code-helper finish 检查执行异常：\${message}\`);
  exitCode = 1;
} finally {
  // Stop hook stdout 必须始终是合法 JSON；空对象表示不阻止 agent 停止。
  // 先写 JSON 再按 exitCode 退出，避免失败路径破坏 Codex Stop 协议。
  process.stdout.write("{}\\n");
}

process.exit(exitCode);

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
