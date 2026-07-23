# code-helper

`code-helper` 是一个面向 agent 协作项目的 CLI，用于初始化协作规则、生成计划和验收模板、记录执行状态，并在任务结束前检查是否还有未处理事项。工具适用于绝大部分编程语言项目，可把 7 个内置 Skills 注册给 Codex、Claude Code、GitHub Copilot 和 Grok Build，并为项目生成 Git 提交信息规范。

## 运行环境

`code-helper` 运行环境需要 Node.js `>=18.18.0`。\
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
npx @skrupellose/code-helper npm-scripts install
npx @skrupellose/code-helper plan docs/订单管理需求.md 订单管理升级
npx @skrupellose/code-helper manual-test 订单管理升级
npx @skrupellose/code-helper finish 订单管理升级
npx @skrupellose/code-helper archive 订单管理升级
npx @skrupellose/code-helper tasks
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
| `finish` | 检查当前任务是否满足完成条件，并提示后续动作 |
| `archive` | 将已结束任务的计划、结果和状态文档移动到 archive |
| `tasks` | 查看 active、archived 和 mixed 状态的任务文档 |
| `check` | 检查协作文档结构是否完整 |

其他常用 CLI：

| 命令 | 作用 |
| ---- | ---- |
| `update` | 按当前项目已启用或已安装的能力刷新 code-helper 本地资产 |
| `version` | 查看当前运行的 code-helper 版本，并在可用时查询 npm latest |
| `npm-scripts install` | 写入常用 npm scripts，仅适合已有 `package.json` 的 Node/npm 项目 |
| `skills` | 查看、注册、取消注册或检查项目级 skills（也可从菜单进入） |
| `hooks` | 查看、安装或卸载 code-helper 管理的 Git / Agent hooks（也可从菜单进入） |

## 会创建或更新的文件

初始化后，工具可能会创建或更新以下受控内容：

| 路径                                | 用途                    |
| --------------------------------- | --------------------- |
| `.code-helper/`                   | 工具配置、受控模板和可选检查输出      |
| `code-helper-docs/user-rules/`    | 长期协作规则                |
| `code-helper-docs/plan-doc/`      | 任务计划文档                |
| `code-helper-docs/result-doc/`    | 执行记录和手工测试文档           |
| `code-helper-docs/status-doc/`    | 当前任务状态记录              |
| `AGENTS.md`                       | Codex / Grok Build 项目入口文档 |
| `CLAUDE.md`                       | Claude Code 项目入口文档    |
| `.github/copilot-instructions.md` | GitHub Copilot 项目入口文档 |
| `.agents/skills/code-helper-*`    | Codex 项目级 Skills       |
| `.claude/skills/code-helper-*`    | Claude Code 项目级 Skills |
| `.github/skills/code-helper-*`    | GitHub Copilot 项目级 Skills |
| `.grok/skills/code-helper-*`      | Grok Build 原生项目级 Skills |

入口文档只更新 `<!-- code-helper:start -->` 和 `<!-- code-helper:end -->` 之间的受控区块，不会覆盖用户已有内容。

## 任务文档

`plan` 默认创建三类模板文档：

- `code-helper-docs/plan-doc/<中文功能名>.md`
- `code-helper-docs/result-doc/<中文功能名>/实施记录.md`
- `code-helper-docs/status-doc/<中文功能名>-状态.md`

页面、可视化、浏览器链路或人工业务验收场景，可以用 `manual-test` 单独创建手工测试模板：

- `code-helper-docs/result-doc/<中文功能名>/手工测试.md`

已完成任务可以用 `archive` 移入对应的 `archive/` 目录。手动移动到 `archive/` 的任务也会被识别为已结束任务。

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

## 7 个内置 Skills

初始化并注册 Skills 后，用户优先用自然语言描述目标即可：

- “把需求拆成可执行计划”对应 `code-helper-plan-workbench`。
- “补一份人工验收清单”对应 `code-helper-manual-test-workbench`。
- “先只读 review 最近改动”对应 `code-helper-review-fix`。
- “完成前检查是否还有遗漏”对应 `code-helper-completion-review`。
- “这个功能完成后先问我是否归档”对应 `code-helper-document-archive`。
- “把稳定规则整理成长期记忆草案”对应 `code-helper-memory-tuning`。
- “按多 agent 协作规范拆分和审阅”对应 `code-helper-agent-collaboration`。

代码审查与修复遵循固定闭环：先只读 review 并输出稳定 Finding ID；用户明确说“修复 RF-P1-001”或“按 findings 依次修复”后才允许修改；修复完成后继续沿用原 Finding ID 逐项复审。单纯说“看看有什么问题”不构成修复授权。

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
