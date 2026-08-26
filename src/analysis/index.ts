import type {
  AnalysisPlanItem,
  AnalysisValidationEvidence,
  RequirementCoverageAnalysisInput,
  RequirementCoverageAnalysisResult,
  SemanticAnalysisDiagnostic
} from "./types.js";

export * from "./types.js";

/**
 * 只读检查规格验收条件与计划、状态、验证证据之间的追踪缺口。
 *
 * 函数仅消费调用方传入的内存快照并返回诊断，不读取或修改文件，也不会自动补齐
 * 计划、状态或验证记录。为减少级联噪声，每条验收条件只分析到第一个缺失层级。
 */
export function analyzeRequirementCoverage(
  input: RequirementCoverageAnalysisInput
): RequirementCoverageAnalysisResult {
  const diagnostics: SemanticAnalysisDiagnostic[] = [];
  const acceptanceIds = new Set<string>();
  const duplicateAcceptanceIds = new Set<string>();

  for (const criterion of input.specification.acceptanceCriteria) {
    if (acceptanceIds.has(criterion.id)) {
      duplicateAcceptanceIds.add(criterion.id);
    }
    acceptanceIds.add(criterion.id);
  }

  if (input.specification.acceptanceCriteria.length === 0) {
    diagnostics.push({
      code: "spec.acceptance.empty",
      severity: "error",
      message: "需求规格没有可追踪的验收条件。",
      target: { artifact: "specification" },
      recommendation: "先补充带稳定 ID 的可观察验收条件，再进入计划和验证。"
    });
  }

  for (const duplicateId of duplicateAcceptanceIds) {
    diagnostics.push({
      code: "spec.acceptance.duplicate-id",
      severity: "error",
      message: `需求规格中的验收条件 ID 重复：${duplicateId}。`,
      target: { artifact: "specification", id: duplicateId },
      acceptanceCriterionId: duplicateId,
      recommendation: "为每条验收条件分配唯一且稳定的 ID。"
    });
  }

  const planById = new Map(input.planItems.map((item) => [item.id, item]));
  validateReferences(input, acceptanceIds, planById, diagnostics);

  for (const criterion of input.specification.acceptanceCriteria) {
    const matchingPlans = input.planItems.filter((item) =>
      item.acceptanceCriterionIds.includes(criterion.id)
    );

    if (matchingPlans.length === 0) {
      diagnostics.push({
        code: "spec.acceptance.not-planned",
        severity: "error",
        message: `验收条件 ${criterion.id} 没有对应计划项。`,
        target: { artifact: "specification", id: criterion.id },
        acceptanceCriterionId: criterion.id,
        recommendation: "在计划中增加至少一个显式引用该验收条件的任务。"
      });
      continue;
    }

    const planIds = new Set(matchingPlans.map((item) => item.id));
    const matchingStatuses = input.statusItems.filter((item) => planIds.has(item.planItemId));
    if (matchingStatuses.length === 0) {
      diagnostics.push({
        code: "spec.acceptance.status-missing",
        severity: "error",
        message: `验收条件 ${criterion.id} 的计划项没有状态记录。`,
        target: { artifact: "status", id: criterion.id },
        acceptanceCriterionId: criterion.id,
        recommendation: "为关联计划项记录当前状态，再判断是否可以验收。"
      });
      continue;
    }

    const incompletePlans = matchingPlans.filter((plan) =>
      !matchingStatuses.some((status) => status.planItemId === plan.id && status.status === "completed")
    );
    if (incompletePlans.length > 0) {
      diagnostics.push({
        code: "spec.acceptance.not-completed",
        severity: "error",
        message: `验收条件 ${criterion.id} 仍有关联计划项未完成：${incompletePlans.map((item) => item.id).join("、")}。`,
        target: { artifact: "status", id: criterion.id },
        acceptanceCriterionId: criterion.id,
        recommendation: "完成关联计划项或修正规格与计划的追踪关系。"
      });
      continue;
    }

    const matchingEvidence = input.validationEvidence.filter((evidence) =>
      evidenceCoversCriterion(evidence, criterion.id, planIds)
    );
    if (matchingEvidence.length === 0) {
      diagnostics.push({
        code: "spec.acceptance.validation-missing",
        severity: "error",
        message: `验收条件 ${criterion.id} 没有验证证据。`,
        target: { artifact: "validation", id: criterion.id },
        acceptanceCriterionId: criterion.id,
        recommendation: "记录直接覆盖该验收条件或其计划项的验证回执。"
      });
      continue;
    }

    if (!matchingEvidence.some((evidence) => evidence.exitCode === 0)) {
      diagnostics.push({
        code: "spec.acceptance.validation-failed",
        severity: "error",
        message: `验收条件 ${criterion.id} 的验证证据均未通过。`,
        target: { artifact: "validation", id: criterion.id },
        acceptanceCriterionId: criterion.id,
        recommendation: "修复失败原因并记录新的通过回执；不要覆盖原失败证据。"
      });
    }
  }

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return {
    diagnostics,
    passed: errors === 0,
    summary: {
      acceptanceCriteria: input.specification.acceptanceCriteria.length,
      errors,
      warnings
    }
  };
}

/** 检查产物之间的悬空引用，避免无效 ID 被误当作完整追踪证据。 */
function validateReferences(
  input: RequirementCoverageAnalysisInput,
  acceptanceIds: ReadonlySet<string>,
  planById: ReadonlyMap<string, AnalysisPlanItem>,
  diagnostics: SemanticAnalysisDiagnostic[]
): void {
  for (const plan of input.planItems) {
    for (const acceptanceId of plan.acceptanceCriterionIds) {
      if (!acceptanceIds.has(acceptanceId)) {
        diagnostics.push({
          code: "plan.acceptance.unknown-reference",
          severity: "warning",
          message: `计划项 ${plan.id} 引用了不存在的验收条件 ${acceptanceId}。`,
          target: { artifact: "plan", id: plan.id },
          acceptanceCriterionId: acceptanceId,
          recommendation: "修正规格 ID 或移除计划中的悬空引用。"
        });
      }
    }
  }

  for (const status of input.statusItems) {
    if (!planById.has(status.planItemId)) {
      diagnostics.push({
        code: "status.plan.unknown-reference",
        severity: "warning",
        message: `状态记录引用了不存在的计划项 ${status.planItemId}。`,
        target: { artifact: "status", id: status.planItemId },
        recommendation: "修正状态记录中的计划项 ID，或恢复对应计划项。"
      });
    }
  }

  for (const evidence of input.validationEvidence) {
    for (const acceptanceId of evidence.acceptanceCriterionIds ?? []) {
      if (!acceptanceIds.has(acceptanceId)) {
        diagnostics.push({
          code: "validation.acceptance.unknown-reference",
          severity: "warning",
          message: `验证证据 ${evidence.id} 引用了不存在的验收条件 ${acceptanceId}。`,
          target: { artifact: "validation", id: evidence.id },
          acceptanceCriterionId: acceptanceId,
          recommendation: "修正验证证据中的验收条件 ID。"
        });
      }
    }
    for (const planId of evidence.planItemIds ?? []) {
      if (!planById.has(planId)) {
        diagnostics.push({
          code: "validation.plan.unknown-reference",
          severity: "warning",
          message: `验证证据 ${evidence.id} 引用了不存在的计划项 ${planId}。`,
          target: { artifact: "validation", id: evidence.id },
          recommendation: "修正验证证据中的计划项 ID。"
        });
      }
    }
  }
}

/** 判断一条验证证据是否直接或通过计划项覆盖指定验收条件。 */
function evidenceCoversCriterion(
  evidence: AnalysisValidationEvidence,
  criterionId: string,
  planIds: ReadonlySet<string>
): boolean {
  if (evidence.acceptanceCriterionIds?.includes(criterionId) === true) {
    return true;
  }

  return evidence.planItemIds?.some((planId) => planIds.has(planId)) === true;
}
