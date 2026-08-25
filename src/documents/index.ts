export { DocumentRepositoryError, MarkdownExportConflictError } from "./errors.js";
export {
  applyLegacyDocumentMigration,
  createLegacyTaskSlug,
  previewLegacyDocumentMigration
} from "./legacy-migration.js";
export {
  exportMarkdownDocuments,
  getStableMarkdownExportPath
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
  TaskEventRecord,
  TaskFilter,
  TaskRecord,
  TaskStatus,
  TrackingMode,
  UpdateDocumentInput,
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
  LegacyNamingStyle
} from "./legacy-migration.js";
export type {
  MarkdownExportItem,
  MarkdownExportOptions,
  MarkdownExportResult,
  MarkdownExportStatus
} from "./markdown-export.js";
export type {
  MarkdownImportItem,
  MarkdownImportOptions,
  MarkdownImportResult,
  MarkdownImportStatus
} from "./markdown-import.js";
