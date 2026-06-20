import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ENTRY_BLOCK_END, ENTRY_BLOCK_START } from "./constants.js";
import type { OperationResult } from "./types.js";

/**
 * 判断未知错误是否表示文件不存在。
 * Node 的 fs 错误对象没有稳定的 TypeScript 类型，因此集中在这里做窄化。
 */
function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * 把相对路径解析到项目根目录下。
 * 所有写入都经过这个函数，避免不同模块各自拼接路径产生偏差。
 */
export function projectPath(projectRoot: string, relativePath: string): string {
  return resolve(projectRoot, relativePath);
}

/**
 * 确保目录存在。
 * recursive 模式让初始化可以同时支持新项目和部分已有目录的老项目。
 */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * 读取 UTF-8 文本文件；文件不存在时返回 undefined。
 * 初始化和检查都需要区分“空文件”和“不存在”，所以不用空字符串兜底。
 */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

/**
 * 写入文件前自动创建父目录。
 * 所有生成文件都走这里，避免调用方忘记创建目录。
 */
export async function writeText(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, content, "utf8");
}

/**
 * 仅在文件不存在时创建文件。
 * 对老项目尤其重要，避免覆盖已有规则、计划或状态文档。
 */
export async function writeTextIfMissing(path: string, content: string): Promise<OperationResult> {
  const existing = await readTextIfExists(path);

  if (existing !== undefined) {
    return {
      path,
      action: "skipped",
      message: "文件已存在，保持原内容"
    };
  }

  await writeText(path, content);

  return {
    path,
    action: "created",
    message: "已创建缺失文件"
  };
}

/**
 * 更新已有 Markdown 文件中的指定二级小节。
 * 如果文件不存在则创建；如果小节不存在则追加；如果内容相同则跳过。
 */
export async function upsertMarkdownSection(
  path: string,
  sectionTitle: string,
  sectionContent: string,
  fallbackContent: string
): Promise<OperationResult> {
  const existing = await readTextIfExists(path);

  if (existing === undefined) {
    await writeText(path, fallbackContent);

    return {
      path,
      action: "created",
      message: "已创建缺失文件"
    };
  }

  const normalizedSection = `${sectionTitle}\n\n${sectionContent.trim()}`;
  const nextContent = replaceMarkdownSection(existing, sectionTitle, normalizedSection);

  if (nextContent !== undefined) {
    if (nextContent === existing) {
      return {
        path,
        action: "skipped",
        message: "文件已存在，保持原内容"
      };
    }

    await writeText(path, ensureTrailingNewline(nextContent));

    return {
      path,
      action: "updated",
      message: `已更新 ${sectionTitle} 小节`
    };
  }

  await writeText(path, `${ensureTrailingNewline(existing)}\n${normalizedSection}\n`);

  return {
    path,
    action: "updated",
    message: `已追加 ${sectionTitle} 小节`
  };
}

/**
 * 通过行扫描替换 Markdown 二级小节。
 * 不使用复杂正则，是为了保证多次 init 时小节边界稳定、不会残留旧列表项。
 */
function replaceMarkdownSection(content: string, sectionTitle: string, replacement: string): string | undefined {
  const lines = content.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === sectionTitle);

  if (startIndex === -1) {
    return undefined;
  }

  let endIndex = lines.length;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("## ") && line.trim() !== sectionTitle) {
      endIndex = index;
      break;
    }
  }

  const before = lines.slice(0, startIndex);
  const after = lines.slice(endIndex);
  return [...before, replacement, ...after].join("\n");
}

/**
 * 在 Markdown 入口文件中追加或更新 code-helper 管理区块。
 * 这个函数只触碰受控区块，保护用户在区块外维护的项目规则。
 */
export async function upsertManagedMarkdownBlock(path: string, blockContent: string): Promise<OperationResult> {
  const normalizedBlock = `${ENTRY_BLOCK_START}\n${blockContent.trim()}\n${ENTRY_BLOCK_END}`;
  const existing = await readTextIfExists(path);

  if (existing === undefined) {
    await writeText(path, `# Agent 协作规则\n\n${normalizedBlock}\n`);

    return {
      path,
      action: "created",
      message: "已创建入口文档并写入 code-helper 区块"
    };
  }

  if (existing.includes(ENTRY_BLOCK_START) && existing.includes(ENTRY_BLOCK_END)) {
    const pattern = new RegExp(`${escapeRegExp(ENTRY_BLOCK_START)}[\\s\\S]*?${escapeRegExp(ENTRY_BLOCK_END)}`);
    const nextContent = existing.replace(pattern, normalizedBlock);

    if (nextContent === existing) {
      return {
        path,
        action: "skipped",
        message: "入口文档区块已是最新内容"
      };
    }

    await writeText(path, ensureTrailingNewline(nextContent));

    return {
      path,
      action: "updated",
      message: "已更新入口文档中的 code-helper 区块"
    };
  }

  await writeText(path, `${ensureTrailingNewline(existing)}\n${normalizedBlock}\n`);

  return {
    path,
    action: "updated",
    message: "已追加 code-helper 受控区块"
  };
}

/**
 * 转义字符串以安全拼进正则表达式。
 * 这里用于匹配 HTML 注释标记，避免特殊字符影响替换。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 确保文本以单个换行结尾。
 * Markdown 和 JSON 文件统一用换行结尾，减少 diff 噪音。
 */
export function ensureTrailingNewline(content: string): string {
  return `${content.replace(/\s+$/u, "")}\n`;
}
