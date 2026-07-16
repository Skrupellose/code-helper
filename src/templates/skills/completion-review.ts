import type { SkillTemplate } from "./types.js";

export const completionReviewSkillTemplate: SkillTemplate = {
  name: "code-helper-completion-review",
  directoryName: "code-helper-completion-review",
  fileName: "completion-review.SKILL.md",
  content: `---
name: code-helper-completion-review
description: 当 agent 完成实现、文档或功能变更节点后准备最终回复，或进行提交前检查、切换任务、询问是否归档、询问是否更新记忆，以及用户要求“检查是否完成”“继续下一个任务”“功能收尾”时必须使用。普通问答、只读 review 或没有产生实现/文档/功能变更的最终回复不触发。该 skill 要按 active、archived、mixed 生命周期读取任务文档并判断下一步。
---

# Code Helper 完成检查

## 目标

在每次功能开发或小节点推进后，避免 agent 直接进入总结或切换任务。先判断当前工作是否真的完成，再决定继续开发、更新过程文档、询问更新记忆、询问归档或选择下一个任务。

## 固定流程

1. 先查看任务列表，区分 active、archived、mixed；目录生命周期优先于归档正文中的历史“下一步”。
2. mixed 任务必须优先请求人工确认 active/archive 哪一侧为终态，不得因为没有纯 active 任务而只报告“没有活动任务”，也不得直接归档或切换任务。
3. 有 active 任务时，读取 code-helper-docs/status-doc/<中文功能名>-状态.md，再读取对应 plan-doc 和 result-doc。
4. 没有 active 且没有 mixed 任务时，不把空 archive 目录当成任务，也不为普通最终回复虚构完成检查；仅报告当前没有活动任务。用户明确查看 archived 任务时，说明它已结束，不重复询问记忆或归档。
5. 当前节点未完成时，继续当前功能；不要询问归档，不要引导新任务。
6. 当前节点完成但功能整体未完成时，更新实施记录、计划文档状态和 status-doc 的下一个执行节点。
7. 识别到功能变更、项目结构变化、测试策略变化、发布流程变化或稳定协作规则时，先检查任务文档是否已记录“长期记忆已更新/已沉淀/无需更新”；已有明确结论时不重复询问。
8. 只有 active 功能整体完成且尚未归档时，才询问是否归档文档。
9. 归档后再查看活动任务，并引导用户选择下一步。

## 命令辅助

- 使用 \`npx @skrupellose/code-helper finish <中文功能名> --check-only\` 做收尾检查。
- 该命令只输出判断和建议，不自动更新记忆、不自动归档、不自动提交。
- 如果缺少功能名，优先从活动任务列表选择，不要求用户凭记忆输入。
- 命令输出中的“必须确认事项”是最终回复前必须处理的强制清单，不能被普通总结覆盖。

## 用户确认边界

- 可以自动更新 result-doc、plan-doc 和 status-doc 中属于当前任务过程的内容。
- 更新长期记忆前必须询问用户。
- 文档归档前必须询问用户。
- 需要选择下一任务时，必须先列出活动任务并询问用户。
- git commit、npm publish 等外部动作前必须询问用户。

## 判断原则

- 长期记忆只记录稳定规则，不记录一次性实现细节。
- 页面、可视化和真实浏览器链路仍只生成手工测试文档。
- Agent hooks 只作为提醒和兜底检查，不替代 agent 自己判断。
- Git hooks 只做提交前检查，不承担对话完成判断。`
};
