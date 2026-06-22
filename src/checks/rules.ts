import { readdir } from "node:fs/promises";

import { portablePath, projectPath, readTextIfExists } from "../fs-utils.js";
import type { CheckIssue, CodeHelperConfig } from "../types.js";

/**
 * 检查专题规则文档结构。
 * 每份规则都要包含固定四段，这样 agent 可以稳定读取和执行。
 */
export async function checkRuleDocuments(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const rulesDirectory = projectPath(projectRoot, config.directories.userRules);
  const requiredSections = ["## 功能描述", "## 调用时机", "## 调用入口文件", "## 规则"];
  let files: string[] = [];

  try {
    files = await readdir(rulesDirectory);
  } catch {
    issues.push({
      level: "error",
      code: "missing-user-rules-directory",
      message: "专题规则目录不存在",
      path: config.directories.userRules,
      suggestion: "运行 `npx @skrupellose/code-helper init` 创建专题规则目录和默认规则。"
    });
    return issues;
  }

  const markdownFiles = files.filter((file) => file.endsWith(".md"));

  if (markdownFiles.length === 0) {
    issues.push({
      level: "error",
      code: "empty-user-rules-directory",
      message: "专题规则目录中没有 Markdown 规则文件",
      path: config.directories.userRules,
      suggestion: "运行 `npx @skrupellose/code-helper init` 安装默认专题规则。"
    });
  }

  for (const file of markdownFiles) {
    const relativePath = portablePath(config.directories.userRules, file);
    const content = await readTextIfExists(projectPath(projectRoot, relativePath));

    for (const section of requiredSections) {
      if (!content?.includes(section)) {
        issues.push({
          level: "error",
          code: "invalid-rule-document",
          message: `专题规则缺少小节 ${section}：${file}`,
          path: relativePath,
          suggestion: "补齐“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。"
        });
      }
    }
  }

  return issues;
}
