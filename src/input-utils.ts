import { isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 解析用户输入或终端拖拽产生的文件路径。
 * 终端拖拽通常会粘贴引号、反斜杠转义空格或 file:// URL，这里统一归一化。
 */
export function normalizeDroppedPath(input: string, projectRoot: string): string {
  const cleanedInput = stripWrappingQuotes(input.trim());
  const decodedPath = cleanedInput.startsWith("file://")
    ? decodeFileUrlPath(cleanedInput)
    : decodePlainPath(cleanedInput);
  const normalizedPath = decodedPath.trim();

  if (isWindowsAbsolutePath(normalizedPath)) {
    const relativePath = win32.relative(win32.resolve(projectRoot), win32.normalize(normalizedPath));

    if (isProjectRelativePath(relativePath, "\\")) {
      return relativePath;
    }

    return normalizedPath;
  }

  if (isWindowsAbsolutePath(projectRoot) && isWindowsPathLike(normalizedPath)) {
    return normalizedPath;
  }

  if (isAbsolute(normalizedPath)) {
    const relativePath = relative(resolve(projectRoot), normalizedPath);

    if (isProjectRelativePath(relativePath, "/")) {
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
 * 解析 file:// URL。
 * Windows 终端可能粘贴 file:///C:/...，在非 Windows 测试环境下需要保留 C: 盘符形态，避免变成 /C:/...。
 */
function decodeFileUrlPath(value: string): string {
  const url = new URL(value);
  const decodedPath = decodeURIComponent(url.pathname);

  if (/^\/[A-Za-z]:\//u.test(decodedPath)) {
    return decodedPath.slice(1).replace(/\//gu, "\\");
  }

  return fileURLToPath(value);
}

/**
 * 解析普通路径输入。
 * Windows 路径中的反斜杠是路径分隔符，不能按 POSIX shell 转义处理。
 */
function decodePlainPath(value: string): string {
  if (isWindowsPathLike(value)) {
    return value;
  }

  return unescapeShellPath(value);
}

/**
 * 处理 shell 风格反斜杠转义。
 * 只移除反斜杠本身，保留被转义字符，例如 a\ b.md -> a b.md。
 */
function unescapeShellPath(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}

/**
 * 判断是否是 Windows 绝对路径。
 * 同时支持盘符路径和 UNC 网络路径。
 */
function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

/**
 * 判断是否看起来像 Windows 路径。
 * 相对路径 docs\需求.md 也要保留反斜杠，不能当成 shell 转义。
 */
function isWindowsPathLike(value: string): boolean {
  if (value.startsWith("/")) {
    return false;
  }

  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || /\\\S/u.test(value);
}

/**
 * 判断绝对路径是否位于项目目录下。
 * 空字符串表示就是项目根目录，不能作为需求文档路径返回。
 */
function isProjectRelativePath(value: string, separator: "\\" | "/"): boolean {
  return value !== "" && value !== ".." && !value.startsWith(`..${separator}`);
}
