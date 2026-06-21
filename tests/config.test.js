import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../dist/constants.js";
import { mergeConfig } from "../dist/config.js";
import { runChecks } from "../dist/checks.js";

test("mergeConfig 会补齐缺失的默认功能开关", () => {
  // 该测试验证老项目配置缺字段时仍可被新版本 CLI 正常读取。
  const config = mergeConfig({
    features: {
      gitHooks: { enabled: true }
    }
  });

  assert.equal(config.features.memoryTuning.enabled, true);
  assert.equal(config.features.planWorkbench.enabled, true);
  assert.equal(config.features.testingPolicy.enabled, true);
  assert.equal(config.features.completionReview.enabled, true);
  assert.equal(config.features.gitHooks.enabled, true);
  assert.equal(config.features.agentHooks.enabled, false);
  assert.equal(config.features.skillRegistration.enabled, true);
  assert.deepEqual(config.directories, DEFAULT_CONFIG.directories);
});

test("runChecks 会发现原始配置缺失功能开关", async () => {
  // loadConfig 会自动合并默认值，检查命令必须在合并前识别用户手工删掉的 feature key。
  const root = await mkdtemp(join(tmpdir(), "code-helper-config-check-"));

  try {
    await mkdir(join(root, ".code-helper"), { recursive: true });
    await writeFile(
      join(root, ".code-helper/config.json"),
      JSON.stringify({
        version: 1,
        entryFiles: { agents: false, claude: false, copilot: false },
        directories: DEFAULT_CONFIG.directories,
        features: {
          gitHooks: { enabled: true }
        }
      }),
      "utf8"
    );

    const issues = await runChecks(root);

    assert.ok(issues.some((issue) => issue.code === "missing-feature-toggle" && issue.message.includes("memoryTuning")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
