import { readdir } from "node:fs/promises";

import { COMPLETION_RECORD_DIRECTORY } from "./constants.js";
import {
  portablePath,
  projectPath,
  readTextIfExists,
  writeTextIfMissing
} from "./fs-utils.js";
import { containsChinese } from "./text-utils.js";
import type { OperationResult } from "./types.js";
import { normalizeDocumentName } from "./workflows.js";

/** 完成记录固定使用的文件名后缀。 */
export const COMPLETION_RECORD_FILE_SUFFIX = "-完成记录.md";

/** 完成记录 frontmatter 的稳定类型标记。 */
export const COMPLETION_RECORD_KIND = "completion-record";

/** 完成记录固定采用直接执行模式。 */
export const COMPLETION_RECORD_TRACKING_MODE = "direct";

/** 完成记录创建即进入终态，不参与活动任务归档。 */
export const COMPLETION_RECORD_LIFECYCLE = "recorded";

/** 创建完成记录时所需的参数。 */
export interface CreateCompletionRecordOptions {
  projectRoot: string;
  featureName: string;
}

/** 单份完成记录的可读信息。 */
export interface CompletionRecord {
  featureName: string;
  relativePath: string;
  content: string;
}

/**
 * 创建一份直接执行任务的终态完成记录。
 *
 * 完成记录独立于 plan/status/result 任务体系；重复执行时通过 writeTextIfMissing
 * 保留已有正文，避免收尾命令覆盖 agent 已补充的实施证据。
 */
export async function createCompletionRecord(
  options: CreateCompletionRecordOptions
): Promise<OperationResult> {
  const featureName = normalizeCompletionRecordFeatureName(options.featureName);
  await assertNoPlanningTaskConflict(options.projectRoot, featureName);
  const relativePath = getCompletionRecordRelativePath(featureName);
  const targetPath = projectPath(options.projectRoot, relativePath);

  const operation = await writeTextIfMissing(
    targetPath,
    renderCompletionRecordDocument(featureName)
  );

  return {
    ...operation,
    message: operation.action === "created"
      ? "已创建直接执行任务的终态完成记录"
      : "完成记录已存在，保持原内容"
  };
}

/**
 * 核心创建 API 同样拒绝与任意计划任务生命周期重名。
 *
 * archive 模块需要读取完成记录，因此这里使用函数内动态导入避免静态循环依赖；
 * 调用发生在模块初始化完成之后。CLI 入口仍保留前置检查，以便返回更直接的错误码。
 */
async function assertNoPlanningTaskConflict(
  projectRoot: string,
  featureName: string
): Promise<void> {
  const { findTaskByFeatureName, listTasks } = await import("./archive.js");
  const matchingTask = findTaskByFeatureName(await listTasks(projectRoot), featureName);

  if (matchingTask !== undefined) {
    throw new Error(
      `功能“${matchingTask.featureName}”已经存在 ${matchingTask.status} 计划任务文档，`
      + "请维护原 plan/status/result 生命周期，不要创建同名完成记录。"
    );
  }
}

/**
 * 查找与输入名称对应的完成记录。
 *
 * 同时接受“功能名”“功能名-完成记录”和完整 Markdown 文件名，方便 finish/archive
 * 复用。查找只读取独立目录，不会把完成记录加入 plan/status/result 任务集合。
 */
export async function findCompletionRecord(
  projectRoot: string,
  rawName: string
): Promise<CompletionRecord | undefined> {
  for (const featureName of getCompletionRecordFeatureNameCandidates(rawName)) {
    const relativePath = getCompletionRecordRelativePath(featureName);
    const content = await readTextIfExists(projectPath(projectRoot, relativePath));

    if (content !== undefined) {
      return {
        featureName,
        relativePath,
        content
      };
    }
  }

  return undefined;
}

/**
 * 返回完成记录目录下的全部 Markdown 文件。
 *
 * 检查器需要读取包括命名不合规文件在内的真实内容，因此这里不预先过滤后缀格式；
 * 隐藏占位文件与非 Markdown 文件不属于完成记录。
 */
export async function listCompletionRecordFiles(
  projectRoot: string
): Promise<Array<{ fileName: string; relativePath: string; content: string }>> {
  const directoryPath = projectPath(projectRoot, COMPLETION_RECORD_DIRECTORY);
  let fileNames: string[];

  try {
    fileNames = await readdir(directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }

  const records: Array<{ fileName: string; relativePath: string; content: string }> = [];

  for (const fileName of fileNames) {
    if (fileName.startsWith(".") || !fileName.endsWith(".md")) {
      continue;
    }

    const relativePath = portablePath(COMPLETION_RECORD_DIRECTORY, fileName);
    const content = await readTextIfExists(projectPath(projectRoot, relativePath));

    // readdir 与 readFile 之间文件可能被外部删除；仅跳过这一瞬态缺失，其他 IO 错误由底层抛出。
    if (content !== undefined) {
      records.push({ fileName, relativePath, content });
    }
  }

  return records.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

/**
 * 解析完成记录开头的简单 YAML frontmatter。
 *
 * 当前契约只需要字符串标量，使用受限解析能避免为了三个固定字段接受复杂 YAML
 * 结构；值两侧的单引号或双引号会被去除。
 */
export function parseCompletionRecordFrontmatter(content: string): Record<string, string> | undefined {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/gu);

  if (lines[0]?.trim() !== "---") {
    return undefined;
  }

  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingIndex < 0) {
    return undefined;
  }

  const fields: Record<string, string> = {};

  for (const line of lines.slice(1, closingIndex + 1)) {
    const match = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*?)\s*$/u);
    if (!match) {
      continue;
    }

    fields[match[1]] = stripMatchingQuotes(match[2]);
  }

  return fields;
}

/**
 * 判断完成记录是否包含合法的直接执行终态元数据。
 *
 * finish 复用既有 frontmatter 解析器和 check 使用的三个固定字段契约，
 * 避免仅凭文件名把损坏记录识别为 recorded 终态。
 */
export function isValidCompletionRecordMetadata(content: string): boolean {
  const frontmatter = parseCompletionRecordFrontmatter(content);

  return frontmatter?.["code-helper-kind"] === COMPLETION_RECORD_KIND
    && frontmatter?.["tracking-mode"] === COMPLETION_RECORD_TRACKING_MODE
    && frontmatter?.lifecycle === COMPLETION_RECORD_LIFECYCLE;
}

/**
 * 判断文件名是否满足 `<中文功能名>-完成记录.md`。
 */
export function isValidCompletionRecordFileName(fileName: string): boolean {
  if (!fileName.endsWith(COMPLETION_RECORD_FILE_SUFFIX)) {
    return false;
  }

  const featureName = fileName.slice(0, -COMPLETION_RECORD_FILE_SUFFIX.length);
  return featureName.length > 0
    && containsChinese(featureName)
    // 手工文件名必须与 CLI 的规范化结果完全一致，否则 check 可能判合法，
    // 但 finish/find 会用规范化名称查不到同一文件。
    && normalizeCompletionRecordFeatureName(featureName) === featureName;
}

/**
 * 从用户输入中得到稳定的中文功能名，并避免重复追加“完成记录”后缀。
 */
export function normalizeCompletionRecordFeatureName(rawName: string): string {
  const withoutMarkdownSuffix = rawName.trim().replace(/\.md$/iu, "");
  const withoutRecordSuffix = withoutMarkdownSuffix.endsWith("-完成记录")
    ? withoutMarkdownSuffix.slice(0, -"-完成记录".length)
    : withoutMarkdownSuffix;

  return normalizeDocumentName(withoutRecordSuffix, "直接执行任务");
}

/**
 * 生成完成记录的固定相对路径。
 */
export function getCompletionRecordRelativePath(featureName: string): string {
  // 所有公开路径入口都再次规范化，避免调用方绕过 create/find 直接传入
  // `../` 片段后把记录定位到项目目录之外。
  const normalizedFeatureName = normalizeCompletionRecordFeatureName(featureName);

  return portablePath(
    COMPLETION_RECORD_DIRECTORY,
    `${normalizedFeatureName}${COMPLETION_RECORD_FILE_SUFFIX}`
  );
}

/**
 * 生成完成记录查找候选。
 *
 * 查找路径只使用规范化名称。不能保留未经处理的 raw 候选，否则包含 `../`
 * 的输入会在 portablePath 规范化时越过 completion-record 目录。
 */
function getCompletionRecordFeatureNameCandidates(rawName: string): string[] {
  return [normalizeCompletionRecordFeatureName(rawName)];
}

/**
 * 渲染终态完成记录模板。
 *
 * 该模板只保存已经发生的实施事实，不包含待执行计划、状态队列或归档指令。
 */
function renderCompletionRecordDocument(featureName: string): string {
  return `---
code-helper-kind: ${COMPLETION_RECORD_KIND}
tracking-mode: ${COMPLETION_RECORD_TRACKING_MODE}
lifecycle: ${COMPLETION_RECORD_LIFECYCLE}
---

# ${featureName}完成记录

## 任务背景

说明本次直接执行任务的目标，以及为何在收尾时需要保留完成记录。

## 实施总结

说明本次已经完成的交付结果，以及明确没有纳入本轮的范围。

## 实际改动

- 补充本次已经完成的代码、配置或文档变更。

## 验证结果

- 补充已执行的检查、测试命令及其结果。

## 未验证事项

- 无；如存在未验证边界，请明确记录。

## 风险与后续

- 无；如存在后续建议，请明确记录，但不要把本文件转为活动任务计划。
`;
}

/** 去除 frontmatter 字符串标量两侧成对的单引号或双引号。 */
function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

/** 判断文件系统错误是否表示路径不存在。 */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}
