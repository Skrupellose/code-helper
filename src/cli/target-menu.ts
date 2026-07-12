import { stdin as input, stdout as output } from "node:process";

import type { HookInstallTarget } from "../hooks.js";
import {
  formatSkillRegistrationTargetName,
  listSupportedSkillRegistrationTargets,
  parseSkillRegistrationTargets,
  resolveSkillRegistrationTargets,
  type SkillRegistrationTarget
} from "../skills.js";
import { canUseInteractiveKeys, promptSelect, TerminalCancelError } from "../terminal-ui.js";
import { askQuestionOrDefault, type MenuReadline } from "./menu-input.js";

/**
 * 功能管理菜单中的目标选择结果。
 * shouldDisableFeatureAfterRemove 用于保留现有命令语义：按当前项目或全部取消时，同步关闭后续自动应用能力。
 */
export interface MenuTargetSelection<TTarget extends string> {
  targets: TTarget[];
  shouldDisableFeatureAfterRemove: boolean;
}

/**
 * 选择 Skills 应用或取消的 agent 工具目标。
 * 优先提供“按当前项目”默认项；用户也可以显式选择单个 agent 或全部 agent。
 */
export async function selectSkillTargetsForMenu(
  projectRoot: string,
  rl: MenuReadline,
  title: string
): Promise<MenuTargetSelection<SkillRegistrationTarget> | undefined> {
  const inferredTargets = await resolveSkillRegistrationTargets(projectRoot);
  const useKeyMenu = canUseInteractiveKeys(input, output);

  if (useKeyMenu) {
    try {
      const answer = await promptSelect(input, output, title, buildSkillTargetSelectOptions(inferredTargets));
      return resolveSkillTargetMenuAnswer(answer, inferredTargets);
    } catch (error) {
      // Esc 取消目标选择，返回上级菜单
      if (error instanceof TerminalCancelError) {
        return undefined;
      }
      throw error;
    }
  }

  const answer = await askTextSkillTargetMenu(rl, title, inferredTargets);
  return resolveSkillTargetMenuAnswer(answer.trim(), inferredTargets);
}

/**
 * 选择 Agent hooks 应用或取消的 agent 工具目标。
 * GitHub Copilot 没有可安装的 Agent hook，因此只把 Codex 和 Claude Code 列为可选项。
 */
export async function selectAgentHookTargetsForMenu(
  projectRoot: string,
  rl: MenuReadline,
  title: string
): Promise<MenuTargetSelection<Exclude<HookInstallTarget, "git">> | undefined> {
  const inferredSkillTargets = await resolveSkillRegistrationTargets(projectRoot);
  const inferredHookTargets = toAgentHookTargets(inferredSkillTargets);

  if (inferredSkillTargets.length > 0 && inferredHookTargets.length === 0) {
    console.log("当前项目只识别到 GitHub Copilot；GitHub Copilot 不支持 Agent hook，请选择 Codex 或 Claude Code。");
  }

  if (canUseInteractiveKeys(input, output)) {
    try {
      const answer = await promptSelect(input, output, title, buildAgentHookTargetSelectOptions(inferredSkillTargets));
      return resolveAgentHookTargetMenuAnswer(answer, inferredSkillTargets);
    } catch (error) {
      // Esc 取消目标选择，返回上级菜单
      if (error instanceof TerminalCancelError) {
        return undefined;
      }
      throw error;
    }
  }

  const answer = await askTextAgentHookTargetMenu(rl, title, inferredSkillTargets);
  return resolveAgentHookTargetMenuAnswer(answer.trim(), inferredSkillTargets);
}

/**
 * 解析功能管理中 Skills 目标文本。
 * 该函数导出给单元测试使用，确保非 raw mode 菜单和 raw mode 菜单使用同一套目标规则。
 */
export function parseSkillTargetMenuSelection(
  value: string,
  inferredTargets: SkillRegistrationTarget[] = []
): SkillRegistrationTarget[] {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "" || normalizedValue === "0") {
    return [];
  }

  if (normalizedValue === "d" || normalizedValue === "default" || normalizedValue === "current") {
    return [...inferredTargets];
  }

  const targets = new Set<SkillRegistrationTarget>();
  const tokens = normalizedValue.split(/[,\s]+/u).filter(Boolean);

  for (const token of tokens) {
    if (token === "a" || token === "all") {
      return listSupportedSkillRegistrationTargets();
    }

    if (token === "1") {
      targets.add("codex");
      continue;
    }

    if (token === "2") {
      targets.add("claudecode");
      continue;
    }

    if (token === "3") {
      targets.add("githubcopilot");
      continue;
    }

    for (const target of parseSkillRegistrationTargets(token)) {
      targets.add(target);
    }
  }

  return [...targets];
}

/**
 * 解析功能管理中 Agent hook 目标文本。
 * GitHub Copilot 没有 Agent hook 安装位置，因此输入相关别名时直接给出清晰错误。
 */
export function parseAgentHookTargetMenuSelection(
  value: string,
  inferredSkillTargets: SkillRegistrationTarget[] = []
): Array<Exclude<HookInstallTarget, "git">> {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "" || normalizedValue === "0") {
    return [];
  }

  if (normalizedValue === "d" || normalizedValue === "default" || normalizedValue === "current") {
    return toAgentHookTargets(inferredSkillTargets);
  }

  const targets = new Set<Exclude<HookInstallTarget, "git">>();
  const tokens = normalizedValue.split(/[,\s]+/u).filter(Boolean);

  for (const token of tokens) {
    if (token === "a" || token === "all" || token === "agent" || token === "agents") {
      return ["codex", "claudecode"];
    }

    if (token === "1" || token === "codex") {
      targets.add("codex");
      continue;
    }

    if (token === "2" || token === "claudecode" || token === "claude-code" || token === "claude") {
      targets.add("claudecode");
      continue;
    }

    if (token === "3" || token === "githubcopilot" || token === "github-copilot" || token === "copilot" || token === "github") {
      throw new Error("GitHub Copilot 不支持 Agent hook，请选择 Codex、Claude Code 或全部可用 Agent hooks。");
    }

    throw new Error(`不支持的 Agent hook 目标：${token}。当前支持 codex、claudecode 或 all。`);
  }

  return [...targets];
}

/**
 * 格式化 Skills 目标列表，用于菜单动作回显。
 */
export function formatTargetList(targets: SkillRegistrationTarget[]): string {
  return targets.map((target) => formatSkillRegistrationTargetName(target)).join("、");
}

/**
 * 格式化 Agent hook 目标列表，用于菜单动作回显。
 */
export function formatAgentHookTargetList(targets: Array<Exclude<HookInstallTarget, "git">>): string {
  return targets.map((target) => target === "codex" ? "Codex" : "Claude Code").join("、");
}

/**
 * raw mode 菜单中的 Skills 目标选项。
 * 默认项放在第一位，让已能识别 agent 工具的项目可以直接回车确认。
 */
function buildSkillTargetSelectOptions(
  inferredTargets: SkillRegistrationTarget[]
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];

  if (inferredTargets.length > 0) {
    options.push({
      value: "default",
      label: `按当前项目（${formatTargetList(inferredTargets)}）`
    });
  }

  options.push(
    { value: "codex", label: "Codex" },
    { value: "claudecode", label: "Claude Code" },
    { value: "githubcopilot", label: "GitHub Copilot" },
    { value: "all", label: "全部" },
    { value: "0", label: "返回" }
  );

  return options;
}

/**
 * raw mode 菜单中的 Agent hook 目标选项。
 * 默认项只包含支持 Agent hook 的目标，自动忽略 GitHub Copilot。
 */
function buildAgentHookTargetSelectOptions(
  inferredSkillTargets: SkillRegistrationTarget[]
): Array<{ value: string; label: string }> {
  const inferredHookTargets = toAgentHookTargets(inferredSkillTargets);
  const options: Array<{ value: string; label: string }> = [];

  if (inferredHookTargets.length > 0) {
    options.push({
      value: "default",
      label: `按当前项目（${formatAgentHookTargetList(inferredHookTargets)}）`
    });
  }

  options.push(
    { value: "codex", label: "Codex" },
    { value: "claudecode", label: "Claude Code" },
    { value: "all", label: "全部可用 Agent hooks" },
    { value: "0", label: "返回" }
  );

  return options;
}

/**
 * 非 raw mode 终端中的 Skills 目标菜单。
 * 除数字外也支持输入 codex、claudecode、githubcopilot、all 和 default。
 */
async function askTextSkillTargetMenu(
  rl: MenuReadline,
  title: string,
  inferredTargets: SkillRegistrationTarget[]
): Promise<string> {
  console.log(`\n${title}`);
  if (inferredTargets.length > 0) {
    console.log(`D. 按当前项目（${formatTargetList(inferredTargets)}）`);
  }
  console.log("1. Codex");
  console.log("2. Claude Code");
  console.log("3. GitHub Copilot");
  console.log("A. 全部");
  console.log("0. 返回");
  console.log("可输入编号或名称，例如：1、codex、githubcopilot、all。");

  return askQuestionOrDefault(rl, "请选择 agent 工具：", "0");
}

/**
 * 非 raw mode 终端中的 Agent hook 目标菜单。
 * 菜单不列出 GitHub Copilot，避免用户误以为它支持 Agent hook。
 */
async function askTextAgentHookTargetMenu(
  rl: MenuReadline,
  title: string,
  inferredSkillTargets: SkillRegistrationTarget[]
): Promise<string> {
  const inferredHookTargets = toAgentHookTargets(inferredSkillTargets);

  console.log(`\n${title}`);
  if (inferredHookTargets.length > 0) {
    console.log(`D. 按当前项目（${formatAgentHookTargetList(inferredHookTargets)}）`);
  }
  console.log("1. Codex");
  console.log("2. Claude Code");
  console.log("A. 全部可用 Agent hooks");
  console.log("0. 返回");
  console.log("GitHub Copilot 不支持 Agent hook，因此不在这里安装或取消。");
  console.log("可输入编号或名称，例如：1、codex、claudecode、all。");

  return askQuestionOrDefault(rl, "请选择 agent 工具：", "0");
}

/**
 * 把 Skills 菜单答案解析成目标列表。
 * 返回 undefined 表示用户返回；抛错表示输入了不支持的目标。
 */
function resolveSkillTargetMenuAnswer(
  answer: string,
  inferredTargets: SkillRegistrationTarget[]
): MenuTargetSelection<SkillRegistrationTarget> | undefined {
  const targets = parseSkillTargetMenuSelection(answer, inferredTargets);

  if (targets.length === 0) {
    return undefined;
  }

  return {
    targets,
    shouldDisableFeatureAfterRemove: isDefaultOrAllTargetAnswer(answer)
  };
}

/**
 * 把 Agent hook 菜单答案解析成目标列表。
 * 返回 undefined 表示用户返回或输入非法；非法输入只提示，不抛错打断菜单会话。
 * 解析函数 parseAgentHookTargetMenuSelection 仍可对非法 token 抛错（供 CLI 子命令语义与单测），
 * 文本菜单路径在此捕获后转为 undefined。
 */
function resolveAgentHookTargetMenuAnswer(
  answer: string,
  inferredSkillTargets: SkillRegistrationTarget[]
): MenuTargetSelection<Exclude<HookInstallTarget, "git">> | undefined {
  try {
    const targets = parseAgentHookTargetMenuSelection(answer, inferredSkillTargets);

    if (targets.length === 0) {
      return undefined;
    }

    return {
      targets,
      shouldDisableFeatureAfterRemove: isDefaultOrAllTargetAnswer(answer)
    };
  } catch (error) {
    // 文本路径输入了 GitHub Copilot 或不支持目标时，打印原因并当作取消
    console.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * 从 Skills 目标中过滤出支持 Agent hook 的目标。
 * GitHub Copilot 只支持项目级 Skills，不映射到任何 hook。
 */
function toAgentHookTargets(
  targets: SkillRegistrationTarget[]
): Array<Exclude<HookInstallTarget, "git">> {
  return targets.filter((target): target is Exclude<HookInstallTarget, "git"> =>
    target === "codex" || target === "claudecode"
  );
}

/**
 * 判断菜单答案是否代表“按当前项目”或“全部”。
 * 这些范围取消后会同步关闭对应功能开关，保持原有菜单行为。
 */
function isDefaultOrAllTargetAnswer(answer: string): boolean {
  const normalizedAnswer = answer.trim().toLowerCase();
  return normalizedAnswer === "default"
    || normalizedAnswer === "d"
    || normalizedAnswer === "current"
    || normalizedAnswer === "all"
    || normalizedAnswer === "a";
}
