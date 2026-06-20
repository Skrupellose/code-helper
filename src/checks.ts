import { readdir } from "node:fs/promises";

import { ENTRY_BLOCK_END, ENTRY_BLOCK_START, FEATURE_KEYS } from "./constants.js";
import { listTasks } from "./archive.js";
import { loadConfig } from "./config.js";
import { portablePath, projectPath, readTextIfExists, writeText } from "./fs-utils.js";
import type { CheckIssue, CodeHelperConfig } from "./types.js";

/**
 * 运行项目协作规则检查。
 * 检查只读项目结构，并把结果写入 `.code-helper/checks/latest.json`。
 */
export async function runChecks(projectRoot: string): Promise<CheckIssue[]> {
  const config = await loadConfig(projectRoot);
  const issues: CheckIssue[] = [];

  if (!config.features.checks.enabled) {
    return issues;
  }

  issues.push(...(await checkConfig(config)));
  issues.push(...(await checkEntryDocuments(projectRoot, config)));
  issues.push(...(await checkRuleDocuments(projectRoot, config)));
  issues.push(...(await checkPlanDirectories(projectRoot, config)));
  issues.push(...(await checkChineseWorkbenchDocuments(projectRoot, config)));
  issues.push(...(await checkTestingPolicy(projectRoot, config)));
  issues.push(...(await checkArchiveState(projectRoot, config)));

  await writeText(
    projectPath(projectRoot, `${config.directories.workspace}/checks/latest.json`),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), issues }, null, 2)}\n`
  );

  return issues;
}

/**
 * 检查计划、结果、状态和测试文档是否遵守中文命名规则。
 * 生成端已经强制中文命名；检查端负责发现用户手动创建或旧文档残留。
 */
async function checkChineseWorkbenchDocuments(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  if (!config.features.planWorkbench.enabled && !config.features.resultSummary.enabled) {
    return issues;
  }

  issues.push(...(await checkPlanDocumentNames(projectRoot, config, config.directories.planDoc)));
  issues.push(...(await checkPlanDocumentNames(projectRoot, config, portablePath(config.directories.planDoc, "archive"))));
  issues.push(...(await checkResultDocumentNames(projectRoot, config, config.directories.resultDoc)));
  issues.push(...(await checkResultDocumentNames(projectRoot, config, portablePath(config.directories.resultDoc, "archive"))));
  issues.push(...(await checkStatusDocumentNames(projectRoot, config, config.directories.statusDoc)));
  issues.push(...(await checkStatusDocumentNames(projectRoot, config, portablePath(config.directories.statusDoc, "archive"))));

  return issues;
}

/**
 * 检查 plan-doc 下的计划文件名。
 * 计划文件必须是 `<中文功能名>.md`，archive 目录本身会跳过。
 */
async function checkPlanDocumentNames(
  projectRoot: string,
  config: CodeHelperConfig,
  relativeDirectory: string
): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const files = await safeReadDirectory(projectPath(projectRoot, relativeDirectory));

  if (files === undefined) {
    return issues;
  }

  for (const file of files) {
    if (file === "archive" || file === ".code-helper-keep" || !file.endsWith(".md")) {
      continue;
    }

    const featureName = file.slice(0, -".md".length);
    if (!containsChinese(featureName)) {
      issues.push(createChineseNameIssue(portablePath(relativeDirectory, file), "计划文档必须使用中文功能名，例如 订单管理升级.md。"));
    }
  }

  return issues;
}

/**
 * 检查 result-doc 下的任务目录和结果文件。
 * 任务目录必须是中文功能名，目录内固定使用 实施记录.md 与 手工测试.md。
 */
async function checkResultDocumentNames(
  projectRoot: string,
  config: CodeHelperConfig,
  relativeDirectory: string
): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const entries = await safeReadDirectory(projectPath(projectRoot, relativeDirectory));

  if (entries === undefined) {
    return issues;
  }

  for (const entry of entries) {
    if (entry === "archive" || entry === ".code-helper-keep" || entry.startsWith(".")) {
      continue;
    }

    const taskDirectory = portablePath(relativeDirectory, entry);
    if (!containsChinese(entry)) {
      issues.push(createChineseNameIssue(taskDirectory, "结果目录必须使用中文功能名，例如 订单管理升级/。"));
    }

    const files = await safeReadDirectory(projectPath(projectRoot, taskDirectory));
    if (files === undefined) {
      continue;
    }

    for (const file of files) {
      if (file.startsWith(".") || !file.endsWith(".md")) {
        continue;
      }

      if (file !== "实施记录.md" && file !== "手工测试.md") {
        issues.push(createChineseNameIssue(portablePath(taskDirectory, file), "结果文件必须使用中文命名，固定使用 实施记录.md 或 手工测试.md。"));
      }
    }
  }

  return issues;
}

/**
 * 检查 status-doc 下的状态文件名。
 * 状态文件必须是 `<中文功能名>-状态.md`，旧版 `-status.md` 会被识别为不合规。
 */
async function checkStatusDocumentNames(
  projectRoot: string,
  config: CodeHelperConfig,
  relativeDirectory: string
): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const files = await safeReadDirectory(projectPath(projectRoot, relativeDirectory));

  if (files === undefined) {
    return issues;
  }

  for (const file of files) {
    if (file === "archive" || file === ".code-helper-keep" || !file.endsWith(".md")) {
      continue;
    }

    if (!file.endsWith("-状态.md")) {
      issues.push(createChineseNameIssue(portablePath(relativeDirectory, file), "状态文档必须使用 <中文功能名>-状态.md。"));
      continue;
    }

    const featureName = file.slice(0, -"-状态.md".length);
    if (!containsChinese(featureName)) {
      issues.push(createChineseNameIssue(portablePath(relativeDirectory, file), "状态文档的功能名必须包含中文。"));
    }
  }

  return issues;
}

/**
 * 构造中文命名违规问题。
 * 集中创建可保持 code、message 和修复建议一致。
 */
function createChineseNameIssue(path: string, suggestion: string): CheckIssue {
  return {
    level: "error",
    code: "non-chinese-document-name",
    message: `文档未使用中文命名：${path}`,
    path,
    suggestion
  };
}

/**
 * 判断字符串是否包含中文字符。
 * 文档命名规则要求任务名至少包含一个中文字符。
 */
function containsChinese(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

/**
 * 检查文档归档目录和任务状态。
 * archive 中的任务视为已结束；同名任务同时存在 active 与 archive 时提示人工确认。
 */
async function checkArchiveState(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  if (!config.features.documentArchive.enabled) {
    return issues;
  }

  for (const directory of [
    `${config.directories.planDoc}/archive`,
    `${config.directories.resultDoc}/archive`,
    `${config.directories.statusDoc}/archive`
  ]) {
    const files = await safeReadDirectory(projectPath(projectRoot, directory));

    if (files === undefined) {
      issues.push({
        level: "error",
        code: "missing-archive-directory",
        message: `归档目录不存在：${directory}`,
        path: directory,
        suggestion: "运行 `npx @skrupellose/code-helper init` 创建文档归档目录。"
      });
    }
  }

  for (const task of await listTasks(projectRoot)) {
    if (task.status === "mixed") {
      issues.push({
        level: "warning",
        code: "mixed-task-archive-state",
        message: `任务同时存在活动文档和归档文档：${task.featureName}`,
        suggestion: "确认该任务是否已经结束；如果已结束，运行 `npx @skrupellose/code-helper archive <中文功能名>` 或手动补齐归档。"
      });
    }
  }

  return issues;
}

/**
 * 检查配置本身是否保持完整。
 * 这能发现用户手工编辑 config.json 时误删功能项的问题。
 */
async function checkConfig(config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  for (const feature of FEATURE_KEYS) {
    if (config.features[feature] === undefined) {
      issues.push({
        level: "error",
        code: "missing-feature-toggle",
        message: `配置缺少功能开关：${feature}`,
        path: ".code-helper/config.json",
        suggestion: "重新运行 `npx @skrupellose/code-helper init`，让工具补齐默认配置。"
      });
    }
  }

  return issues;
}

/**
 * 检查入口文档是否存在 code-helper 管理区块。
 * 入口文档是 agent 发现专题规则的第一站，因此缺失时给 error。
 */
async function checkEntryDocuments(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const entryFiles = [
    config.entryFiles.agents ? "AGENTS.md" : undefined,
    config.entryFiles.claude ? "CLAUDE.md" : undefined
  ].filter((file): file is string => file !== undefined);

  for (const entryFile of entryFiles) {
    const content = await readTextIfExists(projectPath(projectRoot, entryFile));

    if (content === undefined) {
      issues.push({
        level: "error",
        code: "missing-entry-document",
        message: `入口文档不存在：${entryFile}`,
        path: entryFile,
        suggestion: "运行 `npx @skrupellose/code-helper init` 创建入口文档。"
      });
      continue;
    }

    if (!content.includes(ENTRY_BLOCK_START) || !content.includes(ENTRY_BLOCK_END)) {
      issues.push({
        level: "error",
        code: "missing-managed-block",
        message: `入口文档缺少 code-helper 受控区块：${entryFile}`,
        path: entryFile,
        suggestion: "运行 `npx @skrupellose/code-helper init` 追加受控索引区块。"
      });
    }
  }

  return issues;
}

/**
 * 检查专题规则文档结构。
 * 每份规则都要包含固定四段，这样 agent 可以稳定读取和执行。
 */
async function checkRuleDocuments(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const rulesDirectory = projectPath(projectRoot, config.directories.userRules);
  const requiredSections = ["## 功能描述", "## 调用时机", "## 调用入口文件", "## 规则"];
  let files: string[] = [];

  try {
    files = await readdir(rulesDirectory);
  } catch {
    issues.push({
      level: "error",
      code: "missing-user-rules-directory",
      message: "专题规则目录不存在",
      path: config.directories.userRules,
      suggestion: "运行 `npx @skrupellose/code-helper init` 创建专题规则目录和默认规则。"
    });
    return issues;
  }

  const markdownFiles = files.filter((file) => file.endsWith(".md"));

  if (markdownFiles.length === 0) {
    issues.push({
      level: "error",
      code: "empty-user-rules-directory",
      message: "专题规则目录中没有 Markdown 规则文件",
      path: config.directories.userRules,
      suggestion: "运行 `npx @skrupellose/code-helper init` 安装默认专题规则。"
    });
  }

  for (const file of markdownFiles) {
    const relativePath = portablePath(config.directories.userRules, file);
    const content = await readTextIfExists(projectPath(projectRoot, relativePath));

    for (const section of requiredSections) {
      if (!content?.includes(section)) {
        issues.push({
          level: "error",
          code: "invalid-rule-document",
          message: `专题规则缺少小节 ${section}：${file}`,
          path: relativePath,
          suggestion: "补齐“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。"
        });
      }
    }
  }

  return issues;
}

/**
 * 检查计划、结果和状态目录是否存在。
 * 这些目录是项目计划文档的固定落点。
 */
async function checkPlanDirectories(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  if (!config.features.planWorkbench.enabled && !config.features.resultSummary.enabled) {
    return issues;
  }

  for (const directory of [config.directories.planDoc, config.directories.resultDoc, config.directories.statusDoc]) {
    const marker = await readTextIfExists(projectPath(projectRoot, `${directory}/.code-helper-keep`));
    const files = await safeReadDirectory(projectPath(projectRoot, directory));

    if (marker === undefined && files === undefined) {
      issues.push({
        level: "error",
        code: "missing-workbench-directory",
        message: `计划文档目录不存在：${directory}`,
        path: directory,
        suggestion: "运行 `npx @skrupellose/code-helper init` 创建计划、结果和状态目录。"
      });
    }
  }

  return issues;
}

/**
 * 检查测试策略是否已经安装。
 * 如果用户关闭 testingPolicy，则跳过该检查。
 */
async function checkTestingPolicy(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  if (!config.features.testingPolicy.enabled) {
    return [];
  }

  const policyPath = `${config.directories.userRules}/测试策略规范.md`;
  const content = await readTextIfExists(projectPath(projectRoot, policyPath));

  if (content === undefined) {
    return [
      {
        level: "error",
        code: "missing-testing-policy",
        message: "缺少测试策略规范",
        path: policyPath,
        suggestion: "运行 `npx @skrupellose/code-helper init` 安装默认测试策略规范。"
      }
    ];
  }

  if (!content.includes("页面相关测试全部生成严格手工测试文档")) {
    return [
      {
        level: "warning",
        code: "testing-policy-weakened",
        message: "测试策略规范可能缺少页面手工测试约束",
        path: policyPath,
        suggestion: "补充页面测试只生成手工测试文档、工具只执行纯逻辑测试的规则。"
      }
    ];
  }

  return [];
}

/**
 * 安全读取目录。
 * 不存在时返回 undefined，避免检查流程因单个目录缺失中断。
 */
async function safeReadDirectory(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch {
    return undefined;
  }
}
