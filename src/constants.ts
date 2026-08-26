import type { CodeHelperConfig, FeatureKey, SkillModule, SkillProfile } from "./types.js";

/**
 * code-helper 自身配置版本。
 * 后续如果配置结构变更，可以用这个数字做迁移判断。
 */
export const CONFIG_VERSION = 2;

/** Skills 模块使用稳定顺序，配置序列化和 CLI 展示均复用该顺序。 */
export const SKILL_MODULES: readonly SkillModule[] = ["core", "quality", "collaboration", "memory"];

/** 内置 profile 使用稳定顺序，避免帮助和配置输出随对象遍历变化。 */
export const SKILL_PROFILES: readonly SkillProfile[] = ["full", "delivery", "essential"];

/** 内置 profile 到模块集合的确定性映射。 */
export const SKILL_PROFILE_MODULES: Readonly<Record<SkillProfile, readonly SkillModule[]>> = {
  full: SKILL_MODULES,
  delivery: ["core", "quality", "collaboration"],
  essential: ["core", "collaboration"]
};

/**
 * 直接执行任务的终态完成记录目录。
 * 该目录不属于 plan/status/result 工作台，也不参与任务发现与归档生命周期。
 */
export const COMPLETION_RECORD_DIRECTORY = ".code-helper/local/docs/completion-record";

/**
 * 旧版 Markdown 目录只作为迁移和兼容读取来源。
 * 新任务不会再向这些目录写入，需交接或审计时由 `documents export --tracked` 显式生成。
 */
export const LEGACY_DOCUMENTS_DIRECTORY = "code-helper-docs";

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
  memoryTuning: "规则记忆维护",
  planWorkbench: "生成任务计划模板",
  resultSummary: "执行结果总结",
  testingPolicy: "测试策略约束",
  documentArchive: "归档已完成任务",
  completionReview: "检查功能完成情况",
  checks: "检查协作规范",
  gitHooks: "Git hook",
  agentHooks: "Agent hooks",
  skillRegistration: "管理项目 Skills"
};

/**
 * 默认配置。
 * 核心能力默认启用，Git hooks 默认关闭，符合首版“规则 + 检查”的非侵入定位。
 */
export const DEFAULT_CONFIG: CodeHelperConfig = {
  version: CONFIG_VERSION,
  entryFiles: {
    agents: true,
    claude: false,
    copilot: false
  },
  directories: {
    workspace: ".code-helper",
    userRules: "code-helper-docs/user-rules",
    planDoc: ".code-helper/local/docs/plan-doc",
    resultDoc: ".code-helper/local/docs/result-doc",
    statusDoc: ".code-helper/local/docs/status-doc"
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
  },
  // 缺少 Skills 配置的旧项目会迁移到 full，保持历史上的全量注册行为。
  skills: { mode: "profile", profile: "full" }
};

/**
 * 入口文档中由 code-helper 管理的区块标记。
 * 只更新标记之间的内容，保护用户手写的其他项目规则。
 */
export const ENTRY_BLOCK_START = "<!-- code-helper:start -->";
export const ENTRY_BLOCK_END = "<!-- code-helper:end -->";
