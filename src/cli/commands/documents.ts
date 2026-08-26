import {
  applyLegacyDocumentMigration,
  DocumentRepository,
  exportMarkdownDocuments,
  importMarkdownDocuments,
  previewLegacyDocumentMigration,
  previewMigrationBaselineConflicts
} from "../../documents/index.js";
import { openDocumentDatabase } from "../../storage/index.js";
import {
  createErrorResponse,
  createOutcomeResponse,
  createSuccessResponse,
  printAgentResponse,
  type AgentDiagnostic
} from "../agent-response.js";

/**
 * 文档数据库维护命令入口。
 * migrate 默认只预览，只有显式 --apply 才写入；export 默认保护手工修改的 Markdown。
 */
export async function runDocuments(projectRoot: string, args: string[] = []): Promise<number> {
  const [action, ...rest] = args;

  switch (action) {
    case "migrate":
      return runMigration(projectRoot, rest);
    case "export":
      return runExport(projectRoot, rest);
    case "import":
      return runImport(projectRoot, rest);
    case "check":
      return runIntegrityCheck(projectRoot, rest);
    default:
      if (args.includes("--json")) {
        printInvalidArguments("documents.unknown", "用法：code-helper documents <migrate [--apply] [--json]|import [--apply] [--json]|export [--tracked] [--force] [--json]|check [--json]>");
      } else {
        console.error("用法：code-helper documents <migrate [--apply] [--json]|import [--apply] [--json]|export [--tracked] [--force] [--json]|check [--json]>");
      }
      return 1;
  }
}

/** 预览或显式导入已登记导出基线上的 Markdown 单边修改。 */
async function runImport(projectRoot: string, args: string[]): Promise<number> {
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--apply" && arg !== "--json");
  if (unknown.length > 0 || hasDuplicateArgument(args, "--apply") || hasDuplicateArgument(args, "--json")) {
    if (json) {
      printInvalidArguments("documents.import", "用法：code-helper documents import [--apply] [--json]");
    } else {
      console.error("用法：code-helper documents import [--apply] [--json]");
    }
    return 1;
  }

  const connection = openDocumentDatabase({ projectRoot });
  try {
    const result = await importMarkdownDocuments(
      projectRoot,
      connection,
      new DocumentRepository(connection),
      { apply }
    );
    if (json) {
      printDocumentResult("documents.import", result, result.conflicts, result.conflicts.length === 0 ? [apply ? "continue_workflow" : "review_import_preview"] : ["resolve_conflicts"]);
    } else {
      const candidates = result.skipped.filter((item) => item.status === "candidate").length;
      console.log(`已导入：${result.imported.length}；待应用：${candidates}；冲突：${result.conflicts.length}`);
      for (const conflict of result.conflicts) {
        console.error(`- ${conflict.relativePath}：${conflict.message ?? "导入冲突"}`);
      }
    }
    return result.conflicts.length === 0 ? 0 : 2;
  } finally {
    connection.close();
  }
}

/** 预览或显式应用旧版 Markdown 到 SQLite 的迁移。 */
async function runMigration(projectRoot: string, args: string[]): Promise<number> {
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--apply" && arg !== "--json");
  if (unknown.length > 0 || hasDuplicateArgument(args, "--apply") || hasDuplicateArgument(args, "--json")) {
    if (json) {
      printInvalidArguments("documents.migrate", "用法：code-helper documents migrate [--apply] [--json]");
    } else {
      console.error("用法：code-helper documents migrate [--apply] [--json]");
    }
    return 1;
  }

  const preview = await previewLegacyDocumentMigration(projectRoot);
  if (!apply) {
    printMigrationPreview(preview, json);
    return preview.conflicts.length === 0 ? 0 : 2;
  }

  // 写入前预检默认兼容视图目标路径：若已存在正文不同的文件，先中止并返回 2，
  // 避免 applyLegacyDocumentMigration 写入数据库后才在建立基线时发现冲突的部分成功语义。
  const baselinePreviewConflicts = await previewMigrationBaselineConflicts(projectRoot, preview);
  if (baselinePreviewConflicts.length > 0) {
    if (json) {
      printDocumentResult("documents.migrate", { conflicts: baselinePreviewConflicts }, baselinePreviewConflicts, ["resolve_conflicts"]);
    } else {
      console.log("检测到目标兼容视图冲突，已中止迁移（未写入数据库）：");
      for (const conflict of baselinePreviewConflicts) {
        console.error(`- ${conflict.relativePath}：${conflict.message}`);
      }
    }
    return 2;
  }

  const connection = openDocumentDatabase({ projectRoot });
  try {
    const repository = new DocumentRepository(connection);
    const result = await applyLegacyDocumentMigration(
      projectRoot,
      repository,
      preview
    );
    // 迁移后立即生成稳定中文兼容视图并登记摘要。旧英文文件继续保留为只读来源，
    // 用户第一次编辑稳定路径时即可被 import 识别为明确的单边修改。
    const migratedNames = new Set([...result.imported, ...result.skipped]);
    const baselineConflicts = [];
    for (const task of repository.listTasks()) {
      if (!migratedNames.has(task.name)) {
        continue;
      }
      const exported = await exportMarkdownDocuments(projectRoot, connection, repository, { taskId: task.id });
      baselineConflicts.push(...exported.conflicts);
    }
    if (json) {
      printDocumentResult(
        "documents.migrate",
        { ...result, baselineConflicts },
        [...result.conflicts, ...baselineConflicts],
        result.conflicts.length === 0 && baselineConflicts.length === 0 ? ["continue_workflow"] : ["resolve_conflicts"]
      );
    } else {
      const conflictCount = result.conflicts.length + baselineConflicts.length;
      console.log(`已导入：${result.imported.length}；已跳过：${result.skipped.length}；冲突：${conflictCount}`);
      for (const conflict of result.conflicts) {
        console.error(`- ${conflict.taskName}：${conflict.message}`);
      }
      for (const conflict of baselineConflicts) {
        console.error(`- ${conflict.relativePath}：${conflict.message ?? "无法建立导出基线"}`);
      }
    }
    return result.conflicts.length === 0 && baselineConflicts.length === 0 ? 0 : 2;
  } finally {
    connection.close();
  }
}

/** 将 SQLite 权威正文导出为兼容 Markdown 视图。 */
async function runExport(projectRoot: string, args: string[]): Promise<number> {
  const force = args.includes("--force");
  const tracked = args.includes("--tracked");
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--force" && arg !== "--tracked" && arg !== "--json");
  if (unknown.length > 0
    || hasDuplicateArgument(args, "--force")
    || hasDuplicateArgument(args, "--tracked")
    || hasDuplicateArgument(args, "--json")) {
    if (json) {
      printInvalidArguments("documents.export", "用法：code-helper documents export [--tracked] [--force] [--json]");
    } else {
      console.error("用法：code-helper documents export [--tracked] [--force] [--json]");
    }
    return 1;
  }

  const connection = openDocumentDatabase({ projectRoot });
  try {
    const result = await exportMarkdownDocuments(
      projectRoot,
      connection,
      new DocumentRepository(connection),
      { force, tracked }
    );
    if (json) {
      printDocumentResult("documents.export", result, result.conflicts, result.conflicts.length === 0 ? ["continue_workflow"] : ["resolve_conflicts"]);
    } else {
      console.log(`导出完成：${result.exported.length}；冲突：${result.conflicts.length}`);
      for (const conflict of result.conflicts) {
        console.error(`- ${conflict.relativePath}：${conflict.message ?? "目标文件冲突"}`);
      }
    }
    return result.conflicts.length === 0 ? 0 : 2;
  } finally {
    connection.close();
  }
}

/** 显式执行 SQLite 完整性、外键和必要表检查。 */
function runIntegrityCheck(projectRoot: string, args: string[]): number {
  const json = args.includes("--json");
  if (args.length > (json ? 1 : 0) || hasDuplicateArgument(args, "--json")) {
    if (json) {
      printInvalidArguments("documents.check", "用法：code-helper documents check [--json]");
    } else {
      console.error("用法：code-helper documents check [--json]");
    }
    return 1;
  }

  const connection = openDocumentDatabase({ projectRoot });
  try {
    const result = connection.checkIntegrity();
    if (json) {
      if (result.ok) {
        printAgentResponse(createSuccessResponse("documents.check", { integrity: result }, ["continue_workflow"]));
      } else {
        printAgentResponse(createOutcomeResponse("documents.check", "integrity_failed", { integrity: result }, [{
          severity: "error",
          code: "integrity_check_failed",
          message: "SQLite 文档数据库完整性检查失败",
          fix: "根据 missingTables 和 foreignKeyViolations 修复数据库后重试"
        }], ["repair_database", "run_integrity_check"]));
      }
    } else {
      console.log(result.ok ? "SQLite 文档数据库检查通过" : "SQLite 文档数据库检查失败");
      if (result.missingTables.length > 0) {
        console.error(`缺少数据表：${result.missingTables.join("、")}`);
      }
      if (result.foreignKeyViolations.length > 0) {
        console.error(`外键异常：${result.foreignKeyViolations.length}`);
      }
    }
    return result.ok ? 0 : 2;
  } finally {
    connection.close();
  }
}

/** 输出迁移预览；JSON 模式保留完整结构供脚本消费。 */
function printMigrationPreview(
  preview: Awaited<ReturnType<typeof previewLegacyDocumentMigration>>,
  json: boolean
): void {
  if (json) {
    printDocumentResult("documents.migrate", preview, preview.conflicts, preview.conflicts.length === 0 ? ["review_migration_preview", "apply_migration"] : ["resolve_conflicts"]);
    return;
  }

  console.log(`扫描文件：${preview.scannedFiles.length}；候选任务：${preview.tasks.length}；冲突：${preview.conflicts.length}`);
  for (const task of preview.tasks) {
    console.log(`- ${task.name}：${task.status}，${task.documents.length} 份文档`);
  }
  for (const conflict of preview.conflicts) {
    console.error(`- ${conflict.taskName}：${conflict.message}`);
  }
  console.log("确认预览无误后，使用 --apply 显式导入。");
}

/** JSON 参数错误统一使用稳定状态和诊断码，避免错误路径落回纯文本 stderr。 */
function printInvalidArguments(action: string, usage: string): void {
  printAgentResponse(createErrorResponse(action, "invalid_arguments", {
    severity: "error",
    code: "invalid_arguments",
    message: usage,
    fix: "按命令用法移除未知或重复参数后重试"
  }));
}

/** 判断无值 flag 是否重复，避免 Set/contains 解析悄悄吞掉脚本输入错误。 */
function hasDuplicateArgument(args: string[], target: string): boolean {
  return args.filter((arg) => arg === target).length > 1;
}

/**
 * 输出文档命令结果：无冲突为成功，有冲突则保留业务数据并返回可机读诊断。
 * 冲突对象来自不同文档流程，因此只依赖共同可选字段，不耦合具体领域类型。
 */
function printDocumentResult<T>(
  action: string,
  data: T,
  conflicts: Array<{ message?: string; relativePath?: string; taskName?: string }>,
  nextActions: string[]
): void {
  if (conflicts.length === 0) {
    printAgentResponse(createSuccessResponse(action, data, nextActions));
    return;
  }

  const diagnostics: AgentDiagnostic[] = conflicts.map((conflict) => ({
    severity: "error",
    code: "document_conflict",
    message: conflict.message ?? "检测到文档冲突",
    ...(conflict.relativePath !== undefined || conflict.taskName !== undefined
      ? { target: conflict.relativePath ?? conflict.taskName }
      : {}),
    fix: "人工合并冲突内容后重试"
  }));
  printAgentResponse(createOutcomeResponse(action, "conflict", data, diagnostics, nextActions));
}
