import { ENTRY_BLOCK_END, ENTRY_BLOCK_START } from "../constants.js";
import { projectPath, readTextIfExists } from "../fs-utils.js";
import type { CheckIssue, CodeHelperConfig } from "../types.js";

/**
 * 检查入口文档是否存在 code-helper 管理区块。
 * 入口文档是 agent 发现专题规则的第一站，因此缺失时给 error。
 */
export async function checkEntryDocuments(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const entryFiles = [
    config.entryFiles.agents ? "AGENTS.md" : undefined,
    config.entryFiles.claude ? "CLAUDE.md" : undefined,
    config.entryFiles.copilot ? ".github/copilot-instructions.md" : undefined
  ].filter((file): file is string => file !== undefined);

  for (const entryFile of entryFiles) {
    const content = await readTextIfExists(projectPath(projectRoot, entryFile));

    if (content === undefined) {
      issues.push({
        level: "error",
        code: "missing-entry-document",
        message: `入口文档不存在：${entryFile}`,
        path: entryFile,
        suggestion: "运行 `npx @skrupellose/code-helper init` 创建入口文档。"
      });
      continue;
    }

    if (!content.includes(ENTRY_BLOCK_START) || !content.includes(ENTRY_BLOCK_END)) {
      issues.push({
        level: "error",
        code: "missing-managed-block",
        message: `入口文档缺少 code-helper 受控区块：${entryFile}`,
        path: entryFile,
        suggestion: "运行 `npx @skrupellose/code-helper init` 追加受控索引区块。"
      });
    }
  }

  return issues;
}
