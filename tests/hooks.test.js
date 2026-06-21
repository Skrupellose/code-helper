import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { setFeatureEnabled } from "../dist/config.js";
import {
  installHook,
  listHookInstallations,
  parseHookTargets,
  uninstallHook
} from "../dist/hooks.js";

test("parseHookTargets 会解析 hooks 安装目标", () => {
  // 该测试锁定 CLI 支持的 hooks 目标别名。
  assert.deepEqual(parseHookTargets("all"), ["git", "codex", "claudecode"]);
  assert.deepEqual(parseHookTargets("agent"), ["codex", "claudecode"]);
  assert.deepEqual(parseHookTargets("git"), ["git"]);
  assert.deepEqual(parseHookTargets("codex"), ["codex"]);
  assert.deepEqual(parseHookTargets("claude"), ["claudecode"]);
});

test("installHook 不需要用户预先启用 hooks 开关", async () => {
  // 该测试确认直接安装动作不要求用户先理解 feature key。
  const root = await mkdtemp(join(tmpdir(), "code-helper-hooks-disabled-"));

  try {
    await mkdir(join(root, ".git/hooks"), { recursive: true });

    const gitOperation = await installHook(root, "git");
    const codexOperation = await installHook(root, "codex");

    assert.equal(gitOperation.action, "created");
    assert.equal(codexOperation.action, "created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hooks install 不带目标时不会默认安装全部 hooks", async () => {
  // hooks 会写入真实配置，直接命令必须要求用户显式传入目标。
  const root = await mkdtemp(join(tmpdir(), "code-helper-hooks-no-target-"));
  const errors = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;

  try {
    console.error = (...args) => {
      errors.push(args.join(" "));
    };
    console.log = (...args) => {
      logs.push(args.join(" "));
    };
    await mkdir(join(root, ".git/hooks"), { recursive: true });

    const exitCode = await runCli(["hooks", "install"], root);
    const statuses = await listHookInstallations(root);

    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /缺少 hooks 目标/);
    assert.equal(statuses.some((status) => status.installed), false);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("installHook 和 uninstallHook 支持 Git pre-commit", async () => {
  // 该测试覆盖 Git hook 的安装、状态识别和卸载。
  const root = await mkdtemp(join(tmpdir(), "code-helper-hooks-git-"));

  try {
    await mkdir(join(root, ".git/hooks"), { recursive: true });
    await setFeatureEnabled(root, "gitHooks", true);

    const installOperation = await installHook(root, "git");
    const installed = await readFile(join(root, ".git/hooks/pre-commit"), "utf8");
    const installedStatuses = await listHookInstallations(root);
    const uninstallOperation = await uninstallHook(root, "git");
    const uninstalledStatuses = await listHookInstallations(root);

    assert.equal(installOperation.action, "created");
    assert.match(installed, /code-helper:managed-pre-commit/);
    assert.equal(installedStatuses.find((status) => status.target === "git")?.installed, true);
    assert.equal(uninstallOperation.action, "updated");
    assert.equal(uninstalledStatuses.find((status) => status.target === "git")?.installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installHook 支持 Codex 和 Claude Code Agent hooks", async () => {
  // 该测试确认 agentHooks 开启后会写入项目级 agent hooks 配置。
  const root = await mkdtemp(join(tmpdir(), "code-helper-hooks-agent-"));

  try {
    await setFeatureEnabled(root, "agentHooks", true);

    await installHook(root, "codex");
    await installHook(root, "claudecode");

    const codex = await readFile(join(root, ".codex/hooks.json"), "utf8");
    const claude = await readFile(join(root, ".claude/settings.json"), "utf8");
    const agentHook = await readFile(join(root, ".code-helper/hooks/agent-finish-check.mjs"), "utf8");
    const statuses = await listHookInstallations(root);
    const codexConfig = JSON.parse(codex);
    const claudeConfig = JSON.parse(claude);
    const codexCommand = codexConfig.hooks.Stop[0].hooks[0].command;
    const claudeCommand = claudeConfig.hooks.Stop[0].hooks[0].command;

    assert.match(codexCommand, /agent-finish-check\.mjs/);
    assert.doesNotMatch(codexCommand, /@skrupellose\/code-helper/);
    assert.match(codex, /commandWindows/);
    assert.match(claudeCommand, /agent-finish-check\.mjs/);
    assert.doesNotMatch(claudeCommand, /@skrupellose\/code-helper/);
    assert.match(agentHook, /process\.stdout\.write\("\{\}\\n"\)/);
    assert.equal(statuses.find((status) => status.target === "codex")?.installed, true);
    assert.equal(statuses.find((status) => status.target === "claudecode")?.installed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent hook 包装脚本 stdout 只输出 JSON，检查内容写入 stderr", async () => {
  // Codex Stop hook 会解析 stdout 为 JSON；该测试防止 finish 的中文文本再次污染 stdout。
  const root = await mkdtemp(join(tmpdir(), "code-helper-hooks-json-"));

  try {
    await setFeatureEnabled(root, "agentHooks", true);
    await installHook(root, "codex");

    const fakeBin = join(root, "fake-bin");
    await mkdir(fakeBin, { recursive: true });

    if (process.platform === "win32") {
      await writeFile(
        join(fakeBin, "npx.cmd"),
        "@echo off\r\necho 功能完成检查：检测到活动任务\r\necho hook stderr text 1>&2\r\nexit /b 0\r\n",
        "utf8"
      );
    } else {
      const fakeNpx = join(fakeBin, "npx");
      await writeFile(
        fakeNpx,
        "#!/bin/sh\necho '功能完成检查：检测到活动任务'\necho 'hook stderr text' >&2\nexit 0\n",
        "utf8"
      );
      await chmod(fakeNpx, 0o755);
    }

    const scriptPath = join(root, ".code-helper/hooks/agent-finish-check.mjs");
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /功能完成检查：检测到活动任务/);
    assert.match(result.stderr, /hook stderr text/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
