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

在一个项目存在多个功能时，把 SQLite 权威任务状态更新为 archived，并同步 archive 目录中的 Markdown 兼容视图，让当前工作区只保留仍需推进的任务。

## 权威读取与投影位置

SQLite 已初始化时，归档判断默认读取权威任务和文档：

- 使用 \`task status <任务> --json\` 读取任务生命周期。
- 使用 \`document show <任务> result --json\` 和 \`document show <任务> status --json\` 核对最终结论。
- 需要计划或手工验收证据时，使用 \`document show <任务> plan|manual_test --json\` 读取，不直接把 Markdown 投影视为权威正文。

以下路径只是自动生成的本地兼容投影；仅在尚未建立 SQLite 的旧项目或用户明确要求检查人工编辑时读取：

- 活动投影：.code-helper/local/docs/{plan-doc,result-doc,status-doc}/
- 归档投影：.code-helper/local/docs/{plan-doc,result-doc,status-doc}/archive/

## 使用流程

1. 功能完成后，先用 \`task status\` 和 \`document show\` 确认 result、status 权威正文已用中文记录最终结论。
2. 仅当任务涉及页面、可视化、浏览器真实链路、人工业务验收，或 SQLite 已存在 manual_test 文档时，才读取 manual_test 权威正文并把手工测试结论作为归档前检查条件；纯逻辑任务以自动化测试和 result 中的验证结论为准，不要求补建 manual_test。
3. 执行 npx @skrupellose/code-helper archive <中文功能名>，更新 SQLite 状态并同步三类 Markdown 兼容视图。
4. 执行 npx @skrupellose/code-helper tasks，确认该中文功能名状态为 archived。
5. 尚未建立 SQLite 的旧项目中，如果用户手动移动了文档到 archive，也把该任务识别为已结束；SQLite 项目不得用移动投影代替生命周期更新。
6. 如果同名中文功能同时存在 active 和 archive 文档，标记为 mixed，不要直接判断为已完成。

## 状态判断

- active / paused / completed / cancelled / archived：初始化后的项目以 SQLite 任务状态为准。
- mixed：旧项目在顶层和 archive 中同时存在同名 Markdown，需要人工整理后再迁移。
- 尚未建立 SQLite 的旧项目继续按 Markdown 目录分布识别 active、archived 和 mixed。

## 边界规则

- \`.code-helper/local/docs/completion-record/\` 中的完成记录创建即为 recorded 终态，不属于活动任务，也不需要再次归档。
- SQLite 是任务生命周期权威来源；Markdown 仅作为可重建兼容视图，默认导出不得覆盖手工修改。
- SQLite 已初始化时不得把 Markdown 路径作为默认读取或写入入口；人工编辑只通过显式 \`documents import\` 兼容，归档本身始终通过 \`archive\` 命令更新生命周期。
- 只有 plan/status/result 计划任务进入 active、archived、mixed 生命周期；不得因为完成记录缺少计划或状态文档而补齐三件套。
- 归档不覆盖已有 archive 目标。
- 空 archive 目录不代表存在归档任务，也不应单独触发本 skill。
- 已归档 status-doc 不再作为当前任务入口。
- 新功能不要复用已归档中文功能名。
- 需要返工时，优先新建后续中文功能名，或明确从 archive 恢复后再继续。`
};
