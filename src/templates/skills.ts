import { agentCollaborationSkillTemplate } from "./skills/agent-collaboration.js";
import { completionReviewSkillTemplate } from "./skills/completion-review.js";
import { documentArchiveSkillTemplate } from "./skills/document-archive.js";
import { manualTestWorkbenchSkillTemplate } from "./skills/manual-test-workbench.js";
import { memoryTuningSkillTemplate } from "./skills/memory-tuning.js";
import { planWorkbenchSkillTemplate } from "./skills/plan-workbench.js";
import type { SkillTemplate } from "./skills/types.js";

/**
 * 内置 Skills 的单一 manifest。
 *
 * 每个条目同时包含模板文件名、项目级目录名、frontmatter name 和正文。
 * 安装、注册、诊断、审计与测试都应从该清单派生，禁止再维护平行映射。
 */
const CODE_HELPER_SKILL_MANIFEST: readonly Readonly<SkillTemplate>[] = Object.freeze(
  [
    // Agent 协作 Skill 保持首位，确保新会话优先读取协作分工边界。
    agentCollaborationSkillTemplate,
    memoryTuningSkillTemplate,
    planWorkbenchSkillTemplate,
    manualTestWorkbenchSkillTemplate,
    documentArchiveSkillTemplate,
    completionReviewSkillTemplate
  ].map((skill) => Object.freeze({ ...skill }))
);

/**
 * 返回内置 Skills 单一 manifest 的只读视图。
 */
export function getSkillManifest(): readonly Readonly<SkillTemplate>[] {
  return CODE_HELPER_SKILL_MANIFEST;
}

/**
 * 返回内置 Skill 文件模板。
 * 保留既有公共 API，实际数据直接来自单一 manifest。
 */
export function getSkillTemplates(): readonly Readonly<SkillTemplate>[] {
  return getSkillManifest();
}
