import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DocumentDatabase } from "../storage/database.js";
import { DocumentRepositoryError } from "./errors.js";
import type {
  CreateDocumentInput,
  CreateTaskInput,
  DocumentExportInput,
  DocumentRecord,
  DocumentRevisionRecord,
  GitLinkInput,
  GitLinkRecord,
  TaskEventRecord,
  TaskFilter,
  TaskRecord,
  TaskStatus,
  UpdateDocumentInput,
  ValidationRecord,
  ValidationRecordInput
} from "./types.js";

type Clock = () => string;
type IdFactory = () => string;

interface RepositoryOptions {
  clock?: Clock;
  idFactory?: IdFactory;
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  active: ["paused", "completed", "cancelled", "archived"],
  paused: ["active", "cancelled", "archived"],
  completed: ["archived"],
  cancelled: ["archived"],
  archived: [],
  // 独立完成记录创建即为 recorded 终态，不进入计划任务的归档生命周期。
  recorded: []
};

/** 文档正文使用 SHA-256 作为跨进程稳定的 CAS 与导出摘要。 */
export function calculateDocumentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** 判断任务状态变化是否合法；相同状态视为幂等操作。 */
export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * SQLite 任务与文档仓储。
 *
 * 所有跨表写入都经由 DocumentDatabase 的 BEGIN IMMEDIATE 事务；时钟和 ID 可注入，
 * 让测试不依赖真实时间和随机值，也方便未来迁移工具保留旧标识。
 */
export class DocumentRepository {
  readonly #connection: DocumentDatabase;
  readonly #clock: Clock;
  readonly #idFactory: IdFactory;

  constructor(connection: DocumentDatabase, options: RepositoryOptions = {}) {
    this.#connection = connection;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  /** 创建计划任务或独立完成记录任务，并写入首个追加式事件。 */
  createTask(input: CreateTaskInput): TaskRecord {
    const slug = requireNonBlank(input.slug, "任务 slug");
    const name = requireNonBlank(input.name, "任务名称");
    const trackingMode = input.trackingMode ?? "planned";
    const status = input.status ?? (trackingMode === "recorded" ? "recorded" : "active");
    validateInitialTaskState(trackingMode, status);
    const id = input.id ?? this.#idFactory();
    const now = this.#clock();

    try {
      return this.#connection.withImmediateTransaction((database) => {
        database.prepare(`
          INSERT INTO tasks(id, slug, name, tracking_mode, status, current_node, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, slug, name, trackingMode, status, input.currentNode ?? null, now, now);
        insertTaskEvent(database, id, "task_created", { status, trackingMode }, now);
        return this.requireTaskWithDatabase(database, id);
      });
    } catch (error) {
      throw mapConstraintError(error, `任务 slug 或 ID 已存在：${slug}`);
    }
  }

  /** 按稳定 ID 查询任务。 */
  getTask(id: string): TaskRecord | undefined {
    const row = this.#connection.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row === undefined ? undefined : mapTaskRow(row as unknown as TaskRow);
  }

  /** 按项目内唯一 slug 查询任务，供兼容 CLI 将中文功能名映射到稳定任务。 */
  getTaskBySlug(slug: string): TaskRecord | undefined {
    const normalizedSlug = requireNonBlank(slug, "任务 slug");
    const row = this.#connection.database.prepare("SELECT * FROM tasks WHERE slug = ?").get(normalizedSlug);
    return row === undefined ? undefined : mapTaskRow(row as unknown as TaskRow);
  }

  /** 查询任务列表；筛选条件全部参数化，固定按更新时间倒序输出。 */
  listTasks(filter: TaskFilter = {}): TaskRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(filter.status);
    }
    if (filter.trackingMode !== undefined) {
      conditions.push("tracking_mode = ?");
      parameters.push(filter.trackingMode);
    }
    const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    const rows = this.#connection.database.prepare(
      `SELECT * FROM tasks${where} ORDER BY updated_at DESC, id ASC`
    ).all(...parameters) as unknown as TaskRow[];
    return rows.map(mapTaskRow);
  }

  /**
   * 执行受控状态迁移并记录事件。
   * recorded 只能由 recorded 跟踪模式创建；archived 是所有允许归档分支的终态。
   */
  transitionTaskStatus(id: string, nextStatus: TaskStatus, currentNode?: string): TaskRecord {
    return this.#connection.withImmediateTransaction((database) => {
      const current = this.requireTaskWithDatabase(database, id);
      if (!canTransitionTaskStatus(current.status, nextStatus)) {
        throw new DocumentRepositoryError(
          "INVALID_STATE_TRANSITION",
          `任务状态不能从 ${current.status} 迁移到 ${nextStatus}`
        );
      }
      if (current.status === nextStatus && currentNode === undefined) {
        return current;
      }

      const now = this.#clock();
      database.prepare(
        "UPDATE tasks SET status = ?, current_node = ?, updated_at = ? WHERE id = ?"
      ).run(nextStatus, currentNode ?? current.currentNode ?? null, now, id);
      insertTaskEvent(database, id, "status_changed", { from: current.status, to: nextStatus }, now);
      return this.requireTaskWithDatabase(database, id);
    });
  }

  /** 删除任务及其级联领域记录；不存在时返回 false。 */
  deleteTask(id: string): boolean {
    return this.#connection.withImmediateTransaction((database) => {
      const result = database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  /** 创建文档当前正文和 revision=1 的不可变历史快照。 */
  createDocument(input: CreateDocumentInput): DocumentRecord {
    const id = input.id ?? this.#idFactory();
    const now = this.#clock();
    const contentHash = calculateDocumentHash(input.body);
    const source = input.source ?? "repository";

    try {
      return this.#connection.withImmediateTransaction((database) => {
        this.requireTaskWithDatabase(database, input.taskId);
        database.prepare(`
          INSERT INTO documents(id, task_id, type, body, revision, content_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        `).run(id, input.taskId, input.type, input.body, contentHash, now, now);
        insertDocumentRevision(database, id, 1, input.body, contentHash, input.summary, source, now);
        return this.requireDocumentWithDatabase(database, id);
      });
    } catch (error) {
      if (error instanceof DocumentRepositoryError) {
        throw error;
      }
      throw mapConstraintError(error, `任务 ${input.taskId} 已存在 ${input.type} 文档或文档 ID 重复`);
    }
  }

  /** 按文档 ID 查询当前正文。 */
  getDocument(id: string): DocumentRecord | undefined {
    const row = this.#connection.database.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    return row === undefined ? undefined : mapDocumentRow(row as unknown as DocumentRow);
  }

  /** 按任务查询全部当前文档，类型顺序稳定。 */
  listDocuments(taskId: string): DocumentRecord[] {
    const rows = this.#connection.database.prepare(
      "SELECT * FROM documents WHERE task_id = ? ORDER BY type, id"
    ).all(taskId) as unknown as DocumentRow[];
    return rows.map(mapDocumentRow);
  }

  /**
   * 使用 revision 和/或内容摘要进行 CAS 更新。
   *
   * 调用方必须至少提供一种期望值；更新命中 0 行时返回稳定 CAS_CONFLICT，成功后在同一事务写入修订历史。
   */
  updateDocument(id: string, input: UpdateDocumentInput): DocumentRecord {
    if (input.expectedRevision === undefined && input.expectedContentHash === undefined) {
      throw new DocumentRepositoryError("INVALID_INPUT", "更新文档必须提供 expectedRevision 或 expectedContentHash");
    }

    return this.#connection.withImmediateTransaction((database) => {
      const current = this.requireDocumentWithDatabase(database, id);
      assertDocumentCas(current, input);
      const nextHash = calculateDocumentHash(input.body);
      if (nextHash === current.contentHash && input.body === current.body) {
        return current;
      }

      const nextRevision = current.revision + 1;
      const now = this.#clock();
      const conditions = ["id = ?"];
      const parameters: Array<string | number> = [input.body, nextRevision, nextHash, now, id];
      if (input.expectedRevision !== undefined) {
        conditions.push("revision = ?");
        parameters.push(input.expectedRevision);
      }
      if (input.expectedContentHash !== undefined) {
        conditions.push("content_hash = ?");
        parameters.push(input.expectedContentHash);
      }
      const result = database.prepare(`
        UPDATE documents
        SET body = ?, revision = ?, content_hash = ?, updated_at = ?
        WHERE ${conditions.join(" AND ")}
      `).run(...parameters);
      if (result.changes !== 1) {
        throw new DocumentRepositoryError("CAS_CONFLICT", `文档 ${id} 已被其它写入更新`);
      }

      insertDocumentRevision(
        database,
        id,
        nextRevision,
        input.body,
        nextHash,
        input.summary,
        input.source ?? "repository",
        now
      );
      return this.requireDocumentWithDatabase(database, id);
    });
  }

  /** 查询文档不可变修订历史。 */
  listDocumentRevisions(documentId: string): DocumentRevisionRecord[] {
    const rows = this.#connection.database.prepare(
      "SELECT * FROM document_revisions WHERE document_id = ? ORDER BY revision"
    ).all(documentId) as unknown as DocumentRevisionRow[];
    return rows.map(mapDocumentRevisionRow);
  }

  /** 删除单份当前文档及级联修订；不存在时返回 false。 */
  deleteDocument(id: string): boolean {
    return this.#connection.withImmediateTransaction((database) => {
      const result = database.prepare("DELETE FROM documents WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  /** 追加任务事件；payload 使用 JSON 保存，读取时恢复为结构化值。 */
  appendTaskEvent(taskId: string, eventType: string, payload?: unknown): TaskEventRecord {
    const normalizedType = requireNonBlank(eventType, "事件类型");
    return this.#connection.withImmediateTransaction((database) => {
      this.requireTaskWithDatabase(database, taskId);
      const now = this.#clock();
      const id = insertTaskEvent(database, taskId, normalizedType, payload, now);
      return mapTaskEventRow(
        database.prepare("SELECT * FROM task_events WHERE id = ?").get(id) as unknown as TaskEventRow
      );
    });
  }

  /** 查询任务追加式事件流。 */
  listTaskEvents(taskId: string): TaskEventRecord[] {
    const rows = this.#connection.database.prepare(
      "SELECT * FROM task_events WHERE task_id = ? ORDER BY id"
    ).all(taskId) as unknown as TaskEventRow[];
    return rows.map(mapTaskEventRow);
  }

  /** 保存可复用验证回执并返回自增 ID。 */
  recordValidation(input: ValidationRecordInput): number {
    const now = this.#clock();
    const acceptanceCriterionIds = normalizeTraceabilityIds(
      input.acceptanceCriterionIds,
      "验收条件 ID"
    );
    const planItemIds = normalizeTraceabilityIds(input.planItemIds, "计划项 ID");
    const result = this.#connection.database.prepare(`
      INSERT INTO validations(
        task_id,
        command,
        working_directory,
        exit_code,
        summary,
        baseline,
        acceptance_criterion_ids_json,
        plan_item_ids_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.taskId ?? null,
      requireNonBlank(input.command, "验证命令"),
      requireNonBlank(input.workingDirectory, "验证工作目录"),
      input.exitCode,
      input.summary,
      input.baseline ?? null,
      acceptanceCriterionIds.length === 0 ? null : JSON.stringify(acceptanceCriterionIds),
      planItemIds.length === 0 ? null : JSON.stringify(planItemIds),
      now
    );
    return Number(result.lastInsertRowid);
  }

  /** 按任务读取验证回执；未指定任务时读取全部，固定按写入顺序返回。 */
  listValidations(taskId?: string): ValidationRecord[] {
    const rows = taskId === undefined
      ? this.#connection.database.prepare("SELECT * FROM validations ORDER BY id").all()
      : this.#connection.database.prepare("SELECT * FROM validations WHERE task_id = ? ORDER BY id").all(taskId);
    return (rows as unknown as ValidationRow[]).map(mapValidationRow);
  }

  /** 记录任务与 Git commit 的关联；本 API 不执行提交。 */
  linkGitCommit(input: GitLinkInput): number {
    try {
      const result = this.#connection.database.prepare(`
        INSERT INTO git_links(task_id, commit_sha, subject, scope, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        requireNonBlank(input.commitSha, "commit SHA"),
        input.subject ?? null,
        input.scope ?? null,
        this.#clock()
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (error instanceof DocumentRepositoryError) {
        throw error;
      }
      throw mapConstraintError(error, `任务 ${input.taskId} 已关联 commit：${input.commitSha}`);
    }
  }

  /** 读取指定任务的 Git 关联；本 API 不访问仓库，也不校验 commit 是否存在。 */
  listGitLinks(taskId: string): GitLinkRecord[] {
    const rows = this.#connection.database.prepare(
      "SELECT * FROM git_links WHERE task_id = ? ORDER BY id"
    ).all(taskId) as unknown as GitLinkRow[];
    return rows.map(mapGitLinkRow);
  }

  /** 记录 Markdown 导出摘要；重复路径更新为最新导出状态。 */
  recordDocumentExport(input: DocumentExportInput): number {
    const now = this.#clock();
    const result = this.#connection.database.prepare(`
      INSERT INTO document_exports(document_id, export_path, content_hash, exported_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(document_id, export_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        exported_at = excluded.exported_at
    `).run(
      input.documentId,
      requireNonBlank(input.exportPath, "导出路径"),
      requireNonBlank(input.contentHash, "导出摘要"),
      now
    );
    if (result.changes !== 1) {
      throw new Error(`未能记录文档导出：${input.documentId}:${input.exportPath}`);
    }
    const row = this.#connection.database.prepare(
      "SELECT id FROM document_exports WHERE document_id = ? AND export_path = ?"
    ).get(input.documentId, input.exportPath) as { id: number } | undefined;
    if (row === undefined) {
      throw new Error(`写入后无法读取文档导出记录：${input.documentId}:${input.exportPath}`);
    }
    return Number(row.id);
  }

  /** 事务内部读取任务，并统一转换未找到错误。 */
  private requireTaskWithDatabase(database: DatabaseSync, id: string): TaskRecord {
    const row = database.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (row === undefined) {
      throw new DocumentRepositoryError("NOT_FOUND", `未找到任务：${id}`);
    }
    return mapTaskRow(row as unknown as TaskRow);
  }

  /** 事务内部读取文档，并统一转换未找到错误。 */
  private requireDocumentWithDatabase(database: DatabaseSync, id: string): DocumentRecord {
    const row = database.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    if (row === undefined) {
      throw new DocumentRepositoryError("NOT_FOUND", `未找到文档：${id}`);
    }
    return mapDocumentRow(row as unknown as DocumentRow);
  }
}

interface TaskRow {
  id: string;
  slug: string;
  name: string;
  tracking_mode: "planned" | "recorded";
  status: TaskStatus;
  current_node: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  task_id: string;
  type: DocumentRecord["type"];
  body: string;
  revision: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

interface DocumentRevisionRow {
  id: number;
  document_id: string;
  revision: number;
  body: string;
  content_hash: string;
  summary: string | null;
  source: string;
  created_at: string;
}

interface TaskEventRow {
  id: number;
  task_id: string;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

interface ValidationRow {
  id: number;
  task_id: string | null;
  command: string;
  working_directory: string;
  exit_code: number;
  summary: string;
  baseline: string | null;
  acceptance_criterion_ids_json: string | null;
  plan_item_ids_json: string | null;
  created_at: string;
}

interface GitLinkRow {
  id: number;
  task_id: string;
  commit_sha: string;
  subject: string | null;
  scope: string | null;
  created_at: string;
}

/** 插入文档修订的共享 SQL，调用方必须已处于事务中。 */
function insertDocumentRevision(
  database: DatabaseSync,
  documentId: string,
  revision: number,
  body: string,
  contentHash: string,
  summary: string | undefined,
  source: string,
  createdAt: string
): void {
  database.prepare(`
    INSERT INTO document_revisions(document_id, revision, body, content_hash, summary, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(documentId, revision, body, contentHash, summary ?? null, source, createdAt);
}

/** 插入追加式任务事件并返回自增 ID，调用方负责事务边界。 */
function insertTaskEvent(
  database: DatabaseSync,
  taskId: string,
  eventType: string,
  payload: unknown,
  createdAt: string
): number {
  const result = database.prepare(`
    INSERT INTO task_events(task_id, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, eventType, payload === undefined ? null : JSON.stringify(payload), createdAt);
  return Number(result.lastInsertRowid);
}

/** 在执行 UPDATE 前先给出精确 CAS 冲突，便于调用方刷新当前文档。 */
function assertDocumentCas(current: DocumentRecord, input: UpdateDocumentInput): void {
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    throw new DocumentRepositoryError(
      "CAS_CONFLICT",
      `文档 ${current.id} revision 冲突：期望 ${input.expectedRevision}，实际 ${current.revision}`
    );
  }
  if (input.expectedContentHash !== undefined && input.expectedContentHash !== current.contentHash) {
    throw new DocumentRepositoryError("CAS_CONFLICT", `文档 ${current.id} 内容摘要冲突`);
  }
}

/** planned 与 recorded 是不同生命周期入口，创建时禁止交叉组合。 */
function validateInitialTaskState(trackingMode: "planned" | "recorded", status: TaskStatus): void {
  if (trackingMode === "recorded" && status !== "recorded") {
    throw new DocumentRepositoryError("INVALID_INPUT", "recorded 跟踪模式只能使用 recorded 初始状态");
  }
  if (trackingMode === "planned" && status === "recorded") {
    throw new DocumentRepositoryError("INVALID_INPUT", "planned 跟踪模式不能使用 recorded 初始状态");
  }
}

/** 必填标识允许内部空格但禁止全空白值。 */
function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DocumentRepositoryError("INVALID_INPUT", `${label}不能为空`);
  }
  return normalized;
}

/** 清理验证追踪 ID，拒绝空值并保持调用方顺序下的唯一性。 */
function normalizeTraceabilityIds(values: readonly string[] | undefined, label: string): string[] {
  if (values === undefined) {
    return [];
  }
  const normalized = values.map((value) => requireNonBlank(value, label));
  return [...new Set(normalized)];
}

/** 将 SQLite 唯一键错误收敛为稳定 DUPLICATE；其它原始错误保持不变。 */
function mapConstraintError(error: unknown, message: string): unknown {
  if (
    typeof error === "object"
    && error !== null
    && (
      ("code" in error && String(error.code).startsWith("ERR_SQLITE_CONSTRAINT"))
      // Node 22 的 node:sqlite 会使用通用 ERR_SQLITE_ERROR，并把扩展错误码放在 errcode 中。
      || ("errcode" in error && (Number(error.errcode) & 0xff) === 19)
    )
  ) {
    return new DocumentRepositoryError("DUPLICATE", message, error);
  }
  return error;
}

function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    trackingMode: row.tracking_mode,
    status: row.status,
    ...(row.current_node === null ? {} : { currentNode: row.current_node }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDocumentRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    body: row.body,
    revision: row.revision,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDocumentRevisionRow(row: DocumentRevisionRow): DocumentRevisionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    revision: row.revision,
    body: row.body,
    contentHash: row.content_hash,
    ...(row.summary === null ? {} : { summary: row.summary }),
    source: row.source,
    createdAt: row.created_at
  };
}

function mapTaskEventRow(row: TaskEventRow): TaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    ...(row.payload_json === null ? {} : { payload: JSON.parse(row.payload_json) as unknown }),
    createdAt: row.created_at
  };
}

/** 把验证回执数据库字段转换为公开领域模型。 */
function mapValidationRow(row: ValidationRow): ValidationRecord {
  return {
    id: row.id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    command: row.command,
    workingDirectory: row.working_directory,
    exitCode: row.exit_code,
    summary: row.summary,
    ...(row.baseline === null ? {} : { baseline: row.baseline }),
    ...(row.acceptance_criterion_ids_json === null
      ? {}
      : { acceptanceCriterionIds: JSON.parse(row.acceptance_criterion_ids_json) as string[] }),
    ...(row.plan_item_ids_json === null
      ? {}
      : { planItemIds: JSON.parse(row.plan_item_ids_json) as string[] }),
    createdAt: row.created_at
  };
}

/** 把 Git 关联数据库字段转换为公开领域模型。 */
function mapGitLinkRow(row: GitLinkRow): GitLinkRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    commitSha: row.commit_sha,
    ...(row.subject === null ? {} : { subject: row.subject }),
    ...(row.scope === null ? {} : { scope: row.scope }),
    createdAt: row.created_at
  };
}
