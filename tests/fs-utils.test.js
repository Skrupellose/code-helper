import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pathExists } from "../dist/fs-utils.js";
import { containsChinese } from "../dist/text-utils.js";

test("containsChinese 识别汉字脚本并忽略纯英文", () => {
  // 共享实现依赖 Unicode Script=Han，中文命名检查与归档候选排序都依赖这一语义。
  assert.equal(containsChinese("功能完成检查"), true);
  assert.equal(containsChinese("mixed 中文 and latin"), true);
  assert.equal(containsChinese("documentArchive"), false);
  assert.equal(containsChinese(""), false);
});

test("pathExists：存在为 true，ENOENT 为 false", async () => {
  // ENOENT 必须 soft miss；这是全仓库统一的 pathExists 契约。
  const root = await mkdtemp(join(tmpdir(), "code-helper-path-exists-"));

  try {
    const filePath = join(root, "present.txt");
    await writeFile(filePath, "ok", "utf8");

    assert.equal(await pathExists(filePath), true);
    assert.equal(await pathExists(root), true);
    assert.equal(await pathExists(join(root, "missing.txt")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pathExists：非 ENOENT 错误应向上抛出", async () => {
  // 权限等错误不能被吞掉，调用方若需要 soft miss 必须自行 try/catch。
  // 在不支持 chmod 限制目录遍历的平台上跳过，避免误报。
  if (process.platform === "win32") {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "code-helper-path-exists-eacces-"));

  try {
    const blockedDir = join(root, "blocked");
    const nestedPath = join(blockedDir, "secret.txt");
    // writeFile 不会自动创建父目录，需先 mkdir 再落文件。
    await mkdir(blockedDir, { recursive: true });
    await writeFile(nestedPath, "secret", "utf8");
    // 去掉目录的执行/读权限，使 access(nested) 触发 EACCES 而非 ENOENT。
    await chmod(blockedDir, 0o000);

    await assert.rejects(() => pathExists(nestedPath), (error) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.notEqual(error.code, "ENOENT");
      return true;
    });
  } finally {
    // 恢复权限后才能递归删除。
    try {
      await chmod(join(root, "blocked"), 0o755);
    } catch {
      // 目录可能已不存在或权限恢复失败，最后仍 force 清理。
    }
    await rm(root, { recursive: true, force: true });
  }
});
