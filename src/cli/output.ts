import type { CompletionReview } from "../completion.js";
import type { HookInstallationStatus } from "../hooks.js";
import type { SkillAuditRecommendation, SkillDoctorIssue, SkillRegistrationStatus } from "../skills.js";
import type { OperationResult } from "../types.js";

/**
 * 打印操作结果。
 * 路径可能是绝对路径，保留原样方便用户定位。
 */
export function printOperations(operations: OperationResult[]): void {
  for (const operation of operations) {
    console.log(`[${operation.action}] ${operation.path} - ${operation.message}`);
  }
}

/**
 * 打印功能完成检查结果。
 * checkOnly 模式用于 agent hook，输出更强调“下一步必须判断什么”。
 */
export function printCompletionReview(review: CompletionReview, checkOnly: boolean): void {
  console.log(`功能完成检查：${review.featureName}`);
  console.log(`任务状态：${review.taskStatus}`);
  console.log(`检查结论：${formatCompletionReviewStatus(review.reviewStatus)}`);
  console.log(`运行模式：${checkOnly ? "仅检查，不修改文件" : "检查并给出下一步建议"}`);
  console.log("");
  console.log("文档状态：");
  console.log(`- 计划文档：${formatDocumentPresence(review.documents.plan)}`);
  console.log(`- 实施记录：${formatDocumentPresence(review.documents.result)}`);
  console.log(`- 状态记录：${formatDocumentPresence(review.documents.status)}`);
  console.log(`- 手工测试：${formatDocumentPresence(review.documents.manualTest)}`);
  console.log("");
  console.log("状态枚举：");
  console.log(`- 未开始：${review.statusCounts.notStarted}`);
  console.log(`- 进行中：${review.statusCounts.inProgress}`);
  console.log(`- 部分完成：${review.statusCounts.partial}`);
  console.log(`- 被阻塞：${review.statusCounts.blocked}`);
  console.log(`- 已完成：${review.statusCounts.done}`);
  console.log("");
  console.log(`当前执行节点：${review.hasCurrentExecutionNode ? "已存在" : "缺失"}`);
  console.log(`子计划队列：${review.hasSubPlanQueue ? "已存在" : "缺失"}`);
  console.log(`建议询问更新记忆：${review.shouldAskMemoryUpdate ? "是" : "否"}`);
  console.log(`建议询问归档：${review.shouldAskArchive ? "是" : "否"}`);
  console.log("");
  console.log("必须确认事项：");
  if (review.requiredConfirmations.length === 0) {
    console.log("- 无必须向用户确认的事项。");
  } else {
    review.requiredConfirmations.forEach((confirmation, index) => {
      console.log(`${index + 1}. ${confirmation}`);
    });
  }
  console.log("");
  console.log("下一步建议：");
  review.recommendations.forEach((recommendation, index) => {
    console.log(`${index + 1}. ${recommendation}`);
  });

  if (review.changedPaths.length > 0) {
    console.log("");
    console.log("检测到的当前变更：");
    review.changedPaths.forEach((path) => {
      console.log(`- ${path}`);
    });
  }
}

/**
 * 打印项目级 skills 注册状态。
 * 路径使用绝对路径，方便用户排查对应 agent 是否能扫描到文件。
 */
export function printSkillRegistrationStatus(statuses: SkillRegistrationStatus[]): void {
  for (const status of statuses) {
    console.log(`${status.target}/${status.name}: ${status.registered ? "已注册" : "未注册"}`);
    console.log(`  path: ${status.path}`);
  }
}

/**
 * 打印 hooks 安装状态。
 */
export function printHookInstallationStatus(statuses: HookInstallationStatus[]): void {
  for (const status of statuses) {
    console.log(`${status.target}: ${status.installed ? "已安装" : "未安装"} - ${status.label}`);
    console.log(`  开关：${status.enabled ? "启用" : "关闭"}`);
    console.log(`  path: ${status.path}`);
  }
}

/**
 * 打印 skills doctor 检查结果。
 * 没有问题时输出明确结论，避免用户误以为空命令失败。
 */
export function printSkillDoctorIssues(issues: SkillDoctorIssue[]): void {
  if (issues.length === 0) {
    console.log("skills doctor 通过：未发现项目级 skills 结构问题。");
    return;
  }

  for (const issue of issues) {
    console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
    console.log(`  路径：${issue.path}`);
    console.log(`  建议：${issue.suggestion}`);
  }
}

/**
 * 打印 skills audit 推荐项。
 * audit 是建议型命令，始终返回 0。
 */
export function printSkillAuditRecommendations(recommendations: SkillAuditRecommendation[]): void {
  for (const recommendation of recommendations) {
    console.log(`[${recommendation.priority}] ${recommendation.code}: ${recommendation.message}`);
    console.log(`  建议：${recommendation.suggestion}`);
  }
}

/**
 * 把完成检查状态转成中文文案。
 */
function formatCompletionReviewStatus(status: CompletionReview["reviewStatus"]): string {
  const labels: Record<CompletionReview["reviewStatus"], string> = {
    "needs-work": "当前任务仍需继续推进",
    blocked: "当前任务存在阻塞",
    "node-review": "需要先补齐当前执行节点",
    "ready-to-archive": "可在用户确认后归档",
    archived: "任务已归档，视为已结束",
    "missing-docs": "缺少必要协作文档"
  };

  return labels[status];
}

/**
 * 把文档存在状态转成稳定中文输出。
 */
function formatDocumentPresence(document: CompletionReview["documents"]["plan"]): string {
  return `${document.exists ? "已存在" : "缺失"} - ${document.relativePath}`;
}
