import { chmod, stat } from "node:fs/promises";

import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import type { OperationResult } from "../types.js";

import { CODE_HELPER_GIT_HOOK_MARKER, renderGitHook } from "./renderers.js";
import { getGitHookPath } from "./targets.js";

/**
 * 安装 Git pre-commit hook。
 * 已存在非 code-helper 管理的 hook 时停止，避免覆盖用户自己的提交检查。
 */
export async function installGitHook(projectRoot: string): Promise<OperationResult> {
  await assertGitRepository(projectRoot);

  const targetPath = getGitHookPath(projectRoot);
  const existing = await readTextIfExists(targetPath);
  const content = renderGitHook();

  if (existing === content) {
    return {
      path: targetPath,
      action: "skipped",
      message: "Git pre-commit hook 已是最新内容"
    };
  }

  if (existing !== undefined && !existing.includes(CODE_HELPER_GIT_HOOK_MARKER)) {
    throw new Error(`已存在非 code-helper 管理的 Git hook：${targetPath}。请手动合并后再安装。`);
  }

  await writeText(targetPath, content);
  await chmod(targetPath, 0o755);

  return {
    path: targetPath,
    action: existing === undefined ? "created" : "updated",
    message: "已安装 Git pre-commit hook"
  };
}

/**
 * 卸载 Git pre-commit hook。
 * 为保持原有行为，这里清空受控文件而不是删除文件本身。
 */
export async function uninstallGitHook(projectRoot: string): Promise<OperationResult> {
  const targetPath = getGitHookPath(projectRoot);
  const existing = await readTextIfExists(targetPath);

  if (existing === undefined) {
    return {
      path: targetPath,
      action: "skipped",
      message: "Git pre-commit hook 不存在"
    };
  }

  if (!existing.includes(CODE_HELPER_GIT_HOOK_MARKER)) {
    return {
      path: targetPath,
      action: "skipped",
      message: "现有 Git hook 不是 code-helper 管理，已跳过"
    };
  }

  await writeText(targetPath, "");

  return {
    path: targetPath,
    action: "updated",
    message: "已清空 code-helper 管理的 Git pre-commit hook"
  };
}

/**
 * 判断 Git hook 是否已安装。
 * 只识别 code-helper marker，不把用户已有 pre-commit 当作本工具安装结果。
 */
export async function isGitHookInstalled(projectRoot: string): Promise<boolean> {
  return (await readTextIfExists(getGitHookPath(projectRoot)))?.includes(CODE_HELPER_GIT_HOOK_MARKER) === true;
}

/**
 * 确认当前目录是 Git 仓库。
 * 不存在 .git 时不主动创建，避免把普通目录误改成半成品 Git 结构。
 */
async function assertGitRepository(projectRoot: string): Promise<void> {
  try {
    const gitDirectory = await stat(projectPath(projectRoot, ".git"));

    if (!gitDirectory.isDirectory()) {
      throw new Error("当前项目的 .git 不是目录，无法安装 Git hook。");
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error("当前目录不是 Git 仓库，无法安装 Git hook。");
    }

    throw error;
  }
}
