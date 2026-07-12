/**
 * 文本相关的轻量工具。
 * 与文件系统无关的字符串判断集中在此，避免 archive / workflows / checks 各自复制同一正则。
 */

/**
 * 判断字符串是否包含中文字符（汉字脚本）。
 * 使用 Unicode Script=Han，覆盖常用汉字与扩展区，避免仅匹配 `\u4e00-\u9fff` 漏检。
 * 文档命名、归档候选排序、中文命名检查等场景共用此语义。
 */
export function containsChinese(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}
