import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const distRoot = process.env.CODE_HELPER_TEST_DIST_ROOT ?? join(import.meta.dirname, "../dist");
const {
  DocumentRepository,
  exportMarkdownDocuments,
  getStableMarkdownExportPath,
  importMarkdownDocuments
} = await import(pathToFileURL(join(distRoot, "documents/index.js")).href);
const { openDocumentDatabase } = await import(pathToFileURL(join(distRoot, "storage/index.js")).href);

/** 创建临时数据库和仓储，供导出测试复用。 */
async function withExportProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "code-helper-document-export-"));
  const database = openDocumentDatabase({ projectRoot });
  const repository = new DocumentRepository(database);
  try {
    await callback({ projectRoot, database, repository });
  } finally {
    database.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("Markdown 导出按活动、归档和完成记录生成稳定路径", async () => {
  await withExportProject(async ({ projectRoot, database, repository }) => {
    const active = repository.createTask({ slug: "active", name: "活动任务" });
    repository.createDocument({ taskId: active.id, type: "plan", body: "# 活动计划\n" });
    const archived = repository.createTask({ slug: "archived", name: "归档任务", status: "archived" });
    const resultDocument = repository.createDocument({ taskId: archived.id, type: "result", body: "# 归档结果\n" });
    const recorded = repository.createTask({ slug: "recorded", name: "直接任务", trackingMode: "recorded" });
    repository.createDocument({ taskId: recorded.id, type: "completion_record", body: "# 完成记录\n" });

    assert.equal(
      getStableMarkdownExportPath(archived, resultDocument),
      join(".code-helper", "local", "docs", "result-doc", "archive", "归档任务", "实施记录.md")
    );
    const exported = await exportMarkdownDocuments(projectRoot, database, repository);
    assert.equal(exported.conflicts.length, 0);
    assert.equal(exported.exported.length, 3);
    assert.equal(
      await readFile(join(projectRoot, ".code-helper/local/docs/plan-doc/活动任务.md"), "utf8"),
      "# 活动计划\n"
    );
    assert.equal(
      await readFile(join(projectRoot, ".code-helper/local/docs/completion-record/直接任务-完成记录.md"), "utf8"),
      "# 完成记录\n"
    );
  });
});

test("默认不覆盖无摘要文件和导出后手工修改的文件", async () => {
  await withExportProject(async ({ projectRoot, database, repository }) => {
    const task = repository.createTask({ slug: "manual", name: "手改保护" });
    const document = repository.createDocument({ taskId: task.id, type: "status", body: "数据库 v1" });
    const target = join(projectRoot, ".code-helper/local/docs/status-doc/手改保护-状态.md");
    await mkdir(join(projectRoot, ".code-helper/local/docs/status-doc"), { recursive: true });
    await writeFile(target, "用户原文件", "utf8");

    const unknown = await exportMarkdownDocuments(projectRoot, database, repository);
    assert.equal(unknown.conflicts[0].message, "目标文件已存在且没有导出记录");
    assert.equal(await readFile(target, "utf8"), "用户原文件");

    const forced = await exportMarkdownDocuments(projectRoot, database, repository, { force: true });
    assert.equal(forced.exported[0].status, "updated");
    await writeFile(target, "用户手工修改", "utf8");
    repository.updateDocument(document.id, { body: "数据库 v2", expectedRevision: 1 });

    const protectedResult = await exportMarkdownDocuments(projectRoot, database, repository);
    assert.equal(protectedResult.conflicts[0].message, "目标文件在上次导出后被手工修改");
    assert.equal(await readFile(target, "utf8"), "用户手工修改");
  });
});

test("磁盘仍等于上次导出摘要时允许安全刷新", async () => {
  await withExportProject(async ({ projectRoot, database, repository }) => {
    const task = repository.createTask({ slug: "refresh", name: "安全刷新" });
    const document = repository.createDocument({ taskId: task.id, type: "result", body: "版本一" });
    await exportMarkdownDocuments(projectRoot, database, repository);
    repository.updateDocument(document.id, { body: "版本二", expectedRevision: 1 });

    const refreshed = await exportMarkdownDocuments(projectRoot, database, repository);
    assert.equal(refreshed.exported[0].status, "updated");
    assert.equal(
      await readFile(join(projectRoot, ".code-helper/local/docs/result-doc/安全刷新/实施记录.md"), "utf8"),
      "版本二"
    );
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM document_exports").get().count,
      1
    );
  });
});

test("Markdown 单边修改可预览并显式导回 SQLite 修订历史", async () => {
  await withExportProject(async ({ projectRoot, database, repository }) => {
    const task = repository.createTask({ slug: "roundtrip", name: "安全回写" });
    const document = repository.createDocument({ taskId: task.id, type: "plan", body: "数据库初稿" });
    await exportMarkdownDocuments(projectRoot, database, repository);
    const target = join(projectRoot, ".code-helper/local/docs/plan-doc/安全回写.md");
    await writeFile(target, "Markdown 修订", "utf8");

    const preview = await importMarkdownDocuments(projectRoot, database, repository);
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.skipped[0].status, "candidate");
    assert.equal(repository.getDocument(document.id).revision, 1);

    const applied = await importMarkdownDocuments(projectRoot, database, repository, { apply: true });
    assert.equal(applied.imported[0].status, "imported");
    assert.equal(repository.getDocument(document.id).body, "Markdown 修订");
    assert.equal(repository.listDocumentRevisions(document.id).length, 2);
  });
});

test("数据库与 Markdown 双边变化时拒绝自动导入", async () => {
  await withExportProject(async ({ projectRoot, database, repository }) => {
    const task = repository.createTask({ slug: "diverged", name: "双边冲突" });
    const document = repository.createDocument({ taskId: task.id, type: "status", body: "共同基线" });
    await exportMarkdownDocuments(projectRoot, database, repository);
    await writeFile(join(projectRoot, ".code-helper/local/docs/status-doc/双边冲突-状态.md"), "Markdown 分支", "utf8");
    repository.updateDocument(document.id, { body: "数据库分支", expectedRevision: 1 });

    const result = await importMarkdownDocuments(projectRoot, database, repository, { apply: true });
    assert.equal(result.imported.length, 0);
    assert.equal(result.conflicts[0].status, "conflict");
    assert.match(result.conflicts[0].message, /均在上次导出后变化/u);
    assert.equal(repository.getDocument(document.id).body, "数据库分支");
  });
});

test("批量导入预检发现冲突时不部分写入其它安全候选", async () => {
  await withExportProject(async ({ projectRoot, database, repository }) => {
    const safeTask = repository.createTask({ slug: "safe-batch", name: "批量安全项" });
    const safeDocument = repository.createDocument({ taskId: safeTask.id, type: "plan", body: "安全基线" });
    await exportMarkdownDocuments(projectRoot, database, repository, { taskId: safeTask.id });
    await writeFile(join(projectRoot, ".code-helper/local/docs/plan-doc/批量安全项.md"), "安全候选修订", "utf8");

    const conflictTask = repository.createTask({ slug: "conflict-batch", name: "批量冲突项" });
    repository.createDocument({ taskId: conflictTask.id, type: "status", body: "数据库正文" });
    await mkdir(join(projectRoot, ".code-helper/local/docs/status-doc"), { recursive: true });
    await writeFile(join(projectRoot, ".code-helper/local/docs/status-doc/批量冲突项-状态.md"), "无基线修改", "utf8");

    const result = await importMarkdownDocuments(projectRoot, database, repository, { apply: true });
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.imported.length, 0);
    assert.equal(repository.getDocument(safeDocument.id).body, "安全基线");
  });
});

test("稳定导出路径拒绝 Windows 保留名称和路径分隔符", async () => {
  await withExportProject(async ({ repository }) => {
    const reserved = repository.createTask({ slug: "reserved", name: "CON" });
    const reservedDocument = repository.createDocument({ taskId: reserved.id, type: "plan", body: "正文" });
    assert.throws(
      () => getStableMarkdownExportPath(reserved, reservedDocument),
      /跨平台非法字符/u
    );

    const traversal = repository.createTask({ slug: "traversal", name: "子目录/越界" });
    const traversalDocument = repository.createDocument({ taskId: traversal.id, type: "status", body: "正文" });
    assert.throws(
      () => getStableMarkdownExportPath(traversal, traversalDocument),
      /跨平台非法字符/u
    );
  });
});

test("可跟踪导出显式写入旧版公共目录", async () => {
  await withExportProject(async ({ projectRoot, database, repository }) => {
    const task = repository.createTask({ slug: "tracked", name: "交接任务" });
    repository.createDocument({ taskId: task.id, type: "plan", body: "交接正文" });
    const result = await exportMarkdownDocuments(projectRoot, database, repository, { tracked: true });
    assert.equal(result.conflicts.length, 0);
    assert.equal(await readFile(join(projectRoot, "code-helper-docs/plan-doc/交接任务.md"), "utf8"), "交接正文");
  });
});
