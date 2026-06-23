import { basename, isAbsolute, join, win32 } from "node:path";

import { loadConfig } from "./config.js";
import { projectPath, readTextIfExists, writeTextIfMissing } from "./fs-utils.js";
import type { OperationResult } from "./types.js";

/**
 * 新版生成文档固定使用中文文件名。
 * 目录名仍沿用配置路径，避免破坏既有 .agent 目录约定。
 */
export const RESULT_RECORD_FILE_NAME = "实施记录.md";
export const MANUAL_TEST_FILE_NAME = "手工测试.md";

/**
 * 计划文档生成参数。
 * requirementPath 指向用户准备好的完整需求文档。
 */
export interface PlanWorkbenchOptions {
  projectRoot: string;
  requirementPath: string;
  featureName?: string;
}

/**
 * 手工测试文档生成参数。
 * featureName 用于决定输出目录，title 用于文档标题。
 * 新生成的文档路径会强制使用中文名称，避免 docs 区域继续出现英文任务文档。
 */
export interface ManualTestOptions {
  projectRoot: string;
  featureName: string;
  title?: string;
}

/**
 * 根据需求文档生成计划文档的三类产物。
 * 这里生成的是可编辑模板，真正的任务细拆仍由 agent 根据需求内容继续完善。
 */
export async function createPlanWorkbench(options: PlanWorkbenchOptions): Promise<OperationResult[]> {
  const config = await loadConfig(options.projectRoot);
  const requirementAbsolutePath = resolveRequirementPath(options.projectRoot, options.requirementPath);
  const requirement = await readTextIfExists(requirementAbsolutePath);

  if (requirement === undefined) {
    throw new Error(`需求文档不存在：${options.requirementPath}`);
  }

  const featureName = inferChineseFeatureName(options.featureName, options.requirementPath, requirement);
  const planPath = projectPath(options.projectRoot, join(config.directories.planDoc, `${featureName}.md`));
  const resultPath = projectPath(options.projectRoot, join(config.directories.resultDoc, featureName, RESULT_RECORD_FILE_NAME));
  const statusPath = projectPath(options.projectRoot, join(config.directories.statusDoc, `${featureName}-状态.md`));

  return [
    await writeTextIfMissing(planPath, renderPlanDocument(featureName, options.requirementPath, requirement)),
    await writeTextIfMissing(resultPath, renderResultDocument(featureName)),
    await writeTextIfMissing(statusPath, renderStatusDocument(featureName))
  ];
}

/**
 * 生成独立手工测试文档。
 * 页面测试默认交给用户手工执行，因此此函数不启动浏览器自动化。
 */
export async function createManualTestDocument(options: ManualTestOptions): Promise<OperationResult> {
  const config = await loadConfig(options.projectRoot);
  const featureName = normalizeDocumentName(options.featureName, "人工验收");
  const targetPath = projectPath(options.projectRoot, join(config.directories.resultDoc, featureName, MANUAL_TEST_FILE_NAME));

  return writeTextIfMissing(
    targetPath,
    renderManualTestDocument(featureName, options.title ?? `${featureName} 手工测试`)
  );
}

/**
 * 把用户输入转换成稳定路径片段。
 * 仅保留字母、数字、中文、下划线和短横线，避免生成不可预期路径。
 */
export function normalizeFeatureName(value: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");

  return normalized.length > 0 ? normalized : "feature";
}

/**
 * 把功能名转换成中文文档名。
 * 如果输入没有中文字符，则使用中文兜底名，避免新生成的 docs 文档继续使用英文命名。
 */
export function normalizeDocumentName(value: string, fallbackName: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{Script=Han}\p{L}\p{N}_-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");

  if (normalized !== "" && containsChinese(normalized)) {
    return normalized;
  }

  if (fallbackName.trim() === "") {
    return "";
  }

  const normalizedFallback = fallbackName
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{Script=Han}\p{L}\p{N}_-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  const fallback = normalizedFallback !== "" ? normalizedFallback : fallbackName;
  const legacySuffix = normalizeFeatureName(value);

  if (legacySuffix !== "feature") {
    return `${fallback}-${legacySuffix}`;
  }

  return fallback;
}

/**
 * 推断中文功能名。
 * 优先使用用户输入的中文功能名，其次使用需求文档中的中文一级标题，最后用中文兜底名。
 */
function inferChineseFeatureName(featureName: string | undefined, requirementPath: string, requirement: string): string {
  const titleFallback = extractChineseMarkdownTitle(requirement) ?? normalizeDocumentName(getPathBaseName(requirementPath, ".md"), "功能计划");

  if (featureName !== undefined && featureName.trim() !== "") {
    return containsChinese(featureName) ? normalizeDocumentName(featureName, titleFallback) : titleFallback;
  }

  return titleFallback;
}

/**
 * 解析需求文档读取路径。
 * Node 在非 Windows 平台不会把 C:\foo 识别为绝对路径；显式识别 Windows 绝对路径可避免被拼到 projectRoot 后面。
 */
function resolveRequirementPath(projectRoot: string, requirementPath: string): string {
  if (isAbsolute(requirementPath) || win32.isAbsolute(requirementPath)) {
    return requirementPath;
  }

  return projectPath(projectRoot, requirementPath);
}

/**
 * 获取路径文件名。
 * 测试和部分 agent 环境可能在 macOS/Linux 上处理 Windows 风格路径，因此同时兼容反斜杠分隔符。
 */
function getPathBaseName(path: string, suffix: string): string {
  return isWindowsPathLike(path) ? win32.basename(path, suffix) : basename(path, suffix);
}

/**
 * 判断路径是否带有 Windows 风格分隔符或盘符。
 */
function isWindowsPathLike(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path) || path.includes("\\");
}

/**
 * 从 Markdown 文档中提取第一个中文标题。
 * 这让用户拖拽英文文件名的需求文档时，也能生成中文功能文档名。
 */
function extractChineseMarkdownTitle(content: string): string | undefined {
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/u);

    if (!match) {
      continue;
    }

    const title = normalizeDocumentName(match[1], "");
    if (title !== "") {
      return title;
    }
  }

  return undefined;
}

/**
 * 判断字符串中是否包含中文字符。
 */
function containsChinese(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

/**
 * 渲染计划文档模板。
 * 模板把示例 SOP 的关键结构固化成可持续推进的计划文档。
 */
function renderPlanDocument(featureName: string, requirementPath: string, requirement: string): string {
  const excerpt = requirement.trim().slice(0, 2000);

  return `# ${featureName} 执行计划

## 需求来源

- 原始需求文档：\`${requirementPath}\`

## 下一步建议

1. 先确认目标、阶段边界和验收标准。
2. 再按依赖顺序拆分基础能力、核心实现、集成验收和复查任务。
3. 将当前要执行的第一个子计划同步到 \`code-helper-docs/status-doc/${featureName}-状态.md\` 的“当前执行节点”。
4. 每完成一个子计划，都更新实施记录、计划状态和状态记录，再进入下一个子计划。
5. 涉及页面、可视化或浏览器链路时，只生成手工测试文档，由用户执行。
6. 工具执行测试时只运行纯逻辑测试，例如函数单元测试或非浏览器集成测试。

## 需求摘要

> 以下内容来自原始需求文档的前 2000 个字符，后续拆分时以原文为准。

\`\`\`text
${excerpt}
\`\`\`

## 阶段边界

| 子任务 | 已完成 | 未完成 | 备注 |
|---|---|---|---|
| 目标与约束确认 |  | 明确目标、范围、验收标准 | 状态：未开始；先完成需求澄清 |
| 依赖顺序拆分 |  | 按基础能力、数据模型、核心模块、集成验收、复查范围排序 | 状态：未开始；不要按文档顺序或界面直觉直接实现 |
| 执行批次规划 |  | 拆成可交接的小节点 | 状态：未开始；每个节点完成后写 result-doc |

## 子任务拆分

| 子任务 | 已完成 | 未完成 | 备注 |
|---|---|---|---|
| 基础能力 |  | 待根据需求细化 | 状态：未开始 |
| 数据与接口 |  | 待根据需求细化 | 状态：未开始 |
| 核心实现 |  | 待根据需求细化模块、服务、命令、任务、页面或数据流 | 状态：未开始 |
| 集成验收 |  | 待根据需求细化联调、复查、发布和人工验收环节 | 状态：未开始 |
| 自动化验证 |  | 待根据纯逻辑模块补单元或集成测试 | 状态：未开始 |
| 手工验收 |  | 涉及页面、可视化、浏览器链路或人工业务验收时写 ${MANUAL_TEST_FILE_NAME} | 状态：未开始 |

## 验收标准

- 计划中的每个子任务都有完成定义。
- 纯逻辑改动有自动化测试或明确无法测试说明。
- 页面、可视化、浏览器链路或人工业务验收有手工测试文档。
- 阻塞点和后续风险同步到 status-doc。

## 状态记录

- 当前状态文件：\`code-helper-docs/status-doc/${featureName}-状态.md\`
- 执行记录目录：\`code-helper-docs/result-doc/${featureName}/\`
- 按需手工测试文档：\`code-helper-docs/result-doc/${featureName}/${MANUAL_TEST_FILE_NAME}\`
- 推进要求：每个子计划开始前先更新状态记录的“当前执行节点”，完成后再写入下一节点。
`;
}

/**
 * 渲染执行结果文档模板。
 * 小节点完成后可以直接在该模板上补充真实实施内容。
 */
function renderResultDocument(featureName: string): string {
  return `# ${featureName} 实施记录

## 背景

- 待补充任务背景、用户反馈或需求来源。

## 实施总结

- 待用中文总结本节点完成了什么、未完成什么、下一步是什么。

## 实现

- 待记录本节点实际改动。

## 验证

- 纯逻辑测试：待记录命令和结论。
- 人工验收：涉及页面、可视化、浏览器链路或人工业务验收时，见 \`${MANUAL_TEST_FILE_NAME}\`。

## 风险与后续

- 待记录阻塞点、后续检查点和注意事项。
`;
}

/**
 * 渲染当前状态记录模板。
 * 该文件只保留当前仍影响决策的信息，不做流水账。
 */
function renderStatusDocument(featureName: string): string {
  return `# ${featureName} 状态

## 当前状态

1. 状态：未开始；已创建计划文档，当前等待确认第一个可执行子计划。

## 当前执行节点

| 字段 | 内容 |
|---|---|
| 当前子计划 | 计划细化与第一个执行节点确认 |
| 当前状态 | 未开始 |
| 执行目标 | 从计划文档中确认依赖最少、可独立验证的第一个小节点 |
| 进入条件 | 已阅读执行计划、需求摘要和验收标准 |
| 完成定义 | 已在计划文档标记第一个子计划，并把下一步写回本状态记录 |
| 验证方式 | 检查计划文档、实施记录和本状态记录是否互相指向一致 |

## 下一步

1. 阅读执行计划，确认基础能力、核心实现、集成验收的真实依赖顺序。
2. 在本文件“当前执行节点”中写清楚当前子计划、完成定义和验证方式。
3. 只推进当前执行节点，不同时展开多个无依赖关系不明确的子计划。
4. 当前节点完成后，同步更新实施记录、计划文档状态和本文件的下一个执行节点。

## 阶段进度

| 阶段 | 当前状态 | 下一步 |
|---|---|---|
| 计划初始化 | 已创建 | 确认第一个执行节点 |
| 基础能力 | 未开始 | 等待依赖顺序确认 |
| 核心实现 | 未开始 | 等待基础能力完成或明确可并行 |
| 集成验收 | 未开始 | 等待核心实现具备可验证链路 |
| 完成整理 | 未开始 | 等待验证结论和归档条件明确 |

## 子计划队列

| 顺序 | 子计划 | 当前状态 | 推进规则 |
|---|---|---|---|
| 1 | 计划细化与执行节点确认 | 未开始 | 先把大计划拆成可交接小节点，并选定第一个节点 |
| 2 | 基础能力或前置依赖 | 未开始 | 优先处理会阻塞后续实现的目录、配置、类型、协议或公共能力 |
| 3 | 核心实现 | 未开始 | 按依赖顺序逐个推进模块、服务、命令、页面、数据流或业务规则 |
| 4 | 集成验收 | 未开始 | 串起调用链路、验证方案、人工验收和发布检查 |
| 5 | 完成整理 | 未开始 | 汇总结论、更新长期规则、确认是否归档 |

## Agent 推进规则

1. 每次继续任务时，先读本状态记录，再读计划文档中当前节点对应的内容。
2. 一次只推进“当前执行节点”；如需切换节点，先在本文件说明原因。
3. 小节点完成后，必须把完成内容和验证结论写入 \`${RESULT_RECORD_FILE_NAME}\`。
4. 小节点完成后，必须把计划文档对应行改为已完成或部分完成。
5. 小节点完成后，必须把本文件“当前执行节点”更新为下一个子计划。
6. 遇到阻塞时，保持当前节点不变，并在“仍会影响后续判断的风险点”写清阻塞原因和恢复条件。

## 关键结论

- 页面、可视化和浏览器链路只生成手工测试文档。
- 工具只执行纯逻辑测试。
- status-doc 是 agent 恢复任务的当前入口，不保存完整历史；历史细节写入 result-doc。

## 关键索引

- 执行计划：\`code-helper-docs/plan-doc/${featureName}.md\`
- 实施记录：\`code-helper-docs/result-doc/${featureName}/${RESULT_RECORD_FILE_NAME}\`
- 手工测试：\`code-helper-docs/result-doc/${featureName}/${MANUAL_TEST_FILE_NAME}\`

## 仍会影响后续判断的风险点

1. 大计划尚未同步出明确的当前执行节点，agent 可能无法稳定按步骤推进。
2. 如果后续修改计划文档，必须同步更新本状态记录中的当前节点和子计划队列。

## 最近一次更新

- ${new Date().toISOString().slice(0, 10)}：创建 code-helper 状态记录。
`;
}

/**
 * 渲染页面手工测试文档模板。
 * 文档要求用户执行真实页面测试，避免工具默认跑慢且不稳定的浏览器自动化。
 */
function renderManualTestDocument(featureName: string, title: string): string {
  return `# ${title}

## 测试策略

- 本文档用于页面、组件交互、视觉和真实浏览器链路的手工测试。
- code-helper 不默认执行 Playwright、截图对比或浏览器自动化。
- 工具侧只执行纯逻辑测试，例如函数单元测试或非浏览器集成测试。

## 测试环境

- 环境地址：待填写
- 测试账号：待填写
- 浏览器与设备：待填写
- 分支或版本：待填写

## 前置数据

- 待填写页面所需账号、订单、商品、权限、配置或其他业务数据。

## 操作步骤

| 步骤 | 操作 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|
| 1 | 打开目标页面 | 页面正常加载，无阻塞错误 |  | 未测试 |
| 2 | 执行核心交互 | 交互结果符合需求 |  | 未测试 |
| 3 | 验证异常或空状态 | 展示符合设计和业务预期 |  | 未测试 |

## 回归范围

- 功能范围：${featureName}
- UI 验收：待补充关键视觉和布局点。
- 功能验收：待补充数据提交、跳转、权限和错误处理。

## 阻塞记录

| 问题 | 影响 | 处理人 | 当前状态 |
|---|---|---|---|
|  |  |  |  |
`;
}
