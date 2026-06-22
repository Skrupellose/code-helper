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
export function getTargetsFromExistingEntryFiles(config: CodeHelperConfig): SkillRegistrationTarget[] {
  const targets: SkillRegistrationTarget[] = [];

  if (config.entryFiles.agents) {
    targets.push("codex");
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
    config.entryFiles.agents = agentsExists || targets.includes("codex");
    config.entryFiles.claude = claudeExists || targets.includes("claudecode");
    config.entryFiles.copilot = copilotExists || targets.includes("githubcopilot");
    return;
  }

  config.entryFiles.agents = targets.includes("codex");
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
