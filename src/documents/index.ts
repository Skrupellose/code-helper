export { DocumentRepositoryError, MarkdownExportConflictError } from "./errors.js";
export {
  applyLegacyDocumentMigration,
  createLegacyTaskSlug,
  previewLegacyDocumentMigration,
  previewMigrationBaselineConflicts
} from "./legacy-migration.js";
export {
  checkMarkdownProjectionForTask,
  exportMarkdownDocuments,
  getStableMarkdownExportPath,
  registerCompatibleProjectionBaselines
} from "./markdown-export.js";
export { importMarkdownDocuments } from "./markdown-import.js";
export {
  DocumentRepository,
  calculateDocumentHash,
  canTransitionTaskStatus
} from "./repository.js";
export {
  ensureDocumentDatabase,
  registerMarkdownExportBaseline,
  withDocumentRepository
} from "./session.js";
export { DOCUMENT_TYPES, TASK_STATUSES } from "./types.js";
export type {
  CreateDocumentInput,
  CreateTaskInput,
  DocumentExportInput,
  DocumentRecord,
  DocumentRevisionRecord,
  DocumentType,
  GitLinkInput,
  GitLinkRecord,
  TaskEventRecord,
  TaskFilter,
  TaskRecord,
  TaskStatus,
  TrackingMode,
  UpdateDocumentInput,
  ValidationRecord,
  ValidationRecordInput
} from "./types.js";
export type {
  LegacyDocumentCandidate,
  LegacyDocumentLocation,
  LegacyMigrationApplyResult,
  LegacyMigrationConflict,
  LegacyMigrationPreview,
  LegacyMigrationStatus,
  LegacyMigrationTaskPreview,
  LegacyNamingStyle,
  MigrationBaselineConflict
} from "./legacy-migration.js";
export type {
  MarkdownExportItem,
  MarkdownExportHookContext,
  MarkdownExportOptions,
  MarkdownExportResult,
  MarkdownExportStatus,
  MarkdownExportTestHooks
} from "./markdown-export.js";
export type {
  MarkdownProjectionCheckItem,
  MarkdownProjectionCheckResult,
  MarkdownProjectionCheckStatus
} from "./markdown-export.js";
export type {
  MarkdownImportItem,
  MarkdownImportOptions,
  MarkdownImportResult,
  MarkdownImportStatus
} from "./markdown-import.js";
