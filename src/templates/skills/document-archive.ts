import type { SkillTemplate } from "./types.js";

export const documentArchiveSkillTemplate: SkillTemplate = {
  name: "code-helper-document-archive",
  directoryName: "code-helper-document-archive",
  fileName: "document-archive.SKILL.md",
  content: `---
name: code-helper-document-archive
description: 当用户要求归档功能文档、结束一个功能、查看任务生命周期，或项目中存在实际 archived/mixed 任务文档时使用。初始化预建的空 archive 目录不触发。必须把实际归档任务识别为已结束，活动任务和归档任务分开判断；同名任务同时存在 active 和 archive 时标记为 mixed 并要求人工确认。
---

# Code Helper 文档归档

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

## 使用流程

1. 功能完成后，先确认 实施记录.md 和 status-doc 已用中文记录最终结论。
2. 仅当任务涉及页面、可视化、浏览器真实链路、人工业务验收，或结果目录已经存在 手工测试.md 时，才把手工测试结论作为归档前检查条件；纯逻辑任务以自动化测试和实施记录中的验证结论为准，不要求补建 手工测试.md。
3. 执行 npx @skrupellose/code-helper archive <中文功能名>，把三类文档移动到对应 archive 目录。
4. 执行 npx @skrupellose/code-helper tasks，确认该中文功能名状态为 archived。
5. 如果用户手动移动了文档到 archive，也把该任务识别为已结束。
6. 如果同名中文功能同时存在 active 和 archive 文档，标记为 mixed，不要直接判断为已完成。

## 状态判断

- active：只在 plan-doc、result-doc、status-doc 顶层存在文档。
- archived：只在 archive 目录存在文档。
- mixed：顶层和 archive 中同时存在同名任务文档，需要人工整理。

## 边界规则

- 归档不覆盖已有 archive 目标。
- 空 archive 目录不代表存在归档任务，也不应单独触发本 skill。
- 已归档 status-doc 不再作为当前任务入口。
- 新功能不要复用已归档中文功能名。
- 需要返工时，优先新建后续中文功能名，或明确从 archive 恢复后再继续。`
};
