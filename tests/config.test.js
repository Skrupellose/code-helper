import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../dist/constants.js";
import { mergeConfig } from "../dist/config.js";

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
  assert.equal(config.features.gitHooks.enabled, true);
  assert.equal(config.features.skillRegistration.enabled, true);
  assert.deepEqual(config.directories, DEFAULT_CONFIG.directories);
});
