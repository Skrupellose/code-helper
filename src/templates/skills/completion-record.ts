import type { SkillTemplate } from "./types.js";

/**
 * 直接执行任务完成记录 Skill 模板。
 * 该 Skill 只记录已经完成的实施事实，不创建或补齐计划任务三件套。
 */
export const completionRecordSkillTemplate: SkillTemplate = {
  name: "code-helper-completion-record",
  directoryName: "code-helper-completion-record",
  fileName: "completion-record.SKILL.md",
  content: `---
name: code-helper-completion-record
description: 当任务通过直接执行完成，但收尾时发现改动跨模块、验证链较长、形成重要决策或具有后续复盘价值时必须使用。该 skill 只生成 code-helper-docs/completion-record/<中文功能名>-完成记录.md，不创建 plan-doc、status-doc、result-doc 或手工测试文档；任务仍有后续阶段、阻塞、跨会话恢复需求或已经属于 active/mixed 计划任务时不得使用。
---

# Code Helper 完成记录

## 目标

为已经通过直接执行完成、但具有复盘价值的任务保留精简实施证据。完成记录是独立终态，不是计划任务缺失 result-doc 的替代品，也不能反向触发 plan/status/result 补齐。

## 适用判断

只有同时满足以下条件时才生成完成记录：

1. 本轮任务已经完成，没有未完成阶段、阻塞或需要跨会话恢复的后续工作。
2. 本轮没有对应的 active 或 mixed 计划任务；已有计划任务时应更新原有 plan/status/result。
3. 改动具有复盘价值，例如跨模块调用链、较长验证链、重要兼容决策、稳定失败教训或后续维护需要重新理解的边界。
4. 当前会话掌握真实实施证据，可以根据实际 diff、验证和未验证范围完成记录。

以下情况不生成完成记录：

- 搜索、读取、单次命令、单个补丁或无需复盘的普通轻量任务。
- 纯只读 review、普通问答或没有产生实现和文档变更的任务。
- 仍有未完成节点、外部阻塞、跨会话恢复需求或后续阶段的任务；这类任务应升级为计划跟踪。
- 已经存在 active 或 mixed 任务文档的功能；这类任务继续维护原三件套。

## 固定流程

1. 先检查任务列表，确认本轮功能没有对应的 active 或 mixed 任务。
2. 重新核对用户目标、实际 diff、验证结果、未验证范围和剩余风险，确认任务真的已经完成。
3. 如果任务仍需继续，停止生成完成记录，改用 \`code-helper-plan-workbench\` 建立计划跟踪。
4. 使用 \`npx @skrupellose/code-helper record <中文功能名>\` 创建基础模板；CLI 只生成模板，不代表记录已经完成。
5. 由掌握本轮上下文的主会话补全完成记录，不为倒写文档派子代理重新加载上下文。
6. 完成后核对文档元数据、必要章节和实际证据，不虚构事前计划、状态队列或未执行验证。

## 输出位置

\`code-helper-docs/completion-record/<中文功能名>-完成记录.md\`

完成记录必须保留以下 frontmatter：

\`\`\`yaml
---
code-helper-kind: completion-record
tracking-mode: direct
lifecycle: recorded
---
\`\`\`

## 文档结构

完成记录必须包含：

1. 背景：用户目标和为什么采用直接执行。
2. 实施总结：实际完成了什么，没有完成什么。
3. 实际改动：只记录真实文件、逻辑和行为变化。
4. 验证：关键命令、结果和证据边界。
5. 未验证事项：没有执行的页面、环境或外部链路验证。
6. 风险与后续：剩余风险、返工入口和后续建议。

页面、可视化或真实浏览器验证步骤可以写入“未验证事项”或“验证”小节；除非用户明确要求生成独立手工测试文档，否则不创建 \`手工测试.md\`。

## 生命周期边界

- 完成记录创建即为 \`recorded\` 终态，不参与 active、archived、mixed 生命周期。
- 单独存在完成记录是合法状态，不得据此创建 plan-doc、status-doc 或 result-doc。
- \`tasks\` 只展示计划任务，不把完成记录加入活动任务候选。
- \`finish <中文功能名>\` 命中完成记录时只确认已记录终态，不要求补齐过程文档、归档或选择下一任务。
- \`archive\` 不处理完成记录；完成记录不需要再次归档。
- 如果完成记录对应功能后来出现新的后续工作，应使用新的中文功能名建立计划任务，或由用户明确决定升级方式，不能静默覆盖原记录。

## 边界规则

- 不把所有直接执行任务都记录下来，只有确实具有复盘价值时才生成。
- 不倒写虚构的需求计划、阶段状态或执行时间线。
- 不把测试未执行写成测试通过。
- 不覆盖已有完成记录；同名后续工作使用可区分的中文功能名。
- 不自动更新长期记忆、提交、推送或发布。`
};
