import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import type { OperationResult } from "../types.js";

/**
 * code-helper 推荐写入用户项目 package.json 的 npm scripts。
 * 这些脚本只调用已安装的 bin 名称，既适配本地 devDependency，也适配 npm scripts 自动加入的 node_modules/.bin。
 */
const CODE_HELPER_RECOMMENDED_NPM_SCRIPTS = {
  "code-helper:init": "code-helper init",
  "code-helper:update": "code-helper update",
  "code-helper:check": "code-helper check",
  "code-helper:finish": "code-helper finish"
} as const;

interface PackageJsonWithScripts {
  scripts?: unknown;
  [key: string]: unknown;
}

/**
 * 在当前项目 package.json 中安装常用 code-helper npm scripts。
 * 已存在的同名脚本保持原样，避免覆盖用户自定义流程；缺少 package.json 时直接报错提醒用户先进入 Node 项目根目录。
 */
export async function installCodeHelperNpmScripts(projectRoot: string): Promise<OperationResult[]> {
  const packageJsonPath = projectPath(projectRoot, "package.json");
  const rawPackageJson = await readTextIfExists(packageJsonPath);

  if (rawPackageJson === undefined) {
    throw new Error("当前目录没有 package.json，无法安装 npm scripts。请在 Node 项目根目录执行 `code-helper npm-scripts install`。");
  }

  const packageJson = parsePackageJson(rawPackageJson, packageJsonPath);
  const scripts = ensurePackageScriptsObject(packageJson, packageJsonPath);
  const operations: OperationResult[] = [];
  let changed = false;

  for (const [scriptName, command] of Object.entries(CODE_HELPER_RECOMMENDED_NPM_SCRIPTS)) {
    if (Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
      operations.push({
        path: packageJsonPath,
        action: "skipped",
        message: `已存在 npm script：${scriptName}，保持原命令`
      });
      continue;
    }

    scripts[scriptName] = command;
    changed = true;
    operations.push({
      path: packageJsonPath,
      action: "updated",
      message: `已添加 npm script：${scriptName}`
    });
  }

  if (changed) {
    await writeText(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  return operations;
}

/**
 * 解析 package.json，并把语法错误转换成面向 CLI 用户的清晰错误。
 */
function parsePackageJson(content: string, packageJsonPath: string): PackageJsonWithScripts {
  try {
    return JSON.parse(content) as PackageJsonWithScripts;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${packageJsonPath} 不是合法 JSON，无法安装 npm scripts：${message}`);
  }
}

/**
 * 确保 scripts 字段是可写对象。
 * package.json 允许没有 scripts，此时创建一个对象；如果用户写成数组或字符串，则停止以避免破坏未知结构。
 */
function ensurePackageScriptsObject(
  packageJson: PackageJsonWithScripts,
  packageJsonPath: string
): Record<string, string> {
  if (packageJson.scripts === undefined) {
    packageJson.scripts = {};
  }

  if (
    typeof packageJson.scripts !== "object" ||
    packageJson.scripts === null ||
    Array.isArray(packageJson.scripts)
  ) {
    throw new Error(`${packageJsonPath} 的 scripts 字段不是对象，无法安全安装 npm scripts。`);
  }

  return packageJson.scripts as Record<string, string>;
}
