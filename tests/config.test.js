import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../dist/constants.js";
import { loadConfig, mergeConfig, saveConfig } from "../dist/config.js";
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
  assert.deepEqual(config.skills, { mode: "profile", profile: "full" });
  assert.equal(config.version, DEFAULT_CONFIG.version);
  assert.deepEqual(config.directories, DEFAULT_CONFIG.directories);
});

test("Skills 配置会确定性排序并在保存时严格拒绝非法值", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skill-config-"));

  try {
    const config = mergeConfig({
      skills: { mode: "modules", modules: ["memory", "core", "memory"] }
    });
    assert.deepEqual(config.skills, { mode: "modules", modules: ["core", "memory"] });

    await saveConfig(root, config);
    const persisted = JSON.parse(await readFile(join(root, ".code-helper/config.json"), "utf8"));
    assert.deepEqual(persisted.skills, { mode: "modules", modules: ["core", "memory"] });

    const invalid = { ...config, skills: { mode: "modules", modules: ["unknown"] } };
    await assert.rejects(() => saveConfig(root, invalid), /不支持的 Skills 模块：unknown/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧配置缺少或损坏 Skills 选择时保守迁移为 full", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skill-config-migration-"));

  try {
    await mkdir(join(root, ".code-helper"), { recursive: true });
    await writeFile(
      join(root, ".code-helper/config.json"),
      JSON.stringify({ ...DEFAULT_CONFIG, version: 1, skills: { mode: "modules", modules: [] } }),
      "utf8"
    );
    const config = await loadConfig(root);
    assert.equal(config.version, DEFAULT_CONFIG.version);
    assert.deepEqual(config.skills, { mode: "profile", profile: "full" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks 会报告手工写入的非法 Skills 选择", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skill-config-check-"));

  try {
    await mkdir(join(root, ".code-helper"), { recursive: true });
    await writeFile(
      join(root, ".code-helper/config.json"),
      JSON.stringify({ ...DEFAULT_CONFIG, skills: { mode: "profile", profile: "unknown" } }),
      "utf8"
    );
    const issues = await runChecks(root);
    assert.ok(issues.some((issue) => issue.code === "invalid-skill-selection"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
