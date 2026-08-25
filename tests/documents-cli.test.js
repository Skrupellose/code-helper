import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { initializeProject } from "../dist/init.js";

/** 捕获 CLI 输出，避免迁移摘要污染测试回执。 */
async function runCliCaptured(args, projectRoot) {
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

test("documents CLI 支持预览、显式迁移、完整性检查和安全导出", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-documents-cli-"));
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    await mkdir(join(root, "code-helper-docs/result-doc/迁移任务"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/plan-doc"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/status-doc"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/plan-doc/迁移任务.md"), "# 计划\n", "utf8");
    await writeFile(join(root, "code-helper-docs/result-doc/迁移任务/实施记录.md"), "# 实施\n", "utf8");
    await writeFile(join(root, "code-helper-docs/status-doc/迁移任务-状态.md"), "# 状态\n", "utf8");

    const preview = await runCliCaptured(["documents", "migrate", "--json"], root);
    assert.equal(preview.exitCode, 0);
    assert.match(preview.logs.join("\n"), /迁移任务/u);

    const applied = await runCliCaptured(["documents", "migrate", "--apply"], root);
    assert.equal(applied.exitCode, 0);
    assert.match(applied.logs.join("\n"), /已导入：1/u);

    const checked = await runCliCaptured(["documents", "check"], root);
    assert.equal(checked.exitCode, 0);
    assert.match(checked.logs.join("\n"), /检查通过/u);

    // migrate --apply 本身必须登记基线，不能要求用户先额外执行一次 export。
    assert.equal(await readFile(join(root, ".code-helper/local/docs/plan-doc/迁移任务.md"), "utf8"), "# 计划\n");

    await writeFile(join(root, ".code-helper/local/docs/plan-doc/迁移任务.md"), "# 计划修订\n", "utf8");
    const importPreview = await runCliCaptured(["documents", "import", "--json"], root);
    assert.equal(importPreview.exitCode, 0);
    assert.match(importPreview.logs.join("\n"), /"status": "candidate"/u);
    const imported = await runCliCaptured(["documents", "import", "--apply"], root);
    assert.equal(imported.exitCode, 0);
    assert.match(imported.logs.join("\n"), /已导入：1/u);

    const tracked = await runCliCaptured(["documents", "export", "--tracked", "--force"], root);
    assert.equal(tracked.exitCode, 0);
    assert.equal(await readFile(join(root, "code-helper-docs/plan-doc/迁移任务.md"), "utf8"), "# 计划修订\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documents migrate 为旧英文文件生成稳定中文视图和首次导入基线", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-documents-legacy-baseline-"));
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    await mkdir(join(root, "code-helper-docs/result-doc/英文迁移"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/result-doc/英文迁移/implementation.md"), "# 旧实施\n", "utf8");

    const applied = await runCliCaptured(["documents", "migrate", "--apply"], root);
    assert.equal(applied.exitCode, 0);
    assert.equal(
      await readFile(join(root, ".code-helper/local/docs/result-doc/英文迁移/实施记录.md"), "utf8"),
      "# 旧实施\n"
    );

    await writeFile(join(root, ".code-helper/local/docs/result-doc/英文迁移/实施记录.md"), "# 新实施\n", "utf8");
    const preview = await runCliCaptured(["documents", "import", "--json"], root);
    assert.equal(preview.exitCode, 0);
    assert.match(preview.logs.join("\n"), /"status": "candidate"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documents migrate 对 mixed 旧任务保持只读并返回冲突退出码", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-documents-mixed-"));
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    await mkdir(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/plan-doc/冲突任务.md"), "# 活动\n", "utf8");
    await writeFile(join(root, "code-helper-docs/plan-doc/archive/冲突任务.md"), "# 归档\n", "utf8");

    const preview = await runCliCaptured(["documents", "migrate"], root);
    assert.equal(preview.exitCode, 2);
    assert.match(preview.errors.join("\n"), /同时存在活动与归档/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documents 从子目录执行时复用项目根数据库", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-documents-nested-"));
  const nested = join(root, "packages/demo");
  try {
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    await mkdir(nested, { recursive: true });
    const checked = await runCliCaptured(["documents", "check"], nested);
    assert.equal(checked.exitCode, 0);
    await stat(join(root, ".code-helper/code-helper.sqlite"));
    await assert.rejects(() => stat(join(nested, ".code-helper/code-helper.sqlite")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
