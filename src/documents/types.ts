/** 任务生命周期允许持久化的全部状态。 */
export const TASK_STATUSES = [
  "active",
  "paused",
  "completed",
  "cancelled",
  "archived",
  "recorded"
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

/** SQLite 权威管理的任务过程文档类型。 */
export const DOCUMENT_TYPES = [
  "plan",
  "status",
  "result",
  "manual_test",
  "completion_record"
] as const;

export type DocumentType = typeof DOCUMENT_TYPES[number];
export type TrackingMode = "planned" | "recorded";

/** SQLite 中任务记录的领域表示。 */
export interface TaskRecord {
  id: string;
  slug: string;
  name: string;
  trackingMode: TrackingMode;
  status: TaskStatus;
  currentNode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  id?: string;
  slug: string;
  name: string;
  trackingMode?: TrackingMode;
  status?: TaskStatus;
  currentNode?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  trackingMode?: TrackingMode;
}

/** SQLite 中当前文档正文的领域表示。 */
export interface DocumentRecord {
  id: string;
  taskId: string;
  type: DocumentType;
  body: string;
  revision: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentInput {
  id?: string;
  taskId: string;
  type: DocumentType;
  body: string;
  summary?: string;
  source?: string;
}

export interface UpdateDocumentInput {
  body: string;
  expectedRevision?: number;
  expectedContentHash?: string;
  summary?: string;
  source?: string;
}

/** 文档不可变历史修订。 */
export interface DocumentRevisionRecord {
  id: number;
  documentId: string;
  revision: number;
  body: string;
  contentHash: string;
  summary?: string;
  source: string;
  createdAt: string;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  eventType: string;
  payload?: unknown;
  createdAt: string;
}

export interface ValidationRecordInput {
  taskId?: string;
  command: string;
  workingDirectory: string;
  exitCode: number;
  summary: string;
  baseline?: string;
  /** 此验证回执直接覆盖的稳定验收条件 ID。 */
  acceptanceCriterionIds?: readonly string[];
  /** 此验证回执覆盖的稳定计划项 ID。 */
  planItemIds?: readonly string[];
}

/** SQLite 中可复用验证回执的完整读取模型。 */
export interface ValidationRecord extends ValidationRecordInput {
  id: number;
  createdAt: string;
}

export interface GitLinkInput {
  taskId: string;
  commitSha: string;
  subject?: string;
  scope?: string;
}

/** 任务与 Git commit 关联的完整读取模型；仅记录关联，不执行任何 Git 操作。 */
export interface GitLinkRecord extends GitLinkInput {
  id: number;
  createdAt: string;
}

export interface DocumentExportInput {
  documentId: string;
  exportPath: string;
  contentHash: string;
}
