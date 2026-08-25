import { lstat } from "node:fs/promises";

import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import type { OperationResult } from "../types.js";

const BLOCK_START = "# code-helper:local:start";
const BLOCK_END = "# code-helper:local:end";
const LOCAL_WORKSPACE_RULE = ".code-helper/";

/**
 * 幂等维护只属于 code-helper 的 Git 忽略区块。
 *
 * 用户既有规则和其它工具区块逐字保留；重复的完整受控区块会归一为一个。若标记不完整或
 * 顺序错误，则拒绝猜测用户意图并报错，避免覆盖用户自行维护的 `.gitignore` 内容。
 */
export async function ensureCodeHelperGitIgnore(projectRoot: string): Promise<OperationResult> {
  const targetPath = projectPath(projectRoot, ".gitignore");
  await assertSafeGitIgnoreTarget(targetPath);

  const existing = await readTextIfExists(targetPath) ?? "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = [BLOCK_START, LOCAL_WORKSPACE_RULE, BLOCK_END].join(eol);
  const managedBlocks = findManagedBlocks(existing);
  const next = managedBlocks.length === 0
    ? appendManagedBlock(existing, block, eol)
    : replaceManagedBlocks(existing, managedBlocks, block);

  if (next === existing) {
    return { path: targetPath, action: "skipped", message: "code-helper 本地目录 Git 忽略规则已是最新" };
  }

  await writeText(targetPath, next);
  return { path: targetPath, action: existing.length === 0 ? "created" : "updated", message: "已维护 code-helper 本地目录 Git 忽略规则" };
}

/** 受控区块在原文件中的精确字符范围；范围不包含区块相邻的用户换行。 */
interface ManagedBlockRange {
  start: number;
  end: number;
}

/**
 * 拒绝让 init/update 通过符号链接写入项目外文件，也拒绝目录等非普通文件目标。
 * 不存在的 `.gitignore` 仍可由后续写入逻辑安全创建。
 */
async function assertSafeGitIgnoreTarget(targetPath: string): Promise<void> {
  try {
    const metadata = await lstat(targetPath);

    if (metadata.isSymbolicLink()) {
      throw new Error(`拒绝维护符号链接 .gitignore：${targetPath}`);
    }

    if (!metadata.isFile()) {
      throw new Error(`无法维护 .gitignore：目标不是普通文件：${targetPath}`);
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

/** 判断未知错误是否表示路径不存在，避免吞掉权限或链接环等真实异常。 */
function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * 查找并校验所有受控标记。完整标记必须严格按 start/end 成对出现；否则无法判断用户
 * 希望保留还是删除哪一段内容，因此抛出明确错误并保持原文件完全不变。
 */
function findManagedBlocks(content: string): ManagedBlockRange[] {
  const markerExpression = new RegExp(`${escapeRegExp(BLOCK_START)}|${escapeRegExp(BLOCK_END)}`, "gu");
  const markers = [...content.matchAll(markerExpression)];

  if (markers.length === 0) {
    return [];
  }

  if (markers.length % 2 !== 0) {
    throw new Error(".gitignore 中的 code-helper 受控区块标记不完整，未修改原文件");
  }

  const blocks: ManagedBlockRange[] = [];

  for (let index = 0; index < markers.length; index += 2) {
    const start = markers[index];
    const end = markers[index + 1];

    if (start[0] !== BLOCK_START || end[0] !== BLOCK_END || start.index === undefined || end.index === undefined) {
      throw new Error(".gitignore 中的 code-helper 受控区块标记顺序错误，未修改原文件");
    }

    blocks.push({ start: start.index, end: end.index + BLOCK_END.length });
  }

  return blocks;
}

/** 将缺失的受控区块追加到文件末尾，不移除或规整区块外的任何用户字符。 */
function appendManagedBlock(content: string, block: string, eol: string): string {
  if (content.length === 0) {
    return `${block}${eol}`;
  }

  const separator = content.endsWith("\n") ? eol : `${eol}${eol}`;
  return `${content}${separator}${block}${eol}`;
}

/**
 * 以当前文件的换行风格替换第一个完整区块，并删除其余完整重复区块。
 * 删除范围严格限制在标记自身之间，区块外的空行、注释和用户规则均逐字保留。
 */
function replaceManagedBlocks(content: string, blocks: ManagedBlockRange[], block: string): string {
  let cursor = 0;
  let next = "";

  blocks.forEach((managedBlock, index) => {
    next += content.slice(cursor, managedBlock.start);
    if (index === 0) {
      next += block;
    }
    cursor = managedBlock.end;
  });

  return `${next}${content.slice(cursor)}`;
}

/** 转义区块标记，使其可安全用于受控标记扫描。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
