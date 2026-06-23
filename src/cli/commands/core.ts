import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runChecks } from "../../checks.js";
import { loadConfig, setFeatureEnabled } from "../../config.js";
import { FEATURE_KEYS, FEATURE_LABELS } from "../../constants.js";
import { installCodeHelperNpmScripts, initializeProject, updateProject } from "../../init.js";
import {
  formatSkillRegistrationTargetName,
  listProjectSkillRegistrations,
  listSupportedSkillRegistrationTargets,
  parseSkillRegistrationTargets,
  registerProjectSkills,
  resolveSkillRegistrationTargets,
  type SkillRegistrationTarget
} from "../../skills.js";
import { canUseInteractiveKeys, promptMultiSelect } from "../../terminal-ui.js";
import type { FeatureKey } from "../../types.js";
import {
  compareVersions,
  fetchLatestPackageVersion,
  getCurrentPackageVersion
} from "../../version-check.js";
import { printFeatureHelp } from "../help.js";
import { askQuestionOrDefault } from "../menu-input.js";
import { printOperations, printSkillRegistrationStatus } from "../output.js";

type InitTargetPromptResolution =
  | { action: "select"; targets: SkillRegistrationTarget[] }
  | { action: "retry"; targets: [] }
  | { action: "cancel"; targets: [] };

const INIT_TARGET_TEXT_MENU_CLOSED = "__code_helper_init_target_text_menu_closed__";

/**
 * 初始化命令实现。
 * 输出所有操作结果，便于用户看清哪些文件被创建、更新或跳过。
 */
export async function runInit(projectRoot: string, args: string[] = []): Promise<number> {
  if (args.length > 1) {
    console.error("init 只接受一个可选 agent 目标。用法：code-helper init [all|codex|claudecode|githubcopilot]");
    return 1;
  }

  const skillRegistrationTargets = args[0] === undefined
    ? await resolveInitSkillRegistrationTargets(projectRoot)
    : parseSkillRegistrationTargets(args[0]);
  const result = await initializeProject({ projectRoot, skillRegistrationTargets });
  printOperations(result.operations);
  return 0;
}

/**
 * 更新当前项目中已经使用的 code-helper 受控资产。
 * update 不自动开启未启用能力，适合发新版后同步入口、skills 和 hooks。
 */
export async function runUpdate(projectRoot: string, args: string[] = []): Promise<number> {
  if (args.length > 0) {
    console.error("update 暂不接受参数。用法：code-helper update");
    return 1;
  }

  const result = await updateProject(projectRoot);
  printOperations(result.operations);
  return 0;
}

/**
 * 输出当前 code-helper 版本。
 * npm latest 查询是附加信息，失败或被测试/CI 环境跳过时不影响命令退出码。
 */
export async function runVersion(args: string[] = []): Promise<number> {
  if (args.length > 0) {
    console.error("version 不接受参数。用法：code-helper version");
    return 1;
  }

  const currentVersion = await getCurrentPackageVersion();
  console.log(`code-helper ${currentVersion}`);

  if (shouldSkipVersionCommandLatestLookup(process.env)) {
    return 0;
  }

  try {
    const latestVersion = await fetchLatestPackageVersion();
    console.log(`npm latest ${latestVersion}`);

    for (const line of formatVersionCommandUpdateHint(currentVersion, latestVersion)) {
      console.log(line);
    }
  } catch {
    // version 命令的 registry 查询只提供参考信息，离线或代理异常时仍应成功输出当前版本。
  }

  return 0;
}

/**
 * 解析 npm-scripts 子命令。
 * 当前只支持 install，后续若增加 list/remove 可以继续在这里扩展。
 */
export async function runNpmScripts(projectRoot: string, args: string[] = []): Promise<number> {
  const [action, ...rest] = args;

  if (action !== "install" || rest.length > 0) {
    console.error("npm-scripts 只支持 install。用法：code-helper npm-scripts install");
    return 1;
  }

  try {
    const operations = await installCodeHelperNpmScripts(projectRoot);
    printOperations(operations);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * 本仓库开发后的本地刷新命令。
 * 它先用空目标刷新受控入口、规则模板和 `.code-helper/skills`，避免顺带创建其他 agent 入口或安装 hooks；
 * 再显式注册全部项目级 skills，保持 Codex、Claude Code 和 GitHub Copilot 看到的 skill 内容一致。
 */
export async function runSyncLocal(projectRoot: string, args: string[] = []): Promise<number> {
  if (args.length > 0) {
    console.error("sync-local 不接受参数。用法：code-helper sync-local");
    return 1;
  }

  const initializeResult = await initializeProject({ projectRoot, skillRegistrationTargets: [] });
  await setFeatureEnabled(projectRoot, "skillRegistration", true);

  const targets = listSupportedSkillRegistrationTargets();
  const skillOperations = (await Promise.all(targets.map((target) => registerProjectSkills(projectRoot, target)))).flat();
  const statuses = (await Promise.all(targets.map((target) => listProjectSkillRegistrations(projectRoot, target)))).flat();
  const initializeOperations = initializeResult.operations.filter((operation) =>
    !operation.message.includes("已跳过项目级 skills 注册")
    && !operation.message.includes("已跳过 Agent hooks 安装")
  );

  printOperations([...initializeOperations, ...skillOperations]);
  printSkillRegistrationStatus(statuses);
  return 0;
}

/**
 * 检查命令实现。
 * 存在 error 时返回 1，方便 CI 或 hook 使用。
 */
export async function runCheck(projectRoot: string, args: string[] = []): Promise<number> {
  const issues = await runChecks(projectRoot, { writeReport: args.includes("--write-report") });

  if (issues.length === 0) {
    console.log("code-helper check 通过：未发现协作文档结构问题。");
    return 0;
  }

  for (const issue of issues) {
    console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
    if (issue.path) {
      console.log(`  路径：${issue.path}`);
    }
    console.log(`  建议：${issue.suggestion}`);
  }

  return issues.some((issue) => issue.level === "error") ? 1 : 0;
}

/**
 * 非交互功能开关命令。
 * 支持：features list、features enable <key>、features disable <key>。
 */
export async function runFeatures(projectRoot: string, args: string[]): Promise<number> {
  const [action, feature] = args;

  if (action === undefined || action === "list") {
    printFeatureList(await loadConfig(projectRoot));
    return 0;
  }

  if (!isFeatureKey(feature)) {
    console.error(`无效功能 key：${feature ?? ""}`);
    printFeatureHelp();
    return 1;
  }

  if (action === "enable" || action === "disable") {
    const config = await setFeatureEnabled(projectRoot, feature, action === "enable");
    printFeatureList(config);
    return 0;
  }

  printFeatureHelp();
  return 1;
}

/**
 * version 命令在测试、CI 或用户显式禁用版本检查时不访问网络。
 * 这条规则只影响 latest 附加信息，不影响当前版本输出。
 */
function shouldSkipVersionCommandLatestLookup(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CODE_HELPER_SKIP_VERSION_CHECK === "1" ||
    env.CI === "true" ||
    env.GITHUB_ACTIONS === "true" ||
    env.npm_lifecycle_event === "test" ||
    env.npm_lifecycle_event === "check" ||
    env.npm_lifecycle_event === "prepack"
  );
}

/**
 * 为 version 命令生成简短更新提示。
 * 交互菜单的版本提醒走 stderr；version 命令本身是显式查询，因此可以把附加信息写到 stdout。
 */
function formatVersionCommandUpdateHint(currentVersion: string, latestVersion: string): string[] {
  if (compareVersions(currentVersion, latestVersion) >= 0) {
    return [];
  }

  return [
    "可更新到 npm latest：",
    "  npm i -D @skrupellose/code-helper@latest",
    "  npx code-helper update"
  ];
}

/**
 * 为 init 解析要应用的 agent 工具目标。
 * 已有入口文件可以直接推断；完全无法判断时，交互终端让用户选择，非交互场景保守跳过。
 */
async function resolveInitSkillRegistrationTargets(projectRoot: string): Promise<SkillRegistrationTarget[]> {
  const inferredTargets = await resolveSkillRegistrationTargets(projectRoot);
  const canUseTextMenu = Boolean(input.isTTY && output.isTTY);

  if (inferredTargets.length > 0) {
    return inferredTargets;
  }

  if (canUseInteractiveKeys(input, output)) {
    while (true) {
      const result = await promptMultiSelect(
        input,
        output,
        "选择 init 要应用的 agent 工具（空格选择，至少选择一个，Esc 取消）",
        buildInitTargetMultiSelectOptions()
      );
      const resolution = resolveInitMultiSelectTargetPromptResult(result);

      if (resolution.action === "select") {
        return resolution.targets;
      }

      if (resolution.action === "cancel") {
        console.log("已取消 agent 工具选择，init 将只刷新 code-helper 工作区和规则模板，跳过项目级 skills 与 Agent hooks。");
        return [];
      }

      console.log("请至少选择一个 agent 工具，或按 Esc 取消。");
    }
  }

  if (canUseTextMenu) {
    const rl = createInterface({ input, output });

    try {
      return await askTextInitTargetMenu(rl);
    } finally {
      rl.close();
    }
  }

  console.log("未发现 AGENTS.md、CLAUDE.md 或 GitHub Copilot 入口；非交互模式不会默认全量安装项目级 skills 或 Agent hooks。");
  console.log("如需应用能力，请改用 `code-helper init codex|claudecode|githubcopilot|all`，或先创建对应入口文件后再运行 init。");
  return [];
}

/**
 * raw mode 不可用但仍是 TTY 时，使用数字输入选择 init 目标。
 * 空回车会提示继续选择；0 才表示显式取消，避免误初始化成无 agent 目标。
 */
async function askTextInitTargetMenu(
  rl: ReturnType<typeof createInterface>
): Promise<SkillRegistrationTarget[]> {
  while (true) {
    console.log("\n选择 init 要应用的 agent 工具");
    console.log("1. Codex");
    console.log("2. Claude Code");
    console.log("3. GitHub Copilot");
    console.log("A. 全部");
    console.log("0. 取消选择并跳过项目级 skills 与 Agent hooks");
    console.log("可输入多个编号或名称，例如：1,2 或 codex,claudecode。");

    const answer = await askQuestionOrDefault(rl, "请选择 agent 工具：", INIT_TARGET_TEXT_MENU_CLOSED);

    // stdin 异常关闭时按显式取消处理，避免在无法继续读取输入的终端里无限重试。
    if (answer === INIT_TARGET_TEXT_MENU_CLOSED) {
      console.log("已取消 agent 工具选择，init 将只刷新 code-helper 工作区和规则模板，跳过项目级 skills 与 Agent hooks。");
      return [];
    }

    const resolution = resolveInitTextTargetPromptAnswer(answer);

    if (resolution.action === "select") {
      return resolution.targets;
    }

    if (resolution.action === "cancel") {
      console.log("已取消 agent 工具选择，init 将只刷新 code-helper 工作区和规则模板，跳过项目级 skills 与 Agent hooks。");
      return [];
    }

    console.log("请至少选择一个 agent 工具，或输入 0 取消。");
  }
}

/**
 * 构造 init raw mode 多选菜单项。
 * 新项目无法知道用户实际使用哪个 agent，因此所有目标都默认不勾选。
 */
export function buildInitTargetMultiSelectOptions(): Array<{
  value: SkillRegistrationTarget;
  label: string;
  checked: boolean;
}> {
  return listSupportedSkillRegistrationTargets().map((target) => ({
    value: target,
    label: formatSkillRegistrationTargetName(target),
    checked: false
  }));
}

/**
 * 解析 init raw mode 多选结果。
 * 空确认必须回到选择流程；只有 Esc 这类显式取消才允许跳过 agent 目标。
 */
export function resolveInitMultiSelectTargetPromptResult(result: {
  options: Array<{ value: SkillRegistrationTarget; checked: boolean }>;
  cancelled: boolean;
}): InitTargetPromptResolution {
  if (result.cancelled) {
    return { action: "cancel", targets: [] };
  }

  const targets = result.options.filter((option) => option.checked).map((option) => option.value);

  if (targets.length === 0) {
    return { action: "retry", targets: [] };
  }

  return { action: "select", targets };
}

/**
 * 解析 init 文本兜底菜单输入。
 * 空回车不再等同取消，避免用户在新项目里直接确认后得到无 agent 目标的初始化结果。
 */
export function resolveInitTextTargetPromptAnswer(answer: string): InitTargetPromptResolution {
  const trimmedAnswer = answer.trim();

  if (trimmedAnswer === "0") {
    return { action: "cancel", targets: [] };
  }

  if (trimmedAnswer === "") {
    return { action: "retry", targets: [] };
  }

  let targets: SkillRegistrationTarget[];

  try {
    targets = parseInitTargetSelection(trimmedAnswer);
  } catch {
    // 文本兜底菜单允许用户重新输入，不能因为一次输错就退出整个 init 流程。
    return { action: "retry", targets: [] };
  }

  if (targets.length === 0) {
    return { action: "retry", targets: [] };
  }

  return { action: "select", targets };
}

/**
 * 解析 init 文本兜底菜单的多目标输入。
 * 同时支持数字、英文目标名和 all，方便 macOS / Windows 终端复制粘贴。
 */
export function parseInitTargetSelection(value: string): SkillRegistrationTarget[] {
  if (value === "" || value === "0") {
    return [];
  }

  const targets = new Set<SkillRegistrationTarget>();
  const tokens = value.toLowerCase().split(/[,\s]+/u).filter(Boolean);

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
 * 打印功能开关列表。
 * key 直接展示给用户，便于配合非交互命令使用。
 */
function printFeatureList(config: Awaited<ReturnType<typeof loadConfig>>): void {
  for (const feature of FEATURE_KEYS) {
    const status = config.features[feature].enabled ? "启用" : "关闭";
    console.log(`${feature}: ${status} - ${FEATURE_LABELS[feature]}`);
  }
}

/**
 * 判断字符串是否是合法 FeatureKey。
 * 运行时 CLI 参数需要显式校验，不能只依赖 TypeScript 类型。
 */
function isFeatureKey(value: string | undefined): value is FeatureKey {
  return FEATURE_KEYS.includes(value as FeatureKey);
}
