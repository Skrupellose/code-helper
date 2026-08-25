export { DocumentDatabase, openDocumentDatabase } from "./database.js";
export { StorageError } from "./errors.js";
export {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SCHEMA_MIGRATIONS,
  REQUIRED_TABLES,
  calculateMigrationChecksum,
  migrateSchema,
  readSchemaVersion
} from "./schema.js";
export type {
  DatabaseIntegrityResult,
  ImmediateTransactionCallback,
  OpenDatabaseOptions,
  SchemaMigration
} from "./types.js";
