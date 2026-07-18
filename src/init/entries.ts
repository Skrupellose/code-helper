import { projectPath, readTextIfExists, upsertManagedMarkdownBlock } from "../fs-utils.js";
import type { SkillRegistrationTarget } from "../skills.js";
import { renderEntryBlock } from "../templates.js";
import type { CodeHelperConfig, OperationResult } from "../types.js";

/**
 * update 只维护当前真实存在的入口文件。
 * 这避免默认配置中的 AGENTS.md 开关在空目录里创建新的 agent 入口。
 */
export async function applyExistingEntryFiles(projectRoot: string, config: CodeHelperConfig): Promise<void> {
  config.entryFiles.agents = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  config.entryFiles.claude = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;
  config.entryFiles.copilot =
    (await readTextIfExists(projectPath(projectRoot, ".github/copilot-instructions.md"))) !== undefined;
}

/**
 * 根据当前真实存在的入口文件推断 agent 目标。
 */
export function getTargetsFromExistingEntryFiles(
  config: CodeHelperConfig,
  knownTargets: SkillRegistrationTarget[] = []
): SkillRegistrationTarget[] {
  const targets: SkillRegistrationTarget[] = [];

  if (config.entryFiles.agents) {
    // AGENTS.md 是 Codex 与 Grok Build 的共享入口。已有受控注册时延续其真实目标，
    // 避免 Grok-only 项目在 update 时被静默扩展为 Codex；无历史状态的旧项目仍保持 Codex 默认。
    const knownSharedEntryTargets = knownTargets.filter(
      (target): target is "codex" | "grok" => target === "codex" || target === "grok"
    );
    targets.push(...(knownSharedEntryTargets.length > 0 ? knownSharedEntryTargets : ["codex" as const]));
  }

  if (config.entryFiles.claude) {
    targets.push("claudecode");
  }

  if (config.entryFiles.copilot) {
    targets.push("githubcopilot");
  }

  return targets;
}

/**
 * 使用已有受控注册消解初始化推断中 AGENTS.md 的 Codex / Grok Build 歧义。
 * 只收窄共享入口的两个目标，不改变 Claude Code 和 GitHub Copilot 的独立推断。
 */
export function disambiguateSharedAgentsTargets(
  inferredTargets: SkillRegistrationTarget[],
  knownTargets: SkillRegistrationTarget[]
): SkillRegistrationTarget[] {
  const knownSharedEntryTargets = knownTargets.filter(
    (target): target is "codex" | "grok" => target === "codex" || target === "grok"
  );
  const isKnownGrokOnly = knownSharedEntryTargets.includes("grok") && !knownSharedEntryTargets.includes("codex");

  if (!isKnownGrokOnly) {
    return [...inferredTargets];
  }

  // Grok-only 受控状态证明 AGENTS.md 归属 Grok，只移除由共享入口带来的 Codex 猜测。
  return inferredTargets.filter((target) => target !== "codex");
}

/**
 * 安装或更新各 agent 工具的入口记忆文档。
 * 已存在文档只替换 code-helper 管理区块，不触碰用户其他内容。
 */
export async function installEntryDocuments(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];
  const entryBlock = renderEntryBlock(config);

  if (config.entryFiles.agents) {
    operations.push(await upsertManagedMarkdownBlock(projectPath(projectRoot, "AGENTS.md"), entryBlock));
  }

  if (config.entryFiles.claude) {
    operations.push(await upsertManagedMarkdownBlock(projectPath(projectRoot, "CLAUDE.md"), entryBlock));
  }

  if (config.entryFiles.copilot) {
    operations.push(await upsertManagedMarkdownBlock(projectPath(projectRoot, ".github/copilot-instructions.md"), entryBlock));
  }

  return operations;
}

/**
 * 检测用户已经手动创建的入口文件，并按 init 目标补齐需要维护的入口。
 * 完全没有入口文件且没有选择目标时，不创建 agent 入口，避免后续 init 误判项目工具。
 */
export async function detectEntryFiles(
  projectRoot: string,
  config: CodeHelperConfig,
  targets: SkillRegistrationTarget[]
): Promise<void> {
  const agentsExists = (await readTextIfExists(projectPath(projectRoot, "AGENTS.md"))) !== undefined;
  const claudeExists = (await readTextIfExists(projectPath(projectRoot, "CLAUDE.md"))) !== undefined;
  const copilotExists = (await readTextIfExists(projectPath(projectRoot, ".github/copilot-instructions.md"))) !== undefined;

  if (agentsExists || claudeExists || copilotExists) {
    // Grok Build 与 Codex 共用 AGENTS.md 入口；目标状态仍由各自 Skills 目录独立记录。
    config.entryFiles.agents = agentsExists || targets.includes("codex") || targets.includes("grok");
    config.entryFiles.claude = claudeExists || targets.includes("claudecode");
    config.entryFiles.copilot = copilotExists || targets.includes("githubcopilot");
    return;
  }

  config.entryFiles.agents = targets.includes("codex") || targets.includes("grok");
  config.entryFiles.claude = targets.includes("claudecode");
  config.entryFiles.copilot = targets.includes("githubcopilot");
}

/**
 * 渲染专题规则中的调用入口文件列表。
 * 该段会在 init 时同步到已有规则文件，确保手动新增 CLAUDE.md 后规则入口也一致。
 */
export function renderEntryFileList(config: CodeHelperConfig): string {
  const entries = [
    config.entryFiles.agents ? "- `AGENTS.md`" : undefined,
    config.entryFiles.claude ? "- `CLAUDE.md`" : undefined,
    config.entryFiles.copilot ? "- `.github/copilot-instructions.md`" : undefined
  ].filter((entry): entry is string => entry !== undefined);

  return entries.join("\n");
}
