import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";

import {
  compareVersions,
  formatOutdatedVersionMessage,
  maybeNotifyVersionUpdate,
  shouldSkipVersionCheck
} from "../dist/version-check.js";

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

test("maybeNotifyVersionUpdate 在缓存未过期且当前版本一致时沿用缓存", async () => {
  // fresh 缓存的 currentVersion 与当前包一致时，不应触发 registry 请求。
  const root = await mkdtemp(join(tmpdir(), "code-helper-version-cache-hit-"));
  const originalCwd = process.cwd();
  const restoreTTY = forceTTY();
  const restoreConsoleError = silenceConsoleError();
  const currentVersion = await readCurrentPackageVersion();
  const latestVersion = getNextPatchVersion(currentVersion);
  const restoreFetch = mockFetch(async () => {
    throw new Error("不应请求 registry");
  });

  try {
    process.chdir(root);
    const cachePath = join(root, ".code-helper/checks/version-cache.json");
    await mkdir(join(root, ".code-helper/checks"), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(createVersionCache(currentVersion, latestVersion), null, 2)}\n`, "utf8");

    const state = await maybeNotifyVersionUpdate(root, "menu", {});
    const cache = JSON.parse(await readFile(cachePath, "utf8"));

    assert.equal(state?.currentVersion, currentVersion);
    assert.equal(state?.latestVersion, latestVersion);
    assert.equal(cache.currentVersion, currentVersion);
    assert.equal(cache.latestVersion, latestVersion);
  } finally {
    restoreFetch();
    restoreConsoleError();
    restoreTTY();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("maybeNotifyVersionUpdate 在缓存未过期但当前版本变化时刷新缓存", async () => {
  // 包升级后即使缓存仍在 TTL 内，也必须重新查询并写入新的 currentVersion。
  const root = await mkdtemp(join(tmpdir(), "code-helper-version-cache-refresh-"));
  const originalCwd = process.cwd();
  const restoreTTY = forceTTY();
  const restoreConsoleError = silenceConsoleError();
  const currentVersion = await readCurrentPackageVersion();
  const latestVersion = getNextPatchVersion(currentVersion);
  const cachedCurrentVersion = currentVersion === "0.0.0" ? "0.0.1" : "0.0.0";
  let fetchCount = 0;
  const restoreFetch = mockFetch(async () => {
    fetchCount += 1;

    return {
      ok: true,
      json: async () => ({ version: latestVersion })
    };
  });

  try {
    process.chdir(root);
    const cachePath = join(root, ".code-helper/checks/version-cache.json");
    await mkdir(join(root, ".code-helper/checks"), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(createVersionCache(cachedCurrentVersion, getNextPatchVersion(cachedCurrentVersion)), null, 2)}\n`, "utf8");

    const state = await maybeNotifyVersionUpdate(root, "menu", {});
    const cache = JSON.parse(await readFile(cachePath, "utf8"));

    assert.equal(fetchCount, 1);
    assert.equal(state?.currentVersion, currentVersion);
    assert.equal(state?.latestVersion, latestVersion);
    assert.equal(cache.currentVersion, currentVersion);
    assert.equal(cache.latestVersion, latestVersion);
    assert.equal(cache.status, "outdated");
  } finally {
    restoreFetch();
    restoreConsoleError();
    restoreTTY();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

function createVersionCache(currentVersion, latestVersion) {
  // 测试缓存结构保持与真实 version-cache.json 一致，便于覆盖读写行为。
  return {
    checkedAt: new Date().toISOString(),
    currentVersion,
    latestVersion,
    packageName: "@skrupellose/code-helper",
    registryUrl: "https://registry.npmjs.org/@skrupellose/code-helper/latest",
    status: compareVersions(currentVersion, latestVersion) < 0 ? "outdated" : "latest"
  };
}

async function readCurrentPackageVersion() {
  // 测试从项目 package.json 读取版本，避免发版后因为硬编码版本号失效。
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));

  return packageJson.version;
}

function getNextPatchVersion(version) {
  // 构造一个稳定大于当前版本的 latest，用于验证 outdated 状态。
  const parts = version.split(".");
  const patch = Number.parseInt(parts[2] ?? "0", 10);

  return `${parts[0]}.${parts[1]}.${Number.isNaN(patch) ? 1 : patch + 1}`;
}

function forceTTY() {
  // 版本提醒只在 TTY 中运行，测试需要临时模拟交互终端。
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });

  return () => {
    restoreProperty(process.stdout, "isTTY", stdoutDescriptor);
    restoreProperty(process.stderr, "isTTY", stderrDescriptor);
  };
}

function mockFetch(implementation) {
  // 替换全局 fetch，确保单测不会访问真实 npm registry。
  const originalFetch = globalThis.fetch;

  globalThis.fetch = implementation;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function silenceConsoleError() {
  // 升级提示写入 stderr，测试中静默掉输出以保持结果干净。
  const originalConsoleError = console.error;

  console.error = () => {};

  return () => {
    console.error = originalConsoleError;
  };
}

function restoreProperty(target, propertyName, descriptor) {
  // 恢复原始属性描述符，避免 TTY mock 泄漏到后续测试。
  if (descriptor === undefined) {
    delete target[propertyName];
    return;
  }

  Object.defineProperty(target, propertyName, descriptor);
}
