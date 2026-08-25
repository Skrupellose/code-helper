import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const distRoot = process.env.CODE_HELPER_TEST_DIST_ROOT ?? join(import.meta.dirname, "../dist");
const {
  DocumentRepository,
  applyLegacyDocumentMigration,
  previewLegacyDocumentMigration
} = await import(pathToFileURL(join(distRoot, "documents/index.js")).href);
const { openDocumentDatabase } = await import(pathToFileURL(join(distRoot, "storage/index.js")).href);

/** 在临时项目中执行迁移场景，并确保 SQLite 连接和磁盘数据被清理。 */
async function withMigrationProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "code-helper-document-migration-"));
  let connection;
  try {
    await callback({
      projectRoot,
      openRepository(options) {
        connection = openDocumentDatabase({ projectRoot });
        return new DocumentRepository(connection, options);
      }
    });
  } finally {
    connection?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("迁移预览识别中文与旧英文文件并保持只读", async () => {
  await withMigrationProject(async ({ projectRoot }) => {
    await mkdir(join(projectRoot, "code-helper-docs/plan-doc"), { recursive: true });
    await mkdir(join(projectRoot, "code-helper-docs/result-doc/兼容迁移"), { recursive: true });
    await mkdir(join(projectRoot, "code-helper-docs/status-doc"), { recursive: true });
    await writeFile(join(projectRoot, "code-helper-docs/plan-doc/兼容迁移.md"), "# 计划\n", "utf8");
    await writeFile(
      join(projectRoot, "code-helper-docs/result-doc/兼容迁移/implementation.md"),
      "# 实施记录\n",
      "utf8"
    );
    await writeFile(
      join(projectRoot, "code-helper-docs/status-doc/兼容迁移-status.md"),
      "# 状态\n",
      "utf8"
    );

    const preview = await previewLegacyDocumentMigration(projectRoot);
    assert.equal(preview.tasks.length, 1);
    assert.equal(preview.tasks[0].status, "active");
    assert.deepEqual(preview.tasks[0].documents.map((document) => document.type), ["plan", "result", "status"]);
    assert.ok(preview.tasks[0].documents.some((document) => document.namingStyle === "legacy"));
    assert.equal(preview.conflicts.length, 0);
  });
});

test("mixed 生命周期与同名不同正文形成阻断冲突", async () => {
  await withMigrationProject(async ({ projectRoot }) => {
    await mkdir(join(projectRoot, "code-helper-docs/plan-doc/archive"), { recursive: true });
    await mkdir(join(projectRoot, "code-helper-docs/result-doc/冲突任务"), { recursive: true });
    await writeFile(join(projectRoot, "code-helper-docs/plan-doc/冲突任务.md"), "活动正文", "utf8");
    await writeFile(join(projectRoot, "code-helper-docs/plan-doc/archive/冲突任务.md"), "归档正文", "utf8");
    await writeFile(join(projectRoot, "code-helper-docs/result-doc/冲突任务/实施记录.md"), "中文正文", "utf8");
    await writeFile(join(projectRoot, "code-helper-docs/result-doc/冲突任务/implementation.md"), "英文正文", "utf8");

    const preview = await previewLegacyDocumentMigration(projectRoot);
    assert.equal(preview.tasks[0].status, "mixed");
    assert.ok(preview.conflicts.some((conflict) => conflict.code === "mixed_lifecycle"));
    assert.ok(preview.conflicts.some((conflict) => conflict.code === "document_body_conflict"));
  });
});

test("显式导入保留原正文并支持重复执行幂等", async () => {
  await withMigrationProject(async ({ projectRoot, openRepository }) => {
    await mkdir(join(projectRoot, "code-helper-docs/completion-record"), { recursive: true });
    const body = "# 独立完成记录\n\n正文保持不变。\n";
    await writeFile(
      join(projectRoot, "code-helper-docs/completion-record/独立任务-completion-record.md"),
      body,
      "utf8"
    );
    const repository = openRepository();
    const preview = await previewLegacyDocumentMigration(projectRoot);

    const first = await applyLegacyDocumentMigration(projectRoot, repository, preview);
    assert.deepEqual(first.imported, ["独立任务"]);
    assert.equal(first.conflicts.length, 0);
    const task = repository.listTasks()[0];
    assert.equal(task.status, "recorded");
    assert.equal(repository.listDocuments(task.id)[0].body, body);

    const second = await applyLegacyDocumentMigration(projectRoot, repository);
    assert.deepEqual(second.skipped, ["独立任务"]);
    assert.equal(repository.listTasks().length, 1);
    assert.equal(repository.listDocuments(task.id).length, 1);
  });
});

test("导入遇到数据库正文差异时返回明确冲突且不覆盖", async () => {
  await withMigrationProject(async ({ projectRoot, openRepository }) => {
    await mkdir(join(projectRoot, "code-helper-docs/plan-doc"), { recursive: true });
    await writeFile(join(projectRoot, "code-helper-docs/plan-doc/已有任务.md"), "Markdown 正文", "utf8");
    const repository = openRepository();
    const task = repository.createTask({ slug: "已有任务", name: "已有任务" });
    const document = repository.createDocument({ taskId: task.id, type: "plan", body: "数据库正文" });

    const result = await applyLegacyDocumentMigration(projectRoot, repository);
    assert.ok(result.conflicts.some((conflict) => conflict.code === "database_conflict"));
    assert.equal(repository.getDocument(document.id).body, "数据库正文");
  });
});

test("预览不跟随受控目录中的符号链接", async () => {
  await withMigrationProject(async ({ projectRoot }) => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "code-helper-document-outside-"));
    try {
      await mkdir(join(projectRoot, "code-helper-docs/plan-doc"), { recursive: true });
      await writeFile(join(outsideRoot, "越界任务.md"), "不应读取", "utf8");
      await symlink(
        outsideRoot,
        join(projectRoot, "code-helper-docs/plan-doc/archive"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const preview = await previewLegacyDocumentMigration(projectRoot);
      assert.equal(preview.tasks.length, 0);
      assert.ok(preview.conflicts.some((conflict) => conflict.code === "unsafe_path"));
      assert.equal(preview.scannedFiles.includes("code-helper-docs/plan-doc/archive/越界任务.md"), false);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("批量导入中途失败会补偿删除半成品任务", async () => {
  await withMigrationProject(async ({ projectRoot, openRepository }) => {
    await mkdir(join(projectRoot, "code-helper-docs/plan-doc"), { recursive: true });
    await mkdir(join(projectRoot, "code-helper-docs/status-doc"), { recursive: true });
    await writeFile(join(projectRoot, "code-helper-docs/plan-doc/回滚任务.md"), "计划", "utf8");
    await writeFile(join(projectRoot, "code-helper-docs/status-doc/回滚任务-状态.md"), "状态", "utf8");
    // 固定 ID 会让第二份文档触发唯一键冲突，用于覆盖批量导入的补偿路径。
    const repository = openRepository({ idFactory: () => "fixed-id" });

    const result = await applyLegacyDocumentMigration(projectRoot, repository);
    assert.ok(result.conflicts.some((conflict) => conflict.code === "database_conflict"));
    assert.equal(repository.listTasks().length, 0);
  });
});
