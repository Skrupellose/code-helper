import type { RequirementSpecification } from "../requirements/types.js";

/** 跨产物语义分析可返回的稳定诊断代码。 */
export const SEMANTIC_ANALYSIS_CODES = [
  "spec.acceptance.empty",
  "spec.acceptance.duplicate-id",
  "spec.acceptance.not-planned",
  "spec.acceptance.status-missing",
  "spec.acceptance.not-completed",
  "spec.acceptance.validation-missing",
  "spec.acceptance.validation-failed",
  "plan.acceptance.unknown-reference",
  "status.plan.unknown-reference",
  "validation.acceptance.unknown-reference",
  "validation.plan.unknown-reference"
] as const;

/** 语义分析诊断代码联合类型。 */
export type SemanticAnalysisCode = typeof SEMANTIC_ANALYSIS_CODES[number];

/** 计划项与规格验收条件之间的显式追踪关系。 */
export interface AnalysisPlanItem {
  /** 稳定计划项 ID。 */
  id: string;
  /** 计划项标题。 */
  title: string;
  /** 此计划项覆盖的验收条件 ID。 */
  acceptanceCriterionIds: readonly string[];
}

/** 计划项在状态记录中的当前状态。 */
export type AnalysisPlanStatus =
  | "not_started"
  | "in_progress"
  | "partial"
  | "blocked"
  | "completed";

/** 状态记录与计划项之间的显式追踪关系。 */
export interface AnalysisStatusItem {
  /** 对应的计划项 ID。 */
  planItemId: string;
  /** 当前计划项状态。 */
  status: AnalysisPlanStatus;
  /** 可选状态摘要，仅作为诊断上下文，不参与完成判断。 */
  summary?: string;
}

/** 一条验证证据，可直接关联验收条件，也可通过计划项间接关联。 */
export interface AnalysisValidationEvidence {
  /** 稳定验证证据 ID。 */
  id: string;
  /** 实际执行的命令或人工验收名称。 */
  command: string;
  /** 退出码；0 表示验证通过。 */
  exitCode: number;
  /** 验证结果摘要。 */
  summary: string;
  /** 直接覆盖的验收条件 ID。 */
  acceptanceCriterionIds?: readonly string[];
  /** 验证所覆盖的计划项 ID。 */
  planItemIds?: readonly string[];
}

/** 跨规格、计划、状态和验证证据的只读分析输入。 */
export interface RequirementCoverageAnalysisInput {
  /** 正式需求规格。 */
  specification: RequirementSpecification;
  /** 当前计划项快照。 */
  planItems: readonly AnalysisPlanItem[];
  /** 当前状态记录快照。 */
  statusItems: readonly AnalysisStatusItem[];
  /** 当前验证证据快照。 */
  validationEvidence: readonly AnalysisValidationEvidence[];
}

/** 单条只读语义诊断。 */
export interface SemanticAnalysisDiagnostic {
  /** 稳定诊断代码，供 CLI、Agent 或测试可靠处理。 */
  code: SemanticAnalysisCode;
  /** 诊断严重度。 */
  severity: "error" | "warning";
  /** 面向用户的中文说明。 */
  message: string;
  /** 诊断所指向的产物和稳定 ID。 */
  target: {
    artifact: "specification" | "plan" | "status" | "validation";
    id?: string;
  };
  /** 关联验收条件 ID，便于按条件汇总缺口。 */
  acceptanceCriterionId?: string;
  /** 只读修复建议；分析器自身不会执行建议。 */
  recommendation: string;
}

/** 只读语义分析结果。 */
export interface RequirementCoverageAnalysisResult {
  /** 所有诊断按输入顺序稳定输出。 */
  diagnostics: SemanticAnalysisDiagnostic[];
  /** 没有 error 级诊断时为 true。 */
  passed: boolean;
  /** 便于 Agent 快速展示的诊断计数。 */
  summary: {
    acceptanceCriteria: number;
    errors: number;
    warnings: number;
  };
}
