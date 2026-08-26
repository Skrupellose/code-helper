import type { SkillTemplate } from "./types.js";

/** 跨需求规格、计划、状态和验证证据的只读语义分析 Skill 模板。 */
export const semanticAnalysisSkillTemplate: SkillTemplate = {
  name: "code-helper-semantic-analysis",
  directoryName: "code-helper-semantic-analysis",
  fileName: "semantic-analysis.SKILL.md",
  content: `---
name: code-helper-semantic-analysis
description: 当用户要求检查需求规格、计划、状态记录和验证证据是否一致，确认验收条件是否被计划与验证覆盖，或查找跨产物追踪缺口时使用。该 skill 只读分析并返回稳定诊断 code，不自动修改文档、代码、状态或验证记录。
---

# Code Helper 跨产物语义分析

## 目标

沿“需求规格 → 计划项 → 状态记录 → 验证证据”检查每条验收条件是否形成完整追踪链。分析只报告证据和缺口，不把自动补写产物当成修复。

## 适用场景

- 用户要求检查规格与计划是否一致
- 用户要求确认验收条件是否有实施任务和验证证据
- 阶段完成前需要检查计划、状态与验证是否闭环
- 用户提供多个过程产物并要求找出缺失引用或悬空 ID

代码审查关注实现缺陷时使用代码审查能力；本 skill 只判断产物之间的追踪关系，不根据测试通过推断代码一定正确。

## 必读范围

按用户指定范围读取：

1. 带稳定 AC ID 的需求规格
2. 显式引用 AC ID 的计划项
3. 显式引用计划项 ID 的状态记录
4. 显式引用 AC ID 或计划项 ID 的验证回执

没有某类产物时把它报告为缺口，不创建虚假内容。只读取支撑结论所需范围，不修改任何文件或数据库。

## 分析顺序

对每条验收条件依次检查：

1. 是否至少有一个计划项引用
2. 所有关联计划项是否有状态记录并已完成
3. 是否至少有一条直接或间接关联的验证证据
4. 关联验证是否至少有一条通过回执

同时检查计划、状态和验证证据是否引用不存在的 ID。为减少级联噪声，同一验收条件优先报告最靠前的缺失层级。

## 稳定诊断 code

- spec.acceptance.empty
- spec.acceptance.duplicate-id
- spec.acceptance.not-planned
- spec.acceptance.status-missing
- spec.acceptance.not-completed
- spec.acceptance.validation-missing
- spec.acceptance.validation-failed
- plan.acceptance.unknown-reference
- status.plan.unknown-reference
- validation.acceptance.unknown-reference
- validation.plan.unknown-reference

不得为相同语义临时创造新 code。需要扩展诊断时，应先更新领域契约和测试，再更新本模板。

## 输出要求

先回答“通过”或“存在缺口”，再按诊断 code 输出：严重度、目标产物与 ID、证据、影响和只读建议。最后列出已覆盖范围、未提供的产物和不能据此判断的事项。

## 只读边界

- 不自动修改规格、计划、状态、验证记录、代码或过程文档。
- 不把缺失状态自动改为已完成，不补造验证回执。
- 不执行提交、归档、发布或外部写操作。
- 用户随后要求修复时，先按具体诊断确认授权范围，再交给对应的需求、计划、实现或验证流程；不能把本次只读请求视为修复授权。`
};
