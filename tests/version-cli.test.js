import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { initializeProject } from "../dist/init.js";
import { getCurrentPackageVersion } from "../dist/version-check.js";

/** 捕获版本命令输出，便于断言 JSON 契约。 */
async function runVersionCli(args, projectRoot) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...items) => logs.push(items.join(" "));
    console.error = (...items) => errors.push(items.join(" "));
    return { exitCode: await runCli(args, projectRoot), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("version status 和 set 区分当前版本通道与项目选择", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-version-cli-"));
  try {
    const initial = await runVersionCli(["version", "status", "--json"], root);
    assert.equal(initial.exitCode, 0);
    const initialResponse = JSON.parse(initial.logs.join("\n"));
    assert.equal(initialResponse.ok, true);
    assert.equal(initialResponse.action, "version.status");
    const initialStatus = initialResponse.data.version;
    assert.equal(initialStatus.currentVersion, await getCurrentPackageVersion());
    assert.equal(initialStatus.selectedChannel, "stable");
    assert.equal(initialStatus.policyExplicit, false);

    const selected = await runVersionCli(["version", "set", "canary"], root);
    assert.equal(selected.exitCode, 0);
    const status = await runVersionCli(["version", "status", "--json"], root);
    const parsed = JSON.parse(status.logs.join("\n"));
    assert.equal(parsed.data.version.selectedChannel, "canary");
    assert.equal(parsed.data.version.policyExplicit, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version set 拒绝未知发布通道", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-version-invalid-"));
  try {
    const result = await runVersionCli(["version", "set", "beta"], root);
    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join("\n"), /stable\|canary/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version 项目策略从子目录执行时仍写入已初始化项目根", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-version-nested-"));
  const nested = join(root, "packages/demo");
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    await mkdir(nested, { recursive: true });
    const result = await runVersionCli(["version", "set", "canary"], nested);
    assert.equal(result.exitCode, 0);
    await stat(join(root, ".code-helper/version-policy.json"));
    await assert.rejects(() => stat(join(nested, ".code-helper/version-policy.json")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
