import type { CodeHelperConfig, FeatureKey } from "./types.js";

/**
 * 生成入口文档中的 code-helper 受控区块。
 * 区块只放索引和硬约束，不把详细规范塞进入口文件。
 */
export function renderEntryBlock(config: CodeHelperConfig): string {
  const enabledRules = [
    config.features.memoryTuning.enabled
      ? `- 项目记忆规则优化：整理或更新 \`AGENTS.md\` / \`CLAUDE.md\` / \`.github/copilot-instructions.md\` 时，读取 \`${config.directories.userRules}/项目记忆规则优化.md\`。`
      : undefined,
    config.features.planWorkbench.enabled
      ? `- 项目计划优化：开始大型需求、迁移、重构或多阶段任务时，读取 \`${config.directories.userRules}/项目计划管理规范.md\`。`
      : undefined,
    config.features.resultSummary.enabled
      ? `- 执行结果总结：完成小节点后，读取 \`${config.directories.userRules}/执行结果总结规范.md\` 并写入 result-doc。`
      : undefined,
    config.features.testingPolicy.enabled
      ? `- 测试策略约束：涉及页面的测试只生成手工测试文档；工具只执行纯逻辑测试，读取 \`${config.directories.userRules}/测试策略规范.md\`。`
      : undefined,
    config.features.documentArchive.enabled
      ? `- 文档归档：功能完成或手动移动到 archive 后，任务视为已结束，读取 \`${config.directories.userRules}/文档归档规范.md\`。`
      : undefined,
    config.features.completionReview.enabled
      ? `- 功能完成检查：完成小节点、识别到功能变更、准备最终回复或切换任务前，读取 \`${config.directories.userRules}/功能完成检查规范.md\`，并按需运行 \`npx @skrupellose/code-helper finish\`。`
      : undefined,
    config.features.checks.enabled
      ? "- 规则检查：提交或阶段结束前运行 `npx @skrupellose/code-helper check`，确认协作文档结构仍完整。"
      : undefined,
    config.features.agentHooks.enabled
      ? "- Agent hooks：需要在 agent 生命周期中提醒完成检查时，参考 `.code-helper/hooks/` 下的 agent hook 模板。"
      : undefined,
    config.features.skillRegistration.enabled
      ? "- Skills 管理：需要让 Codex、Claude Code 或 GitHub Copilot 在当前项目自动发现 code-helper skills 时，执行 `npx @skrupellose/code-helper skills register`。"
      : undefined
  ].filter((line): line is string => line !== undefined);

  return `## code-helper 协作入口

### 核心规则

1. 开始新需求、迁移、重构或反馈修复前，先读取本区块索引到的专题规则。
2. 长期规则写入 \`${config.directories.userRules}/\`，短期过程写入 \`${config.directories.resultDoc}/\`，当前状态记录写入 \`${config.directories.statusDoc}/\`。
3. 不把一次性调试过程、临时失败细节或大段实现流水写进入口文档。
4. 主会话只做管理、分配、审阅和结果同步；具体执行任务必须交给子代理。当前 agent 工具没有子代理能力时，先说明限制并等待用户确认，再由主会话执行。

### 专题规则索引

${enabledRules.join("\n")}

### 文档维护规则

- 入口文档只保留轻量索引和核心约束。
- 专题规则文档必须包含“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。
- 计划、状态、结果和测试文档必须使用中文命名与中文总结。
- agent 识别到功能变更、项目结构变化、稳定规则变化或小节点完成时，必须主动判断是否需要更新过程文档、询问更新长期记忆、询问归档或继续当前节点。
- 新功能或重构形成稳定规则后，先询问用户是否更新项目记忆，不自动把短期任务状态写入长期记忆。`;
}

/**
 * 返回内置专题规则模板。
 * 模板文本放在代码中，确保 npm 包无需额外复制资源也能完成初始化。
 */
export function getRuleTemplates(config: CodeHelperConfig): Array<{ fileName: string; content: string }> {
  const entryFiles = [
    config.entryFiles.agents ? "`AGENTS.md`" : undefined,
    config.entryFiles.claude ? "`CLAUDE.md`" : undefined,
    config.entryFiles.copilot ? "`.github/copilot-instructions.md`" : undefined
  ].filter((value): value is string => value !== undefined);

  return [
    {
      fileName: "项目记忆规则优化.md",
      content: `# 项目记忆规则优化

## 功能描述

维护项目级 agent 记忆，把项目规则组织成“轻量入口文档 + 专题规则文档”的结构，避免入口文件膨胀、规则重复和短期任务状态污染长期记忆。

## 调用时机

- 用户要求更新记忆、优化记忆、整理 AGENTS.md 或 CLAUDE.md
- 用户要求同步 AGENTS.md 和 CLAUDE.md
- 用户要求沉淀规则、把当前变更写入记忆、拆分项目规则文档
- agent 识别到功能变更、项目结构变化、测试策略变化、发布流程变化或稳定协作规则后
- 入口文档变长、重复或混入短期任务状态时

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 先判断任务类型：入口文档整理、AGENTS.md / CLAUDE.md 双入口同步、专题规则拆分、根据当前变更更新记忆、新增专题规则、修改已有专题规则、仅输出草案。
2. 写入前先读取项目根目录下已存在的 AGENTS.md、CLAUDE.md 和 \`${config.directories.userRules}/\`，不要假设文件或目录存在。
3. 若两个入口文件都存在，同时识别二者，并保持专题规则索引、文档维护规则和规则路径一致。
4. 若只存在一个入口文件，优先优化已有入口文件；只有用户明确要求双入口时，才创建缺失入口文件。
5. 若两个入口文件都不存在，先输出入口文档草案；只有用户明确要求写入时，默认创建 AGENTS.md。
6. 入口文档只保留项目概览、核心规则、常用命令、专题规则索引和文档维护规则。
7. 具体规则默认写入 \`${config.directories.userRules}/\`，不要把完整规范塞进入口文档。
8. 专题规则文档必须包含“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。
9. 当 agent 判断可能需要更新记忆，或用户明确要求更新记忆时，先查看当前变更范围，再只更新相关专题文档。
10. 如新增主题不存在，新增对应专题文档；如入口索引缺失，再更新已存在的入口文件。
11. 不整份覆盖所有文档，不重复创建相似专题，不把一次性任务状态、临时调试过程、完整命令输出或短期计划写进长期记忆。
12. 新功能、小节点或重构形成稳定规则后，agent 必须主动询问用户是否更新记忆；用户确认前不自动写入长期记忆。

## 输出格式

仅输出草案时使用“记忆优化草案 / 入口文档调整 / 专题文档调整 / 定向更新规则 / 待确认问题”。

写入文件后使用“已完成记忆优化 / 校验”，列出更新的入口文件、专题规则文件和校验结果。

## 校验

1. AGENTS.md 和 CLAUDE.md 如果存在，仍应保持轻量入口定位。
2. 两个入口文件同时存在时，专题规则索引必须一致指向 \`${config.directories.userRules}/\`。
3. 每份专题规则文档都必须包含四个固定小节。
4. 专题文档路径必须被现有入口文件正确引用。
5. 不得误把当前调试状态、临时实现方案或一次性任务流水写入长期记忆。`
    },
    {
      fileName: "项目计划管理规范.md",
      content: `# 项目计划管理规范

## 功能描述

把完整需求文档拆成可推进、可记录阻塞、可恢复上下文、便于后续复查的执行计划。目标不是只写说明文档，而是生成 agent 和开发者可以持续使用的计划、状态和结果记录体系。

## 调用时机

- 用户提供完整需求文档并要求拆分计划
- 项目迁移、框架升级、多阶段功能建设、平台能力建设、数据任务、工具链建设或技术债清理
- 多模块、多系统、多角色、多数据流或跨端交付存在明显依赖关系的任务
- 需要长期推进、多人协作或中途暂停再恢复的任务

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 所有计划、结果、状态和测试文档必须使用中文命名与中文总结。
2. 计划文档写入 \`${config.directories.planDoc}/<中文功能名>.md\`。
3. 执行记录写入 \`${config.directories.resultDoc}/<中文功能名>/实施记录.md\`。
4. 当前状态写入 \`${config.directories.statusDoc}/<中文功能名>-状态.md\`。
5. 需要人工验收时，手工测试或验收文档写入 \`${config.directories.resultDoc}/<中文功能名>/手工测试.md\`。
6. status-doc 必须包含“当前执行节点”，写清当前子计划、状态、执行目标、进入条件、完成定义和验证方式。
7. status-doc 必须包含“子计划队列”，按顺序列出基础能力、核心实现、集成验收和完成整理等后续节点。
8. agent 每次继续任务时先读 status-doc，只推进当前执行节点；完成后同步更新 result-doc、plan-doc 和 status-doc 的下一个执行节点。
9. 最终计划必须同时具备总纲、分层顺序、模块或能力拆分、依赖与集成计划、验收标准、状态记录、阻塞点、后续检查点和下一步建议。
10. 生成顺序必须是：目标与约束、P0/P1 总纲、依赖顺序、目录或模块策略、基础阶段计划、核心实现计划、集成验收计划、执行计划。
11. 不要一开始直接写细表；先给总纲和阶段边界，再逐步细化。
12. 必须按依赖链路重排顺序，不按需求文档顺序、界面直觉或个人偏好排序。
13. 推荐依赖顺序：目标和范围、现状和影响面、基础结构、数据模型或接口契约、核心业务规则、关键模块或服务、集成链路、验证方案、发布和交接整理。
14. 不预设任务一定是前端页面或组件；应按实际需求拆成功能模块、领域能力、接口、命令、任务、作业、页面、组件、数据流或服务单元。
15. 集成和验收计划必须包含前置依赖、执行任务、验证方式、验收标准、完成定义和后续检查点。
16. 所有总览表和明细表统一使用“子任务 / 已完成 / 未完成 / 备注”四列。
17. 备注第一句必须写 \`状态：未开始\`、\`状态：进行中\`、\`状态：部分完成\`、\`状态：被阻塞\` 或 \`状态：已完成\`。
18. 备注必须说明阻塞点、依赖后续流程、后续检查点，以及是否允许跳过继续推进。
19. 文档前部必须包含“下一步建议”，明确现在先做什么、下一步接什么、第一个核心模块或能力何时开始、第一个集成或验收环节何时开始、当前默认执行主线是什么。
20. 验证计划必须按任务类型选择；纯逻辑、数据转换、接口契约、CLI 命令、权限规则和后端服务优先规划可自动执行的单元测试或集成测试。
21. 页面、可视化、组件交互、视觉和真实浏览器链路只生成严格手工测试文档；工具自身只执行纯逻辑测试。
22. 文档只有满足可直接推进、可记录阻塞、可恢复上下文、便于后续复查时，才算完整。`
    },
    {
      fileName: "执行结果总结规范.md",
      content: `# 执行结果总结规范

## 功能描述

规范小节点完成后的实施记录，保证后续 agent 能恢复上下文并判断风险。

## 调用时机

- 完成一个可交接的小粒度任务后
- 阶段内出现重要阻塞、回滚点或验证结论后
- 准备更新当前状态记录前

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 结果文档默认写入 \`${config.directories.resultDoc}/<中文功能名>/实施记录.md\`。
2. 文档必须包含背景、实现、验证、风险与后续。
3. 验证只记录关键命令和结论，不粘贴冗长输出。
4. 如果页面需要测试，写入手工测试文档，不要求 agent 执行浏览器自动化。
5. 影响下一步决策的结论同步到 \`${config.directories.statusDoc}/\`，细节留在 result-doc。`
    },
    {
      fileName: "测试策略规范.md",
      content: `# 测试策略规范

## 功能描述

约束 agent 的测试边界，减少慢且不稳定的页面自动化，把页面验收交给严格手工测试文档。

## 调用时机

- 任务涉及页面、组件交互、视觉验收或浏览器真实链路
- 任务涉及纯函数、数据转换、接口封装或可稳定自动化的逻辑
- 阶段结束需要说明测试范围时

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 页面相关测试全部生成严格手工测试文档，由用户执行。
2. 工具自己只执行纯逻辑测试，例如函数单元测试、数据转换测试、非浏览器集成测试。
3. 不默认引入 Playwright、截图对比或浏览器自动化作为页面验收手段。
4. 手工测试文档必须包含测试环境、前置数据、操作步骤、预期结果、回归范围和阻塞记录。
5. 如果用户明确要求执行页面自动化，先提示这会偏离默认策略，再按用户明确指令处理。`
    },
    {
      fileName: "文档归档规范.md",
      content: `# 文档归档规范

## 功能描述

管理已完成或已结束功能的计划、结果和状态文档，避免多个功能长期堆在当前工作区里，影响 agent 判断下一步任务。

## 调用时机

- 一个功能、阶段或反馈修复已经完成并完成必要总结后
- 用户要求归档某个功能文档
- 用户手动把文档移动到 archive 目录后，需要识别该任务已经结束
- agent 需要判断当前项目还有哪些 active 任务、哪些 archived 任务

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 活动任务文档保留在当前工作区：\`${config.directories.planDoc}/\`、\`${config.directories.resultDoc}/\`、\`${config.directories.statusDoc}/\`。
2. 已结束任务文档放入归档目录：\`${config.directories.planDoc}/archive/\`、\`${config.directories.resultDoc}/archive/\`、\`${config.directories.statusDoc}/archive/\`。
3. 执行 \`npx @skrupellose/code-helper archive <中文功能名>\` 时，将 \`${config.directories.planDoc}/<中文功能名>.md\`、\`${config.directories.resultDoc}/<中文功能名>/\`、\`${config.directories.statusDoc}/<中文功能名>-状态.md\` 移入对应 archive 目录。
4. 归档不覆盖已有目标；如果 archive 中已经存在同名文档，视为用户已经手动归档。
5. 只要任务文档只存在于 archive 目录中，就应识别为已结束任务。
6. 如果同一中文功能名同时存在 active 文档和 archived 文档，状态为 mixed，必须人工确认是否有遗漏文档需要继续归档。
7. 新功能开始时不要复用已归档中文功能名；需要返工时，新建后续中文功能名或明确从 archive 恢复。
8. status-doc 是当前状态记录，归档后不再作为当前任务入口。`
    },
    {
      fileName: "功能完成检查规范.md",
      content: `# 功能完成检查规范

## 功能描述

约束 agent 在完成小节点、识别到功能变更、准备最终回复或切换任务前，主动判断当前功能是否真正完成，并据此更新过程文档、询问是否更新长期记忆、询问是否归档或继续当前节点。

## 调用时机

- 完成一个小节点、阶段任务、反馈修复或功能开发后
- 修改了功能行为、项目结构、配置、测试策略、发布流程、CLI 交互、初始化逻辑或协作文档生成逻辑后
- 准备最终回复用户、提交代码、归档文档或切换到下一个任务前
- 用户表达“这个逻辑以后都这样”“沉淀为规则”“功能完成了”“继续下一个任务”等意图时
- agent hook 或用户手动执行 \`npx @skrupellose/code-helper finish\` 时

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 完成检查不是只在固定节点触发；只要 agent 识别到功能变更、项目改变或稳定规则变化，就必须主动判断是否需要进入完成检查。
2. 每次完成检查先读取 \`${config.directories.statusDoc}/<中文功能名>-状态.md\`，再读取对应 plan-doc 和 result-doc。
3. status-doc 是当前执行入口，必须能看出当前执行节点、子计划队列、完成定义、验证方式和下一步。
4. 当前小节点未完成时，不询问归档，不引导新任务；继续当前节点，或在 status-doc 记录阻塞原因和恢复条件。
5. 当前小节点完成但功能整体未完成时，更新 \`${config.directories.resultDoc}/<中文功能名>/实施记录.md\`、plan-doc 对应任务状态和 status-doc 的下一个执行节点。
6. 小节点完成后必须主动判断是否形成长期规则；如果形成稳定协作规范、项目约束、测试策略、发布流程或工具使用偏好，询问用户是否更新项目记忆。
7. 如果只是一次性实现细节、临时失败过程或短期调试状态，不写入长期记忆。
8. 功能整体完成时，先确认过程文档和验证结论已更新，再询问用户是否更新长期记忆、是否归档文档、是否选择下一个活动任务。
9. 更新长期记忆和归档文档都需要用户确认，不自动执行。
10. agent hook 只做提醒和检查，不替代 agent 判断；Git hook 只做提交前兜底。
11. 推荐运行 \`npx @skrupellose/code-helper finish <中文功能名> --check-only\` 作为收尾检查，不让检查命令直接修改项目文件。
12. 如果 \`finish\` 输出仍有未开始、进行中、部分完成或被阻塞节点，agent 必须继续当前功能，而不是切换新任务。
13. \`finish\` 输出的“必须确认事项”是强制收尾清单；最终回复前必须逐项处理或明确询问用户，不能只总结已完成内容。
14. 如果“必须确认事项”包含更新长期记忆、归档文档或选择下一个任务，agent 必须在最终回复中明确提出对应问题；用户确认前不得自动执行。`
    },
    {
      fileName: "Agent协作规范.md",
      content: `# Agent 协作规范

## 功能描述

统一多个 agent 在同一项目中的协作入口、状态记录和交接方式。

## 调用时机

- 新 agent 接手项目或恢复上下文
- 开始新任务、拆分计划、记录阶段结果或检查规则
- 完成小节点、识别到功能变更、准备最终回复或切换任务前
- 多人或多 agent 交替推进同一项目时

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 开始任务前先读入口文档和相关专题规则。
2. 大任务先生成计划文档，再进入实现。
3. 小节点完成后写结果总结，避免只把结论留在对话里。
4. 当前仍影响决策的信息写入 status-doc，历史细节写入 result-doc。
5. 不覆盖用户已有规则；确需重写时先说明变更范围和原因。
6. 主会话定位为协调者，只负责理解目标、拆分任务、分配子代理、审阅结果、同步过程文档和向用户汇报，不直接执行具体实现、调试、测试、文件修改或资料整理。
7. 任何需要读取大量代码、修改文件、运行命令、排查问题、生成文档、执行测试或整理数据的任务，都必须由子代理执行。
8. 派发子代理时，主会话必须写清任务目标、允许修改的范围、必须读取的规则、禁止触碰的内容、预期产物和验证方式，避免子代理扩大范围。
9. 子代理返回后，主会话必须审阅变更、验证结论、风险和未完成项；发现范围外改动、验证不足或结论不清时，继续派发补充任务或要求修正。
10. 主会话只汇总已审阅的子代理结果，并负责同步 status-doc、result-doc、长期记忆更新询问和最终回复。
11. 如果当前 agent 工具没有子代理能力，主会话必须先明确说明“当前工具不支持子代理执行”，列出原本应交给子代理的任务和由主会话执行的影响，等待用户确认后才能继续执行；用户未确认时不得擅自开始具体任务。
12. 完成小节点、识别到功能变更、准备最终回复或切换任务前，必须执行功能完成检查，判断是否继续当前节点、更新过程文档、询问更新长期记忆、询问归档或选择下一任务。
13. agent 识别到稳定规则、项目结构变化、测试策略变化、发布流程变化或长期协作偏好时，应主动询问用户是否更新项目记忆；用户确认前不自动写入长期规则。
14. Agent hooks 只作为完成检查提醒和兜底，不替代 agent 自己判断；Git hooks 只做提交前检查。`
    }
  ];
}

/**
 * 返回内置 skill 文件模板。
 * 这些模板放到 `.code-helper/skills`，方便用户复制到具体 agent 的 skill 目录。
 */
export function getSkillTemplates(): Array<{ fileName: string; content: string }> {
  return [
    {
      fileName: "memory-tuning.SKILL.md",
      content: `---
name: code-helper-memory-tuning
description: 当用户要求“更新记忆”“优化记忆”“沉淀规则”“整理 AGENTS.md”“整理 CLAUDE.md”“同步 AGENTS.md 和 CLAUDE.md”“拆分项目规则文档”“把当前变更写入记忆”，或 agent 识别到功能变更、项目结构变化、测试策略变化、发布流程变化、稳定协作规则变化并需要询问是否更新长期记忆时必须使用。该 skill 同时识别 AGENTS.md 与 CLAUDE.md，把项目记忆维护为轻量入口文档 + code-helper-docs/user-rules/ 专题规则文档；如果 code-helper-docs/ 或 code-helper-docs/user-rules/ 不存在则按需创建，避免整份覆盖、重复建档或把入口文件写成大而全的长文档。
---

# Code Helper Memory Tuning

## 目标

将项目记忆维护为清晰、可持续、可按需读取的结构：

1. AGENTS.md 和 CLAUDE.md 都视为项目记忆入口文件。
2. 入口文件只保留项目概览、核心规则、常用命令、专题规则索引和文档维护规则。
3. 具体规则默认拆分到 code-helper-docs/user-rules/ 下的专题文档。
4. 如果 code-helper-docs/ 或 code-helper-docs/user-rules/ 不存在，写入时先创建目录。
5. 每份专题文档统一包含“功能描述 / 调用时机 / 调用入口文件 / 规则”。
6. 用户确认更新记忆时，根据当前项目变更定向更新对应专题文档。
7. 新功能、小节点或重构形成稳定规则后，agent 主动询问用户是否更新记忆；用户确认前不自动写入长期记忆。

## 使用场景

当用户表达以下意图时，使用本 skill：

- 更新记忆
- 优化记忆
- 整理 AGENTS.md
- 整理 CLAUDE.md
- 同步 AGENTS.md 和 CLAUDE.md
- 沉淀规则
- 把这个逻辑写进记忆
- 根据这次变更更新记忆
- 新增功能后更新项目规则
- 重构后同步一下文档
- 把入口文档拆干净
- 把规则拆到 code-helper-docs/user-rules

## 输入

执行前需要获得或确认：

- 当前项目根目录。
- 当前入口记忆文件内容：AGENTS.md 和 CLAUDE.md，如果存在。
- 当前 code-helper-docs/user-rules/ 目录内容。
- 当前项目变更范围，例如 git diff、用户描述的新功能、用户描述的重构内容、用户明确指出要沉淀的规则。
- 用户是否只是要草案，还是要直接写入文件。

## 工作流

### 1. 判断任务类型

先判断用户意图属于哪一类：

- 入口文档整理
- AGENTS.md / CLAUDE.md 双入口同步
- 专题规则拆分
- 根据当前变更更新记忆
- 新增专题规则文档
- 修改已有专题规则文档
- 仅输出模板草案，不写文件

如果用户没有明确要求写入文件，先输出草案让用户确认。

### 2. 检查现有结构

读取：

- 项目根目录下存在的 AGENTS.md
- 项目根目录下存在的 CLAUDE.md
- code-helper-docs/user-rules/ 下已有专题文档
- 必要时查看当前 diff 或相关代码文件

不要直接假设文件存在。

- 若 AGENTS.md 和 CLAUDE.md 都存在：同时识别二者，并保持入口索引、文档维护规则和专题规则路径一致。
- 若只存在其中一个入口文件：优先优化已有入口文件；只有用户明确要求双入口时，再创建缺失的入口文件。
- 若两个入口文件都不存在：先输出入口文档草案；只有用户明确要求写入时，默认创建 AGENTS.md，并按用户要求决定是否同时创建 CLAUDE.md。
- 若 code-helper-docs/ 不存在：写入专题规则前创建 code-helper-docs/。
- 若 code-helper-docs/user-rules/ 不存在：写入专题规则前创建 code-helper-docs/user-rules/。

### 3. 整理入口记忆文件

AGENTS.md 和 CLAUDE.md 都只保留以下内容：

- 项目基本信息
- 基础规则
- 常用命令
- 专题规则文档索引
- 文档维护规则

避免在入口文件中保留大段实现细节、长示例、完整规范说明、一次性调试过程或短期任务状态。

入口索引推荐格式：

- 文件命名规范：新增文件、拆分模块或创建专题文档时，读取 code-helper-docs/user-rules/文件命名规范.md
- API 请求规范：新增或修改接口请求时，读取 code-helper-docs/user-rules/API请求规范.md
- 错误处理规范：处理异步异常或统一兜底提示时，读取 code-helper-docs/user-rules/错误处理规范.md

当两个入口文件同时存在时：

- 保持专题规则索引路径一致，统一指向 code-helper-docs/user-rules/。
- 保持文档维护规则一致。
- 允许入口文件保留面向具体工具的少量表述差异，例如 CLAUDE.md 可写 Claude，AGENTS.md 可写 Agent，但不要让规则含义分叉。

### 4. 拆分专题文档

专题文档固定放在 code-helper-docs/user-rules/。

每个专题文档必须包含：

- 一级标题：专题名称
- 功能描述：说明该文档解决什么问题，为什么存在
- 调用时机：说明 AI 编码助手在什么场景下应该读取该文档
- 调用入口文件：列出 AGENTS.md 和 / 或 CLAUDE.md
- 规则：具体规则内容

如果项目只有一个入口文件，也可以只列出现存入口文件；后续补齐另一个入口文件时，再同步更新这一节。

### 5. 定向更新记忆

当 agent 主动判断需要更新记忆，或用户明确触发“更新记忆”时：

1. 先查看当前项目变更。
2. 判断变更影响哪个专题。
3. 只更新相关专题文档。
4. 如新增主题不存在，新增对应专题文档到 code-helper-docs/user-rules/。
5. 如 code-helper-docs/ 或 code-helper-docs/user-rules/ 不存在，先创建目录。
6. 如入口索引缺失，再更新已存在的 AGENTS.md 和 / 或 CLAUDE.md。
7. 如用户明确要求双入口同步，补齐缺失入口文件并保持索引一致。
8. 不整份覆盖所有文档。
9. 不把短期任务状态写进长期记忆。

### 6. 新功能、小节点或重构后的固定判断

如果刚完成新功能、小节点或重构，先判断是否形成稳定规则。

如果这次变更形成了新的项目规则、协作约束、测试策略、发布流程或长期偏好，必须询问用户是否更新记忆。

只有用户确认后，才根据当前 diff 或用户描述定向更新专题文档。

### 7. 校验

写入文件后检查：

- CLAUDE.md 是否仍然是轻量入口，如果存在。
- AGENTS.md 是否仍然是轻量入口，如果存在。
- 两个入口文件同时存在时，专题规则索引是否一致指向 code-helper-docs/user-rules/。
- 目标专题目录是否正确：固定为 code-helper-docs/user-rules/。
- code-helper-docs/ 和 code-helper-docs/user-rules/ 是否已在需要写入时创建。
- 每份 .md 是否都有“功能描述 / 调用时机 / 调用入口文件 / 规则”。
- 专题文档路径是否被现有入口文件正确引用。
- 是否误把一次性任务、临时实现方案、当前调试状态写入长期文档。

## 输出格式

### 仅输出草案时

使用以下结构：

- 记忆优化草案
- 入口文档调整
- 专题文档调整
- 定向更新规则
- 待确认问题

### 写入文件后

使用以下结构：

- 已完成记忆优化
- 更新 AGENTS.md / CLAUDE.md 的情况
- 新增或更新 code-helper-docs/user-rules/xxx.md 的情况
- 保留入口文档为轻量索引
- 已按当前变更定向更新对应专题文档
- 校验结果

## 边界规则

- 不要把 AGENTS.md 或 CLAUDE.md 写成大而全的长文档。
- 不要为了更新一个规则而整份覆盖所有专题文档。
- 不要把临时任务进度、一次性 debug 过程、未稳定的实现细节写入长期记忆。
- 不要在用户未确认时批量改文件。
- 不要把可从代码直接推导的细节无差别写进记忆。
- 如果规则已经存在，优先编辑原专题文档，不重复创建相似文件。
- 如果当前变更和已有专题都不匹配，再新增专题文档。
- 不要让 AGENTS.md 和 CLAUDE.md 对同一规则给出不同路径或不同要求。`
    },
    {
      fileName: "plan-workbench.SKILL.md",
      content: `---
name: code-helper-plan-workbench
description: 当用户提供完整需求文档，并要求拆分开发计划、迁移计划、阶段计划、任务记录、执行计划、跨模块协作计划或长期项目计划时必须使用。该 skill 要把需求转成可持续推进的 plan-doc、result-doc、status-doc 和必要的测试/验收文档；必须先总纲后细化，按依赖链路排序，区分基础能力、核心实现、集成验证和发布整理，并保留状态枚举、阻塞点、后续检查点和下一步建议。
---

# Code Helper 计划管理

## 目标

当需要为迁移、升级、重构、多阶段功能建设、平台能力建设、数据任务、CLI 工具、后端服务、前端页面或长期协作任务生成计划文档时，输出不能只是“可阅读”的说明文档，而必须是能持续推进、记录阻塞、便于复查、恢复上下文的执行计划。

## 适用场景

- 旧项目迁移到新框架、新架构、新运行环境或新交付流程
- 大型功能、平台能力、数据链路、工具链或服务能力分阶段建设
- 技术债清理与结构重构
- 多模块、多系统、多角色或多数据流存在明显依赖关系的任务
- 涉及需求拆解、接口契约、数据模型、权限规则、任务编排、交付验收或上线整理的任务
- 需要长期推进、多人协作或中途暂停再恢复的任务
- 用户要求生成计划文档、阶段计划、执行计划、状态记录或计划优化

## 最终产物

默认生成或维护以下文件：

- code-helper-docs/plan-doc/<中文功能名>.md：执行计划文档
- code-helper-docs/result-doc/<中文功能名>/实施记录.md：阶段或小节点实施记录
- code-helper-docs/status-doc/<中文功能名>-状态.md：当前状态记录
- code-helper-docs/result-doc/<中文功能名>/手工测试.md：仅当需求涉及页面、可视化、浏览器链路或需要人工验收时生成

所有最终产物必须使用中文命名，并在文档内使用中文总结当前目标、完成情况、验证结论、风险和下一步。

最终计划必须同时具备：

1. 总纲
2. 分层顺序
3. 模块或能力拆分
4. 依赖与集成计划
5. 验收标准
6. 状态记录
7. 阻塞点和后续检查点
8. 下一步建议

## 标准生成顺序

### Step 1：确认目标与约束

先明确：

- 项目最终目标
- 当前最重要的优先级
- 当前阶段边界
- 必须写进计划的验收标准
- 用户补充约束
- 当前仓库现状和已有入口规则

输出主原则、总体约束和阶段边界。

### Step 2：先出总纲计划

先只输出：

- P0 / P1
- 总阶段顺序
- 每阶段目标
- 总体验收口径

不要一开始直接写细表。

### Step 3：按依赖关系重排顺序

必须按依赖链路重排，而不是按需求文档出现顺序、界面直觉或个人偏好排序。

通用推荐顺序：

1. 目标、范围、非目标和验收口径
2. 现状盘点、影响面和风险边界
3. 基础结构、目录、配置、环境和权限前置
4. 数据模型、类型定义、接口契约或输入输出协议
5. 核心业务规则、领域逻辑、状态流转或任务编排
6. 关键模块、服务、命令、页面、组件或数据处理单元
7. 集成路径、调用链路、兼容策略和迁移策略
8. 验证方案、测试数据、回归范围和人工验收点
9. 发布、灰度、回滚、监控、文档和交接整理

输出真实执行顺序和每层依赖说明。

### Step 4：做目录或模块级策略

先分析当前项目结构，输出：

- 可整包前置迁移或前置建设的目录 / 模块
- 需要拆分推进的目录 / 模块
- 强依赖后置目录 / 模块
- 建议暂时跳过项

输出目录优先级策略、迁移或建设顺序、暂时跳过项。

### Step 5：生成基础阶段计划

基础阶段按项目类型选择覆盖：

- 目录、配置、构建、运行环境或部署前置
- 类型定义、数据模型、协议、schema 或接口契约
- 权限、认证、配置、环境变量、存储或外部依赖
- 核心抽象、公共工具、基础服务或共享模块
- 最小可运行链路或最小可验证流程

基础阶段不能只写目标，必须也有可执行任务表。

### Step 6：拆分核心实现计划

按需求实际形态拆分核心实现，不预设一定是前端页面或组件。根据项目类型选择合适维度：

1. 功能模块或领域能力
2. 接口、命令、任务、作业、页面、组件、数据流或服务单元
3. 数据模型、状态流转、权限规则或业务规则
4. 外部系统、第三方依赖或上下游契约
5. 单元级 checklist
6. 模块组真实执行顺序
7. 模块组总览表和逐模块执行表

### Step 7：生成集成与验收计划

核心模块计划完成后，再进入集成、联调、验收和完成整理计划。

每个集成或验收对象必须包含：

- 前置依赖
- 执行任务
- 验证方式
- 验收标准
- 完成定义
- 后续检查点

如果需求涉及页面、可视化、浏览器链路或人工业务验收，再补充 UI 验收、功能验收和手工测试文档。否则不要强行生成页面计划。

集成阶段必须先有总览状态表，再有逐项执行表。

### Step 8：改造成执行计划

最终文档必须统一补上：

- 基础阶段总览 + 明细
- 核心实现阶段总览 + 明细
- 集成验收阶段总览 + 明细
- 下一步建议
- 状态枚举规范
- 阻塞和后续检查点

## 表格规范

所有总览表和明细表统一使用 4 列：

| 子任务 | 已完成 | 未完成 | 备注 |
|---|---|---|---|
| 示例 | 已完成内容 | 剩余内容 | 状态：未开始；阻塞原因 / 依赖说明 / 后续检查点 |

备注第一句必须写：

- 状态：未开始
- 状态：进行中
- 状态：部分完成
- 状态：被阻塞
- 状态：已完成

备注还应说明：

- 是否被阻塞
- 阻塞点是什么
- 依赖哪个后续流程
- 后续从哪里继续检查
- 是否允许先跳过继续推进

## 下一步建议

文档前部必须包含“下一步建议”，明确：

1. 现在先做什么
2. 下一步接什么
3. 第一个核心模块或能力何时开始
4. 第一个集成或验收环节何时开始
5. 当前默认执行主线是什么

这样每次打开文档，第一眼就知道下一步。

## 验证与测试规则

- 验证计划必须按任务类型选择，不默认套用前端页面测试。
- 纯逻辑、数据转换、接口契约、CLI 命令、权限规则和后端服务应优先规划可自动执行的单元测试或集成测试。
- 页面、可视化、组件交互、视觉和真实浏览器链路只生成严格手工测试文档。
- 工具自身只执行纯逻辑测试，例如函数单元测试、数据转换测试、非浏览器集成测试。
- 手工测试文档必须包含测试环境、前置数据、操作步骤、预期结果、回归范围和阻塞记录。
- 无法自动验证的业务验收点必须写清楚人工验收人、验收数据、验收步骤和通过标准。

## 状态文档分工

- plan-doc：计划文档，记录阶段、依赖、任务表和验收标准。
- result-doc：实施记录，使用中文总结实际改动、验证结论、临时失败、风险和后续。
- status-doc：当前执行入口，只保留当前状态、当前执行节点、子计划队列、下一步、阶段进度、关键结论、关键索引、仍影响判断的风险点、最近一次更新。

状态文档不是流水账，不写完整命令输出、大段实现过程或已解决的旧风险。
状态文档必须让 agent 在恢复任务时直接知道“现在只推进哪一个子计划”，不能只写泛泛的任务摘要。

## 完成标准

文档满足以下条件才算最终版：

- 有明确总顺序
- 有基础层、核心实现层、集成验收层
- 有与任务类型匹配的自动验证或人工验收方案
- 有总览表和明细表
- 有状态规范
- 有阻塞后的恢复机制
- 有下一步建议
- 能直接拿来推进，而不是还要二次设计

## 边界规则

- 不要创建英文任务文档名，例如 implementation.md、manual-test.md 或 <feature>-status.md；新文档统一使用 实施记录.md、手工测试.md 和 <中文功能名>-状态.md。
- 不要跳过总纲直接写细表。
- 不要把所有需求都套成组件计划或页面计划。
- 不要按界面、文档章节或个人直觉排序，必须按依赖链路排序。
- 不要把页面测试写成默认自动化测试任务。
- 不要把 status-doc 写成历史流水账。
- 不要把所有细节塞进入口规则或状态记录，细节放 result-doc。`
    },
    {
      fileName: "document-archive.SKILL.md",
      content: `---
name: code-helper-document-archive
description: 当用户要求归档功能文档、结束一个功能、查看当前任务状态，或项目中出现 code-helper-docs/plan-doc/archive、code-helper-docs/result-doc/archive、code-helper-docs/status-doc/archive 时使用。必须把 archive 目录中的任务识别为已结束，活动任务和归档任务分开判断；同名任务同时存在 active 和 archive 时标记为 mixed 并要求人工确认。
---

# Code Helper 文档归档

## 目标

在一个项目存在多个功能时，把已完成或已结束的功能文档移入 archive 目录，让当前工作区只保留仍需推进的任务。

## 文档位置

- 活动计划：code-helper-docs/plan-doc/<中文功能名>.md
- 活动结果：code-helper-docs/result-doc/<中文功能名>/
- 活动状态：code-helper-docs/status-doc/<中文功能名>-状态.md
- 活动实施记录：code-helper-docs/result-doc/<中文功能名>/实施记录.md
- 活动手工测试：code-helper-docs/result-doc/<中文功能名>/手工测试.md
- 归档计划：code-helper-docs/plan-doc/archive/<中文功能名>.md
- 归档结果：code-helper-docs/result-doc/archive/<中文功能名>/
- 归档状态：code-helper-docs/status-doc/archive/<中文功能名>-状态.md

## 使用流程

1. 功能完成后，先确认 实施记录.md、手工测试.md 和 status-doc 已用中文记录最终结论。
2. 执行 npx @skrupellose/code-helper archive <中文功能名>，把三类文档移动到对应 archive 目录。
3. 执行 npx @skrupellose/code-helper tasks，确认该中文功能名状态为 archived。
4. 如果用户手动移动了文档到 archive，也把该任务识别为已结束。
5. 如果同名中文功能同时存在 active 和 archive 文档，标记为 mixed，不要直接判断为已完成。

## 状态判断

- active：只在 plan-doc、result-doc、status-doc 顶层存在文档。
- archived：只在 archive 目录存在文档。
- mixed：顶层和 archive 中同时存在同名任务文档，需要人工整理。

## 边界规则

- 归档不覆盖已有 archive 目标。
- 已归档 status-doc 不再作为当前任务入口。
- 新功能不要复用已归档中文功能名。
- 需要返工时，优先新建后续中文功能名，或明确从 archive 恢复后再继续。`
    },
    {
      fileName: "completion-review.SKILL.md",
      content: `---
name: code-helper-completion-review
description: 当 agent 完成小节点、识别到功能变更或项目结构变化、准备最终回复、提交前检查、切换任务、询问是否归档、询问是否更新记忆，或用户要求“检查是否完成”“继续下一个任务”“功能收尾”时必须使用。该 skill 要读取 status-doc、plan-doc、result-doc，判断当前节点是否完成、是否需要继续当前功能、是否需要询问更新长期记忆、是否需要询问归档，并引导选择下一步任务。
---

# Code Helper 完成检查

## 目标

在每次功能开发或小节点推进后，避免 agent 直接进入总结或切换任务。先判断当前工作是否真的完成，再决定继续开发、更新过程文档、询问更新记忆、询问归档或选择下一个任务。

## 固定流程

1. 先读取 code-helper-docs/status-doc/<中文功能名>-状态.md，确认当前执行节点、完成定义、验证方式和子计划队列。
2. 再读取 code-helper-docs/plan-doc/<中文功能名>.md 和 code-helper-docs/result-doc/<中文功能名>/实施记录.md。
3. 当前节点未完成时，继续当前功能；不要询问归档，不要引导新任务。
4. 当前节点完成但功能整体未完成时，更新实施记录、计划文档状态和 status-doc 的下一个执行节点。
5. 识别到功能变更、项目结构变化、测试策略变化、发布流程变化或稳定协作规则时，主动询问用户是否更新长期记忆。
6. 只有功能整体完成并经用户确认后，才询问是否归档文档。
7. 归档后再查看活动任务，并引导用户选择下一步。

## 命令辅助

- 使用 \`npx @skrupellose/code-helper finish <中文功能名> --check-only\` 做收尾检查。
- 该命令只输出判断和建议，不自动更新记忆、不自动归档、不自动提交。
- 如果缺少功能名，优先从活动任务列表选择，不要求用户凭记忆输入。
- 命令输出中的“必须确认事项”是最终回复前必须处理的强制清单，不能被普通总结覆盖。

## 用户确认边界

- 可以自动更新 result-doc、plan-doc 和 status-doc 中属于当前任务过程的内容。
- 更新长期记忆前必须询问用户。
- 文档归档前必须询问用户。
- 需要选择下一任务时，必须先列出活动任务并询问用户。
- git commit、npm publish 等外部动作前必须询问用户。

## 判断原则

- 长期记忆只记录稳定规则，不记录一次性实现细节。
- 页面、可视化和真实浏览器链路仍只生成手工测试文档。
- Agent hooks 只作为提醒和兜底检查，不替代 agent 自己判断。
- Git hooks 只做提交前检查，不承担对话完成判断。`
    }
  ];
}

/**
 * 返回可选 hook 模板。
 * Git hooks 和 Agent hooks 分别受不同功能开关控制，避免概念混用。
 */
export function getHookTemplates(): Array<{ fileName: string; content: string; feature: FeatureKey }> {
  return [
    {
      fileName: "pre-commit.sample",
      feature: "gitHooks",
      content: `#!/bin/sh
# code-helper 可选 pre-commit 模板。
# 启用方式：复制到 .git/hooks/pre-commit 并添加可执行权限。
# code-helper:managed-pre-commit
npx @skrupellose/code-helper check
`
    },
    {
      fileName: "agent-finish-check.mjs.sample",
      feature: "agentHooks",
      content: `#!/usr/bin/env node
/**
 * code-helper Agent hook 示例。
 * 适合接到 Codex / Claude Code 等 agent 的 Stop、收尾或提交前生命周期事件中。
 * 该脚本只运行完成检查，不自动修改文件、不归档、不更新长期记忆。
 */
import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["@skrupellose/code-helper", "finish", "--check-only"], {
  cwd: process.cwd(),
  encoding: "utf8"
});

if (result.stdout.trim() !== "") {
  console.log(result.stdout.trim());
}

if (result.stderr.trim() !== "") {
  console.error(result.stderr.trim());
}

process.exit(result.status ?? 0);
`
    },
    {
      fileName: "agent-hooks.md.sample",
      feature: "agentHooks",
      content: `# code-helper Agent hooks 模板

## 用途

Agent hooks 用于在 agent 准备最终回复、停止任务、提交前检查或切换任务前，提醒运行完成检查。

## 推荐命令

\`\`\`bash
node .code-helper/hooks/agent-finish-check.mjs
\`\`\`

如果所在 agent 工具支持分别配置 macOS/Linux 和 Windows 命令，Windows 可以使用：

\`\`\`powershell
node .code-helper\\hooks\\agent-finish-check.mjs
\`\`\`

## 行为边界

- hook 只运行 \`code-helper finish --check-only\`。
- hook 不自动更新长期记忆。
- hook 不自动归档文档。
- hook 不自动提交代码。
- agent 仍需要根据输出主动询问用户是否更新记忆、归档或选择下一任务。

## code-helper 安装命令

\`\`\`bash
npx @skrupellose/code-helper hooks install codex
npx @skrupellose/code-helper hooks install claudecode
\`\`\`
`
    }
  ];
}

/**
 * 判断功能是否启用。
 * 这个小工具让调用方不需要直接访问配置内部结构。
 */
export function isFeatureEnabled(config: CodeHelperConfig, feature: FeatureKey): boolean {
  return config.features[feature]?.enabled === true;
}
