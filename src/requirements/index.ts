import {
  REQUIREMENT_CONTRACT_VERSION,
  type ClarificationQuestion,
  type ClarificationAnswerInput,
  type ClarificationAnswerRecord,
  type RequirementExploration,
  type RequirementExplorationClarificationInput,
  type RequirementExplorationInput,
  type RequirementSpecification,
  type RequirementSpecificationClarificationInput,
  type RequirementSpecificationInput
} from "./types.js";

export * from "./types.js";

/**
 * 从用户原始描述生成需求探索结果。
 *
 * 该函数只使用调用方明确提供的信息，不猜测业务事实；缺失的关键维度会转化为
 * 稳定的待澄清问题，供后续会话逐项回答。
 */
export function createRequirementExploration(
  input: RequirementExplorationInput
): RequirementExploration {
  const rawRequest = input.rawRequest.trim();
  if (rawRequest.length === 0) {
    throw new Error("原始需求不能为空。");
  }

  const goal = input.goal?.trim() ?? "";
  const nonGoals = normalizeTextList(input.nonGoals);
  const users = normalizeTextList(input.users);
  const scenarios = normalizeTextList(input.scenarios);
  const constraints = normalizeTextList(input.constraints);
  const acceptanceCriteria = normalizeTextList(input.acceptanceCriteria);
  const clarificationQuestions = buildClarificationQuestions({
    goal,
    nonGoals,
    users,
    scenarios,
    constraints,
    acceptanceCriteria
  });

  return {
    contractVersion: REQUIREMENT_CONTRACT_VERSION,
    title: input.title?.trim() || deriveTitle(rawRequest),
    rawRequest,
    goal,
    nonGoals,
    users,
    scenarios,
    constraints,
    acceptanceCriteria,
    clarificationQuestions,
    clarificationAnswers: [],
    readyForSpecification: clarificationQuestions.every((question) => !question.blocking)
  };
}

/**
 * 将探索结果转换为需求规格骨架。
 *
 * 调用方可以用已确认答案覆盖探索字段；仍未解决的阻断问题会被保留，避免把
 * 信息不全的规格错误标记为可进入计划阶段。
 */
export function createRequirementSpecification(
  input: RequirementSpecificationInput
): RequirementSpecification {
  const goal = input.goal?.trim() ?? input.exploration.goal;
  const nonGoals = input.nonGoals === undefined
    ? [...input.exploration.nonGoals]
    : normalizeTextList(input.nonGoals);
  const users = input.users === undefined
    ? [...input.exploration.users]
    : normalizeTextList(input.users);
  const scenarios = input.scenarios === undefined
    ? [...input.exploration.scenarios]
    : normalizeTextList(input.scenarios);
  const constraints = input.constraints === undefined
    ? [...input.exploration.constraints]
    : normalizeTextList(input.constraints);
  const acceptanceDescriptions = input.acceptanceCriteria === undefined
    ? [...input.exploration.acceptanceCriteria]
    : normalizeTextList(input.acceptanceCriteria);
  const clarificationAnswers = [...(input.exploration.clarificationAnswers ?? [])];
  const openQuestions = buildClarificationQuestions({
    goal,
    nonGoals,
    users,
    scenarios,
    constraints,
    acceptanceCriteria: acceptanceDescriptions
  }, getResolvedCategories(clarificationAnswers));

  return {
    contractVersion: REQUIREMENT_CONTRACT_VERSION,
    title: input.exploration.title,
    goal,
    nonGoals,
    users,
    scenarios,
    constraints,
    acceptanceCriteria: acceptanceDescriptions.map((description, index) => ({
      id: `AC-${String(index + 1).padStart(3, "0")}`,
      description
    })),
    openQuestions,
    clarificationAnswers,
    readyForPlanning: openQuestions.every((question) => !question.blocking)
  };
}

/**
 * 将一轮或多轮回答合并回探索产物。
 *
 * 每条回答都必须引用当前仍开放的问题；结构化增量会与已有字段合并，问题 ID
 * 由语义类别固定映射，因此部分回答后剩余问题不会重新编号。
 */
export function clarifyRequirementExploration(
  input: RequirementExplorationClarificationInput
): RequirementExploration {
  let current: RequirementExploration = {
    ...input.exploration,
    nonGoals: [...input.exploration.nonGoals],
    users: [...input.exploration.users],
    scenarios: [...input.exploration.scenarios],
    constraints: [...input.exploration.constraints],
    acceptanceCriteria: [...input.exploration.acceptanceCriteria],
    clarificationQuestions: [...input.exploration.clarificationQuestions],
    clarificationAnswers: [...(input.exploration.clarificationAnswers ?? [])]
  };

  for (const answer of input.answers) {
    const question = findOpenQuestion(current.clarificationQuestions, answer);
    const merged = mergeRequirementFields(current, answer);
    const priorAnswers = [...current.clarificationAnswers];
    const provisionalQuestions = buildClarificationQuestions(merged, getResolvedCategories(priorAnswers));
    const answered = isQuestionResolved(question, provisionalQuestions, answer);
    const record = createAnswerRecord(question, answer, answered);
    const clarificationAnswers = [...priorAnswers, record];
    const clarificationQuestions = buildClarificationQuestions(merged, getResolvedCategories(clarificationAnswers));
    current = {
      ...current,
      ...merged,
      clarificationAnswers,
      clarificationQuestions,
      readyForSpecification: clarificationQuestions.every((item) => !item.blocking)
    };
  }

  return current;
}

/**
 * 将回答合并回正式规格，并复用已有验收条件 ID。
 *
 * 新验收条件只会分配尚未使用的下一个 AC 编号，已有描述即使在新一轮回答中
 * 再次出现也继续沿用原 ID。
 */
export function clarifyRequirementSpecification(
  input: RequirementSpecificationClarificationInput
): RequirementSpecification {
  let current: RequirementSpecification = {
    ...input.specification,
    nonGoals: [...input.specification.nonGoals],
    users: [...input.specification.users],
    scenarios: [...input.specification.scenarios],
    constraints: [...input.specification.constraints],
    acceptanceCriteria: input.specification.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    openQuestions: [...input.specification.openQuestions],
    clarificationAnswers: [...(input.specification.clarificationAnswers ?? [])]
  };

  for (const answer of input.answers) {
    const question = findOpenQuestion(current.openQuestions, answer);
    const merged = mergeRequirementFields({
      goal: current.goal,
      nonGoals: current.nonGoals,
      users: current.users,
      scenarios: current.scenarios,
      constraints: current.constraints,
      acceptanceCriteria: current.acceptanceCriteria.map((criterion) => criterion.description)
    }, answer);
    const priorAnswers = [...current.clarificationAnswers];
    const provisionalQuestions = buildClarificationQuestions(merged, getResolvedCategories(priorAnswers));
    const answered = isQuestionResolved(question, provisionalQuestions, answer);
    const record = createAnswerRecord(question, answer, answered);
    const clarificationAnswers = [...priorAnswers, record];
    const openQuestions = buildClarificationQuestions(merged, getResolvedCategories(clarificationAnswers));
    current = {
      ...current,
      goal: merged.goal,
      nonGoals: merged.nonGoals,
      users: merged.users,
      scenarios: merged.scenarios,
      constraints: merged.constraints,
      acceptanceCriteria: mergeAcceptanceCriteria(current.acceptanceCriteria, merged.acceptanceCriteria),
      openQuestions,
      clarificationAnswers,
      readyForPlanning: openQuestions.every((item) => !item.blocking)
    };
  }

  return current;
}

/** 将结构化需求探索结果渲染为稳定的中文 Markdown。 */
export function renderRequirementExplorationMarkdown(
  exploration: RequirementExploration
): string {
  return [
    `# ${exploration.title}：需求探索`,
    "",
    "## 原始需求",
    "",
    exploration.rawRequest,
    "",
    "## 目标",
    "",
    renderText(exploration.goal),
    "",
    "## 非目标",
    "",
    renderList(exploration.nonGoals),
    "",
    "## 用户与场景",
    "",
    renderList([
      ...exploration.users.map((user) => `用户：${user}`),
      ...exploration.scenarios.map((scenario) => `场景：${scenario}`)
    ]),
    "",
    "## 限制",
    "",
    renderList(exploration.constraints),
    "",
    "## 验收条件草案",
    "",
    renderList(exploration.acceptanceCriteria),
    "",
    "## 待澄清问题",
    "",
    renderQuestions(exploration.clarificationQuestions),
    "",
    "## 澄清记录",
    "",
    renderAnswers(exploration.clarificationAnswers),
    "",
    `规格准备状态：${exploration.readyForSpecification ? "可以生成规格" : "需要继续澄清"}`,
    ""
  ].join("\n");
}

/** 将正式需求规格渲染为可审阅的中文 Markdown。 */
export function renderRequirementSpecificationMarkdown(
  specification: RequirementSpecification
): string {
  return [
    `# ${specification.title}：需求规格`,
    "",
    "## 目标",
    "",
    renderText(specification.goal),
    "",
    "## 非目标",
    "",
    renderList(specification.nonGoals),
    "",
    "## 用户与场景",
    "",
    renderList([
      ...specification.users.map((user) => `用户：${user}`),
      ...specification.scenarios.map((scenario) => `场景：${scenario}`)
    ]),
    "",
    "## 限制",
    "",
    renderList(specification.constraints),
    "",
    "## 验收条件",
    "",
    specification.acceptanceCriteria.length === 0
      ? "- 待补充"
      : specification.acceptanceCriteria
        .map((criterion) => `- [${criterion.id}] ${criterion.description}`)
        .join("\n"),
    "",
    "## 未决问题",
    "",
    renderQuestions(specification.openQuestions),
    "",
    "## 澄清记录",
    "",
    renderAnswers(specification.clarificationAnswers),
    "",
    `计划准备状态：${specification.readyForPlanning ? "可以进入计划" : "不能进入计划"}`,
    ""
  ].join("\n");
}

/** 根据缺失维度生成固定顺序和稳定 ID 的澄清问题。 */
function buildClarificationQuestions(input: {
  goal: string;
  nonGoals: readonly string[];
  users: readonly string[];
  scenarios: readonly string[];
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}, resolvedCategories: ReadonlySet<ClarificationQuestion["category"]> = new Set()): ClarificationQuestion[] {
  const candidates: Omit<ClarificationQuestion, "id">[] = [];

  if (input.goal.length === 0 && !resolvedCategories.has("goal")) {
    candidates.push({
      category: "goal",
      question: "这项需求最终要改善什么结果，怎样判断目标已经达成？",
      reason: "目标决定方案边界和优先级。",
      blocking: true
    });
  }
  if ((input.users.length === 0 || input.scenarios.length === 0) && !resolvedCategories.has("user")) {
    candidates.push({
      category: "user",
      question: "谁会在什么场景下使用或受到这项变更影响？",
      reason: "用户和场景决定主流程、异常路径及兼容范围。",
      blocking: true
    });
  }
  if (input.acceptanceCriteria.length === 0 && !resolvedCategories.has("acceptance")) {
    candidates.push({
      category: "acceptance",
      question: "至少需要满足哪些可观察条件，才能验收这项需求？",
      reason: "可验证的验收条件是计划拆分和完成判断的依据。",
      blocking: true
    });
  }
  if (input.nonGoals.length === 0 && !resolvedCategories.has("scope")) {
    candidates.push({
      category: "scope",
      question: "本阶段明确不处理哪些相邻问题或扩展能力？",
      reason: "非目标用于防止方案和实现范围持续扩张。",
      blocking: false
    });
  }
  if (input.constraints.length === 0 && !resolvedCategories.has("constraint")) {
    candidates.push({
      category: "constraint",
      question: "是否存在兼容性、时间、权限、数据、发布或外部依赖限制？",
      reason: "限制可能改变实现顺序、验证方式和风险等级。",
      blocking: false
    });
  }

  const questionIds: Record<ClarificationQuestion["category"], string> = {
    goal: "Q-001",
    user: "Q-002",
    acceptance: "Q-003",
    scope: "Q-004",
    constraint: "Q-005"
  };
  return candidates.map((question) => ({
    id: questionIds[question.category],
    ...question
  }));
}

/** 根据当前开放问题校验回答引用，防止回答静默丢失或误关其他问题。 */
function findOpenQuestion(
  questions: readonly ClarificationQuestion[],
  answer: ClarificationAnswerInput
): ClarificationQuestion {
  const question = questions.find((item) => item.id === answer.questionId);
  if (question === undefined) {
    throw new Error(`澄清问题不存在或已经关闭：${answer.questionId}`);
  }
  if (answer.answer.trim().length === 0 || answer.source.trim().length === 0) {
    throw new Error(`澄清回答和来源不能为空：${answer.questionId}`);
  }
  return question;
}

/** 合并单条回答中的结构化增量，列表字段去重且保留首次出现顺序。 */
function mergeRequirementFields<T extends {
  goal: string;
  nonGoals: readonly string[];
  users: readonly string[];
  scenarios: readonly string[];
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}>(current: T, answer: ClarificationAnswerInput) {
  const updates = answer.updates ?? {};
  return {
    goal: updates.goal === undefined ? current.goal : updates.goal.trim(),
    nonGoals: mergeTextLists(current.nonGoals, updates.nonGoals),
    users: mergeTextLists(current.users, updates.users),
    scenarios: mergeTextLists(current.scenarios, updates.scenarios),
    constraints: mergeTextLists(current.constraints, updates.constraints),
    acceptanceCriteria: mergeTextLists(current.acceptanceCriteria, updates.acceptanceCriteria)
  };
}

/** 判断回答是否已补齐该问题维度；仅非阻断问题允许显式“无内容”关闭。 */
function isQuestionResolved(
  question: ClarificationQuestion,
  remainingQuestions: readonly ClarificationQuestion[],
  answer: ClarificationAnswerInput
): boolean {
  if (!remainingQuestions.some((item) => item.category === question.category)) {
    return true;
  }
  if (answer.resolved === true && !question.blocking) {
    return true;
  }
  return false;
}

/** 创建不可变回答记录，保留问题文本、答案来源和关闭状态。 */
function createAnswerRecord(
  question: ClarificationQuestion,
  answer: ClarificationAnswerInput,
  answered: boolean
): ClarificationAnswerRecord {
  return {
    questionId: question.id,
    category: question.category,
    question: question.question,
    answer: answer.answer.trim(),
    source: answer.source.trim(),
    status: answered ? "answered" : "partial"
  };
}

/** 从历史记录提取已经关闭的问题类别。 */
function getResolvedCategories(
  answers: readonly ClarificationAnswerRecord[]
): Set<ClarificationQuestion["category"]> {
  return new Set(
    answers.filter((answer) => answer.status === "answered").map((answer) => answer.category)
  );
}

/** 合并列表并进行与入口输入一致的空白清理和去重。 */
function mergeTextLists(current: readonly string[], updates: readonly string[] | undefined): string[] {
  return normalizeTextList(updates === undefined ? current : [...current, ...updates]);
}

/** 按描述复用验收 ID，并为真正新增的条件分配单调递增 ID。 */
function mergeAcceptanceCriteria(
  current: readonly RequirementSpecification["acceptanceCriteria"][number][],
  descriptions: readonly string[]
): RequirementSpecification["acceptanceCriteria"] {
  const byDescription = new Map(current.map((criterion) => [criterion.description, criterion]));
  let nextId = current.reduce((maximum, criterion) => {
    const match = /^AC-(\d+)$/u.exec(criterion.id);
    return Math.max(maximum, match === null ? 0 : Number(match[1]));
  }, 0) + 1;
  return descriptions.map((description) => {
    const existing = byDescription.get(description);
    if (existing !== undefined) {
      return { ...existing };
    }
    const criterion = { id: `AC-${String(nextId).padStart(3, "0")}`, description };
    nextId += 1;
    return criterion;
  });
}

/** 清理空白和重复项，同时保留调用方输入顺序。 */
function normalizeTextList(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }

  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** 从原始需求首行生成短标题，避免空标题或过长 Markdown 标题。 */
function deriveTitle(rawRequest: string): string {
  const firstLine = rawRequest.split(/\r?\n/u, 1)[0].replace(/^#+\s*/u, "").trim();
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 40)}…`;
}

/** 渲染单段文本的空值占位。 */
function renderText(value: string): string {
  return value.length > 0 ? value : "待澄清";
}

/** 渲染 Markdown 无序列表。 */
function renderList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- 待澄清";
}

/** 渲染待澄清问题，并保留稳定问题 ID 和阻断属性。 */
function renderQuestions(questions: readonly ClarificationQuestion[]): string {
  if (questions.length === 0) {
    return "- 无";
  }

  return questions
    .map((question) => `- [${question.id}] ${question.question}（${question.blocking ? "阻断" : "非阻断"}）`)
    .join("\n");
}

/** 渲染回答审计记录，明确区分部分回答与已关闭回答。 */
function renderAnswers(answers: readonly ClarificationAnswerRecord[]): string {
  if (answers.length === 0) {
    return "- 无";
  }
  return answers
    .map((answer) => `- [${answer.questionId}] ${answer.answer}（${answer.source}；${answer.status === "answered" ? "已关闭" : "部分回答"}）`)
    .join("\n");
}
