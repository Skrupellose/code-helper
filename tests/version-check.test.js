import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, formatOutdatedVersionMessage, shouldSkipVersionCheck } from "../dist/version-check.js";

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
  assert.equal(shouldSkipVersionCheck("update", {}), true);
  assert.equal(shouldSkipVersionCheck("sync-local", {}), true);
});

test("formatOutdatedVersionMessage 简洁说明菜单快捷升级含义", () => {
  // 版本提示只用于交互菜单路径，文案应指向顶部快捷升级入口而不是污染普通命令输出。
  const message = formatOutdatedVersionMessage("0.1.3", "0.1.4").join("\n");

  assert.match(message, /发现 code-helper 新版本：0\.1\.4（当前 0\.1\.3）/);
  assert.match(message, /主菜单顶部可选择“更新到最新版本”/);
  assert.match(message, /升级 npm 包并刷新当前项目 code-helper 入口、Skills 和 Hooks/);
});
