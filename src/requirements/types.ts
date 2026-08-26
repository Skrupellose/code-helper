/** 需求探索文档的当前数据契约版本。 */
export const REQUIREMENT_CONTRACT_VERSION = 1 as const;

/** 一条待澄清问题，稳定 ID 便于跨会话引用和关闭。 */
export interface ClarificationQuestion {
  /** 稳定问题 ID，例如 Q-001。 */
  id: string;
  /** 问题所属维度，用于组织回答顺序。 */
  category: "goal" | "scope" | "user" | "acceptance" | "constraint";
  /** 面向需求提出者的自然中文问题。 */
  question: string;
  /** 为什么该问题会影响计划或实现。 */
  reason: string;
  /** 该问题是否会阻止规格进入计划阶段。 */
  blocking: boolean;
}

/** 一次澄清回答对结构化需求字段产生的增量更新。 */
export interface RequirementClarificationPatch {
  /** 新确认的目标；提供时替换原目标。 */
  goal?: string;
  /** 新确认的非目标；提供时与已有非目标合并。 */
  nonGoals?: readonly string[];
  /** 新确认的用户；提供时与已有用户合并。 */
  users?: readonly string[];
  /** 新确认的场景；提供时与已有场景合并。 */
  scenarios?: readonly string[];
  /** 新确认的限制；提供时与已有限制合并。 */
  constraints?: readonly string[];
  /** 新确认的验收条件；提供时与已有验收条件合并。 */
  acceptanceCriteria?: readonly string[];
}

/** 调用方提交的一条澄清回答。 */
export interface ClarificationAnswerInput {
  /** 当前开放问题的稳定 ID。 */
  questionId: string;
  /** 用户或外部来源给出的原始答案，不由工具改写。 */
  answer: string;
  /** 答案来源，例如 user、product-owner 或 imported-document。 */
  source: string;
  /** 从答案中明确提取出的结构化字段增量。 */
  updates?: RequirementClarificationPatch;
  /** 非阻断问题可用该标记表达“无此类内容”，并显式关闭问题。 */
  resolved?: boolean;
}

/** 已处理回答的可追踪记录。 */
export interface ClarificationAnswerRecord {
  /** 被回答问题的稳定 ID。 */
  questionId: string;
  /** 被回答问题所属维度。 */
  category: ClarificationQuestion["category"];
  /** 回答发生时的问题文本，避免后续模板变化导致审计信息丢失。 */
  question: string;
  /** 调用方提供的原始答案。 */
  answer: string;
  /** 调用方提供的答案来源。 */
  source: string;
  /** 回答是否已关闭问题；partial 表示仍缺少该维度的必要信息。 */
  status: "partial" | "answered";
}

/** 从模糊需求生成探索文档时允许提供的已知信息。 */
export interface RequirementExplorationInput {
  /** 用户原始需求，不在生成过程中改写或丢失。 */
  rawRequest: string;
  /** 可选标题；省略时从原始需求生成简短标题。 */
  title?: string;
  /** 已明确的目标。 */
  goal?: string;
  /** 已明确不在本次处理范围内的事项。 */
  nonGoals?: readonly string[];
  /** 已知用户或使用者。 */
  users?: readonly string[];
  /** 已知使用场景。 */
  scenarios?: readonly string[];
  /** 已知限制，例如兼容性、时间、权限或数据边界。 */
  constraints?: readonly string[];
  /** 已明确的验收条件。 */
  acceptanceCriteria?: readonly string[];
}

/** 需求探索的结构化结果，可渲染为中文 Markdown。 */
export interface RequirementExploration {
  /** 数据契约版本。 */
  contractVersion: typeof REQUIREMENT_CONTRACT_VERSION;
  /** 需求标题。 */
  title: string;
  /** 用户原始需求。 */
  rawRequest: string;
  /** 当前能确认的目标；未知时保留空字符串而不虚构。 */
  goal: string;
  /** 明确的非目标。 */
  nonGoals: string[];
  /** 目标用户或使用者。 */
  users: string[];
  /** 使用场景。 */
  scenarios: string[];
  /** 实施限制。 */
  constraints: string[];
  /** 当前验收条件草案。 */
  acceptanceCriteria: string[];
  /** 进入正式规格前需要回答的问题。 */
  clarificationQuestions: ClarificationQuestion[];
  /** 按处理顺序保留的澄清回答，包含部分回答和已关闭回答。 */
  clarificationAnswers: ClarificationAnswerRecord[];
  /** 是否已经具备生成可执行规格的最小信息。 */
  readyForSpecification: boolean;
}

/** 正式需求规格中的验收条件。 */
export interface AcceptanceCriterion {
  /** 稳定验收 ID，例如 AC-001。 */
  id: string;
  /** 可观察、可验证的验收描述。 */
  description: string;
}

/** 由探索结果生成规格骨架时允许补充的字段。 */
export interface RequirementSpecificationInput {
  /** 已确认的探索结果。 */
  exploration: RequirementExploration;
  /** 对探索阶段目标的最终修订。 */
  goal?: string;
  /** 对探索阶段非目标的最终修订。 */
  nonGoals?: readonly string[];
  /** 对探索阶段目标用户或使用者的最终修订。 */
  users?: readonly string[];
  /** 对探索阶段场景的最终修订。 */
  scenarios?: readonly string[];
  /** 对探索阶段限制的最终修订。 */
  constraints?: readonly string[];
  /** 对探索阶段验收条件的最终修订。 */
  acceptanceCriteria?: readonly string[];
}

/** 可被计划和语义分析引用的正式需求规格。 */
export interface RequirementSpecification {
  /** 数据契约版本。 */
  contractVersion: typeof REQUIREMENT_CONTRACT_VERSION;
  /** 规格标题。 */
  title: string;
  /** 要解决的问题和预期结果。 */
  goal: string;
  /** 明确排除的范围。 */
  nonGoals: string[];
  /** 已确认的目标用户或使用者。 */
  users: string[];
  /** 用户场景。 */
  scenarios: string[];
  /** 技术、业务和交付限制。 */
  constraints: string[];
  /** 带稳定 ID 的验收条件。 */
  acceptanceCriteria: AcceptanceCriterion[];
  /** 尚未关闭的问题；存在阻断问题时规格不能视为可执行。 */
  openQuestions: ClarificationQuestion[];
  /** 从探索阶段继承并在规格阶段继续追加的澄清回答。 */
  clarificationAnswers: ClarificationAnswerRecord[];
  /** 规格是否具备进入计划阶段的最小条件。 */
  readyForPlanning: boolean;
}

/** 对探索产物继续提交回答时的输入。 */
export interface RequirementExplorationClarificationInput {
  /** 上一轮探索产物。 */
  exploration: RequirementExploration;
  /** 本轮按顺序处理的回答。 */
  answers: readonly ClarificationAnswerInput[];
}

/** 对规格产物继续提交回答时的输入。 */
export interface RequirementSpecificationClarificationInput {
  /** 上一轮规格产物。 */
  specification: RequirementSpecification;
  /** 本轮按顺序处理的回答。 */
  answers: readonly ClarificationAnswerInput[];
}

/** CLI clarify/answer 动作接受的探索或规格澄清输入。 */
export type RequirementClarificationInput =
  | RequirementExplorationClarificationInput
  | RequirementSpecificationClarificationInput;
