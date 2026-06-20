import { basename, isAbsolute, join } from "node:path";

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
  const requirementAbsolutePath = isAbsolute(options.requirementPath)
    ? options.requirementPath
    : projectPath(options.projectRoot, options.requirementPath);
  const requirement = await readTextIfExists(requirementAbsolutePath);

  if (requirement === undefined) {
    throw new Error(`需求文档不存在：${options.requirementPath}`);
  }

  const featureName = inferChineseFeatureName(options.featureName, options.requirementPath, requirement);
  const planPath = projectPath(options.projectRoot, join(config.directories.planDoc, `${featureName}.md`));
  const resultPath = projectPath(options.projectRoot, join(config.directories.resultDoc, featureName, RESULT_RECORD_FILE_NAME));
  const statusPath = projectPath(options.projectRoot, join(config.directories.statusDoc, `${featureName}-状态.md`));
  const manualTestPath = projectPath(options.projectRoot, join(config.directories.resultDoc, featureName, MANUAL_TEST_FILE_NAME));

  return [
    await writeTextIfMissing(planPath, renderPlanDocument(featureName, options.requirementPath, requirement)),
    await writeTextIfMissing(resultPath, renderResultDocument(featureName)),
    await writeTextIfMissing(statusPath, renderStatusDocument(featureName)),
    await writeTextIfMissing(manualTestPath, renderManualTestDocument(featureName, `${featureName} 页面回归测试`))
  ];
}

/**
 * 生成独立手工测试文档。
 * 页面测试默认交给用户手工执行，因此此函数不启动浏览器自动化。
 */
export async function createManualTestDocument(options: ManualTestOptions): Promise<OperationResult> {
  const config = await loadConfig(options.projectRoot);
  const featureName = normalizeDocumentName(options.featureName, "页面功能");
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
    .replace(/[^\p{Script=Han}\p{N}_-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");

  if (normalized !== "" && containsChinese(normalized)) {
    return normalized;
  }

  return fallbackName;
}

/**
 * 推断中文功能名。
 * 优先使用用户输入的中文功能名，其次使用需求文档中的中文一级标题，最后用中文兜底名。
 */
function inferChineseFeatureName(featureName: string | undefined, requirementPath: string, requirement: string): string {
  const titleFallback = extractChineseMarkdownTitle(requirement) ?? normalizeDocumentName(basename(requirementPath, ".md"), "功能计划");

  if (featureName !== undefined && featureName.trim() !== "") {
    return normalizeDocumentName(featureName, titleFallback);
  }

  return titleFallback;
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
3. 涉及页面、可视化或浏览器链路时，只生成手工测试文档，由用户执行。
4. 工具执行测试时只运行纯逻辑测试，例如函数单元测试或非浏览器集成测试。

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
- 手工测试文档：\`code-helper-docs/result-doc/${featureName}/${MANUAL_TEST_FILE_NAME}\`
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

1. 状态：未开始；已创建计划文档，等待拆分和执行。

## 下一步

1. 完成需求目标、阶段边界和验收标准确认。
2. 按依赖顺序细化计划文档。
3. 开始第一个可交接小节点。

## 阶段进度

- 计划初始化：已创建。

## 关键结论

- 页面、可视化和浏览器链路只生成手工测试文档。
- 工具只执行纯逻辑测试。

## 关键索引

- 执行计划：\`code-helper-docs/plan-doc/${featureName}.md\`
- 实施记录：\`code-helper-docs/result-doc/${featureName}/${RESULT_RECORD_FILE_NAME}\`
- 手工测试：\`code-helper-docs/result-doc/${featureName}/${MANUAL_TEST_FILE_NAME}\`

## 仍会影响后续判断的风险点

1. 需求尚未拆成可执行小节点。

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
