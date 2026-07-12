import { readdir } from "node:fs/promises";

import { containsChinese } from "../text-utils.js";
import type { CheckIssue } from "../types.js";

// 向 checks/* 模块统一再导出，避免各检查文件各自依赖 text-utils 路径不一致。
export { containsChinese };

/**
 * 安全读取目录。
 * 不存在或不可读取时返回 undefined，避免单个缺失目录中断完整检查流程。
 */
export async function safeReadDirectory(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch {
    return undefined;
  }
}

/**
 * 构造中文命名违规问题。
 * 旧项目可能已经存在英文或非中文文档名，检查端只做兼容提醒，不阻塞当前检查。
 */
export function createChineseNameIssue(path: string, suggestion: string): CheckIssue {
  return {
    level: "warning",
    code: "non-chinese-document-name",
    message: `旧文档命名兼容提醒：${path} 未使用中文命名。`,
    path,
    suggestion: `${suggestion} 这是旧文档兼容提醒，不阻塞当前检查；建议后续迁移为中文命名。`
  };
}
