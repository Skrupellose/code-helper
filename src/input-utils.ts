import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 解析用户输入或终端拖拽产生的文件路径。
 * 终端拖拽通常会粘贴引号、反斜杠转义空格或 file:// URL，这里统一归一化。
 */
export function normalizeDroppedPath(input: string, projectRoot: string): string {
  const cleanedInput = stripWrappingQuotes(input.trim());
  const decodedPath = cleanedInput.startsWith("file://")
    ? fileURLToPath(cleanedInput)
    : unescapeShellPath(cleanedInput);
  const normalizedPath = decodedPath.trim();
  const absoluteProjectRoot = resolve(projectRoot);

  if (normalizedPath.startsWith("/")) {
    const relativePath = relative(absoluteProjectRoot, normalizedPath);

    if (!relativePath.startsWith("..") && relativePath !== "") {
      return relativePath;
    }
  }

  return normalizedPath;
}

/**
 * 去掉拖拽路径外层可能出现的单引号或双引号。
 */
function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("\"") && value.endsWith("\""))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * 处理 shell 风格反斜杠转义。
 * 只移除反斜杠本身，保留被转义字符，例如 a\ b.md -> a b.md。
 */
function unescapeShellPath(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}
