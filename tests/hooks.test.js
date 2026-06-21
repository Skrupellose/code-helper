import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const statuses = await listHookInstallations(root);

    assert.match(codex, /@skrupellose\/code-helper/);
    assert.match(codex, /commandWindows/);
    assert.match(claude, /@skrupellose\/code-helper/);
    assert.equal(statuses.find((status) => status.target === "codex")?.installed, true);
    assert.equal(statuses.find((status) => status.target === "claudecode")?.installed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
