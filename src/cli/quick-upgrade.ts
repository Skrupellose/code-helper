import { spawn } from "node:child_process";

import { pathExists, projectPath, readTextIfExists } from "../fs-utils.js";
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
 * 交给 child_process.spawn 的最终命令。
 * Windows 的 `.cmd` shim 需要通过 cmd.exe 运行，因此与逻辑层的包管理器命令分开建模。
 */
export interface PackageUpgradeSpawnCommand extends PackageUpgradeCommand {}

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
 * 解析升级后用于刷新本地资产的 update 命令。
 * 优先调用刚安装到 node_modules 的本地入口，确保执行的是新版本代码；
 * 本地入口不存在时回退到完整 scoped 包名的 npx，避免裸短名 code-helper 解析歧义。
 */
export async function resolveCodeHelperUpdateCommand(projectRoot: string): Promise<PackageUpgradeCommand> {
  const localEntryPath = projectPath(
    projectRoot,
    "node_modules/@skrupellose/code-helper/dist/index.js"
  );

  if (await pathExists(localEntryPath)) {
    return {
      // 使用当前 Node 进程的绝对可执行文件，避免 Windows 执行层把 `node` 错误解析成不存在的 `node.cmd`。
      command: process.execPath,
      args: [localEntryPath, "update"]
    };
  }

  return {
    command: "npx",
    args: ["--yes", CODE_HELPER_PACKAGE_NAME, "update"]
  };
}

/**
 * 运行升级后安装到项目里的 code-helper update。
 * 不能直接调用当前进程的 updateProject，否则 npm 包虽然已升级，刷新逻辑仍然来自旧版本代码。
 */
async function runLatestCodeHelperUpdateCommand(projectRoot: string): Promise<number> {
  const command = await resolveCodeHelperUpdateCommand(projectRoot);
  return runPackageUpgradeCommand(command, projectRoot);
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
 * 执行包管理器升级命令。
 * Windows 下包管理器 shim 通过 .cmd 启动；Node 绝对路径等原生可执行文件保持不变，避免生成 node.exe.cmd。
 */
function runPackageUpgradeCommand(command: PackageUpgradeCommand, projectRoot: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const spawnCommand = resolvePackageManagerSpawnCommand(command);
    const child = spawn(spawnCommand.command, spawnCommand.args, {
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
 * 解析交给 spawn 的跨平台命令与参数。
 * Node 官方文档明确说明 Windows 的 `.cmd` 文件不能作为普通可执行文件直接启动，因此 npm 等 shim
 * 必须显式交给 cmd.exe；这里不使用 `shell: true`，避免 Node 将参数拼成未经约束的 shell 命令。
 * 当前进入 cmd.exe 的命令名和参数均由本工具内部固定生成，不接收用户输入；项目路径只通过 cwd 传递。
 * Bun 在 Windows 上提供原生可执行文件，不属于 `.cmd` shim，必须保持直接启动。
 */
export function resolvePackageManagerSpawnCommand(
  command: PackageUpgradeCommand,
  platform: NodeJS.Platform = process.platform,
  commandProcessor: string = process.env.ComSpec ?? "cmd.exe"
): PackageUpgradeSpawnCommand {
  const windowsCommandShims = new Set(["npm", "npx", "pnpm", "pnpx", "yarn"]);

  if (platform === "win32" && windowsCommandShims.has(command.command.toLowerCase())) {
    return {
      command: commandProcessor,
      args: ["/d", "/s", "/c", `${command.command}.cmd`, ...command.args]
    };
  }

  return command;
}
