import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { resolvePackageManagerSpawnCommand } from "../dist/cli/quick-upgrade.js";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

/**
 * 复用 CLI 已验证的跨平台包管理器启动规则。
 * Windows 显式通过 cmd.exe 执行 npm.cmd；其它平台直接执行 npm，
 * 命令和参数保持数组结构，不启用 shell，也不拼接用户输入。
 */
function getNpmPackCommand() {
  return resolvePackageManagerSpawnCommand({
    command: "npm",
    args: ["pack", "--dry-run", "--json", "--ignore-scripts"]
  });
}

test("npm pack 清单包含 README 引用的最佳实践指南", async () => {
  // 使用 npm 自己生成的 dry-run JSON 清单，避免只检查 files 配置却遗漏实际发布产物。
  const command = getNpmPackCommand();
  const { stdout } = await execFileAsync(command.command, command.args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODE_HELPER_SKIP_VERSION_CHECK: "1"
    },
    maxBuffer: 10 * 1024 * 1024
  });
  const [packResult] = JSON.parse(stdout);
  const packedPaths = new Set(packResult.files.map((file) => file.path));
  const readme = await readFile(join(projectRoot, "README.md"), "utf8");
  const guideLink = /\[最佳实践指南\]\(([^)]+)\)/u.exec(readme)?.[1];

  assert.equal(guideLink, "docs/最佳实践指南.md");
  assert.ok(packedPaths.has("README.md"));
  assert.ok(packedPaths.has(guideLink));
});
