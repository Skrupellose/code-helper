import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DocumentRepository,
  DocumentRepositoryError,
  calculateDocumentHash,
  canTransitionTaskStatus
} from "../dist/documents/index.js";
import { openDocumentDatabase } from "../dist/storage/index.js";

/** 创建带固定时钟和递增 ID 的仓储，使修订与排序断言完全确定。 */
async function withRepository(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "code-helper-document-repository-"));
  const connection = openDocumentDatabase({ projectRoot });
  let id = 0;
  let tick = 0;
  const repository = new DocumentRepository(connection, {
    idFactory: () => `generated-${++id}`,
    clock: () => `2026-08-25T00:00:${String(tick++).padStart(2, "0")}.000Z`
  });

  try {
    await callback({ connection, repository });
  } finally {
    connection.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("DocumentRepository 支持任务 CRUD、筛选和追加事件", async () => {
  await withRepository(async ({ repository }) => {
    const task = repository.createTask({ slug: "sqlite-core", name: "SQLite 基础" });
    assert.equal(task.status, "active");
    assert.equal(task.trackingMode, "planned");
    assert.equal(repository.getTask(task.id)?.slug, "sqlite-core");
    assert.deepEqual(repository.listTasks({ status: "active" }).map((item) => item.id), [task.id]);

    const customEvent = repository.appendTaskEvent(task.id, "decision", { storage: "sqlite" });
    assert.deepEqual(customEvent.payload, { storage: "sqlite" });
    assert.deepEqual(
      repository.listTaskEvents(task.id).map((event) => event.eventType),
      ["task_created", "decision"]
    );

    assert.equal(repository.deleteTask(task.id), true);
    assert.equal(repository.getTask(task.id), undefined);
    assert.equal(repository.deleteTask(task.id), false);
  });
});

test("任务状态机允许暂停恢复与归档，并拒绝终态回流", async () => {
  await withRepository(async ({ connection, repository }) => {
    const task = repository.createTask({ slug: "lifecycle", name: "生命周期" });
    assert.equal(canTransitionTaskStatus("active", "paused"), true);
    assert.equal(repository.transitionTaskStatus(task.id, "paused", "等待复核").currentNode, "等待复核");
    assert.equal(repository.transitionTaskStatus(task.id, "active").status, "active");
    assert.equal(repository.transitionTaskStatus(task.id, "completed").status, "completed");
    assert.equal(repository.transitionTaskStatus(task.id, "archived").status, "archived");
    assert.throws(
      () => repository.transitionTaskStatus(task.id, "active"),
      (error) => error instanceof DocumentRepositoryError && error.code === "INVALID_STATE_TRANSITION"
    );

    const recorded = repository.createTask({
      slug: "completion-record",
      name: "完成记录",
      trackingMode: "recorded"
    });
    assert.equal(recorded.status, "recorded");
    assert.throws(
      () => repository.createTask({ slug: "bad-record", name: "错误组合", status: "recorded" }),
      (error) => error instanceof DocumentRepositoryError && error.code === "INVALID_INPUT"
    );

    // 数据库 CHECK 约束是仓储状态机之外的最后一道防线。
    assert.throws(() => connection.database.prepare(
      "UPDATE tasks SET status = 'unknown' WHERE id = ?"
    ).run(recorded.id));
  });
});

test("文档创建、查询、更新和删除会维护不可变 revision", async () => {
  await withRepository(async ({ repository }) => {
    const task = repository.createTask({ slug: "documents", name: "文档 CRUD" });
    const document = repository.createDocument({
      taskId: task.id,
      type: "plan",
      body: "# 初始计划",
      summary: "创建计划",
      source: "test"
    });
    assert.equal(document.revision, 1);
    assert.equal(document.contentHash, calculateDocumentHash("# 初始计划"));
    assert.deepEqual(repository.listDocuments(task.id).map((item) => item.type), ["plan"]);

    const updated = repository.updateDocument(document.id, {
      body: "# 更新计划",
      expectedRevision: 1,
      expectedContentHash: document.contentHash,
      summary: "补充步骤",
      source: "test"
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.body, "# 更新计划");
    assert.deepEqual(
      repository.listDocumentRevisions(document.id).map((revision) => ({
        revision: revision.revision,
        body: revision.body,
        summary: revision.summary
      })),
      [
        { revision: 1, body: "# 初始计划", summary: "创建计划" },
        { revision: 2, body: "# 更新计划", summary: "补充步骤" }
      ]
    );

    // 相同正文是幂等更新，不制造无意义修订。
    const unchanged = repository.updateDocument(document.id, {
      body: updated.body,
      expectedRevision: 2
    });
    assert.equal(unchanged.revision, 2);
    assert.equal(repository.listDocumentRevisions(document.id).length, 2);

    assert.equal(repository.deleteDocument(document.id), true);
    assert.equal(repository.getDocument(document.id), undefined);
  });
});

test("文档 CAS 冲突回滚正文和修订，且同任务同类型保持唯一", async () => {
  await withRepository(async ({ repository }) => {
    const task = repository.createTask({ slug: "cas", name: "CAS" });
    const document = repository.createDocument({ taskId: task.id, type: "status", body: "v1" });
    const current = repository.updateDocument(document.id, { body: "v2", expectedRevision: 1 });

    assert.throws(
      () => repository.updateDocument(document.id, { body: "stale", expectedRevision: 1 }),
      (error) => error instanceof DocumentRepositoryError && error.code === "CAS_CONFLICT"
    );
    assert.equal(repository.getDocument(document.id)?.body, "v2");
    assert.equal(repository.listDocumentRevisions(document.id).length, 2);

    assert.throws(
      () => repository.updateDocument(document.id, { body: "missing-cas" }),
      (error) => error instanceof DocumentRepositoryError && error.code === "INVALID_INPUT"
    );
    assert.throws(
      () => repository.createDocument({ taskId: task.id, type: "status", body: "duplicate" }),
      (error) => error instanceof DocumentRepositoryError && error.code === "DUPLICATE"
    );
    assert.equal(current.contentHash, calculateDocumentHash("v2"));
  });
});

test("验证、Git 关联和导出记录 API 写入最小 schema", async () => {
  await withRepository(async ({ connection, repository }) => {
    const task = repository.createTask({ slug: "evidence", name: "验证证据" });
    const document = repository.createDocument({ taskId: task.id, type: "result", body: "结果" });
    const validationId = repository.recordValidation({
      taskId: task.id,
      command: "node --test",
      workingDirectory: "/workspace",
      exitCode: 0,
      summary: "通过",
      baseline: "abc123",
      acceptanceCriterionIds: ["AC-001", "AC-002", "AC-001"],
      planItemIds: ["PLAN-001"]
    });
    const gitLinkId = repository.linkGitCommit({
      taskId: task.id,
      commitSha: "abc123",
      subject: "feat(storage): 增加 SQLite"
    });
    repository.recordDocumentExport({
      documentId: document.id,
      exportPath: "code-helper-docs/result-doc/结果.md",
      contentHash: document.contentHash
    });

    assert.equal(validationId > 0, true);
    assert.deepEqual(repository.listValidations(task.id)[0].acceptanceCriterionIds, ["AC-001", "AC-002"]);
    assert.deepEqual(repository.listValidations(task.id)[0].planItemIds, ["PLAN-001"]);
    assert.equal(gitLinkId > 0, true);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM validations").get().count, 1);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM git_links").get().count, 1);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM document_exports").get().count, 1);
  });
});
