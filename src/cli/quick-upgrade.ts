import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

import { projectPath, readTextIfExists } from "../fs-utils.js";
import { CODE_HELPER_PACKAGE_NAME } from "../version-check.js";

/**
 * npm 包升级命令。
 * command 是包管理器可执行文件，args 是传给该可执行文件的参数，二者分开保存以避免 shell 转义问题。
 */
export interface PackageUpgradeCommand {
  command: string;
  args: string[];
}

/**
 * 快捷升级依赖项。
 * 单元测试通过注入 runPackageCommand 和 runUpdateCommand 验证执行顺序，真实 CLI 使用默认实现。
 */
export interface CodeHelperQuickUpgradeOptions {
  runPackageCommand?: (command: PackageUpgradeCommand, projectRoot: string) => Promise<number>;
  runUpdateCommand?: (projectRoot: string) => Promise<number>;
}

/**
 * 主菜单顶部的快捷升级动作。
 * 该动作只在交互菜单中出现，执行顺序固定为：升级 npm 包，再刷新当前项目已有 code-helper 本地资产。
 */
export async function runCodeHelperQuickUpgrade(
  projectRoot: string,
  options: CodeHelperQuickUpgradeOptions = {}
): Promise<number> {
  const runPackageCommand = options.runPackageCommand ?? runPackageUpgradeCommand;
  const runUpdateCommand = options.runUpdateCommand ?? runLatestCodeHelperUpdateCommand;

  try {
    const command = await resolveCodeHelperUpgradeCommand(projectRoot);

    console.log(`准备升级 npm 包：${command.command} ${command.args.join(" ")}`);
    const installExitCode = await runPackageCommand(command, projectRoot);

    if (installExitCode !== 0) {
      console.error(`npm 包升级失败，退出码：${installExitCode}`);
      return installExitCode;
    }

    console.log("npm 包升级成功，开始刷新当前项目 code-helper 入口、Skills 和 Hooks。");
    const updateExitCode = await runUpdateCommand(projectRoot);

    if (updateExitCode !== 0) {
      console.error(`code-helper 本地资产刷新失败，退出码：${updateExitCode}`);
      return updateExitCode;
    }

    console.log("当前项目 code-helper 本地资产刷新完成。");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * 推断当前项目的 code-helper 包升级命令。
 * 优先读取 package.json 的 packageManager 字段，再参考常见锁文件；都无法判断时使用 npm。
 */
export async function resolveCodeHelperUpgradeCommand(projectRoot: string): Promise<PackageUpgradeCommand> {
  const packageJsonPath = projectPath(projectRoot, "package.json");
  const rawPackageJson = await readTextIfExists(packageJsonPath);

  if (rawPackageJson === undefined) {
    throw new Error("当前目录没有 package.json，无法升级 code-helper。请在 Node 项目根目录执行菜单升级。");
  }

  const packageManager = await inferPackageManager(projectRoot, rawPackageJson, packageJsonPath);
  const packageSpecifier = `${CODE_HELPER_PACKAGE_NAME}@latest`;

  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "-D", packageSpecifier] };
    case "yarn":
      return { command: "yarn", args: ["add", "-D", packageSpecifier] };
    case "bun":
      return { command: "bun", args: ["add", "-d", packageSpecifier] };
    case "npm":
    default:
      return { command: "npm", args: ["install", "-D", packageSpecifier] };
  }
}

/**
 * 运行升级后安装到项目里的 code-helper update。
 * 不能直接调用当前进程的 updateProject，否则 npm 包虽然已升级，刷新逻辑仍然来自旧版本代码。
 */
function runLatestCodeHelperUpdateCommand(projectRoot: string): Promise<number> {
  return runPackageUpgradeCommand(
    {
      command: "npx",
      args: ["code-helper", "update"]
    },
    projectRoot
  );
}

/**
 * 推断包管理器。
 * packageManager 字段最能代表项目当前约定；锁文件作为兼容旧项目的兜底信号。
 */
async function inferPackageManager(
  projectRoot: string,
  rawPackageJson: string,
  packageJsonPath: string
): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  const packageManagerFromJson = readPackageManagerField(rawPackageJson, packageJsonPath);

  if (packageManagerFromJson !== undefined) {
    return packageManagerFromJson;
  }

  if (await pathExists(projectPath(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (await pathExists(projectPath(projectRoot, "yarn.lock"))) {
    return "yarn";
  }

  if (
    await pathExists(projectPath(projectRoot, "bun.lock"))
    || await pathExists(projectPath(projectRoot, "bun.lockb"))
  ) {
    return "bun";
  }

  return "npm";
}

/**
 * 从 package.json 中读取 packageManager 字段。
 * 字段不存在或不是已支持的管理器时回退到锁文件/默认 npm；JSON 语法错误则直接失败，避免在未知项目结构下写入依赖。
 */
function readPackageManagerField(
  rawPackageJson: string,
  packageJsonPath: string
): "npm" | "pnpm" | "yarn" | "bun" | undefined {
  let packageJson: { packageManager?: unknown };

  try {
    packageJson = JSON.parse(rawPackageJson) as { packageManager?: unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${packageJsonPath} 不是合法 JSON，无法升级 code-helper：${message}`);
  }

  if (typeof packageJson.packageManager !== "string") {
    return undefined;
  }

  const [name] = packageJson.packageManager.split("@");

  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    return name;
  }

  return undefined;
}

/**
 * 判断路径是否存在。
 * 用 access 而不是读取文件内容，才能安全识别 bun.lockb 这类二进制锁文件。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行包管理器升级命令。
 * Windows 下 npm/pnpm/yarn/bun 通过 .cmd 启动；其他平台直接执行二进制，避免额外 shell 层污染参数。
 */
function runPackageUpgradeCommand(command: PackageUpgradeCommand, projectRoot: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePackageManagerExecutable(command.command), command.args, {
      cwd: projectRoot,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

/**
 * 解析跨平台可执行文件名。
 * Node 在 Windows 上不通过 shell 启动 .cmd 文件时需要显式补后缀。
 */
function resolvePackageManagerExecutable(command: string): string {
  return process.platform === "win32" ? `${command}.cmd` : command;
}
