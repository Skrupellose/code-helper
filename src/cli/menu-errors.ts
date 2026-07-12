/**
 * 交互菜单致命错误判断。
 * stdin / readline 关闭后无法再读输入，应结束会话而不是假装回到菜单。
 * 单独成模块便于纯函数单测，避免依赖整份 cli 入口。
 */

/**
 * 可识别为致命 I/O 的 Node 错误 code 集合。
 * 优先于 message 子串匹配，避免文案变更导致漏判或误判。
 */
const FATAL_NODE_ERROR_CODES = new Set([
  "ERR_USE_AFTER_CLOSE",
  "ERR_STREAM_DESTROYED",
  "EPIPE",
  "ERR_STREAM_WRITE_AFTER_END"
]);

/**
 * 从未知错误对象上读取 Node 风格的 `code` 字段（若存在）。
 */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

/**
 * 判断交互菜单是否遇到无法继续的致命错误。
 *
 * 匹配优先级：
 * 1. `error.name === "AbortError"`
 * 2. Node `code`（如 ERR_USE_AFTER_CLOSE、EPIPE 等）
 * 3. message 子串（仅作兜底，兼容无 code 的历史错误文案）
 */
export function isFatalInteractiveMenuError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // 1. 标准 AbortError（含部分取消/中断场景）
  if (error.name === "AbortError") {
    return true;
  }

  // 2. 稳定的 Node 错误 code，优先于文案
  const code = getErrorCode(error);
  if (code !== undefined && FATAL_NODE_ERROR_CODES.has(code)) {
    return true;
  }

  // 3. message 子串兜底：readline/stdin 已关闭类错误
  const message = error.message.toLowerCase();
  return (
    message.includes("readline was closed")
    || message.includes("the readline interface instance has been finished")
    || (message.includes("stdin") && (message.includes("close") || message.includes("closed")))
  );
}
