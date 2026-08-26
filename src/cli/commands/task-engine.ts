import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  checkMarkdownProjectionForTask,
  DOCUMENT_TYPES,
  DocumentRepositoryError,
  exportMarkdownDocuments,
  registerCompatibleProjectionBaselines,
  TASK_STATUSES,
  type DocumentRecord,
  DocumentRepository,
  type DocumentType,
  type MarkdownExportResult,
  type MarkdownExportTestHooks,
  type TaskRecord,
  type TaskStatus,
  withDocumentRepository
} from "../../documents/index.js";
import { openDocumentDatabase } from "../../storage/index.js";
import {
  createErrorResponse,
  createOutcomeResponse,
  createSuccessResponse,
  printAgentResponse,
  type AgentResponse
} from "../agent-response.js";

type CommandGroup = "task" | "document" | "validation" | "git";

export interface TaskEngineInternalOptions {
  /** 仅供定向测试注入投影文件竞态；正常 CLI 路由不传入。 */
  markdownExportTestHooks?: MarkdownExportTestHooks;
}

/**
 * SQLite 任务引擎的稳定 CLI 入口。
 * 所有 JSON 分支都在本函数内捕获错误并输出一次 envelope，避免顶层 catch 污染机器协议。
 */
export async function runTaskEngine(
  projectRoot: string,
  group: CommandGroup,
  args: string[],
  inputBasePath = projectRoot,
  internalOptions: TaskEngineInternalOptions = {}
): Promise<number> {
  const json = args.includes("--json");
  const action = `${group}.${args.find((arg) => !arg.startsWith("--")) ?? "unknown"}`;

  try {
    const response = await dispatchTaskEngine(projectRoot, group, args, inputBasePath, internalOptions);
    printResponse(response, json);
    return response.ok ? 0 : exitCodeForStatus(response.status);
  } catch (error) {
    const response = mapError(action, error);
    printResponse(response, json);
    return exitCodeForStatus(response.status);
  }
}

/** 按命令组分发，同时保持各分支返回同一种响应协议。 */
async function dispatchTaskEngine(
  projectRoot: string,
  group: CommandGroup,
  args: string[],
  inputBasePath: string,
  internalOptions: TaskEngineInternalOptions
): Promise<AgentResponse> {
  const tokens = args.filter((arg) => arg !== "--json");
  switch (group) {
    case "task":
      return runTaskCommand(projectRoot, tokens);
    case "document":
      return runDocumentCommand(projectRoot, tokens, inputBasePath, internalOptions);
    case "validation":
      return runValidationCommand(projectRoot, tokens);
    case "git":
      return runGitCommand(projectRoot, tokens);
  }
}

/** 处理任务状态读取、迁移和下一动作查询。 */
function runTaskCommand(projectRoot: string, args: string[]): AgentResponse {
  const [action, taskReference, ...rest] = args;
  if (action === "status" || action === "next") {
    requireNoExtraArguments(rest, `code-helper task ${action} <任务 slug|ID> [--json]`);
    const task = withDocumentRepository(projectRoot, (repository) => requireTask(repository, taskReference));
    return createSuccessResponse(`task.${action}`, { task }, getTaskNextActions(task));
  }
  if (action === "transition") {
    const nextStatus = rest.shift();
    const options = parseOptions(rest, new Set(["--current-node"]));
    if (!isTaskStatus(nextStatus)) {
      throw invalidInput(`任务状态必须是：${TASK_STATUSES.join("、")}`);
    }
    const task = withDocumentRepository(projectRoot, (repository) => {
      const current = requireTask(repository, taskReference);
      return repository.transitionTaskStatus(current.id, nextStatus, options["--current-node"]);
    });
    return createSuccessResponse("task.transition", { task }, getTaskNextActions(task));
  }
  throw invalidInput("用法：code-helper task <status|next|transition> ...");
}

/** 处理文档读取、CAS 更新和修订历史查询。 */
async function runDocumentCommand(
  projectRoot: string,
  args: string[],
  inputBasePath: string,
  internalOptions: TaskEngineInternalOptions
): Promise<AgentResponse> {
  const [action, taskReference, rawType, ...rest] = args;
  const type = requireDocumentType(rawType);
  if (action === "show" || action === "history") {
    requireNoExtraArguments(rest, `code-helper document ${action} <任务 slug|ID> <类型> [--json]`);
    return withDocumentRepository(projectRoot, (repository) => {
      const task = requireTask(repository, taskReference);
      const document = requireDocument(repository, task.id, type);
      const data = action === "show"
        ? { task, document }
        : { task, document, revisions: repository.listDocumentRevisions(document.id) };
      return createSuccessResponse(`document.${action}`, data);
    });
  }
  if (action === "update") {
    const { options, bodyStdin } = parseDocumentUpdateOptions(rest, new Set([
      "--body",
      "--body-file",
      "--expected-revision",
      "--expected-content-hash",
      "--summary",
      "--source"
    ]));
    const bodySourceCount = [
      options["--body"] !== undefined,
      options["--body-file"] !== undefined,
      bodyStdin
    ].filter(Boolean).length;
    if (bodySourceCount !== 1) {
      throw invalidInput("document update 必须且只能提供 --body、--body-file 或 --body-stdin 之一");
    }
    const expectedRevision = parseOptionalInteger(options["--expected-revision"], "expected revision");
    if (expectedRevision === undefined && options["--expected-content-hash"] === undefined) {
      throw invalidInput("document update 必须提供 --expected-revision 或 --expected-content-hash");
    }
    const body = bodyStdin
      ? await readStandardInput()
      : options["--body"] ?? await readFile(
          resolve(inputBasePath, options["--body-file"] as string),
          "utf8"
        );
    // 空 stdin 往往表示上游生成正文的进程失败；必须在打开数据库前拒绝，避免把文档误清空。
    if (bodyStdin && body.length === 0) {
      throw invalidInput("--body-stdin 未读取到正文；请检查上游命令后重试");
    }

    // 文件投影检查和自动刷新包含异步文件操作，不能使用同步关闭连接的 withDocumentRepository。
    const connection = openDocumentDatabase({ projectRoot });
    try {
      const repository = new DocumentRepository(connection);
      const task = requireTask(repository, taskReference);
      const current = requireDocument(repository, task.id, type);
      const projectionCheck = await checkMarkdownProjectionForTask(
        projectRoot,
        connection,
        repository,
        task.id
      );
      if (projectionCheck.conflicts.length > 0) {
        return createOutcomeResponse(
          "document.update",
          "conflict",
          {
            task,
            document: current,
            database: { updated: false, revision: current.revision },
            projection: { updated: false, check: projectionCheck }
          },
          [{
            severity: "error",
            code: "markdown_projection_modified",
            message: "Markdown 兼容投影存在人工修改，SQLite 未更新",
            target: projectionCheck.conflicts[0]?.relativePath,
            fix: "先使用 documents import 预览并显式合并人工修改，再重新读取 revision 后重试"
          }],
          ["preview_markdown_import", "resolve_projection_conflict", "show_document"]
        );
      }

      const document = repository.updateDocument(current.id, {
        body,
        expectedRevision,
        expectedContentHash: options["--expected-content-hash"],
        summary: options["--summary"],
        source: options["--source"] ?? "cli"
      });
      const databaseUpdated = document.revision !== current.revision;
      try {
        // 兼容基线必须在 CAS 成功后登记；陈旧 revision 不得产生任何 document_exports 副作用。
        // 登记异常与后续文件导出异常都属于“数据库已提交、投影未完成”的同一部分失败协议。
        registerCompatibleProjectionBaselines(repository, projectionCheck);
        const projection = await exportMarkdownDocuments(projectRoot, connection, repository, {
          taskId: task.id,
          testHooks: internalOptions.markdownExportTestHooks
        });
        if (projection.conflicts.length > 0) {
          return createProjectionFailureResponse(
            task,
            document,
            databaseUpdated,
            projection,
            "投影刷新前检测到并发人工修改"
          );
        }
        return createSuccessResponse("document.update", {
          task,
          document,
          database: { updated: databaseUpdated, revision: document.revision, contentHash: document.contentHash },
          projection: { updated: true, ...projection }
        });
      } catch (error) {
        return createProjectionFailureResponse(
          task,
          document,
          databaseUpdated,
          { exported: [], conflicts: [] },
          error instanceof Error ? error.message : String(error)
        );
      }
    } finally {
      connection.close();
    }
  }
  throw invalidInput("用法：code-helper document <show|update|history> ...");
}

/**
 * 读取 stdin 的完整 UTF-8 正文。
 * 显式 --body-stdin 才会进入该分支，因此普通命令和 TTY 不会意外挂起等待输入。
 */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 文档更新同时支持带值选项和无值的 --body-stdin，并严格拒绝重复或未知参数。 */
function parseDocumentUpdateOptions(
  args: string[],
  allowedValueOptions: ReadonlySet<string>
): { options: Record<string, string>; bodyStdin: boolean } {
  const options: Record<string, string> = {};
  let bodyStdin = false;
  for (let index = 0; index < args.length;) {
    const key = args[index];
    if (key === "--body-stdin") {
      if (bodyStdin) {
        throw invalidInput("参数不能重复：--body-stdin");
      }
      bodyStdin = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (key === undefined || !allowedValueOptions.has(key) || value === undefined || value.startsWith("--")) {
      throw invalidInput(`无效或缺少值的参数：${key ?? "<empty>"}`);
    }
    if (options[key] !== undefined) {
      throw invalidInput(`参数不能重复：${key}`);
    }
    options[key] = value;
    index += 2;
  }
  return { options, bodyStdin };
}

/**
 * SQLite 已提交但兼容投影未能刷新时返回可机器处理的部分成功状态。
 * 调用方必须重新读取 SQLite，处理指定投影后再执行非 force 导出；不得重放旧 CAS 写入。
 */
function createProjectionFailureResponse(
  task: TaskRecord,
  document: DocumentRecord,
  databaseUpdated: boolean,
  projection: MarkdownExportResult,
  reason: string
): AgentResponse {
  return createOutcomeResponse(
    "document.update",
    "projection_failed",
    {
      task,
      document,
      database: { updated: databaseUpdated, revision: document.revision, contentHash: document.contentHash },
      projection: { updated: false, ...projection, error: reason }
    },
    [{
      severity: "error",
      code: "markdown_projection_refresh_failed",
      message: `SQLite ${databaseUpdated ? "已更新" : "正文未变化"}，但 Markdown 兼容投影刷新失败：${reason}`,
      fix: "以 SQLite 当前正文为准，处理投影文件冲突或文件系统错误后运行 documents export；仅在确认可覆盖人工修改时使用 --force"
    }],
    ["show_document", "repair_projection", "export_documents"]
  );
}

/** 处理验证回执的生产写入和读取。 */
function runValidationCommand(projectRoot: string, args: string[]): AgentResponse {
  const [action, taskReference, ...rest] = args;
  if (action === "list") {
    requireNoExtraArguments(rest, "code-helper validation list <任务 slug|ID> [--json]");
    return withDocumentRepository(projectRoot, (repository) => {
      const task = requireTask(repository, taskReference);
      return createSuccessResponse("validation.list", {
        task,
        validations: repository.listValidations(task.id)
      });
    });
  }
  if (action === "record") {
    const options = parseOptions(rest, new Set([
      "--command",
      "--working-directory",
      "--exit-code",
      "--summary",
      "--baseline",
      "--acceptance-criteria",
      "--plan-items"
    ]));
    const command = requireOption(options, "--command");
    const workingDirectory = requireOption(options, "--working-directory");
    const summary = requireOption(options, "--summary");
    const exitCode = parseRequiredInteger(options["--exit-code"], "exit code");
    return withDocumentRepository(projectRoot, (repository) => {
      const task = requireTask(repository, taskReference);
      const id = repository.recordValidation({
        taskId: task.id,
        command,
        workingDirectory,
        exitCode,
        summary,
        baseline: options["--baseline"],
        acceptanceCriterionIds: parseOptionalIdList(options["--acceptance-criteria"]),
        planItemIds: parseOptionalIdList(options["--plan-items"])
      });
      const validation = repository.listValidations(task.id).find((item) => item.id === id);
      return createSuccessResponse("validation.record", { task, validation });
    });
  }
  throw invalidInput("用法：code-helper validation <record|list> ...");
}

/** 处理 Git 关联记录；不会调用 git 命令或修改仓库。 */
function runGitCommand(projectRoot: string, args: string[]): AgentResponse {
  const [action, taskReference, commitSha, ...rest] = args;
  if (action === "list") {
    requireNoExtraArguments([commitSha, ...rest].filter((item): item is string => item !== undefined), "code-helper git list <任务 slug|ID> [--json]");
    return withDocumentRepository(projectRoot, (repository) => {
      const task = requireTask(repository, taskReference);
      return createSuccessResponse("git.list", { task, links: repository.listGitLinks(task.id) });
    });
  }
  if (action === "link") {
    if (commitSha === undefined) {
      throw invalidInput("git link 缺少 commit SHA");
    }
    const options = parseOptions(rest, new Set(["--subject", "--scope"]));
    return withDocumentRepository(projectRoot, (repository) => {
      const task = requireTask(repository, taskReference);
      const id = repository.linkGitCommit({
        taskId: task.id,
        commitSha,
        subject: options["--subject"],
        scope: options["--scope"]
      });
      const link = repository.listGitLinks(task.id).find((item) => item.id === id);
      return createSuccessResponse("git.link", { task, link });
    });
  }
  throw invalidInput("用法：code-helper git <link|list> ...");
}

/** 任务可使用 slug 或稳定 ID 定位，优先 slug 保持常用 CLI 简洁。 */
function requireTask(repository: DocumentRepository, reference?: string): TaskRecord {
  if (reference === undefined || reference.trim() === "") {
    throw invalidInput("缺少任务 slug 或 ID");
  }
  const task = repository.getTaskBySlug(reference) ?? repository.getTask(reference);
  if (task === undefined) {
    throw new DocumentRepositoryError("NOT_FOUND", `未找到任务：${reference}`);
  }
  return task;
}

/** 在任务内按唯一文档类型定位当前正文。 */
function requireDocument(repository: DocumentRepository, taskId: string, type: DocumentType): DocumentRecord {
  const document = repository.listDocuments(taskId).find((item) => item.type === type);
  if (document === undefined) {
    throw new DocumentRepositoryError("NOT_FOUND", `任务 ${taskId} 不存在 ${type} 文档`);
  }
  return document;
}

/** 根据权威任务状态生成稳定、无副作用的下一动作标识。 */
function getTaskNextActions(task: TaskRecord): string[] {
  switch (task.status) {
    case "active":
      return task.currentNode === undefined ? ["set_current_node"] : ["continue_current_node"];
    case "paused":
      return ["resume_task"];
    case "completed":
    case "cancelled":
      return ["archive_task"];
    case "archived":
    case "recorded":
      return [];
  }
}

/** 严格解析成对长选项，拒绝未知项、缺值和重复项。 */
function parseOptions(args: string[], allowed: ReadonlySet<string>): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !allowed.has(key) || value === undefined || value.startsWith("--")) {
      throw invalidInput(`无效或缺少值的参数：${key ?? "<empty>"}`);
    }
    if (options[key] !== undefined) {
      throw invalidInput(`参数不能重复：${key}`);
    }
    options[key] = value;
  }
  return options;
}

/** 读取必填非空选项。 */
function requireOption(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (value === undefined || value.trim() === "") {
    throw invalidInput(`缺少参数：${key}`);
  }
  return value;
}

/** 解析必填整数，并保留 0 和负数等合法退出码。 */
function parseRequiredInteger(value: string | undefined, label: string): number {
  const parsed = parseOptionalInteger(value, label);
  if (parsed === undefined) {
    throw invalidInput(`缺少整数参数：${label}`);
  }
  return parsed;
}

/** 解析可选整数；未提供时返回 undefined。 */
function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^-?\d+$/u.test(value)) {
    throw invalidInput(`${label} 必须是整数`);
  }
  return Number.parseInt(value, 10);
}

/** 把逗号分隔的追踪 ID 解析为稳定去重列表，并拒绝空元素。 */
function parseOptionalIdList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ids = value.split(",").map((item) => item.trim());
  if (ids.length === 0 || ids.some((item) => item.length === 0)) {
    throw invalidInput("追踪 ID 列表必须是逗号分隔的非空值");
  }
  return [...new Set(ids)];
}

/** 无参数动作拒绝任何多余位置参数。 */
function requireNoExtraArguments(args: string[], usage: string): void {
  if (args.length > 0) {
    throw invalidInput(`用法：${usage}`);
  }
}

/** 把 CLI 字符串收窄为 schema 支持的文档类型。 */
function requireDocumentType(value?: string): DocumentType {
  if (value !== undefined && (DOCUMENT_TYPES as readonly string[]).includes(value)) {
    return value as DocumentType;
  }
  throw invalidInput(`文档类型必须是：${DOCUMENT_TYPES.join("、")}`);
}

/** 判断 CLI 字符串是否为持久化任务状态。 */
function isTaskStatus(value?: string): value is TaskStatus {
  return value !== undefined && (TASK_STATUSES as readonly string[]).includes(value);
}

/** 使用仓储稳定错误码表达 CLI 输入错误。 */
function invalidInput(message: string): DocumentRepositoryError {
  return new DocumentRepositoryError("INVALID_INPUT", message);
}

/** 把领域错误和意外错误收敛为稳定诊断，不泄漏 SQLite 原生协议。 */
function mapError(action: string, error: unknown): AgentResponse {
  if (error instanceof DocumentRepositoryError) {
    const statuses: Record<string, string> = {
      CAS_CONFLICT: "conflict",
      DUPLICATE: "conflict",
      INVALID_INPUT: "invalid_input",
      INVALID_STATE_TRANSITION: "invalid_state_transition",
      NOT_FOUND: "not_found"
    };
    return createErrorResponse(action, statuses[error.code] ?? "error", {
      severity: "error",
      code: error.code.toLowerCase(),
      message: error.message,
      ...(error.code === "CAS_CONFLICT" ? { fix: "重新读取当前 revision 后重试" } : {})
    });
  }
  return createErrorResponse(action, "error", {
    severity: "error",
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error)
  });
}

/** JSON 模式单次写 stdout；人类模式保留简洁可读输出。 */
function printResponse(response: AgentResponse, json: boolean): void {
  if (json) {
    printAgentResponse(response);
    return;
  }
  if (response.ok) {
    console.log(`${response.action}：${response.status}`);
    console.log(JSON.stringify(response.data, null, 2));
    if (response.nextActions.length > 0) {
      console.log(`下一步：${response.nextActions.join("、")}`);
    }
    return;
  }
  for (const diagnostic of response.diagnostics) {
    console.error(`${diagnostic.code}：${diagnostic.message}`);
  }
}

/** 0 表示成功，2 表示可处理冲突，其它协议错误使用 1。 */
function exitCodeForStatus(status: string): number {
  return status === "conflict" || status === "invalid_state_transition" ? 2 : status === "success" ? 0 : 1;
}
