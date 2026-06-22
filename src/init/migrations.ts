import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { projectPath } from "../fs-utils.js";
import type { CodeHelperConfig, OperationResult } from "../types.js";

/**
 * 迁移旧版工作区到新版布局。
 * 内部状态保留在 `.code-helper`，可读协作文档迁移到 `code-helper-docs`。
 */
export async function migrateLegacyAgentWorkspace(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const migrations = [
    { from: ".agent/code-helper", to: config.directories.workspace },
    { from: ".agent/user-rules", to: config.directories.userRules },
    { from: ".agent/plan-doc", to: config.directories.planDoc },
    { from: ".agent/result-doc", to: config.directories.resultDoc },
    { from: ".agent/status-doc", to: config.directories.statusDoc },
    { from: ".code-helper/user-rules", to: config.directories.userRules },
    { from: ".code-helper/plan-doc", to: config.directories.planDoc },
    { from: ".code-helper/result-doc", to: config.directories.resultDoc },
    { from: ".code-helper/status-doc", to: config.directories.statusDoc }
  ];
  const operations: OperationResult[] = [];

  for (const migration of migrations) {
    operations.push(...(await migratePath(projectRoot, migration.from, migration.to)));
  }

  await removeEmptyDirectoryIfPossible(projectPath(projectRoot, ".agent"));

  return operations;
}

/**
 * 迁移一个文件或目录。
 * 目标不存在时直接 rename；目标存在时递归合并，且遇到同名目标不覆盖。
 */
async function migratePath(projectRoot: string, fromRelativePath: string, toRelativePath: string): Promise<OperationResult[]> {
  const fromPath = projectPath(projectRoot, fromRelativePath);
  const toPath = projectPath(projectRoot, toRelativePath);
  const sourceStat = await statIfExists(fromPath);
  const operations: OperationResult[] = [];

  if (sourceStat === undefined) {
    return operations;
  }

  const targetStat = await statIfExists(toPath);

  if (targetStat === undefined) {
    await mkdir(dirname(toPath), { recursive: true });
    await rename(fromPath, toPath);
    operations.push({
      path: toPath,
      action: "updated",
      message: `已从旧路径迁移：${fromRelativePath}`
    });
    return operations;
  }

  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    const entries = await readdir(fromPath);

    for (const entry of entries) {
      operations.push(...(await migratePath(projectRoot, join(fromRelativePath, entry), join(toRelativePath, entry))));
    }

    await removeEmptyDirectoryIfPossible(fromPath);
    return operations;
  }

  operations.push({
    path: fromPath,
    action: "skipped",
    message: `迁移目标已存在，为避免覆盖已保留旧路径：${toRelativePath}`
  });
  return operations;
}

/**
 * 安全读取路径状态。
 * 不存在时返回 undefined，其他错误继续抛出。
 */
export async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/**
 * 尝试删除空目录。
 * 如果目录不存在或非空，保持现状，避免误删用户未知内容。
 */
async function removeEmptyDirectoryIfPossible(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // 目录不存在、非空或被系统占用时都不处理，迁移逻辑不应破坏用户文件。
  }
}
