import { join } from "node:path";

import { FEATURE_KEYS } from "../constants.js";
import { loadConfig } from "../config.js";
import {
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

    // 未改动的内置规则：安全整文件刷新为当前模板（含最新入口列表与上游正文改进）。
    if (isUnmodifiedBuiltinRuleDocument(existing, template.content, entrySectionTitle)) {
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
  const state = {
    initializedAt: new Date().toISOString(),
    packageVersion,
    enabledFeatures,
    note: "此文件由 code-helper 维护，仅记录工具状态，不承载业务项目状态。"
  };

  await writeText(targetPath, `${JSON.stringify(state, null, 2)}\n`);

  return {
    path: targetPath,
    action: "updated",
    message: "已刷新 code-helper 运行状态"
  };
}
