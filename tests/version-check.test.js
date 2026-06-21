import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, shouldSkipVersionCheck } from "../dist/version-check.js";

test("compareVersions 会比较数字版本", () => {
  // 版本提醒只需要判断 npm latest 是否大于当前运行版本。
  assert.equal(compareVersions("0.1.2", "0.1.3") < 0, true);
  assert.equal(compareVersions("0.1.3", "0.1.3"), 0);
  assert.equal(compareVersions("0.2.0", "0.1.9") > 0, true);
});

test("shouldSkipVersionCheck 在 CI 和非菜单命令中跳过", () => {
  // 版本检查不能污染 CI、脚本和非交互命令输出。
  assert.equal(shouldSkipVersionCheck(undefined, { CI: "true" }), true);
  assert.equal(shouldSkipVersionCheck("check", {}), true);
  assert.equal(shouldSkipVersionCheck("help", {}), true);
});
