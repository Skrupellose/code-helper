# code-helper

`code-helper` 是一个面向 agent 协作项目的 CLI，用于初始化协作规则、生成计划和验收模板、记录执行状态，并在任务结束前检查是否还有未处理事项。工具适用于绝大部分编程语言项目，可把 8 个内置 Skills 注册给 Codex、Claude Code、GitHub Copilot 和 Grok Build，并为项目生成 Git 提交信息规范。

## 运行环境

`code-helper` 运行环境需要 Node.js `>=22.13.0`，文档数据库使用 Node 内置的 `node:sqlite`。\
code-helper 通过 npm 分发，所以本机需要能运行 Node 和 `npx`；

## 快速开始

优先用正式包名直接运行（打开交互菜单）：

```bash
npx @skrupellose/code-helper
```

也可以直接执行子命令：

```bash
npx @skrupellose/code-helper init
npx @skrupellose/code-helper update
```

希望每次都拉最新 CLI 时，在包名后加 `@latest`：

```bash
npx @skrupellose/code-helper@latest
npx @skrupellose/code-helper@latest init
```

Go、Java、Python 等非 Node 项目同样用上面的 `npx` 方式即可，**无需** `package.json`，也**无需** `npm i -D`。

### 可选：安装到项目开发依赖

仅在需要固定版本、CI/脚本复现，或希望本机解析本地 `npx code-helper` 短命令时，再把包装进 Node 项目：

```bash
npm i -D @skrupellose/code-helper
npx code-helper init
```

本地装好后，可用短形式 `npx code-helper <命令>`。需要把常用命令写入 `package.json` 时，可以执行：

```bash
npx @skrupellose/code-helper npm-scripts install
```

初始化会根据当前项目已有的 `AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`、`.grok/` 资产和受控注册状态判断要维护的 agent 工具。无法判断时，交互式初始化会让你选择目标；非交互环境会保守跳过项目级 Skills 和 Agent hooks。

需要从安装、一级功能到 Skills 开发工作流完整理解使用方式，可以阅读 [最佳实践指南](docs/最佳实践指南.md)。

## 常用命令

```bash
npx @skrupellose/code-helper init
npx @skrupellose/code-helper update
npx @skrupellose/code-helper version
npx @skrupellose/code-helper version status
npx @skrupellose/code-helper npm-scripts install
npx @skrupellose/code-helper plan docs/订单管理需求.md 订单管理升级
npx @skrupellose/code-helper manual-test 订单管理升级
npx @skrupellose/code-helper record 轻量修复复盘
npx @skrupellose/code-helper finish 订单管理升级
npx @skrupellose/code-helper archive 订单管理升级
npx @skrupellose/code-helper tasks
npx @skrupellose/code-helper documents migrate
npx @skrupellose/code-helper documents import
npx @skrupellose/code-helper documents export
npx @skrupellose/code-helper check
```

无参数运行会打开交互菜单。菜单主要解决**项目准备**与**工具能力管理**，降低心智负担：

- **项目准备**：初始化/刷新项目配置
- **工具设置**：功能管理、管理项目 Skills、管理 Hooks
- （可选顶部）发现新版本时出现「安装或升级到最新版本」快捷项

任务推进与项目维护（`plan` / `manual-test` / `finish` / `tasks` / `archive` / `check`）**已移出交互菜单**，优先对 agent 说自然语言，由 agent 按项目规则和适用 Skills 执行；必要时仍可调用保留的 CLI 子命令，供脚本与精确复现。

升级迁移：数字兜底菜单中，旧版的 `8`（功能管理）、`9`（管理项目 Skills）、`10`（管理 Hooks）已分别调整为 `2`、`3`、`4`；旧版 `2`–`7` 对应的任务推进与项目维护入口已移出主菜单，请改为对 agent 说明需求，或使用上方保留的 CLI 子命令。

交互菜单支持方向键移动，空格或回车确认。不支持按键交互的终端会回退为数字菜单。

不带功能名运行 `manual-test`、`finish` 或 `archive` 时，TTY 终端会优先展示当前活动任务列表；仍然支持直接传入中文功能名。

### 升级

优先用 `@latest` 拉最新 CLI，并刷新当前项目资产：

```bash
npx @skrupellose/code-helper@latest update
```

若项目内已 `npm i -D` 安装，也可先升级本地依赖再刷新：

```bash
npm i -D @skrupellose/code-helper@latest
npx code-helper update
```

菜单顶部的快捷升级项适用于存在 `package.json` 的 Node 项目；选择后会按项目包管理器安装或升级本地开发依赖，再调用新版 `update` 刷新当前项目资产。没有 `package.json` 时，用上面的 `@latest` 命令。

## 功能概览

交互菜单内的能力：

| 菜单路径 | 作用 |
| -------- | ---- |
| 项目准备 / 初始化/刷新项目配置 | 创建或更新协作入口、规则模板、项目级 skills 和可选 hooks |
| 工具设置 / 功能管理 | 应用或取消项目级 Skills、Agent hooks 和 Git hook |
| 工具设置 / 管理项目 Skills | 查看、注册、取消注册、检查或分析项目级 skills |
| 工具设置 / 管理 Hooks | 查看、安装或卸载 code-helper 管理的 Git / Agent hooks |

任务类能力（优先自然语言 / skills；CLI 作补充）：

| 命令 | 作用 |
| ---- | ---- |
| `plan` | 根据需求文档创建计划、状态记录和执行记录模板，供 agent 继续完善 |
| `manual-test` | 创建人工验收测试模板，供 agent 根据页面和流程补充步骤 |
| `record` | 为已完成且具有复盘价值的直接执行任务创建完成记录模板 |
| `finish` | 检查当前任务是否满足完成条件，并提示后续动作 |
| `archive` | 将 SQLite 任务状态更新为 archived，并同步兼容 Markdown 视图 |
| `tasks` | 查看 SQLite 权威任务状态；旧项目继续兼容 Markdown 扫描 |
| `documents` | 预览/导入旧文档、导出兼容 Markdown、检查 SQLite 完整性 |
| `check` | 检查协作文档结构是否完整 |

其他常用 CLI：

| 命令 | 作用 |
| ---- | ---- |
| `update` | 按当前项目已启用或已安装的能力刷新 code-helper 本地资产 |
| `version` | 查看版本，选择 Stable/Canary 通道并检查 npm 发布状态 |
| `npm-scripts install` | 写入常用 npm scripts，仅适合已有 `package.json` 的 Node/npm 项目 |
| `skills` | 查看、注册、取消注册或检查项目级 skills（也可从菜单进入） |
| `hooks` | 查看、安装或卸载 code-helper 管理的 Git / Agent hooks（也可从菜单进入） |

## 会创建或更新的文件

初始化后，工具可能会创建或更新以下受控内容：

| 路径                                | 用途                    |
| --------------------------------- | --------------------- |
| `.code-helper/code-helper.sqlite` | 任务、文档、修订历史和验证记录的权威数据库 |
| `.code-helper/version-policy.json` | 项目选择的 Stable/Canary 通道策略 |
| `.code-helper/`                   | 其他工具配置、受控模板和可选检查输出      |
| `code-helper-docs/user-rules/`    | 长期协作规则                |
| `code-helper-docs/plan-doc/`      | 任务计划文档                |
| `code-helper-docs/result-doc/`    | 执行记录和手工测试文档           |
| `code-helper-docs/status-doc/`    | 当前任务状态记录              |
| `code-helper-docs/completion-record/` | 直接执行任务的终态完成记录        |
| `AGENTS.md`                       | Codex / Grok Build 项目入口文档 |
| `CLAUDE.md`                       | Claude Code 项目入口文档    |
| `.github/copilot-instructions.md` | GitHub Copilot 项目入口文档 |
| `.agents/skills/code-helper-*`    | Codex 项目级 Skills       |
| `.claude/skills/code-helper-*`    | Claude Code 项目级 Skills |
| `.github/skills/code-helper-*`    | GitHub Copilot 项目级 Skills |
| `.grok/skills/code-helper-*`      | Grok Build 原生项目级 Skills |

入口文档只更新 `<!-- code-helper:start -->` 和 `<!-- code-helper:end -->` 之间的受控区块，不会覆盖用户已有内容。

## 任务文档

`plan` 默认把三类文档写入 SQLite，并同步生成以下 Markdown 兼容视图：

- `code-helper-docs/plan-doc/<中文功能名>.md`
- `code-helper-docs/result-doc/<中文功能名>/实施记录.md`
- `code-helper-docs/status-doc/<中文功能名>-状态.md`

页面、可视化、浏览器链路或人工业务验收场景，可以用 `manual-test` 单独创建手工测试模板：

- `code-helper-docs/result-doc/<中文功能名>/手工测试.md`

SQLite 是初始化后项目的任务与文档权威来源；Markdown 用于人工阅读、Git 审阅和旧工具兼容。默认导出不会覆盖导出后被手工修改的文件，只有显式 `documents export --force` 才允许覆盖。

Agent 或用户编辑 Markdown 兼容视图后，先运行 `documents import` 预览；只有磁盘文件基于上次导出且数据库没有同时变化时，`documents import --apply` 才会创建新的 SQLite revision。双边变化或缺少导出基线会保持冲突，不自动猜测覆盖方向。

旧项目升级时先运行 `documents migrate` 只读预览；确认没有 mixed 生命周期或正文冲突后，再运行 `documents migrate --apply`。已完成任务使用 `archive` 更新数据库状态并同步 `archive/` 兼容视图；未建立数据库的旧项目仍保留原有目录扫描行为。

## 正式版与测试版

- Stable（正式版）：无预发布后缀，发布到 npm `latest` 和 `stable` 标签。
- Canary（测试版）：版本必须形如 `x.y.z-canary.n`，只发布到 npm `canary` 标签。
- 发布顺序采用 Canary-first：目标能力必须先有规范 Canary 标签和可校验制品，才能触发 Stable 发布。
- `version status` 只读展示本地版本与项目通道；`version set stable|canary` 仅保存偏好；`version check` 显式联网校验标签、精确版本和包完整性元数据。

选择测试通道后可使用 `npx @skrupellose/code-helper@canary`；正式使用继续采用 `@latest`。通道切换不会自动安装、发布或移动远端标签。

发布 workflow 的包上传继续使用 Trusted Publishing/OIDC；由于 `npm dist-tag add` 是独立写操作，GitHub `npm-publish` environment 还需要配置仅限当前包、仅含 dist-tag 所需写权限且短有效期的 `NPM_DIST_TAG_TOKEN`，不要复用高权限长期发布 token。

直接执行任务如果已经完成、没有后续阶段，但收尾时发现具有跨模块改动、较长验证链或重要决策等复盘价值，可以让 agent 生成独立完成记录：

```bash
npx @skrupellose/code-helper record 轻量修复复盘
```

完成记录写入 `code-helper-docs/completion-record/<中文功能名>-完成记录.md`，创建即为 `recorded` 终态。它不属于活动任务，不要求补齐 plan/status/result，也不需要再次归档。普通轻量任务不强制生成完成记录；仍有后续阶段或阻塞的任务应升级为计划跟踪。

## 完成检查

完成小节点、识别到功能变更、准备最终回复或切换任务前，可以运行：

```bash
npx @skrupellose/code-helper finish 订单管理升级 --check-only
```

`finish` 只输出完成判断和后续建议，不会自动更新长期记忆、归档文档、提交代码或发布包。更推荐对 agent 说“完成前做一次收尾检查”，由 agent 走完成检查相关 skills。

## Git 提交信息规范

初始化或更新项目后，内置规则会说明提交格式：

```text
<type>(<scope>): <subject>
<type>(<scope>)!: <subject>
```

普通提交使用第一种格式，Breaking change 使用第二种格式；`scope` 始终必填。`type` 和 `scope` 使用英文，`subject` 与 `body` 默认使用中文，命令、API、包名和平台名保留原始英文。版本发布使用 `chore(release): 发布 <version>`；不同逻辑主题应按可独立验证、独立回滚的边界拆分提交。

当前规范由用户和 agent 在提交前执行，项目尚未内置 commitlint 或 `commit-msg` hook 自动强制格式。

## 8 个内置 Skills

初始化并注册 Skills 后，用户优先用自然语言描述目标即可：

- “把需求拆成可执行计划”对应 `code-helper-plan-workbench`。
- “补一份人工验收清单”对应 `code-helper-manual-test-workbench`。
- “先只读 review 最近改动”对应 `code-helper-review-fix`。
- “完成前检查是否还有遗漏”对应 `code-helper-completion-review`。
- “这个直接执行任务已经完成，但值得留一份复盘记录”对应 `code-helper-completion-record`。
- “这个功能完成后先问我是否归档”对应 `code-helper-document-archive`。
- “把稳定规则整理成长期记忆草案”对应 `code-helper-memory-tuning`。
- “按多 agent 协作规范拆分和审阅”对应 `code-helper-agent-collaboration`。

代码审查与修复遵循固定闭环：先只读 review 并输出稳定 Finding ID；用户明确说“修复 RF-P1-001”或“按 findings 依次修复”后才允许修改；修复完成后继续沿用原 Finding ID 逐项复审。单纯说“看看有什么问题”不构成修复授权。

多 Agent 协作按风险和复杂度分级：T0/T1 默认由主会话直接完成，T2 默认使用一个实现子 Agent，T3 默认使用一个实现子 Agent和一个独立复核子 Agent。单个逻辑交付点默认最多触发 4 个子 Agent 任务和一轮独立完整审查；达到原始完成定义且当前阻断项关闭后停止自动扩修。计划任务会在关键里程碑输出当前节点、完成定义进度、剩余门禁、后续优化、下一步和 Agent 使用摘要。

## 可选 Agent 集成

```bash
npx @skrupellose/code-helper skills register
npx @skrupellose/code-helper skills register codex
npx @skrupellose/code-helper skills register claudecode
npx @skrupellose/code-helper skills register githubcopilot
npx @skrupellose/code-helper skills register grok
npx @skrupellose/code-helper hooks install codex
npx @skrupellose/code-helper hooks install claudecode
```

`skills register` 会把 code-helper 的项目级 skills 注册到对应 agent 工具目录：Codex 使用 `.agents/skills`，Claude Code 使用 `.claude/skills`，GitHub Copilot 使用 `.github/skills`，Grok Build 使用原生 `.grok/skills`。`grok-build` 也可作为 `grok` 的 CLI 别名。

不带 target 时，会按当前项目已有资产和受控注册状态推断目标。`AGENTS.md` 同时可被 Codex 与 Grok Build 读取：已有 Grok-only 受控注册时会延续 Grok 且不误增 Codex；仅出现 `.grok/` 资产时会启用 Grok，但若同时有无明确归属的 `AGENTS.md`，仍会保守推断 Codex。传 `all` 时强制注册全部四类目标。Grok Build 兼容读取 Claude Code 资产，但 code-helper 仍以用户显式选择的原生目标和目录为准，不假设同名 Skill 的发现优先级。

`hooks install` 只安装指定目标的 hook。Agent hooks 当前只支持 Codex 和 Claude Code；GitHub Copilot 与 Grok Build 均不在支持范围。Git hook 需要显式执行 `hooks install git`，初始化不会自动安装 Git hook。

## 本地验证

```bash
npm test
npm pack --dry-run
```

`npm pack` 前会自动执行构建，避免发布包依赖本地残留的 `dist/`。
