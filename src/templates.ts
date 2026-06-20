import type { CodeHelperConfig, FeatureKey } from "./types.js";

/**
 * 生成入口文档中的 code-helper 受控区块。
 * 区块只放索引和硬约束，不把详细规范塞进入口文件。
 */
export function renderEntryBlock(config: CodeHelperConfig): string {
  const enabledRules = [
    config.features.memoryTuning.enabled
      ? `- 项目记忆规则优化：整理或更新 \`AGENTS.md\` / \`CLAUDE.md\` 时，读取 \`${config.directories.userRules}/项目记忆规则优化.md\`。`
      : undefined,
    config.features.planWorkbench.enabled
      ? `- 项目计划优化：开始大型需求、迁移、重构或多阶段任务时，读取 \`${config.directories.userRules}/项目计划工作台规范.md\`。`
      : undefined,
    config.features.resultSummary.enabled
      ? `- 执行结果总结：完成小节点后，读取 \`${config.directories.userRules}/执行结果总结规范.md\` 并写入 result-doc。`
      : undefined,
    config.features.testingPolicy.enabled
      ? `- 测试策略约束：涉及页面的测试只生成手工测试文档；工具只执行纯逻辑测试，读取 \`${config.directories.userRules}/测试策略规范.md\`。`
      : undefined,
    config.features.checks.enabled
      ? "- 规则检查：提交或阶段收口前运行 `npx code-helper check`，确认协作文档结构仍完整。"
      : undefined
  ].filter((line): line is string => line !== undefined);

  return `## code-helper 协作入口

### 核心规则

1. 开始新需求、迁移、重构或反馈修复前，先读取本区块索引到的专题规则。
2. 长期规则写入 \`${config.directories.userRules}/\`，短期过程写入 \`${config.directories.resultDoc}/\`，当前驾驶舱写入 \`${config.directories.statusDoc}/\`。
3. 不把一次性调试过程、临时失败细节或大段实现流水写进入口文档。

### 专题规则索引

${enabledRules.join("\n")}

### 文档维护规则

- 入口文档只保留轻量索引和核心约束。
- 专题规则文档必须包含“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。
- 新功能或重构形成稳定规则后，手动执行项目记忆规则优化，不自动把短期任务状态写入长期记忆。`;
}

/**
 * 返回内置专题规则模板。
 * 模板文本放在代码中，确保 npm 包无需额外复制资源也能完成初始化。
 */
export function getRuleTemplates(config: CodeHelperConfig): Array<{ fileName: string; content: string }> {
  const entryFiles = [
    config.entryFiles.agents ? "`AGENTS.md`" : undefined,
    config.entryFiles.claude ? "`CLAUDE.md`" : undefined
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
- 新功能或重构形成稳定协作规则后
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
9. 当用户手动触发更新记忆时，先查看当前变更范围，再只更新相关专题文档。
10. 如新增主题不存在，新增对应专题文档；如入口索引缺失，再更新已存在的入口文件。
11. 不整份覆盖所有文档，不重复创建相似专题，不把一次性任务状态、临时调试过程、完整命令输出或短期计划写进长期记忆。
12. 新功能或重构完成后，不自动更新记忆；只在总结中提醒用户可以手动触发“更新记忆”。

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
      fileName: "项目计划工作台规范.md",
      content: `# 项目计划工作台规范

## 功能描述

把完整需求文档拆成可推进、可记录阻塞、可恢复上下文的执行工作台。

## 调用时机

- 用户提供完整需求文档并要求拆分计划
- 项目迁移、框架升级、多阶段功能建设或技术债清理
- 页面、组件、接口、状态层存在明显依赖关系的任务

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 计划文档写入 \`${config.directories.planDoc}/<feature>.md\`。
2. 执行记录写入 \`${config.directories.resultDoc}/<feature>/implementation.md\`。
3. 当前状态写入 \`${config.directories.statusDoc}/<feature>-status.md\`。
4. 计划必须包含目标、阶段边界、依赖顺序、子任务、验收标准、状态跟踪和当前推进建议。
5. 总览表和明细表统一使用“子任务 / 已完成 / 未完成 / 备注”四列。
6. 备注第一句必须写 \`状态：未开始\`、\`状态：进行中\`、\`状态：部分完成\`、\`状态：被阻塞\` 或 \`状态：已完成\`。
7. 页面相关验收必须拆成 UI 验收和功能验收，并生成手工测试文档。`
    },
    {
      fileName: "执行结果总结规范.md",
      content: `# 执行结果总结规范

## 功能描述

规范小节点完成后的实施记录，保证后续 agent 能恢复上下文并判断风险。

## 调用时机

- 完成一个可交接的小粒度任务后
- 阶段内出现重要阻塞、回滚点或验证结论后
- 准备更新当前状态驾驶舱前

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 结果文档默认写入 \`${config.directories.resultDoc}/<feature>/implementation.md\`。
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
- 阶段收口需要说明测试范围时

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
      fileName: "Agent协作规范.md",
      content: `# Agent 协作规范

## 功能描述

统一多个 agent 在同一项目中的协作入口、状态记录和交接方式。

## 调用时机

- 新 agent 接手项目或恢复上下文
- 开始新任务、拆分计划、记录阶段结果或检查规则
- 多人或多 agent 交替推进同一项目时

## 调用入口文件

${entryFiles.map((file) => `- ${file}`).join("\n")}

## 规则

1. 开始任务前先读入口文档和相关专题规则。
2. 大任务先生成计划工作台，再进入实现。
3. 小节点完成后写结果总结，避免只把结论留在对话里。
4. 当前仍影响决策的信息写入 status-doc，历史细节写入 result-doc。
5. 不覆盖用户已有规则；确需重写时先说明变更范围和原因。`
    }
  ];
}

/**
 * 返回内置 skill 文件模板。
 * 这些模板放到 `.agent/code-helper/skills`，方便用户复制到具体 agent 的 skill 目录。
 */
export function getSkillTemplates(): Array<{ fileName: string; content: string }> {
  return [
    {
      fileName: "memory-tuning.SKILL.md",
      content: `---
name: code-helper-memory-tuning
description: 当用户要求“更新记忆”“优化记忆”“沉淀规则”“整理 AGENTS.md”“整理 CLAUDE.md”“同步 AGENTS.md 和 CLAUDE.md”“拆分项目规则文档”“把当前变更写入记忆”时必须使用。该 skill 同时识别 AGENTS.md 与 CLAUDE.md，把项目记忆维护为轻量入口文档 + .agent/user-rules/ 专题规则文档；如果 .agent/ 或 .agent/user-rules/ 不存在则按需创建，避免整份覆盖、重复建档或把入口文件写成大而全的长文档。新功能或重构完成后，也用它提醒用户手动触发记忆更新。
---

# Code Helper Memory Tuning

## 目标

将项目记忆维护为清晰、可持续、可按需读取的结构：

1. AGENTS.md 和 CLAUDE.md 都视为项目记忆入口文件。
2. 入口文件只保留项目概览、核心规则、常用命令、专题规则索引和文档维护规则。
3. 具体规则默认拆分到 .agent/user-rules/ 下的专题文档。
4. 如果 .agent/ 或 .agent/user-rules/ 不存在，写入时先创建目录。
5. 每份专题文档统一包含“功能描述 / 调用时机 / 调用入口文件 / 规则”。
6. 用户手动触发更新记忆时，根据当前项目变更定向更新对应专题文档。
7. 新功能或重构完成后，不自动更新记忆；在总结中提醒用户手动触发。

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
- 把规则拆到 .agent/user-rules

## 输入

执行前需要获得或确认：

- 当前项目根目录。
- 当前入口记忆文件内容：AGENTS.md 和 CLAUDE.md，如果存在。
- 当前 .agent/user-rules/ 目录内容。
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
- .agent/user-rules/ 下已有专题文档
- 必要时查看当前 diff 或相关代码文件

不要直接假设文件存在。

- 若 AGENTS.md 和 CLAUDE.md 都存在：同时识别二者，并保持入口索引、文档维护规则和专题规则路径一致。
- 若只存在其中一个入口文件：优先优化已有入口文件；只有用户明确要求双入口时，再创建缺失的入口文件。
- 若两个入口文件都不存在：先输出入口文档草案；只有用户明确要求写入时，默认创建 AGENTS.md，并按用户要求决定是否同时创建 CLAUDE.md。
- 若 .agent/ 不存在：写入专题规则前创建 .agent/。
- 若 .agent/user-rules/ 不存在：写入专题规则前创建 .agent/user-rules/。

### 3. 整理入口记忆文件

AGENTS.md 和 CLAUDE.md 都只保留以下内容：

- 项目基本信息
- 基础规则
- 常用命令
- 专题规则文档索引
- 文档维护规则

避免在入口文件中保留大段实现细节、长示例、完整规范说明、一次性调试过程或短期任务状态。

入口索引推荐格式：

- 文件命名规范：新增文件、拆分模块或创建专题文档时，读取 .agent/user-rules/文件命名规范.md
- API 请求规范：新增或修改接口请求时，读取 .agent/user-rules/API请求规范.md
- 错误处理规范：处理异步异常或统一兜底提示时，读取 .agent/user-rules/错误处理规范.md

当两个入口文件同时存在时：

- 保持专题规则索引路径一致，统一指向 .agent/user-rules/。
- 保持文档维护规则一致。
- 允许入口文件保留面向具体工具的少量表述差异，例如 CLAUDE.md 可写 Claude，AGENTS.md 可写 Agent，但不要让规则含义分叉。

### 4. 拆分专题文档

专题文档固定放在 .agent/user-rules/。

每个专题文档必须包含：

- 一级标题：专题名称
- 功能描述：说明该文档解决什么问题，为什么存在
- 调用时机：说明 AI 编码助手在什么场景下应该读取该文档
- 调用入口文件：列出 AGENTS.md 和 / 或 CLAUDE.md
- 规则：具体规则内容

如果项目只有一个入口文件，也可以只列出现存入口文件；后续补齐另一个入口文件时，再同步更新这一节。

### 5. 定向更新记忆

当用户手动触发“更新记忆”时：

1. 先查看当前项目变更。
2. 判断变更影响哪个专题。
3. 只更新相关专题文档。
4. 如新增主题不存在，新增对应专题文档到 .agent/user-rules/。
5. 如 .agent/ 或 .agent/user-rules/ 不存在，先创建目录。
6. 如入口索引缺失，再更新已存在的 AGENTS.md 和 / 或 CLAUDE.md。
7. 如用户明确要求双入口同步，补齐缺失入口文件并保持索引一致。
8. 不整份覆盖所有文档。
9. 不把短期任务状态写进长期记忆。

### 6. 新功能或重构后的固定提示

如果刚完成新功能或重构，不自动更新记忆；在最终总结中固定提醒：

如果这次功能或重构形成了新的项目规则，可以手动让我“更新记忆”，我会根据当前结构定向更新对应的专题规则文档。

只有用户明确触发“更新记忆”后，才根据当前 diff 或用户描述定向更新专题文档。

### 7. 校验

写入文件后检查：

- CLAUDE.md 是否仍然是轻量入口，如果存在。
- AGENTS.md 是否仍然是轻量入口，如果存在。
- 两个入口文件同时存在时，专题规则索引是否一致指向 .agent/user-rules/。
- 目标专题目录是否正确：固定为 .agent/user-rules/。
- .agent/ 和 .agent/user-rules/ 是否已在需要写入时创建。
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
- 新增或更新 .agent/user-rules/xxx.md 的情况
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
description: 当用户提供完整需求文档并要求拆分开发计划、阶段计划、状态跟踪或执行工作台时使用。必须生成 plan-doc、result-doc 和 status-doc 的清晰分工。
---

# Code Helper Plan Workbench

## 工作流

1. 先确认需求目标、阶段边界、约束和验收标准。
2. 按依赖顺序拆分计划，不按页面直觉排序。
3. 计划文档写入 .agent/plan-doc/，结果记录写入 .agent/result-doc/，当前状态写入 .agent/status-doc/。
4. 页面验收生成手工测试文档，工具只执行纯逻辑测试。
5. 每个阶段保留当前推进建议、阻塞入口和完成定义。`
    }
  ];
}

/**
 * 返回可选 Git hooks 模板。
 * 首版不默认安装，只放在工作区供用户手工启用。
 */
export function getHookTemplates(): Array<{ fileName: string; content: string }> {
  return [
    {
      fileName: "pre-commit.sample",
      content: `#!/bin/sh
# code-helper 可选 pre-commit 模板。
# 启用方式：复制到 .git/hooks/pre-commit 并添加可执行权限。
npx code-helper check
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
