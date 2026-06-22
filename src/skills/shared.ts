import { readdir } from "node:fs/promises";

import { readTextIfExists } from "../fs-utils.js";

/**
 * 判断未知异常是否为指定文件系统错误码。
 * Node 的 fs 错误没有稳定公共类型，集中窄化能避免各模块重复写脆弱判断。
 */
export function hasFileSystemErrorCode(error: unknown, codes: string[]): boolean {
  return typeof error === "object" && error !== null && "code" in error && codes.includes(String(error.code));
}

/**
 * 安全判断目录是否存在。
 * 目录不存在或路径指向普通文件时都返回 false，便于跨平台保持一致的探测语义。
 */
export async function directoryExists(path: string): Promise<boolean> {
  return (await readDirectoryIfExists(path)) !== undefined;
}

/**
 * 安全读取目录；目录不存在或不是目录时返回 undefined。
 */
export async function readDirectoryIfExists(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if (hasFileSystemErrorCode(error, ["ENOENT", "ENOTDIR"])) {
      return undefined;
    }

    throw error;
  }
}

/**
 * 安全读取单个 SKILL.md。
 * skills 根目录下混入普通文件时，`目录名/SKILL.md` 会触发 ENOTDIR，这里把它归为结构缺失问题。
 */
export async function readSkillDocumentIfExists(path: string): Promise<string | undefined> {
  try {
    return await readTextIfExists(path);
  } catch (error) {
    if (hasFileSystemErrorCode(error, ["ENOTDIR"])) {
      return undefined;
    }

    throw error;
  }
}
