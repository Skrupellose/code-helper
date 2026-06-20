---
name: code-helper-document-archive
description: 当用户要求归档功能文档、结束一个功能、查看当前任务状态，或项目中出现 code-helper-docs/plan-doc/archive、code-helper-docs/result-doc/archive、code-helper-docs/status-doc/archive 时使用。必须把 archive 目录中的任务识别为已结束，活动任务和归档任务分开判断；同名任务同时存在 active 和 archive 时标记为 mixed 并要求人工收口。
---

# Code Helper Document Archive

## 目标

在一个项目存在多个功能时，把已完成或已结束的功能文档移入 archive 目录，让当前工作区只保留仍需推进的任务。

## 文档位置

- 活动计划：code-helper-docs/plan-doc/<中文功能名>.md
- 活动结果：code-helper-docs/result-doc/<中文功能名>/
- 活动状态：code-helper-docs/status-doc/<中文功能名>-状态.md
- 活动实施记录：code-helper-docs/result-doc/<中文功能名>/实施记录.md
- 活动手工测试：code-helper-docs/result-doc/<中文功能名>/手工测试.md
- 归档计划：code-helper-docs/plan-doc/archive/<中文功能名>.md
- 归档结果：code-helper-docs/result-doc/archive/<中文功能名>/
- 归档状态：code-helper-docs/status-doc/archive/<中文功能名>-状态.md

## 工作流

1. 功能完成后，先确认 实施记录.md、手工测试.md 和 status-doc 已用中文记录最终结论。
2. 执行 npx code-helper archive <中文功能名>，把三类文档移动到对应 archive 目录。
3. 执行 npx code-helper tasks，确认该中文功能名状态为 archived。
4. 如果用户手动移动了文档到 archive，也把该任务识别为已结束。
5. 如果同名中文功能同时存在 active 和 archive 文档，标记为 mixed，不要直接判断为已完成。

## 状态判断

- active：只在 plan-doc、result-doc、status-doc 顶层存在文档。
- archived：只在 archive 目录存在文档。
- mixed：顶层和 archive 中同时存在同名任务文档，需要人工整理。

## 边界规则

- 归档不覆盖已有 archive 目标。
- 已归档 status-doc 不再作为当前任务驾驶舱入口。
- 新功能不要复用已归档中文功能名。
- 需要返工时，优先新建后续中文功能名，或明确从 archive 恢复后再继续。