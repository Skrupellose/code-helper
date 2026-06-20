---
name: code-helper-plan-workbench
description: 当用户提供完整需求文档并要求拆分开发计划、阶段计划、状态跟踪或执行工作台时使用。必须生成 plan-doc、result-doc 和 status-doc 的清晰分工。
---

# Code Helper Plan Workbench

## 工作流

1. 先确认需求目标、阶段边界、约束和验收标准。
2. 按依赖顺序拆分计划，不按页面直觉排序。
3. 计划文档写入 .agent/plan-doc/，结果记录写入 .agent/result-doc/，当前状态写入 .agent/status-doc/。
4. 页面验收生成手工测试文档，工具只执行纯逻辑测试。
5. 每个阶段保留当前推进建议、阻塞入口和完成定义。