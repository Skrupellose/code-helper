import { join } from "node:path";

import { FEATURE_KEYS } from "../constants.js";
import { loadConfig } from "../config.js";
import {
  createRuleDocumentFingerprint,
  ensureDirectory,
  ensureTrailingNewline,
  isUnmodifiedBuiltinRuleDocument,
  projectPath,
  readTextIfExists,
  upsertMarkdownSection,
  writeText
} from "../fs-utils.js";
import { getHookTemplates, getRuleTemplates, getSkillTemplates } from "../templates.js";
import type { CodeHelperConfig, OperationResult } from "../types.js";
import { getCurrentPackageVersion } from "../version-check.js";
import { renderEntryFileList } from "./entries.js";

/**
 * 安装 / 刷新专题规则时的选项。
 */
export interface InstallRuleTemplatesOptions {
  /**
   * 为 true 时强制用当前内置模板整文件覆盖（仅内置模板文件名）。
   * 危险：会丢弃用户在这些文件上的自定义改动；message 必须写清。
   */
  refreshRules?: boolean;
}

/** code-helper 状态文件中与规则安全升级有关的可选字段。 */
interface PersistedRuleTemplateState {
  ruleTemplateFingerprints?: Record<string, string>;
}

/**
 * 指纹机制上线前的真实内置规则基线。
 *
 * 发布来源矩阵：0.1.0=`4f5025f`、0.1.1=`5f06e29`、0.1.2=`d38a1b4`、0.1.3=`1cdfec8`、
 * 0.1.4=`a1086ad`、0.1.5=`4d342b9`、0.1.6=`e19a599`、0.1.7=`ba9f4e5`、
 * 0.1.8=`1ec6bfa`、0.1.9=`efb8bd1`。逐版编译 `getRuleTemplates` 后计算规范化正文
 * SHA-256，并按规则去重登记。只接受可审计的已发布模板，不对未知正文做模糊推断。
 * 版本差异集中在项目记忆、项目计划、文档归档、功能完成检查和 Agent 协作规则；
 * 执行结果与测试策略在 0.1.0～0.1.9 间保持同一指纹。
 */
const LEGACY_RULE_TEMPLATE_FINGERPRINTS: Readonly<Record<string, readonly string[]>> = {
  "项目记忆规则优化.md": [
    // 0.1.0（4f5025f）
    "b01632d719873cb0539ca46d8d9ed5568e88a430c15168331cb0498db7a477b1",
    // 0.1.5（4d342b9）
    "322f19474b0b291d5f03b466a1fae8a1b7d4578741e422749249572a34283653",
    // 0.1.6～0.1.9（e19a599、ba9f4e5、1ec6bfa、efb8bd1）
    "004980664656826a58eb3e9402a496145650f0727d7264ce9d147f8a82e82439"
  ],
  "项目计划管理规范.md": [
    // 0.1.0（4f5025f）
    "59f769e4dac60e19480ae8657d026fb88274cc4165afb004b9d9b00b63148a41",
    // 0.1.1～0.1.9
    "8fbfa5fe721e16f5413170c70242220fce5c4a4c17fb8cd030452af276906d05"
  ],
  "执行结果总结规范.md": ["a0d25f4625d4de43d1b98b7d9e5f4739733c19d9e9e813af7f446592e304d78c"],
  "测试策略规范.md": ["7b70470cdd39019918babe755db76b8ede7183c84ab88313408794e8114b18dd"],
  "文档归档规范.md": [
    // 0.1.0（4f5025f）
    "bd2feb890ae391a780adb58f26f07df0fd1ffad03f51b44608edbd1527373104",
    // 0.1.1～0.1.9
    "891ca8037bd88c0f99303ba2225ff31e1797143ce6204b6e24e9e37a2b6c82e4"
  ],
  "功能完成检查规范.md": [
    // 0.1.1（5f06e29）
    "78ad0837de57153fee22bac29207fefea88d45a988ecc2b79aedc8785649f5cb",
    // 0.1.2～0.1.9
    "d97fbe59bcb26c1867561c39a8d8146e6bc40a5dfc1b1dc22adf21c892a6a5bf"
  ],
  "Agent协作规范.md": [
    // 0.1.0（4f5025f）
    "2fd5b5ed5ab66564129f1c7f635311d8843a2ac5cf92d390bb59334815e2268e",
    // 0.1.1～0.1.2（5f06e29、d38a1b4）
    "8b17d40ea5a6dcdf096050f52a9c60002c883c7128dbcba9c9d6236e29d7586b",
    // 0.1.3～0.1.9
    "4a71dd533a327ae07214d201679a9c10be209de74c83e80b99daec55b671132d"
  ]
};

/** 判断 JSON 值是否为可安全合并的普通对象形状。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取合法状态对象；缺失、损坏、null 或数组都返回空对象。
 * 调用方只覆盖 code-helper 受控字段，其它未知字段通过对象展开原样保留。
 */
async function readPersistedStateObject(
  projectRoot: string,
  config: CodeHelperConfig
): Promise<Record<string, unknown>> {
  const statePath = projectPath(projectRoot, `${config.directories.workspace}/state.json`);
  const content = await readTextIfExists(statePath);

  if (content === undefined) {
    return {};
  }

  try {
    const state: unknown = JSON.parse(content);
    return isJsonObject(state) ? state : {};
  } catch {
    return {};
  }
}

/**
 * 读取上一次运行时记录的内置规则指纹。
 * 旧版状态文件没有该字段，或状态文件损坏时采用保守兼容：不把未知旧正文当作内置模板覆盖。
 */
async function readPersistedRuleTemplateFingerprints(
  projectRoot: string,
  config: CodeHelperConfig
): Promise<Record<string, string>> {
  const state = await readPersistedStateObject(projectRoot, config) as PersistedRuleTemplateState;
  const fingerprints = state.ruleTemplateFingerprints;

  if (!isJsonObject(fingerprints)) {
    return {};
  }

  // 字段内部也逐项校验，避免 null、数组或非字符串值进入可信基线比较。
  return Object.fromEntries(
    Object.entries(fingerprints).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

/**
 * 创建所有固定目录。
 * 目录创建本身幂等，因此统一标记为 updated，表示已确保存在。
 */
export async function createDirectories(
  projectRoot: string,
  config: CodeHelperConfig,
  operations: OperationResult[]
): Promise<void> {
  const directories = [
    config.directories.workspace,
    `${config.directories.workspace}/templates`,
    `${config.directories.workspace}/skills`,
    `${config.directories.workspace}/hooks`,
    `${config.directories.workspace}/checks`,
    `${config.directories.workspace}/archives`,
    config.directories.userRules,
    config.directories.planDoc,
    `${config.directories.planDoc}/archive`,
    config.directories.resultDoc,
    `${config.directories.resultDoc}/archive`,
    config.directories.statusDoc,
    `${config.directories.statusDoc}/archive`
  ];

  for (const directory of directories) {
    const absolutePath = projectPath(projectRoot, directory);
    await ensureDirectory(absolutePath);
    operations.push({
      path: absolutePath,
      action: "updated",
      message: "已确保目录存在"
    });
  }
}

/**
 * 安装专题规则模板，并在安全前提下刷新未改动的内置规则。
 *
 * 语义：
 * 1. 文件不存在 → 写入完整模板（created）
 * 2. 文件是未改动的内置规则（忽略「调用入口文件」差异后与模板正文一致）→ 整文件写为当前模板（updated）
 * 3. 用户改过正文 → 只 upsert「调用入口文件」小节，保留用户改动
 * 4. refreshRules / force → 对内置文件名强制整文件覆盖（绝不碰用户自建的其它 md）
 */
export async function installRuleTemplates(
  projectRoot: string,
  config: CodeHelperConfig,
  options: InstallRuleTemplatesOptions = {}
): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];
  const forceRefresh = options.refreshRules === true;
  const entrySectionTitle = "## 调用入口文件";
  const entrySectionBody = renderEntryFileList(config);
  const persistedFingerprints = await readPersistedRuleTemplateFingerprints(projectRoot, config);

  for (const template of getRuleTemplates(config)) {
    const targetPath = projectPath(projectRoot, join(config.directories.userRules, template.fileName));
    const existing = await readTextIfExists(targetPath);

    // 缺失文件：直接创建完整模板。
    if (existing === undefined) {
      await writeText(targetPath, ensureTrailingNewline(template.content));
      operations.push({
        path: targetPath,
        action: "created",
        message: "已创建缺失的内置规则模板"
      });
      continue;
    }

    const nextTemplateContent = ensureTrailingNewline(template.content);

    // 强制刷新：仅覆盖内置模板列表中的同名文件。
    if (forceRefresh) {
      if (existing === nextTemplateContent || ensureTrailingNewline(existing) === nextTemplateContent) {
        operations.push({
          path: targetPath,
          action: "skipped",
          message: "内置规则已是最新（强制刷新未写入变更）"
        });
        continue;
      }

      await writeText(targetPath, nextTemplateContent);
      operations.push({
        path: targetPath,
        action: "updated",
        message: "已强制刷新内置规则全文（用户改动已被覆盖）"
      });
      continue;
    }

    const existingFingerprint = createRuleDocumentFingerprint(existing, entrySectionTitle);
    const persistedFingerprint = persistedFingerprints[template.fileName];
    const matchesKnownLegacyTemplate =
      LEGACY_RULE_TEMPLATE_FINGERPRINTS[template.fileName]?.includes(existingFingerprint) === true;

    // 磁盘正文匹配当前模板或上次记录的模板指纹时，均可确认用户没有改过正文。
    // 后者是跨版本升级的关键：即使新版模板正文已变化，原样旧模板仍会被安全识别。
    if (
      isUnmodifiedBuiltinRuleDocument(existing, template.content, entrySectionTitle) ||
      (persistedFingerprint !== undefined && existingFingerprint === persistedFingerprint) ||
      matchesKnownLegacyTemplate
    ) {
      if (existing === nextTemplateContent || ensureTrailingNewline(existing) === nextTemplateContent) {
        operations.push({
          path: targetPath,
          action: "skipped",
          message: "内置规则已是最新"
        });
        continue;
      }

      await writeText(targetPath, nextTemplateContent);
      operations.push({
        path: targetPath,
        action: "updated",
        message: "已刷新未改动的内置规则"
      });
      continue;
    }

    // 用户改过正文：只同步调用入口小节，绝不覆盖自定义段落。
    operations.push(
      await upsertMarkdownSection(targetPath, entrySectionTitle, entrySectionBody, template.content)
    );
  }

  return operations;
}

/**
 * 仅刷新内置专题规则模板（不触碰用户自建 md）。
 * force=true 时整文件覆盖内置规则；否则对未改动规则做安全刷新，改动过的只更新入口小节。
 */
export async function refreshRuleTemplates(
  projectRoot: string,
  options: { force?: boolean } = {}
): Promise<OperationResult[]> {
  const config = await loadConfig(projectRoot);
  return installRuleTemplates(projectRoot, config, { refreshRules: options.force === true });
}

/**
 * 安装内置 skill 模板副本。
 * 这些文件是 code-helper 工作区资产，可以在新版本初始化时安全刷新。
 */
export async function installSkillTemplates(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];

  for (const template of getSkillTemplates()) {
    const targetPath = projectPath(projectRoot, join(config.directories.workspace, "skills", template.fileName));
    await writeText(targetPath, template.content);
    operations.push({
      path: targetPath,
      action: "updated",
      message: "已刷新内置 skill 模板"
    });
  }

  return operations;
}

/**
 * 安装可选 hook 模板。
 * 即使功能关闭也会写入 sample 文件（action 为 created/updated，message 说明仅 sample），不安装实际 hook。
 */
export async function installHookTemplates(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];

  for (const template of getHookTemplates()) {
    const targetPath = projectPath(projectRoot, join(config.directories.workspace, "hooks", template.fileName));
    const enabled = config.features[template.feature].enabled;
    const existing = await readTextIfExists(targetPath);
    const action = existing === undefined ? "created" : "updated";
    const kindLabel = template.feature === "gitHooks" ? "Git hook" : "Agent hook";
    const featureLabel = template.feature === "gitHooks" ? "Git hooks" : "Agent hooks";

    await writeText(targetPath, template.content);
    operations.push({
      path: targetPath,
      action,
      message: enabled
        ? `已${action === "created" ? "创建" : "刷新"}可选 ${kindLabel} 模板`
        : `${featureLabel} 功能关闭，已${action === "created" ? "创建" : "更新"} sample 模板（仅示例，未安装实际 hook）`
    });
  }

  return operations;
}

/**
 * 写入 code-helper 状态文件。
 * 该文件记录工具自身最近一次初始化状态，不替代业务项目 status-doc。
 * packageVersion 供后续 doctor 判断本地资产是否落后于当前 CLI 版本。
 */
export async function writeStateFile(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult> {
  const enabledFeatures = FEATURE_KEYS.filter((feature) => config.features[feature].enabled);
  const targetPath = projectPath(projectRoot, `${config.directories.workspace}/state.json`);
  const packageVersion = await getCurrentPackageVersion();
  const existingState = await readPersistedStateObject(projectRoot, config);
  const ruleTemplateFingerprints = Object.fromEntries(
    getRuleTemplates(config).map((template) => [
      template.fileName,
      createRuleDocumentFingerprint(template.content)
    ])
  );
  const state = {
    ...existingState,
    initializedAt: new Date().toISOString(),
    packageVersion,
    enabledFeatures,
    ruleTemplateFingerprints,
    note: "此文件由 code-helper 维护，仅记录工具状态，不承载业务项目状态。"
  };

  await writeText(targetPath, `${JSON.stringify(state, null, 2)}\n`);

  return {
    path: targetPath,
    action: "updated",
    message: "已刷新 code-helper 运行状态"
  };
}
