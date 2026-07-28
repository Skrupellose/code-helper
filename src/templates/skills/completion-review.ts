import type { SkillTemplate } from "./types.js";

export const completionReviewSkillTemplate: SkillTemplate = {
  name: "code-helper-completion-review",
  directoryName: "code-helper-completion-review",
  fileName: "completion-review.SKILL.md",
  content: `---
name: code-helper-completion-review
description: 当 agent 完成可独立验收的逻辑交付点并准备最终回复，或进行提交前检查、切换任务、询问是否归档、询问是否更新记忆，以及用户要求“检查是否完成”“继续下一个任务”“功能收尾”时必须使用。搜索、读取、单次命令或单个补丁等微型步骤不单独触发；真实功能变更在最终回复前仍必须触发。该 skill 必须先区分计划跟踪、直接执行和 recorded 完成记录，避免轻量任务被迫补齐 plan/status/result。
---

# Code Helper 完成检查

## 目标

在一个可独立验收的逻辑交付点完成后，避免 agent 未经收尾直接进入最终总结、提交或切换任务。先区分计划跟踪、直接执行和已经存在的完成记录，再决定继续开发、更新过程文档、生成完成记录、询问更新记忆、询问归档或选择下一个任务。

## 固定流程

1. 先判断本轮工作模式：已有 active/mixed 文档的是计划跟踪任务；没有对应任务文档的是直接执行；已经存在 completion-record 的是 recorded 终态。
2. 计划跟踪任务继续查看任务列表并区分 active、archived、mixed；目录生命周期优先于归档正文中的历史“下一步”。
3. mixed 任务必须优先请求人工确认 active/archive 哪一侧为终态，不得因为没有纯 active 任务而只报告“没有活动任务”，也不得直接归档或切换任务。
4. 有 active 任务时，读取 code-helper-docs/status-doc/<中文功能名>-状态.md，再读取对应 plan-doc 和 result-doc。
5. 直接执行任务没有 active 或 mixed 文档时，不虚构任务名，也不创建 plan/status/result；先检查实际 diff、验证、风险和未完成项。
6. 直接执行任务仍有后续阶段、阻塞或跨会话恢复需求时，使用 \`code-helper-plan-workbench\` 升级为计划跟踪；已经完成且具有复盘价值时，使用 \`code-helper-completion-record\` 生成独立完成记录；普通轻量任务直接总结。
7. 已经存在 completion-record 时，只确认其为 recorded 终态，不要求补齐过程文档、归档或选择下一任务。
8. 当前计划逻辑交付点未完成时，继续当前功能；不要询问归档，不要引导新任务。
9. 当前计划逻辑交付点完成但功能整体未完成时，更新实施记录、计划文档状态和 status-doc 的下一个执行节点。
10. 识别到功能变更、项目结构变化、测试策略变化、发布流程变化或稳定协作规则时，先检查任务文档或完成记录是否已记录“长期记忆已更新/已沉淀/无需更新”；已有明确结论时不重复询问。
11. 只有 active 功能整体完成且尚未归档时，才询问是否归档文档。
12. 归档后再查看活动任务，并引导用户选择下一步。
13. 最终回复前输出紧凑进度摘要，至少包含当前节点、完成定义进度、已经完成、剩余门禁、后续优化、下一步和 Agent 使用；不得让普通建议淹没当前结论。

## 命令辅助

- 使用 \`npx @skrupellose/code-helper finish <中文功能名> --check-only\` 做收尾检查。
- 该命令只输出判断和建议，不自动更新记忆、不自动归档、不自动提交。
- 如果缺少功能名，优先从活动任务列表选择，不要求用户凭记忆输入。
- 直接执行任务没有活动任务名时，不强行运行精确 finish；按直接执行分支检查实际改动即可。
- \`finish <中文功能名>\` 命中完成记录时应返回 recorded，不得返回 missing-docs。
- 命令输出中的“必须确认事项”是最终回复前必须处理的强制清单，不能被普通总结覆盖。

## 进度摘要

- 计划跟踪任务优先复用 status-doc 的“进度摘要”，并在最终回复前更新为最新状态。
- 直接执行任务按实际 diff、验证和风险生成同字段摘要，不因此创建计划文档。
- recorded 完成记录只需说明其已结束，不虚构剩余门禁或 Agent 使用。
- “剩余门禁”只列当前阻断；当前非阻断和后续优化单独列出，不得因此把已满足完成定义的节点继续标为进行中。

## 用户确认边界

- 可以自动更新 result-doc、plan-doc 和 status-doc 中属于当前任务过程的内容。
- 可以为已经完成且具有复盘价值的直接执行任务生成 completion-record；该动作不得创建或补齐计划任务三件套。
- 更新长期记忆前必须询问用户。
- 文档归档前必须询问用户。
- 需要选择下一任务时，必须先列出活动任务并询问用户。
- git commit、npm publish 等外部动作前必须询问用户。

## 判断原则

- 长期记忆只记录稳定规则，不记录一次性实现细节。
- 页面、可视化和真实浏览器链路仍只生成手工测试文档。
- 直接执行完成记录可以在同一文档中写明页面或真实浏览器的未验证步骤；除非用户明确要求，不额外生成手工测试文档。
- Agent hooks 只作为提醒和兜底检查，不替代 agent 自己判断。
- Git hooks 只做提交前检查，不承担对话完成判断。`
};
