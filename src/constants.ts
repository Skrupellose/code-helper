import type { CodeHelperConfig, FeatureKey } from "./types.js";

/**
 * code-helper 自身配置版本。
 * 后续如果配置结构变更，可以用这个数字做迁移判断。
 */
export const CONFIG_VERSION = 1;

/**
 * 所有内置功能的稳定顺序。
 * 菜单展示、配置合并和测试断言都复用这个顺序。
 */
export const FEATURE_KEYS: FeatureKey[] = [
  "memoryTuning",
  "planWorkbench",
  "resultSummary",
  "testingPolicy",
  "documentArchive",
  "completionReview",
  "checks",
  "gitHooks",
  "agentHooks",
  "skillRegistration"
];

/**
 * 功能名称的中文展示文案。
 * 这让 CLI 输出保持稳定，也避免各模块重复写同一份文案。
 */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  memoryTuning: "项目记忆规则优化",
  planWorkbench: "项目计划优化",
  resultSummary: "执行结果总结",
  testingPolicy: "测试策略约束",
  documentArchive: "文档归档",
  completionReview: "功能完成检查",
  checks: "项目规则检查",
  gitHooks: "Git hooks 模板",
  agentHooks: "Agent hooks 模板",
  skillRegistration: "Skills 管理"
};

/**
 * 默认配置。
 * 核心能力默认启用，Git hooks 默认关闭，符合首版“规则 + 检查”的非侵入定位。
 */
export const DEFAULT_CONFIG: CodeHelperConfig = {
  version: CONFIG_VERSION,
  entryFiles: {
    agents: true,
    claude: false
  },
  directories: {
    workspace: ".code-helper",
    userRules: "code-helper-docs/user-rules",
    planDoc: "code-helper-docs/plan-doc",
    resultDoc: "code-helper-docs/result-doc",
    statusDoc: "code-helper-docs/status-doc"
  },
  features: {
    memoryTuning: { enabled: true },
    planWorkbench: { enabled: true },
    resultSummary: { enabled: true },
    testingPolicy: { enabled: true },
    documentArchive: { enabled: true },
    completionReview: { enabled: true },
    checks: { enabled: true },
    gitHooks: { enabled: false },
    agentHooks: { enabled: false },
    skillRegistration: { enabled: true }
  }
};

/**
 * 入口文档中由 code-helper 管理的区块标记。
 * 只更新标记之间的内容，保护用户手写的其他项目规则。
 */
export const ENTRY_BLOCK_START = "<!-- code-helper:start -->";
export const ENTRY_BLOCK_END = "<!-- code-helper:end -->";
