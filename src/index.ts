#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { resolveRuntimeBootstrap } from "./runtime.js";

/**
 * 可执行文件入口。
 * 这里先处理 Node 22.5-22.12 的 SQLite 实验参数，再延迟加载 CLI 并设置退出码。
 */
const runtimeDecision = resolveRuntimeBootstrap(process.version, process.execArgv);
if (runtimeDecision.kind === "unsupported") {
  console.error(runtimeDecision.message);
  process.exitCode = 1;
} else if (runtimeDecision.kind === "reexec") {
  // stdio 继承可保持 CLI 交互、JSON stdout 和错误输出语义；附加参数后同一入口只重启一次。
  const child = spawnSync(
    process.execPath,
    [...runtimeDecision.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: process.env }
  );
  if (child.error !== undefined) {
    console.error(`无法使用 SQLite 兼容参数重启 code-helper：${child.error.message}`);
  }
  process.exitCode = child.status ?? 1;
} else {
  // 延迟加载确保不受支持的运行时在解析 node:sqlite 相关业务模块前得到明确诊断。
  const { runCli } = await import("./cli.js");
  process.exitCode = await runCli(process.argv.slice(2));
}
