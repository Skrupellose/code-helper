import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getConfigRelativePath } from "./config.js";

/**
 * 向上查找已经初始化过的 code-helper 项目根目录。
 * plan 常被从需求文档所在子目录触发；如果只使用当前 cwd，会把 docs/ 误当成项目根并生成 docs/code-helper-docs。
 */
export async function resolveInitializedProjectRoot(startPath: string): Promise<string> {
  let currentPath = resolve(startPath);
  let nearestDocsRoot: string | undefined;

  while (true) {
    if (await pathExists(join(currentPath, getConfigRelativePath()))) {
      return currentPath;
    }

    if (nearestDocsRoot === undefined && await pathExists(join(currentPath, "code-helper-docs"))) {
      nearestDocsRoot = currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return nearestDocsRoot ?? resolve(startPath);
    }

    currentPath = parentPath;
  }
}

/**
 * 判断路径是否存在。
 * 这里不区分文件和目录，只用于识别项目标记，避免不存在时抛出 ENOENT 打断 CLI。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
