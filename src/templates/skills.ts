import { agentCollaborationSkillTemplate } from "./skills/agent-collaboration.js";
import { completionReviewSkillTemplate } from "./skills/completion-review.js";
import { documentArchiveSkillTemplate } from "./skills/document-archive.js";
import { manualTestWorkbenchSkillTemplate } from "./skills/manual-test-workbench.js";
import { memoryTuningSkillTemplate } from "./skills/memory-tuning.js";
import { planWorkbenchSkillTemplate } from "./skills/plan-workbench.js";
import type { SkillTemplate } from "./skills/types.js";

/**
 * 返回内置 skill 文件模板。
 * 保持统一入口，具体模板按功能拆到 `templates/skills/` 下维护。
 */
export function getSkillTemplates(): SkillTemplate[] {
  return [
    agentCollaborationSkillTemplate,
    memoryTuningSkillTemplate,
    planWorkbenchSkillTemplate,
    manualTestWorkbenchSkillTemplate,
    documentArchiveSkillTemplate,
    completionReviewSkillTemplate
  ];
}
