import { spawnSync } from "node:child_process";
import { chmod, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import type { OperationResult } from "../types.js";

import { CODE_HELPER_GIT_HOOK_MARKER, renderGitHook } from "./renderers.js";
import { getDefaultGitHookPath } from "./targets.js";

/**
 * 安装 Git pre-commit hook。
 * 已存在非 code-helper 管理的 hook 时停止，避免覆盖用户自己的提交检查。
 * 支持普通仓库（.git 为目录）与 worktree（.git 为 gitdir 文件）。
 */
export async function installGitHook(projectRoot: string): Promise<OperationResult> {
  const targetPath = await resolveGitHookPath(projectRoot, { requireRepository: true });
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
  const targetPath = await resolveGitHookPath(projectRoot, { requireRepository: false });
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
  const targetPath = await resolveGitHookPath(projectRoot, { requireRepository: false });
  return (await readTextIfExists(targetPath))?.includes(CODE_HELPER_GIT_HOOK_MARKER) === true;
}

/**
 * 判断项目根目录是否为 Git 仓库（含 worktree）。
 * .git 可为目录或指向 gitdir 的文件。
 */
export async function isGitRepository(projectRoot: string): Promise<boolean> {
  return (await tryResolveGitHooksDirectory(projectRoot)) !== undefined;
}

/**
 * 解析 Git pre-commit hook 的绝对路径。
 * 优先使用 `git rev-parse --git-path hooks`，失败时回退解析 .git 目录/文件（含 worktree commondir）。
 *
 * @param requireRepository 为 true 时，无法解析则抛出友好错误；为 false 时回退到默认 `.git/hooks/pre-commit`。
 */
export async function resolveGitHookPath(
  projectRoot: string,
  options: { requireRepository: boolean }
): Promise<string> {
  const hooksDirectory = await tryResolveGitHooksDirectory(projectRoot);

  if (hooksDirectory !== undefined) {
    return join(hooksDirectory, "pre-commit");
  }

  if (options.requireRepository) {
    throw await buildMissingGitRepositoryError(projectRoot);
  }

  return getDefaultGitHookPath(projectRoot);
}

/**
 * 尝试解析 hooks 目录绝对路径。
 * 返回 undefined 表示当前目录不是可用的 Git 仓库。
 */
export async function tryResolveGitHooksDirectory(projectRoot: string): Promise<string | undefined> {
  const fromGitCommand = tryResolveHooksDirectoryWithGit(projectRoot);
  if (fromGitCommand !== undefined) {
    return fromGitCommand;
  }

  return tryResolveHooksDirectoryFromDotGit(projectRoot);
}

/**
 * 通过 `git rev-parse --git-path hooks` 解析 hooks 目录。
 * git 不可用或命令失败时返回 undefined，由调用方走文件解析回退。
 */
function tryResolveHooksDirectoryWithGit(projectRoot: string): string | undefined {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: projectRoot,
      encoding: "utf8"
    });

    if (result.error || result.status !== 0) {
      return undefined;
    }

    const relativeOrAbsolute = (result.stdout ?? "").trim();
    if (relativeOrAbsolute === "") {
      return undefined;
    }

    return isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : resolve(projectRoot, relativeOrAbsolute);
  } catch {
    return undefined;
  }
}

/**
 * 通过读取 `.git` 目录或 worktree 的 gitdir 文件解析 hooks 目录。
 * worktree 的 gitdir 常指向 `.git/worktrees/<name>`，真实 hooks 在 commondir 下。
 */
async function tryResolveHooksDirectoryFromDotGit(projectRoot: string): Promise<string | undefined> {
  const gitPath = projectPath(projectRoot, ".git");

  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  if (gitStat.isDirectory()) {
    return join(gitPath, "hooks");
  }

  if (!gitStat.isFile()) {
    return undefined;
  }

  const gitDir = await parseGitDirFile(gitPath, projectRoot);
  if (gitDir === undefined) {
    return undefined;
  }

  // worktree：commondir 指向主仓库 git 目录，hooks 安装在主仓库 hooks 下。
  const commonDir = await readCommonDir(gitDir);
  const hooksRoot = commonDir ?? gitDir;
  return join(hooksRoot, "hooks");
}

/**
 * 解析 `.git` 文件中的 `gitdir: <path>` 行。
 * 相对路径相对于项目根目录解析。
 */
async function parseGitDirFile(gitFilePath: string, projectRoot: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(gitFilePath, "utf8");
  } catch {
    return undefined;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (match === null) {
    return undefined;
  }

  const rawPath = match[1].trim();
  if (rawPath === "") {
    return undefined;
  }

  const gitDir = isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath);

  try {
    const gitDirStat = await stat(gitDir);
    if (!gitDirStat.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return gitDir;
}

/**
 * 读取 worktree gitdir 内的 commondir，得到主仓库 git 目录。
 * 普通仓库或无 commondir 时返回 undefined。
 */
async function readCommonDir(gitDir: string): Promise<string | undefined> {
  const commonDirFile = join(gitDir, "commondir");

  try {
    const raw = (await readFile(commonDirFile, "utf8")).trim();
    if (raw === "") {
      return undefined;
    }

    const commonDir = isAbsolute(raw) ? raw : resolve(gitDir, raw);
    const commonStat = await stat(commonDir);
    return commonStat.isDirectory() ? commonDir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构造「无法安装 Git hook」时的友好错误信息。
 */
async function buildMissingGitRepositoryError(projectRoot: string): Promise<Error> {
  const gitPath = projectPath(projectRoot, ".git");

  try {
    const gitStat = await stat(gitPath);

    if (gitStat.isFile()) {
      return new Error(
        "当前项目的 .git 是 worktree 指针文件，但无法解析有效的 gitdir/hooks 路径。请确认 worktree 完整，或安装 Git 后重试。"
      );
    }

    if (!gitStat.isDirectory()) {
      return new Error("当前项目的 .git 既不是目录也不是有效的 gitdir 文件，无法安装 Git hook。");
    }

    return new Error("当前目录的 Git 元数据无法解析 hooks 路径，无法安装 Git hook。");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return new Error("当前目录不是 Git 仓库，无法安装 Git hook。");
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error("当前目录不是 Git 仓库，无法安装 Git hook。");
  }
}
