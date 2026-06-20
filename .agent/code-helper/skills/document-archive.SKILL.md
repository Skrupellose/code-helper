---
name: code-helper-document-archive
description: 当用户要求归档功能文档、结束一个功能、查看当前任务状态，或项目中出现 .agent/plan-doc/archive、.agent/result-doc/archive、.agent/status-doc/archive 时使用。必须把 archive 目录中的任务识别为已结束，活动任务和归档任务分开判断；同名任务同时存在 active 和 archive 时标记为 mixed 并要求人工收口。
---

# Code Helper Document Archive

## 目标

在一个项目存在多个功能时，把已完成或已结束的功能文档移入 archive 目录，让当前工作区只保留仍需推进的任务。

## 文档位置

- 活动计划：.agent/plan-doc/<feature>.md
- 活动结果：.agent/result-doc/<feature>/
- 活动状态：.agent/status-doc/<feature>-status.md
- 归档计划：.agent/plan-doc/archive/<feature>.md
- 归档结果：.agent/result-doc/archive/<feature>/
- 归档状态：.agent/status-doc/archive/<feature>-status.md

## 工作流

1. 功能完成后，先确认 implementation.md、manual-test.md 和 status-doc 已记录最终结论。
2. 执行 npx code-helper archive <feature>，把三类文档移动到对应 archive 目录。
3. 执行 npx code-helper tasks，确认该 feature 状态为 archived。
4. 如果用户手动移动了文档到 archive，也把该任务识别为已结束。
5. 如果同名 feature 同时存在 active 和 archive 文档，标记为 mixed，不要直接判断为已完成。

## 状态判断

- active：只在 plan-doc、result-doc、status-doc 顶层存在文档。
- archived：只在 archive 目录存在文档。
- mixed：顶层和 archive 中同时存在同名任务文档，需要人工整理。

## 边界规则

- 归档不覆盖已有 archive 目标。
- 已归档 status-doc 不再作为当前任务驾驶舱入口。
- 新功能不要复用已归档 feature 名称。
- 需要返工时，优先新建后续 feature，或明确从 archive 恢复后再继续。