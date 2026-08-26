import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  analyzeRequirementCoverage,
  type AnalysisValidationEvidence,
  type RequirementCoverageAnalysisInput
} from "../../analysis/index.js";
import { withDocumentRepository } from "../../documents/index.js";
import {
  clarifyRequirementExploration,
  clarifyRequirementSpecification,
  createRequirementExploration,
  createRequirementSpecification,
  renderRequirementExplorationMarkdown,
  renderRequirementSpecificationMarkdown,
  type RequirementClarificationInput,
  type RequirementExplorationInput,
  type RequirementSpecificationInput
} from "../../requirements/index.js";
import {
  createErrorResponse,
  createSuccessResponse,
  printAgentResponse,
  type AgentResponse
} from "../agent-response.js";

type RequirementCommand = "requirement" | "analyze";

/**
 * 需求探索、规格生成和只读语义分析的 CLI 入口。
 *
 * JSON 输入文件让 Agent 可以显式保存调用参数，避免复杂自然语言参数在 Shell 中发生转义漂移；
 * JSON 输出继续复用统一 Agent Contract，且 stdout 每次只输出一个完整文档。
 */
export async function runRequirementTools(
  command: RequirementCommand,
  args: string[],
  inputBasePath: string,
  projectRoot = inputBasePath
): Promise<number> {
  const json = args.includes("--json");
  // answer 是 clarify 的兼容别名；成功与失败都必须使用同一个 canonical action。
  const requirementAction = args[0] === "answer" ? "clarify" : (args[0] ?? "unknown");
  const action = command === "analyze" ? "requirement.analyze" : `requirement.${requirementAction}`;

  try {
    const response = command === "analyze"
      ? await runAnalyze(args, inputBasePath, projectRoot)
      : await runRequirement(args, inputBasePath);
    printRequirementResponse(response, json);
    return response.ok ? 0 : 1;
  } catch (error) {
    const response = createErrorResponse(action, "invalid_input", {
      severity: "error",
      code: "invalid_input",
      message: error instanceof Error ? error.message : String(error),
      fix: "检查 --input JSON 文件结构和命令用法后重试"
    });
    printRequirementResponse(response, json);
    return 1;
  }
}

/** 根据 explore/specify/clarify 子命令生成或继续澄清结构化需求产物。 */
async function runRequirement(args: string[], inputBasePath: string): Promise<AgentResponse> {
  const tokens = args.filter((arg) => arg !== "--json");
  const [action, ...rest] = tokens;
  const inputPath = parseInputPath(rest, `code-helper requirement ${action ?? "<explore|specify|clarify>"} --input <JSON 文件> [--json]`);

  if (action === "explore") {
    const input = await readJsonFile<RequirementExplorationInput>(inputBasePath, inputPath);
    const exploration = createRequirementExploration(input);
    return createSuccessResponse("requirement.explore", {
      exploration,
      markdown: renderRequirementExplorationMarkdown(exploration)
    }, exploration.readyForSpecification ? ["create_specification"] : ["answer_blocking_questions"]);
  }

  if (action === "specify") {
    const input = await readJsonFile<RequirementSpecificationInput>(inputBasePath, inputPath);
    const specification = createRequirementSpecification(input);
    return createSuccessResponse("requirement.specify", {
      specification,
      markdown: renderRequirementSpecificationMarkdown(specification)
    }, specification.readyForPlanning ? ["create_plan"] : ["answer_blocking_questions"]);
  }

  if (action === "clarify" || action === "answer") {
    const input = await readJsonFile<RequirementClarificationInput>(inputBasePath, inputPath);
    if ("exploration" in input && !("specification" in input)) {
      const exploration = clarifyRequirementExploration(input);
      return createSuccessResponse("requirement.clarify", {
        artifactType: "exploration",
        exploration,
        markdown: renderRequirementExplorationMarkdown(exploration)
      }, exploration.readyForSpecification ? ["create_specification"] : ["answer_open_questions"]);
    }
    if ("specification" in input && !("exploration" in input)) {
      const specification = clarifyRequirementSpecification(input);
      return createSuccessResponse("requirement.clarify", {
        artifactType: "specification",
        specification,
        markdown: renderRequirementSpecificationMarkdown(specification)
      }, specification.readyForPlanning ? ["create_plan"] : ["answer_open_questions"]);
    }
    throw new Error("clarify 输入必须且只能包含 exploration 或 specification 之一。");
  }

  throw new Error("用法：code-helper requirement <explore|specify|clarify|answer> --input <JSON 文件> [--json]");
}

/** 执行纯只读跨产物语义分析；函数不会修改输入文件或项目状态。 */
async function runAnalyze(
  args: string[],
  inputBasePath: string,
  projectRoot: string
): Promise<AgentResponse> {
  const tokens = args.filter((arg) => arg !== "--json");
  const options = parseNamedOptions(
    tokens,
    new Set(["--input", "--task"]),
    "code-helper analyze --input <JSON 文件> [--task <任务 slug|ID>] [--json]"
  );
  const inputPath = options["--input"];
  if (inputPath === undefined) {
    throw new Error("analyze 缺少 --input JSON 文件。");
  }
  const input = await readJsonFile<RequirementCoverageAnalysisInput>(inputBasePath, inputPath);
  const taskReference = options["--task"];
  const analysisInput = taskReference === undefined
    ? input
    : { ...input, validationEvidence: loadTaskValidationEvidence(projectRoot, taskReference) };
  const analysis = analyzeRequirementCoverage(analysisInput);
  return createSuccessResponse("requirement.analyze", { analysis }, analysis.passed ? ["continue_workflow"] : ["resolve_diagnostics"]);
}

/**
 * 从 SQLite 权威任务库读取验证证据，并转换为语义分析器使用的稳定追踪模型。
 * 显式 --task 会覆盖输入文件中的 validationEvidence，避免陈旧手工快照被误当成最新回执。
 */
function loadTaskValidationEvidence(projectRoot: string, taskReference: string): AnalysisValidationEvidence[] {
  return withDocumentRepository(projectRoot, (repository) => {
    const task = repository.getTaskBySlug(taskReference) ?? repository.getTask(taskReference);
    if (task === undefined) {
      throw new Error(`未找到用于语义分析的任务：${taskReference}`);
    }
    return repository.listValidations(task.id).map((validation) => ({
      id: String(validation.id),
      command: validation.command,
      exitCode: validation.exitCode,
      summary: validation.summary,
      acceptanceCriterionIds: validation.acceptanceCriterionIds,
      planItemIds: validation.planItemIds
    }));
  });
}

/** 严格解析唯一 --input 参数，拒绝未知、重复或缺值选项。 */
function parseInputPath(args: string[], usage: string): string {
  if (args.length !== 2 || args[0] !== "--input" || args[1]?.startsWith("--")) {
    throw new Error(`用法：${usage}`);
  }
  return args[1];
}

/** 严格解析成对命名参数，拒绝未知项、缺值和重复项。 */
function parseNamedOptions(
  args: string[],
  allowed: ReadonlySet<string>,
  usage: string
): Record<string, string> {
  if (args.length % 2 !== 0) {
    throw new Error(`用法：${usage}`);
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !allowed.has(key) || value.startsWith("--")) {
      throw new Error(`用法：${usage}`);
    }
    if (options[key] !== undefined) {
      throw new Error(`参数不能重复：${key}`);
    }
    options[key] = value;
  }
  return options;
}

/** 从调用目录解析 JSON 输入；解析错误保留精确路径上下文。 */
async function readJsonFile<T>(inputBasePath: string, inputPath: string): Promise<T> {
  const absolutePath = resolve(inputBasePath, inputPath);
  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`无法读取 JSON 输入文件：${absolutePath}`, { cause: error });
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`JSON 输入文件格式无效：${absolutePath}`, { cause: error });
  }
}

/** JSON 模式输出统一 envelope；人类模式优先展示 Markdown 或诊断摘要。 */
function printRequirementResponse(response: AgentResponse, json: boolean): void {
  if (json) {
    printAgentResponse(response);
    return;
  }

  if (!response.ok) {
    for (const diagnostic of response.diagnostics) {
      console.error(`${diagnostic.code}：${diagnostic.message}`);
    }
    return;
  }

  const data = response.data as Record<string, unknown>;
  if (typeof data.markdown === "string") {
    console.log(data.markdown);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}
