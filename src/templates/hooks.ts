import type { FeatureKey } from "../types.js";
import { renderAgentFinishCheckScript, renderGitHook } from "../hooks/renderers.js";

/**
 * 返回可选 hook 模板。
 * Git hooks 和 Agent hooks 分别受不同功能开关控制，避免概念混用。
 * sample 正文与安装脚本同源：由 renderGitHook / renderAgentFinishCheckScript 生成，禁止双份维护。
 */
export function getHookTemplates(): Array<{ fileName: string; content: string; feature: FeatureKey }> {
  // pre-commit.sample 在安装用 hook 正文前附加「可选模板」说明，正文仍来自 renderGitHook。
  const gitHookBody = renderGitHook()
    .split("\n")
    .slice(1)
    .join("\n");

  return [
    {
      fileName: "pre-commit.sample",
      feature: "gitHooks",
      content: `#!/bin/sh
# code-helper 可选 pre-commit 模板。
# 启用方式：复制到 .git/hooks/pre-commit 并添加可执行权限。
${gitHookBody}`
    },
    {
      fileName: "agent-finish-check.mjs.sample",
      feature: "agentHooks",
      // 与安装到 .code-helper/hooks/agent-finish-check.mjs 的脚本完全一致。
      content: renderAgentFinishCheckScript()
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
