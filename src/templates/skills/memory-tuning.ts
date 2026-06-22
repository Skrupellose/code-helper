import type { SkillTemplate } from "./types.js";

export const memoryTuningSkillTemplate: SkillTemplate = {
  fileName: "memory-tuning.SKILL.md",
  content: `---
name: code-helper-memory-tuning
description: 当用户要求“更新记忆”“优化记忆”“沉淀规则”“整理 AGENTS.md”“整理 CLAUDE.md”“同步 AGENTS.md、CLAUDE.md 和 Copilot 入口”“拆分项目规则文档”“把当前变更写入记忆”，或 agent 识别到功能变更、项目结构变化、测试策略变化、发布流程变化、稳定协作规则变化并需要询问是否更新长期记忆时必须使用。该 skill 同时识别 AGENTS.md、CLAUDE.md 与 .github/copilot-instructions.md，把项目记忆维护为轻量入口文档 + code-helper-docs/user-rules/ 专题规则文档；如果 code-helper-docs/ 或 code-helper-docs/user-rules/ 不存在则按需创建，避免整份覆盖、重复建档或把入口文件写成大而全的长文档。
---

# Code Helper Memory Tuning

## 目标

将项目记忆维护为清晰、可持续、可按需读取的结构：

1. AGENTS.md、CLAUDE.md 和 .github/copilot-instructions.md 都视为项目记忆入口文件。
2. 入口文件只保留项目概览、核心规则、常用命令、专题规则索引和文档维护规则。
3. 入口文件中的 \`<!-- code-helper:start -->\` 到 \`<!-- code-helper:end -->\` 受控区块由 code-helper 自动维护；整理或优化入口文件时，绝对不能改动该区块，只能处理区块外内容。
4. 具体规则默认拆分到 code-helper-docs/user-rules/ 下的专题文档。
5. 如果 code-helper-docs/ 或 code-helper-docs/user-rules/ 不存在，写入时先创建目录。
6. 每份专题文档统一包含“功能描述 / 调用时机 / 调用入口文件 / 规则”。
7. 用户确认更新记忆时，根据当前项目变更定向更新对应专题文档。
8. 新功能、小节点或重构形成稳定规则后，agent 主动询问用户是否更新记忆；用户确认前不自动写入长期记忆。

## 使用场景

当用户表达以下意图时，使用本 skill：

- 更新记忆
- 优化记忆
- 整理 AGENTS.md
- 整理 CLAUDE.md
- 整理 .github/copilot-instructions.md
- 同步 AGENTS.md、CLAUDE.md 和 Copilot 入口
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
- 当前入口记忆文件内容：AGENTS.md、CLAUDE.md 和 .github/copilot-instructions.md，如果存在。
- 当前 code-helper-docs/user-rules/ 目录内容。
- 当前项目变更范围，例如 git diff、用户描述的新功能、用户描述的重构内容、用户明确指出要沉淀的规则。
- 用户是否只是要草案，还是要直接写入文件。

## 工作流

### 1. 判断任务类型

先判断用户意图属于哪一类：

- 入口文档整理
- AGENTS.md / CLAUDE.md / Copilot 入口同步
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
- 项目根目录下存在的 .github/copilot-instructions.md
- code-helper-docs/user-rules/ 下已有专题文档
- 必要时查看当前 diff 或相关代码文件

不要直接假设文件存在。

- 若多个入口文件同时存在：同时识别并保持入口索引、文档维护规则和专题规则路径一致。
- 若只存在其中一个入口文件：优先优化已有入口文件；只有用户明确要求多入口同步时，再创建缺失的入口文件。
- 若入口文件都不存在：先输出入口文档草案；只有用户明确要求写入时，默认创建 AGENTS.md，并按用户要求决定是否同时创建 CLAUDE.md 或 Copilot 入口。
- 若 code-helper-docs/ 不存在：写入专题规则前创建 code-helper-docs/。
- 若 code-helper-docs/user-rules/ 不存在：写入专题规则前创建 code-helper-docs/user-rules/。

### 3. 整理入口记忆文件

AGENTS.md、CLAUDE.md 和 .github/copilot-instructions.md 都只保留以下内容：

- 项目基本信息
- 基础规则
- 常用命令
- 专题规则文档索引
- 文档维护规则

避免在入口文件中保留大段实现细节、长示例、完整规范说明、一次性调试过程或短期任务状态。

整理或优化 AGENTS.md、CLAUDE.md、.github/copilot-instructions.md 时，绝对不能改动 \`<!-- code-helper:start -->\` 到 \`<!-- code-helper:end -->\` 之间的受控区块；所有整理、合并、删减、重排和格式化都只允许发生在区块外。不要把用户自定义规则写入受控区块。自定义规则应写在受控区块外；长期规则写入 code-helper-docs/user-rules/。如需改变受控区块内容，应修改 code-helper 模板源后运行 init、update 或 sync-local，让工具重新生成。

入口索引推荐格式：

- 文件命名规范：新增文件、拆分模块或创建专题文档时，读取 code-helper-docs/user-rules/文件命名规范.md
- API 请求规范：新增或修改接口请求时，读取 code-helper-docs/user-rules/API请求规范.md
- 错误处理规范：处理异步异常或统一兜底提示时，读取 code-helper-docs/user-rules/错误处理规范.md

当多个入口文件同时存在时：

- 保持专题规则索引路径一致，统一指向 code-helper-docs/user-rules/。
- 保持文档维护规则一致。
- 允许入口文件保留面向具体工具的少量表述差异，例如 CLAUDE.md 可写 Claude，AGENTS.md 可写 Agent，Copilot 入口可写 GitHub Copilot，但不要让规则含义分叉。

### 4. 拆分专题文档

专题文档固定放在 code-helper-docs/user-rules/。

每个专题文档必须包含：

- 一级标题：专题名称
- 功能描述：说明该文档解决什么问题，为什么存在
- 调用时机：说明 AI 编码助手在什么场景下应该读取该文档
- 调用入口文件：列出 AGENTS.md、CLAUDE.md 和 / 或 .github/copilot-instructions.md
- 规则：具体规则内容

如果项目只有一个入口文件，也可以只列出现存入口文件；后续补齐另一个入口文件时，再同步更新这一节。

### 5. 定向更新记忆

当 agent 主动判断需要更新记忆，或用户明确触发“更新记忆”时：

1. 先查看当前项目变更。
2. 判断变更影响哪个专题。
3. 只更新相关专题文档。
4. 如新增主题不存在，新增对应专题文档到 code-helper-docs/user-rules/。
5. 如 code-helper-docs/ 或 code-helper-docs/user-rules/ 不存在，先创建目录。
6. 如入口索引缺失，再更新已存在的 AGENTS.md、CLAUDE.md 和 / 或 .github/copilot-instructions.md。
7. 如用户明确要求多入口同步，补齐缺失入口文件并保持索引一致。
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
- .github/copilot-instructions.md 是否仍然是轻量入口，如果存在。
- code-helper 受控区块是否逐字保持工具生成内容，没有被记忆优化流程增删、改写、重排、格式化或混入用户自定义规则。
- 多个入口文件同时存在时，专题规则索引是否一致指向 code-helper-docs/user-rules/。
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
- 更新 AGENTS.md / CLAUDE.md / .github/copilot-instructions.md 的情况
- 新增或更新 code-helper-docs/user-rules/xxx.md 的情况
- 保留入口文档为轻量索引
- 已按当前变更定向更新对应专题文档
- 校验结果

## 边界规则

- 不要把 AGENTS.md 或 CLAUDE.md 写成大而全的长文档。
- 记忆优化流程绝对不能改动 code-helper 受控区块；不要把用户自定义规则写入该区块，也不要手工调整、重排或格式化该区块，受控内容只能通过模板源和 init、update 或 sync-local 改变。
- 不要为了更新一个规则而整份覆盖所有专题文档。
- 不要把临时任务进度、一次性 debug 过程、未稳定的实现细节写入长期记忆。
- 不要在用户未确认时批量改文件。
- 不要把可从代码直接推导的细节无差别写进记忆。
- 如果规则已经存在，优先编辑原专题文档，不重复创建相似文件。
- 如果当前变更和已有专题都不匹配，再新增专题文档。
- 不要让 AGENTS.md、CLAUDE.md 和 Copilot 入口对同一规则给出不同路径或不同要求。`
};
