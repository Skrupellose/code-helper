import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { DocumentRepositoryError } from "./errors.js";
import { getStableMarkdownExportPath } from "./markdown-export.js";
import { calculateDocumentHash, type DocumentRepository } from "./repository.js";
import type { DocumentType, TaskStatus, TrackingMode } from "./types.js";

export type LegacyDocumentLocation = "active" | "archived" | "recorded";
export type LegacyNamingStyle = "current" | "legacy";
export type LegacyMigrationStatus = "active" | "archived" | "mixed" | "recorded";

export interface LegacyDocumentCandidate {
  type: DocumentType;
  body: string;
  relativePath: string;
  location: LegacyDocumentLocation;
  namingStyle: LegacyNamingStyle;
}

export interface LegacyMigrationConflict {
  code:
    | "mixed_lifecycle"
    | "document_body_conflict"
    | "tracking_mode_conflict"
    | "database_conflict"
    | "unsafe_path";
  blocking: true;
  taskName: string;
  documentType?: DocumentType;
  paths: string[];
  message: string;
}

export interface LegacyMigrationTaskPreview {
  key: string;
  name: string;
  slug: string;
  status: LegacyMigrationStatus;
  trackingMode: TrackingMode;
  documents: LegacyDocumentCandidate[];
  conflicts: LegacyMigrationConflict[];
}

export interface LegacyMigrationPreview {
  projectRoot: string;
  scannedFiles: string[];
  tasks: LegacyMigrationTaskPreview[];
  conflicts: LegacyMigrationConflict[];
}

export interface LegacyMigrationApplyResult {
  imported: string[];
  skipped: string[];
  conflicts: LegacyMigrationConflict[];
}

interface DiscoveredCandidate extends LegacyDocumentCandidate {
  taskName: string;
}

const DOCUMENT_ROOT = "code-helper-docs";

/**
 * 只读扫描旧版 Markdown 任务文档，并返回可在写入前审阅的结构化预览。
 * 扫描范围固定为四类受控目录，符号链接不会被跟随，避免从项目根逃逸。
 */
export async function previewLegacyDocumentMigration(projectRoot: string): Promise<LegacyMigrationPreview> {
  const safeRoot = await resolveProjectRoot(projectRoot);
  const candidates: DiscoveredCandidate[] = [];
  const scanConflicts: LegacyMigrationConflict[] = [];

  await scanSingleFileDirectory(safeRoot, "plan-doc", "plan", parsePlanName, candidates, scanConflicts);
  await scanResultDirectory(safeRoot, candidates, scanConflicts);
  await scanSingleFileDirectory(safeRoot, "status-doc", "status", parseStatusName, candidates, scanConflicts);
  await scanCompletionRecords(safeRoot, candidates, scanConflicts);

  const grouped = new Map<string, DiscoveredCandidate[]>();
  for (const candidate of candidates) {
    const key = normalizeTaskKey(candidate.taskName);
    const current = grouped.get(key) ?? [];
    current.push(candidate);
    grouped.set(key, current);
  }

  const tasks = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .map(([key, entries]) => buildTaskPreview(key, entries));
  const conflicts = [...scanConflicts, ...tasks.flatMap((task) => task.conflicts)];

  return {
    projectRoot: safeRoot,
    scannedFiles: candidates.map((candidate) => candidate.relativePath).sort(),
    tasks,
    conflicts
  };
}

/**
 * 显式应用迁移预览。只导入无阻断冲突的任务；传入旧预览时会重新扫描，防止预览后文件变化。
 */
export async function applyLegacyDocumentMigration(
  projectRoot: string,
  repository: DocumentRepository,
  expectedPreview?: LegacyMigrationPreview
): Promise<LegacyMigrationApplyResult> {
  const preview = await previewLegacyDocumentMigration(projectRoot);
  const conflicts = [...preview.conflicts];
  const imported: string[] = [];
  const skipped: string[] = [];

  if (expectedPreview !== undefined && previewFingerprint(expectedPreview) !== previewFingerprint(preview)) {
    conflicts.push({
      code: "document_body_conflict",
      blocking: true,
      taskName: "迁移预览",
      paths: preview.scannedFiles,
      message: "Markdown 文档在预览后发生变化，请重新预览后再导入"
    });
    return { imported, skipped, conflicts };
  }

  for (const task of preview.tasks) {
    if (task.conflicts.length > 0) {
      continue;
    }

    const databaseConflict = inspectDatabaseConflict(repository, task);
    if (databaseConflict !== undefined) {
      conflicts.push(databaseConflict);
      continue;
    }

    const existing = repository.listTasks().find((item) => item.slug === task.slug);
    if (existing === undefined) {
      let createdTaskId: string | undefined;
      try {
        const created = repository.createTask({
          slug: task.slug,
          name: task.name,
          trackingMode: task.trackingMode,
          status: toRepositoryStatus(task.status, task.trackingMode)
        });
        createdTaskId = created.id;
        for (const document of task.documents) {
          repository.createDocument({
            taskId: created.id,
            type: document.type,
            body: document.body,
            summary: "从旧版 Markdown 文档导入",
            source: `legacy-migration:${document.relativePath}`
          });
        }
        imported.push(task.name);
      } catch (error) {
        // 仓储当前以单次写入为事务边界；批量导入失败时补偿删除本轮新任务，避免留下半份迁移。
        const rollbackTaskId = createdTaskId;
        const rollbackError = rollbackTaskId === undefined
          ? undefined
          : compensate(() => repository.deleteTask(rollbackTaskId));
        conflicts.push(toDatabaseConflict(task, error, rollbackError));
      }
      continue;
    }

    const existingDocuments = new Map(
      repository.listDocuments(existing.id).map((document) => [document.type, document])
    );
    let createdCount = 0;
    const createdDocumentIds: string[] = [];
    try {
      for (const document of task.documents) {
        if (!existingDocuments.has(document.type)) {
          const created = repository.createDocument({
            taskId: existing.id,
            type: document.type,
            body: document.body,
            summary: "补充导入旧版 Markdown 文档",
            source: `legacy-migration:${document.relativePath}`
          });
          createdDocumentIds.push(created.id);
          createdCount += 1;
        }
      }
      (createdCount === 0 ? skipped : imported).push(task.name);
    } catch (error) {
      // 只删除本轮补充创建的文档，不影响数据库中原有正文。
      const rollbackErrors = createdDocumentIds
        .reverse()
        .map((documentId) => compensate(() => repository.deleteDocument(documentId)))
        .filter((message): message is string => message !== undefined);
      conflicts.push(toDatabaseConflict(task, error, rollbackErrors.join("；") || undefined));
    }
  }

  return { imported, skipped, conflicts };
}

export interface MigrationBaselineConflict {
  relativePath: string;
  message: string;
}

/**
 * 写入前预检：为每个将被导入的任务计算默认兼容视图目标路径，检查是否已存在正文不同的文件。
 * 用于避免 migrate --apply 先把文档写入数据库、随后建立兼容视图基线时才发现冲突的部分成功语义。
 */
export async function previewMigrationBaselineConflicts(
  projectRoot: string,
  preview: LegacyMigrationPreview
): Promise<MigrationBaselineConflict[]> {
  const safeRoot = await resolveProjectRoot(projectRoot);
  const conflicts: MigrationBaselineConflict[] = [];

  for (const task of preview.tasks) {
    if (task.conflicts.length > 0) {
      continue;
    }

    const status = toRepositoryStatus(task.status, task.trackingMode);
    for (const document of task.documents) {
      let relativePath: string;
      try {
        relativePath = getStableMarkdownExportPath(
          { name: task.name, status },
          { type: document.type }
        );
      } catch (error) {
        conflicts.push({
          relativePath: task.name,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      // 与真实导出的安全约束保持一致：已存在的路径段不得包含符号链接，
      // 最终目标必须是普通文件，否则 --apply 写库后建立基线时会直接抛异常。
      const unsafeSegment = await findUnsafeExistingSegment(safeRoot, relativePath);
      if (unsafeSegment !== undefined) {
        conflicts.push({
          relativePath,
          message: `目标兼容视图路径包含不受支持的符号链接或非普通文件：${unsafeSegment}`
        });
        continue;
      }

      const absolutePath = resolveInsideProject(safeRoot, relativePath);
      let existingBody: string | undefined;
      try {
        existingBody = await readFile(absolutePath, "utf8");
      } catch (error) {
        if (isMissingPath(error)) {
          continue;
        }
        throw error;
      }

      if (calculateDocumentHash(existingBody) !== calculateDocumentHash(document.body)) {
        conflicts.push({
          relativePath,
          message: "目标兼容视图已存在且正文与待迁移内容不同"
        });
      }
    }
  }

  return conflicts;
}

/**
 * 逐段检查已存在的目标路径：任何一段是符号链接即返回该段的根相对路径；
 * 最后一段还必须是普通文件（目录会让导出的读取/写入直接抛错）。
 * 某一段不存在时，其后所有段都不存在，导出时会新建目录和文件，视为安全。
 */
async function findUnsafeExistingSegment(
  projectRoot: string,
  relativePath: string
): Promise<string | undefined> {
  const segments = relativePath.split(sep).filter(Boolean);
  let cursor = projectRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    let stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (isMissingPath(error)) {
        return undefined;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || (index === segments.length - 1 && !stats.isFile())) {
      return relative(projectRoot, cursor);
    }
  }
  return undefined;
}

function buildTaskPreview(key: string, entries: DiscoveredCandidate[]): LegacyMigrationTaskPreview {
  const name = chooseTaskName(entries.map((entry) => entry.taskName));
  const locations = new Set(entries.map((entry) => entry.location));
  const hasRecorded = locations.has("recorded");
  const hasPlanned = locations.has("active") || locations.has("archived");
  const status: LegacyMigrationStatus = hasRecorded
    ? "recorded"
    : locations.has("active") && locations.has("archived")
      ? "mixed"
      : locations.has("archived")
        ? "archived"
        : "active";
  const conflicts: LegacyMigrationConflict[] = [];

  if (locations.has("active") && locations.has("archived")) {
    conflicts.push({
      code: "mixed_lifecycle",
      blocking: true,
      taskName: name,
      paths: entries.map((entry) => entry.relativePath).sort(),
      message: `任务“${name}”同时存在活动与归档文档，不能猜测最终生命周期`
    });
  }
  if (hasRecorded && hasPlanned) {
    conflicts.push({
      code: "tracking_mode_conflict",
      blocking: true,
      taskName: name,
      paths: entries.map((entry) => entry.relativePath).sort(),
      message: `任务“${name}”同时存在计划任务文档和独立完成记录`
    });
  }

  const documents: LegacyDocumentCandidate[] = [];
  for (const type of new Set(entries.map((entry) => entry.type))) {
    const sameType = entries.filter((entry) => entry.type === type);
    const bodies = new Set(sameType.map((entry) => entry.body));
    if (bodies.size > 1) {
      conflicts.push({
        code: "document_body_conflict",
        blocking: true,
        taskName: name,
        documentType: type,
        paths: sameType.map((entry) => entry.relativePath).sort(),
        message: `任务“${name}”的 ${type} 文档存在不同正文`
      });
      continue;
    }
    documents.push(choosePreferredCandidate(sameType));
  }

  return {
    key,
    name,
    slug: createLegacyTaskSlug(name),
    status,
    trackingMode: hasRecorded ? "recorded" : "planned",
    documents: documents.sort((left, right) => left.type.localeCompare(right.type)),
    conflicts
  };
}

/** 将旧任务名转换为稳定 slug；保留中文，避免多个非英文任务坍缩到同一兜底值。 */
export function createLegacyTaskSlug(name: string): string {
  const slug = name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "");
  return slug || `legacy-${Buffer.from(name, "utf8").toString("hex").slice(0, 24)}`;
}

function inspectDatabaseConflict(
  repository: DocumentRepository,
  task: LegacyMigrationTaskPreview
): LegacyMigrationConflict | undefined {
  const existing = repository.listTasks().find((item) => item.slug === task.slug);
  if (existing === undefined) {
    return undefined;
  }
  const expectedStatus = toRepositoryStatus(task.status, task.trackingMode);
  if (
    normalizeTaskKey(existing.name) !== task.key
    || existing.trackingMode !== task.trackingMode
    || existing.status !== expectedStatus
  ) {
    return databaseConflict(task, `数据库中已存在同 slug 但任务元数据不同：${task.slug}`);
  }
  const currentDocuments = new Map(
    repository.listDocuments(existing.id).map((document) => [document.type, document.body])
  );
  const differing = task.documents.filter((document) => {
    const current = currentDocuments.get(document.type);
    return current !== undefined && current !== document.body;
  });
  return differing.length === 0
    ? undefined
    : databaseConflict(task, `数据库中已存在不同正文：${differing.map((item) => item.type).join("、")}`);
}

function toRepositoryStatus(status: LegacyMigrationStatus, trackingMode: TrackingMode): TaskStatus {
  if (trackingMode === "recorded") {
    return "recorded";
  }
  return status === "archived" ? "archived" : "active";
}

function databaseConflict(task: LegacyMigrationTaskPreview, message: string): LegacyMigrationConflict {
  return {
    code: "database_conflict",
    blocking: true,
    taskName: task.name,
    paths: task.documents.map((document) => document.relativePath),
    message
  };
}

function toDatabaseConflict(
  task: LegacyMigrationTaskPreview,
  error: unknown,
  rollbackError?: string
): LegacyMigrationConflict {
  const detail = error instanceof DocumentRepositoryError || error instanceof Error
    ? error.message
    : String(error);
  const rollbackDetail = rollbackError === undefined ? "" : `；补偿回滚失败：${rollbackError}`;
  return databaseConflict(task, `导入数据库失败：${detail}${rollbackDetail}`);
}

/** 补偿动作不得覆盖最初的导入异常，因此失败时只返回可附加到冲突的信息。 */
function compensate(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function previewFingerprint(preview: LegacyMigrationPreview): string {
  return JSON.stringify(preview.tasks.map((task) => ({
    key: task.key,
    status: task.status,
    documents: task.documents.map((document) => [document.type, document.relativePath, document.body])
  })));
}

async function scanSingleFileDirectory(
  projectRoot: string,
  directoryName: "plan-doc" | "status-doc",
  type: "plan" | "status",
  parseName: (fileName: string) => { taskName: string; namingStyle: LegacyNamingStyle } | undefined,
  output: DiscoveredCandidate[],
  conflicts: LegacyMigrationConflict[]
): Promise<void> {
  for (const location of ["active", "archived"] as const) {
    const relativeDirectory = join(DOCUMENT_ROOT, directoryName, ...(location === "archived" ? ["archive"] : []));
    for (const fileName of await safeListDirectory(projectRoot, relativeDirectory, conflicts)) {
      const parsed = parseName(fileName);
      if (parsed === undefined) {
        continue;
      }
      const relativePath = join(relativeDirectory, fileName);
      const body = await safeReadMarkdown(projectRoot, relativePath, parsed.taskName, conflicts);
      if (body !== undefined) {
        output.push({ type, body, relativePath, location, ...parsed });
      }
    }
  }
}

async function scanResultDirectory(
  projectRoot: string,
  output: DiscoveredCandidate[],
  conflicts: LegacyMigrationConflict[]
): Promise<void> {
  for (const location of ["active", "archived"] as const) {
    const baseDirectory = join(DOCUMENT_ROOT, "result-doc", ...(location === "archived" ? ["archive"] : []));
    for (const taskName of await safeListDirectory(projectRoot, baseDirectory, conflicts, true)) {
      const taskDirectory = join(baseDirectory, taskName);
      for (const fileName of await safeListDirectory(projectRoot, taskDirectory, conflicts)) {
        const parsed = parseResultFile(fileName);
        if (parsed === undefined) {
          continue;
        }
        const relativePath = join(taskDirectory, fileName);
        const body = await safeReadMarkdown(projectRoot, relativePath, taskName, conflicts);
        if (body !== undefined) {
          output.push({ taskName, type: parsed.type, body, relativePath, location, namingStyle: parsed.namingStyle });
        }
      }
    }
  }
}

async function scanCompletionRecords(
  projectRoot: string,
  output: DiscoveredCandidate[],
  conflicts: LegacyMigrationConflict[]
): Promise<void> {
  const relativeDirectory = join(DOCUMENT_ROOT, "completion-record");
  for (const fileName of await safeListDirectory(projectRoot, relativeDirectory, conflicts)) {
    const parsed = parseCompletionRecordName(fileName);
    if (parsed === undefined) {
      continue;
    }
    const relativePath = join(relativeDirectory, fileName);
    const body = await safeReadMarkdown(projectRoot, relativePath, parsed.taskName, conflicts);
    if (body !== undefined) {
      output.push({
        taskName: parsed.taskName,
        type: "completion_record",
        body,
        relativePath,
        location: "recorded",
        namingStyle: parsed.namingStyle
      });
    }
  }
}

/**
 * 列出固定受控目录。requireDirectory=true 时只返回普通目录；否则只返回普通文件。
 * 符号链接以阻断冲突呈现，既不读取也不递归。
 */
async function safeListDirectory(
  projectRoot: string,
  relativeDirectory: string,
  conflicts: LegacyMigrationConflict[],
  requireDirectory = false
): Promise<string[]> {
  const absoluteDirectory = resolveInsideProject(projectRoot, relativeDirectory);
  if (!await isSafeScanDirectory(projectRoot, relativeDirectory, conflicts)) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name === "archive" && relativeDirectory.endsWith(join(DOCUMENT_ROOT, "result-doc"))) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      conflicts.push(unsafePathConflict(join(relativeDirectory, entry.name)));
      continue;
    }
    if (requireDirectory ? entry.isDirectory() : entry.isFile()) {
      names.push(entry.name);
    }
  }
  return names.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

/**
 * 扫描前逐段验证目录，尤其阻止固定的 archive 路径本身被替换成符号链接。
 * 目录不存在代表没有旧文档；非目录或符号链接则形成结构化阻断冲突。
 */
async function isSafeScanDirectory(
  projectRoot: string,
  relativeDirectory: string,
  conflicts: LegacyMigrationConflict[]
): Promise<boolean> {
  let cursor = projectRoot;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        conflicts.push(unsafePathConflict(relative(projectRoot, cursor)));
        return false;
      }
    } catch (error) {
      if (isMissingPath(error)) {
        return false;
      }
      throw error;
    }
  }
  return true;
}

async function safeReadMarkdown(
  projectRoot: string,
  relativePath: string,
  taskName: string,
  conflicts: LegacyMigrationConflict[]
): Promise<string | undefined> {
  const absolutePath = resolveInsideProject(projectRoot, relativePath);
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    conflicts.push({ ...unsafePathConflict(relativePath), taskName });
    return undefined;
  }
  return readFile(absolutePath, "utf8");
}

function resolveInsideProject(projectRoot: string, relativePath: string): string {
  const target = resolve(projectRoot, relativePath);
  const relativeTarget = relative(projectRoot, target);
  if (
    relativeTarget === ""
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    throw new Error(`文档路径必须位于项目根目录内：${relativePath}`);
  }
  return target;
}

async function resolveProjectRoot(projectRoot: string): Promise<string> {
  return realpath(resolve(projectRoot));
}

function unsafePathConflict(relativePath: string): LegacyMigrationConflict {
  return {
    code: "unsafe_path",
    blocking: true,
    taskName: relativePath,
    paths: [relativePath],
    message: `旧文档路径包含不受支持的符号链接或非普通文件：${relativePath}`
  };
}

function parsePlanName(fileName: string): { taskName: string; namingStyle: LegacyNamingStyle } | undefined {
  return fileName.endsWith(".md")
    ? { taskName: fileName.slice(0, -3), namingStyle: "current" }
    : undefined;
}

function parseStatusName(fileName: string): { taskName: string; namingStyle: LegacyNamingStyle } | undefined {
  if (fileName.endsWith("-状态.md")) {
    return { taskName: fileName.slice(0, -"-状态.md".length), namingStyle: "current" };
  }
  if (fileName.endsWith("-status.md")) {
    return { taskName: fileName.slice(0, -"-status.md".length), namingStyle: "legacy" };
  }
  return undefined;
}

function parseResultFile(fileName: string): { type: "result" | "manual_test"; namingStyle: LegacyNamingStyle } | undefined {
  if (fileName === "实施记录.md") {
    return { type: "result", namingStyle: "current" };
  }
  if (fileName === "implementation.md") {
    return { type: "result", namingStyle: "legacy" };
  }
  if (fileName === "手工测试.md") {
    return { type: "manual_test", namingStyle: "current" };
  }
  if (fileName === "manual-test.md") {
    return { type: "manual_test", namingStyle: "legacy" };
  }
  return undefined;
}

function parseCompletionRecordName(fileName: string): { taskName: string; namingStyle: LegacyNamingStyle } | undefined {
  if (fileName.endsWith("-完成记录.md")) {
    return { taskName: fileName.slice(0, -"-完成记录.md".length), namingStyle: "current" };
  }
  if (fileName.endsWith("-completion-record.md")) {
    return { taskName: fileName.slice(0, -"-completion-record.md".length), namingStyle: "legacy" };
  }
  return undefined;
}

function choosePreferredCandidate(candidates: DiscoveredCandidate[]): LegacyDocumentCandidate {
  const selected = [...candidates].sort((left, right) => {
    if (left.namingStyle !== right.namingStyle) {
      return left.namingStyle === "current" ? -1 : 1;
    }
    return left.relativePath.localeCompare(right.relativePath, "zh-CN");
  })[0];
  if (selected === undefined) {
    throw new Error("候选文档不能为空");
  }
  const { taskName: _taskName, ...document } = selected;
  return document;
}

function chooseTaskName(names: string[]): string {
  return [...names].sort((left, right) => {
    const leftChinese = /\p{Script=Han}/u.test(left);
    const rightChinese = /\p{Script=Han}/u.test(right);
    return leftChinese === rightChinese ? left.localeCompare(right, "zh-CN") : leftChinese ? -1 : 1;
  })[0] ?? "未命名任务";
}

function normalizeTaskKey(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
