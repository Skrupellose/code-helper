import {
  applyLegacyDocumentMigration,
  DocumentRepository,
  exportMarkdownDocuments,
  importMarkdownDocuments,
  previewLegacyDocumentMigration
} from "../../documents/index.js";
import { openDocumentDatabase } from "../../storage/index.js";

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
      console.error("用法：code-helper documents <migrate [--apply] [--json]|import [--apply] [--json]|export [--force] [--json]|check [--json]>");
      return 1;
  }
}

/** 预览或显式导入已登记导出基线上的 Markdown 单边修改。 */
async function runImport(projectRoot: string, args: string[]): Promise<number> {
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--apply" && arg !== "--json");
  if (unknown.length > 0) {
    console.error("用法：code-helper documents import [--apply] [--json]");
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
      console.log(JSON.stringify(result, null, 2));
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
  if (unknown.length > 0) {
    console.error("用法：code-helper documents migrate [--apply] [--json]");
    return 1;
  }

  const preview = await previewLegacyDocumentMigration(projectRoot);
  if (!apply) {
    printMigrationPreview(preview, json);
    return preview.conflicts.length === 0 ? 0 : 2;
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
      console.log(JSON.stringify({ ...result, baselineConflicts }, null, 2));
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
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--force" && arg !== "--json");
  if (unknown.length > 0) {
    console.error("用法：code-helper documents export [--force] [--json]");
    return 1;
  }

  const connection = openDocumentDatabase({ projectRoot });
  try {
    const result = await exportMarkdownDocuments(
      projectRoot,
      connection,
      new DocumentRepository(connection),
      { force }
    );
    if (json) {
      console.log(JSON.stringify(result, null, 2));
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
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > (json ? 1 : 0)) {
    console.error("用法：code-helper documents check [--json]");
    return 1;
  }

  const connection = openDocumentDatabase({ projectRoot });
  try {
    const result = connection.checkIntegrity();
    if (json) {
      console.log(JSON.stringify(result, null, 2));
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
    console.log(JSON.stringify(preview, null, 2));
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
