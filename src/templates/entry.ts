import type { CodeHelperConfig } from "../types.js";

/**
 * 生成入口文档中的 code-helper 受控区块。
 * 区块只放索引和硬约束，不把详细规范塞进入口文件。
 */
export function renderEntryBlock(config: CodeHelperConfig): string {
  const enabledRules = [
    "- Agent 协作规范：开始新需求、迁移、重构或反馈修复时，读取 `code-helper-docs/user-rules/Agent协作规范.md`；主会话只做协调、分配、审阅和同步，具体执行任务必须交给子代理；被明确派发的执行子代理直接完成任务，不再二次转派。",
    config.features.memoryTuning.enabled
      ? `- 项目记忆规则优化：整理或更新 \`AGENTS.md\` / \`CLAUDE.md\` / \`.github/copilot-instructions.md\` 时，读取 \`${config.directories.userRules}/项目记忆规则优化.md\`。`
      : undefined,
    config.features.planWorkbench.enabled
      ? `- 项目计划优化：开始大型需求、迁移、重构或多阶段任务时，读取 \`${config.directories.userRules}/项目计划管理规范.md\`。`
      : undefined,
    config.features.resultSummary.enabled
      ? `- 执行结果总结：完成小节点后，读取 \`${config.directories.userRules}/执行结果总结规范.md\` 并写入 result-doc。`
      : undefined,
    config.features.testingPolicy.enabled
      ? `- 测试策略约束：涉及页面的测试只生成手工测试文档；工具只执行纯逻辑测试，读取 \`${config.directories.userRules}/测试策略规范.md\`。`
      : undefined,
    config.features.testingPolicy.enabled
      ? "- 手工测试生成：需要生成验收清单、页面/可视化/浏览器链路或回归测试步骤时，使用 `code-helper-manual-test-workbench`，并把完整步骤写入 result-doc 下的 `手工测试.md`。"
      : undefined,
    config.features.skillRegistration.enabled
      ? "- 代码审查与修复：要求 review、代码审查、检查最近改动、按 findings 修复或复审时，使用 `code-helper-review-fix`；默认只读审查，只有用户明确授权后才修改。"
      : undefined,
    config.features.documentArchive.enabled
      ? `- 文档归档：功能完成或手动移动到 archive 后，任务视为已结束，读取 \`${config.directories.userRules}/文档归档规范.md\`。`
      : undefined,
    config.features.completionReview.enabled
      ? `- 功能完成检查：完成实现、文档或功能变更节点后准备最终回复，或切换任务前，读取 \`${config.directories.userRules}/功能完成检查规范.md\`，并按需运行 \`npx @skrupellose/code-helper finish\`；普通问答和只读 review 不触发。`
      : undefined,
    config.features.checks.enabled
      ? "- 规则检查：提交或阶段结束前运行 `npx @skrupellose/code-helper check`，确认协作文档结构仍完整。"
      : undefined,
    config.features.agentHooks.enabled
      ? "- Agent hooks：需要在 agent 生命周期中提醒完成检查时，参考 `.code-helper/hooks/` 下的 agent hook 模板。"
      : undefined,
    config.features.skillRegistration.enabled
      ? "- Skills 管理：需要让 Codex、Claude Code、GitHub Copilot 或 Grok Build 在当前项目自动发现 code-helper skills 时，执行 `npx @skrupellose/code-helper skills register`。"
      : undefined
  ].filter((line): line is string => line !== undefined);

  return `## code-helper 协作入口

### 核心规则

1. 本区块由 code-helper 自动维护，请不要手工编辑；自定义规则应写在本区块外，长期规则写入 \`${config.directories.userRules}/\`。
2. 开始新需求、迁移、重构或反馈修复前，先读取本区块索引到的专题规则。
3. 长期规则写入 \`${config.directories.userRules}/\`，短期过程写入 \`${config.directories.resultDoc}/\`，当前状态记录写入 \`${config.directories.statusDoc}/\`。
4. 不把一次性调试过程、临时失败细节或大段实现流水写进入口文档。
5. 主会话只做管理、分配、审阅和结果同步；具体执行任务必须交给子代理。当前 agent 工具没有子代理能力时，先说明限制并等待用户确认，再由主会话执行。
6. 如果当前会话是主会话明确派发的执行子代理，必须按派发范围直接读取、修改、验证和汇报，不再因“主会话必须派发子代理”规则而停止或再次转派。

### 专题规则索引

${enabledRules.join("\n")}

### 文档维护规则

- 入口文档只保留轻量索引和核心约束。
- 专题规则文档必须包含“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。
- 计划、状态、结果和测试文档必须使用中文命名与中文总结。
- agent 识别到功能变更、项目结构变化、稳定规则变化或小节点完成时，必须主动判断是否需要更新过程文档、询问更新长期记忆、询问归档或继续当前节点。
- 新功能或重构形成稳定规则后，先询问用户是否更新项目记忆，不自动把短期任务状态写入长期记忆。`;
}
