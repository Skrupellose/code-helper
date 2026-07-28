import type { CodeHelperConfig } from "../types.js";

/**
 * 生成入口文档中的 code-helper 受控区块。
 * 区块只放索引和硬约束，不把详细规范塞进入口文件。
 */
export function renderEntryBlock(config: CodeHelperConfig): string {
  const enabledRules = [
    "- Agent 协作规范：开始新需求、迁移、重构或反馈修复时，读取 `code-helper-docs/user-rules/Agent协作规范.md`；先按 T0-T3 判断主会话直办、建议分发或强制隔离，主会话始终负责范围控制、结果审阅和最终结论；执行身份优先由工具元数据承载，无法可靠传递时才由派发提示明确，执行子代理直接完成任务且不再二次转派。",
    `- Git 提交信息格式规范：准备提交、整理提交历史、生成版本发布提交或执行 revert 时，读取 \`${config.directories.userRules}/Git提交信息格式规范.md\`；scope 必填。`,
    config.features.memoryTuning.enabled
      ? `- 项目记忆规则优化：整理或更新 \`AGENTS.md\` / \`CLAUDE.md\` / \`.github/copilot-instructions.md\` 时，读取 \`${config.directories.userRules}/项目记忆规则优化.md\`。`
      : undefined,
    config.features.planWorkbench.enabled
      ? `- 项目计划优化：开始大型需求、迁移、重构或多阶段任务时，读取 \`${config.directories.userRules}/项目计划管理规范.md\`。`
      : undefined,
    config.features.resultSummary.enabled
      ? `- 执行结果总结：可独立验收的逻辑交付点完成后，读取 \`${config.directories.userRules}/执行结果总结规范.md\` 并写入 result-doc；微型步骤不单独生成或更新实施记录。`
      : undefined,
    config.features.resultSummary.enabled
      ? `- 完成记录：直接执行任务已经完成、没有后续阶段，但收尾时发现具有复盘价值时，读取 \`${config.directories.userRules}/完成记录规范.md\` 并使用 \`code-helper-completion-record\`；完成记录不是活动任务，不得反向补齐 plan/status/result。`
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
      ? `- 功能完成检查：完成一个可独立验收的逻辑交付点后准备最终回复，或切换任务前，读取 \`${config.directories.userRules}/功能完成检查规范.md\`，并按需运行 \`npx @skrupellose/code-helper finish\`；微型步骤、普通问答和只读 review 不单独触发。`
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
3. 长期规则写入 \`${config.directories.userRules}/\`；计划任务的短期过程写入 \`${config.directories.resultDoc}/\`，当前状态记录写入 \`${config.directories.statusDoc}/\`；直接执行后形成的终态完成记录写入 \`code-helper-docs/completion-record/\`。
4. 不把一次性调试过程、临时失败细节或大段实现流水写进入口文档。
5. 主会话按 T0-T3 风险与复杂度决定执行方式：T0/T1 可直办，T2 建议分发，T3 必须实现与复核隔离；主会话始终负责范围控制、结果审阅和最终结论。
6. 主会话始终可以进行只读证据核验、查看 diff、搜索调用方、运行非变更型静态检查和定向测试，不需要为了这些复核动作额外分发。
7. 当前会话优先使用工具提供的父任务或角色元数据识别执行子代理；元数据不可用或不能可靠传递时，派发提示必须明确执行身份并作为兼容回退。执行子代理必须按派发范围直接完成，不再转派。

### 专题规则索引

${enabledRules.join("\n")}

### 文档维护规则

- 入口文档只保留轻量索引和核心约束。
- 专题规则文档必须包含“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。
- 计划、状态、结果、测试和完成记录必须使用中文命名与中文总结。
- agent 识别到功能变更、项目结构变化、稳定规则变化或可独立验收的逻辑交付点完成时，必须主动判断是否需要更新过程文档、询问更新长期记忆、询问归档或继续当前节点；微型步骤不单独触发。
- 新功能或重构形成稳定规则后，先询问用户是否更新项目记忆，不自动把短期任务状态写入长期记忆。`;
}
