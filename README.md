# code-helper

`code-helper` 是一个面向 agent 协作项目的 CLI，用于初始化协作规则、生成计划文档、记录执行状态，并在任务结束前检查是否还有未处理事项。

## 快速开始

```bash
npx @skrupellose/code-helper
```

首次在项目中使用时，建议先初始化：

```bash
npx @skrupellose/code-helper init
```

初始化会根据当前项目已有的 `AGENTS.md`、`CLAUDE.md` 或 `.github/copilot-instructions.md` 判断要维护的 agent 工具。无法判断时，交互式初始化会让你选择目标；非交互环境会保守跳过项目级 skills 和 agent hooks。

## 常用命令

```bash
npx @skrupellose/code-helper init
npx @skrupellose/code-helper@latest update
npx @skrupellose/code-helper plan docs/订单管理需求.md 订单管理升级
npx @skrupellose/code-helper manual-test 订单管理升级
npx @skrupellose/code-helper finish 订单管理升级
npx @skrupellose/code-helper archive 订单管理升级
npx @skrupellose/code-helper tasks
npx @skrupellose/code-helper check
```

交互菜单支持方向键移动，空格或回车确认。不支持按键交互的终端会回退为数字菜单。

不带功能名运行 `manual-test`、`finish` 或 `archive` 时，TTY 终端会优先展示当前活动任务列表；仍然支持直接传入中文功能名。

交互菜单启动时会轻量检查 npm 上是否有新版本；发现更新时只给出提示，不会自动升级。要把当前项目中的入口、skills 和 hooks 刷新到最新版，运行：

```bash
npx @skrupellose/code-helper@latest update
```

## 功能概览

| 命令 | 作用 |
| --- | --- |
| `init` | 创建或更新协作入口、规则模板、项目级 skills 和可选 hooks |
| `update` | 按当前项目已启用或已安装的能力刷新 code-helper 本地资产 |
| `plan` | 根据需求文档生成计划文档、执行记录和状态记录 |
| `manual-test` | 为页面、可视化或人工验收场景生成手工测试文档 |
| `finish` | 检查当前任务是否满足完成条件，并提示后续动作 |
| `archive` | 将已结束任务的计划、结果和状态文档移动到 archive |
| `tasks` | 查看 active、archived 和 mixed 状态的任务文档 |
| `check` | 检查协作文档结构是否完整 |
| `skills` | 查看、注册、取消注册或检查项目级 skills |
| `hooks` | 查看、安装或卸载 code-helper 管理的 Git / Agent hooks |

## 会创建或更新的文件

初始化后，工具可能会创建或更新以下受控内容：

| 路径 | 用途 |
| --- | --- |
| `.code-helper/` | 工具配置、受控模板和可选检查输出 |
| `code-helper-docs/user-rules/` | 长期协作规则 |
| `code-helper-docs/plan-doc/` | 任务计划文档 |
| `code-helper-docs/result-doc/` | 执行记录和手工测试文档 |
| `code-helper-docs/status-doc/` | 当前任务状态记录 |
| `AGENTS.md` | Codex 项目入口文档 |
| `CLAUDE.md` | Claude Code 项目入口文档 |
| `.github/copilot-instructions.md` | GitHub Copilot 项目入口文档 |

入口文档只更新 `<!-- code-helper:start -->` 和 `<!-- code-helper:end -->` 之间的受控区块，不会覆盖用户已有内容。

## 任务文档

`plan` 默认生成三类文档：

- `code-helper-docs/plan-doc/<中文功能名>.md`
- `code-helper-docs/result-doc/<中文功能名>/实施记录.md`
- `code-helper-docs/status-doc/<中文功能名>-状态.md`

页面、可视化、浏览器链路或人工业务验收场景，可以用 `manual-test` 单独生成：

- `code-helper-docs/result-doc/<中文功能名>/手工测试.md`

已完成任务可以用 `archive` 移入对应的 `archive/` 目录。手动移动到 `archive/` 的任务也会被识别为已结束任务。

## 完成检查

完成小节点、识别到功能变更、准备最终回复或切换任务前，可以运行：

```bash
npx @skrupellose/code-helper finish 订单管理升级 --check-only
```

`finish` 只输出完成判断和后续建议，不会自动更新长期记忆、归档文档、提交代码或发布包。

## 可选 Agent 集成

```bash
npx @skrupellose/code-helper skills register
npx @skrupellose/code-helper skills register codex
npx @skrupellose/code-helper skills register claudecode
npx @skrupellose/code-helper skills register githubcopilot
npx @skrupellose/code-helper hooks install codex
npx @skrupellose/code-helper hooks install claudecode
```

`skills register` 会把 code-helper 的项目级 skills 注册到对应 agent 工具目录。不带 target 时，会按当前项目已有入口文件推断目标；传 `all` 时强制注册 Codex、Claude Code 和 GitHub Copilot 三类目标。

`hooks install` 只安装指定目标的 hook。Git hook 需要显式执行 `hooks install git`，初始化不会自动安装 Git hook。

## 本地验证

```bash
npm test
npm pack --dry-run
```

`npm pack` 前会自动执行构建，避免发布包依赖本地残留的 `dist/`。
