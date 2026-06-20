#!/usr/bin/env node

import { runCli } from "./cli.js";

/**
 * 可执行文件入口。
 * 这里保持极薄，只负责把命令行参数交给 CLI 模块并设置退出码。
 */
const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
