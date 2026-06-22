import type { FeatureKey } from "../types.js";

/**
 * 返回可选 hook 模板。
 * Git hooks 和 Agent hooks 分别受不同功能开关控制，避免概念混用。
 */
export function getHookTemplates(): Array<{ fileName: string; content: string; feature: FeatureKey }> {
  return [
    {
      fileName: "pre-commit.sample",
      feature: "gitHooks",
      content: `#!/bin/sh
# code-helper 可选 pre-commit 模板。
# 启用方式：复制到 .git/hooks/pre-commit 并添加可执行权限。
# code-helper:managed-pre-commit
npx @skrupellose/code-helper check
`
    },
    {
      fileName: "agent-finish-check.mjs.sample",
      feature: "agentHooks",
      content: `#!/usr/bin/env node
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
`
    },
    {
      fileName: "agent-hooks.md.sample",
      feature: "agentHooks",
      content: `# code-helper Agent hooks 模板

## 用途

Agent hooks 用于在 agent 准备最终回复、停止任务、提交前检查或切换任务前，提醒运行完成检查。

## 推荐命令

\`\`\`bash
node .code-helper/hooks/agent-finish-check.mjs
\`\`\`

如果所在 agent 工具支持分别配置 macOS/Linux 和 Windows 命令，Windows 可以使用：

\`\`\`powershell
node .code-helper\\hooks\\agent-finish-check.mjs
\`\`\`

## 行为边界

- hook 只运行 \`code-helper finish --check-only\`。
- hook 不自动更新长期记忆。
- hook 不自动归档文档。
- hook 不自动提交代码。
- agent 仍需要根据输出主动询问用户是否更新记忆、归档或选择下一任务。

## code-helper 安装命令

\`\`\`bash
npx @skrupellose/code-helper hooks install codex
npx @skrupellose/code-helper hooks install claudecode
\`\`\`
`
    }
  ];
}
