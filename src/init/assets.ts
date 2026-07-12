import { join } from "node:path";

import { FEATURE_KEYS } from "../constants.js";
import { ensureDirectory, projectPath, readTextIfExists, upsertMarkdownSection, writeText } from "../fs-utils.js";
import { getHookTemplates, getRuleTemplates, getSkillTemplates } from "../templates.js";
import type { CodeHelperConfig, OperationResult } from "../types.js";
import { renderEntryFileList } from "./entries.js";

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
 * 安装专题规则模板。
 * 老项目已有同名规则时不会覆盖，避免丢失用户维护的规则。
 */
export async function installRuleTemplates(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult[]> {
  const operations: OperationResult[] = [];

  for (const template of getRuleTemplates(config)) {
    const targetPath = projectPath(projectRoot, join(config.directories.userRules, template.fileName));
    operations.push(
      await upsertMarkdownSection(
        targetPath,
        "## 调用入口文件",
        renderEntryFileList(config),
        template.content
      )
    );
  }

  return operations;
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
 */
export async function writeStateFile(projectRoot: string, config: CodeHelperConfig): Promise<OperationResult> {
  const enabledFeatures = FEATURE_KEYS.filter((feature) => config.features[feature].enabled);
  const targetPath = projectPath(projectRoot, `${config.directories.workspace}/state.json`);
  const state = {
    initializedAt: new Date().toISOString(),
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
