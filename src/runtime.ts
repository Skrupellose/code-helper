/** code-helper 完整 SQLite 模式可接受的最早 Node.js 版本。 */
export const MINIMUM_NODE_VERSION = "22.5.0";

/** Node.js 从此版本开始不再要求显式 --experimental-sqlite。 */
export const UNFLAGGED_SQLITE_NODE_VERSION = "22.13.0";

/** 可执行入口在加载业务模块前使用的运行时决策。 */
export type RuntimeBootstrapDecision =
  | { kind: "ready" }
  | { kind: "reexec"; execArgv: string[] }
  | { kind: "unsupported"; message: string };

/**
 * 判断当前 Node.js 能否运行完整 SQLite 工作流。
 *
 * Node 22.5.0 首次提供 DatabaseSync，但 22.13.0 之前需要显式实验参数；入口会在旧版
 * 22.x 上安全地重启自身，而不是要求用户记忆隐藏参数。低于 22.5.0 时不提供会丢失
 * 权威任务状态的伪降级模式。
 */
export function resolveRuntimeBootstrap(
  nodeVersion: string,
  currentExecArgv: readonly string[]
): RuntimeBootstrapDecision {
  const parsed = parseNodeVersion(nodeVersion);
  if (parsed === undefined || compareVersion(parsed, [22, 5, 0]) < 0) {
    return {
      kind: "unsupported",
      message: `code-helper 需要 Node.js >=${MINIMUM_NODE_VERSION}；当前版本为 ${nodeVersion}。`
    };
  }

  if (
    compareVersion(parsed, [22, 13, 0]) < 0
    && !currentExecArgv.includes("--experimental-sqlite")
  ) {
    // 必须保留调用方已有的 Node 参数；只追加缺失的 SQLite 参数即可天然避免重复。
    return { kind: "reexec", execArgv: [...currentExecArgv, "--experimental-sqlite"] };
  }

  return { kind: "ready" };
}

/** 解析严格的三段 Node.js 版本；允许 process.version 使用的 v 前缀。 */
function parseNodeVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 比较两个三段数字版本，返回负数、零或正数。 */
function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
