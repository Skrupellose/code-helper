# code-helper

`code-helper` 是一个通用 agent 协作工作流 CLI，用于提高项目中多个 agent 协作时的规范度和上下文持久化能力。

## 使用方式

```bash
npx @skrupellose/code-helper
```

交互菜单支持方向键移动，空格或回车确认。不支持按键交互的终端会回退为数字菜单，输入 `0` 返回上一级。菜单动作会打印开始和完成状态，并在 TTY 模式下等待回车后再返回菜单，避免执行结果一闪而过。

也可以使用非交互命令：

```bash
npx @skrupellose/code-helper init
npx @skrupellose/code-helper check
npx @skrupellose/code-helper features list
npx @skrupellose/code-helper plan docs/订单管理需求.md 订单管理升级
npx @skrupellose/code-helper manual-test 订单管理升级
npx @skrupellose/code-helper finish 订单管理升级
npx @skrupellose/code-helper archive 订单管理升级
npx @skrupellose/code-helper tasks
npx @skrupellose/code-helper init codex
npx @skrupellose/code-helper skills register
npx @skrupellose/code-helper hooks install agent
npx @skrupellose/code-helper hooks list
```

在交互式“项目计划优化”里，可以直接把需求文档拖到终端；工具会识别引号、`file://`、反斜杠转义空格和项目内绝对路径。

生成项目计划时，`status-doc` 会同步生成当前执行入口，包含“当前执行节点”和“子计划队列”，用于让 agent 按计划逐步推进。

完成小节点、识别到功能变更、准备最终回复或切换任务前，可以运行 `code-helper finish <中文功能名> --check-only`。它只输出完成判断和后续建议，不会自动更新长期记忆、归档或提交。

生成手工测试文档和文档归档时，工具会优先读取当前 `plan-doc` / `result-doc` / `status-doc` 中的活动任务，让用户从列表选择；仍然支持直接传入中文功能名。

## 默认工作区

初始化后会创建或按目标写入：

- `.code-helper/`：工具配置、内置 skills 模板、hook sample 和检查结果
- `.agents/skills/`：Codex 项目级 skills 注册目录，当前项目选择或识别到 Codex 时注册 code-helper skills
- `.claude/skills/`：Claude Code 项目级 skills 注册目录，当前项目选择或识别到 Claude Code 时注册 code-helper skills
- `.github/copilot-instructions.md`：GitHub Copilot 项目入口记忆文档，当前项目选择或识别到 GitHub Copilot 时写入 code-helper 入口区块
- `.github/skills/`：GitHub Copilot 项目级 skills 注册目录，当前项目选择或识别到 GitHub Copilot Agent Skills 时注册 code-helper skills
- `code-helper-docs/user-rules/`：长期专题规则
- `code-helper-docs/plan-doc/`：项目计划
- `code-helper-docs/result-doc/`：执行结果和手工测试文档
- `code-helper-docs/status-doc/`：当前状态记录
- `code-helper-docs/*/archive/`：已完成或已结束任务的归档文档

## 默认策略

- 初始化会优先根据已有 `AGENTS.md`、`CLAUDE.md` 和 GitHub Copilot 入口判断 agent 工具；完全无法判断时，交互式 init 会让用户选择目标，非交互 init 会保守跳过项目级 skills 和 Agent hooks。
- `init` 一旦确定目标，就会补齐对应入口记忆文档：Codex 写 `AGENTS.md`，Claude Code 写 `CLAUDE.md`，GitHub Copilot 写 `.github/copilot-instructions.md`；`init all` 会补齐三类入口。
- 初始化不会覆盖已有专题规则。
- `.code-helper/skills/` 只是内置 skills 模板源，不会被 Codex 或 Claude Code 默认识别。
- `npx @skrupellose/code-helper init [target]` 支持显式指定 `codex`、`claudecode`、`githubcopilot` 或 `all`；init 确定目标后，会按同一批目标注册项目级 skills，并安装 Codex / Claude Code 对应的 Agent hooks。
- `npx @skrupellose/code-helper skills register` 不带 target 时按当前项目已有 `AGENTS.md` / `CLAUDE.md` / GitHub Copilot 入口自动选择目标；无法识别时跳过，传 `all` 时强制注册全部三类目标。
- 入口文档只更新 `<!-- code-helper:start -->` 和 `<!-- code-helper:end -->` 之间的受控区块。
- 计划、结果、状态和测试文档必须使用中文命名与中文总结，例如 `code-helper-docs/plan-doc/订单管理升级.md`、`code-helper-docs/result-doc/订单管理升级/实施记录.md`、`code-helper-docs/status-doc/订单管理升级-状态.md`。
- 页面相关测试只生成严格手工测试文档。
- 工具自己只执行纯逻辑测试，例如函数单元测试或非浏览器集成测试。
- 功能完成检查只做判断和提示；更新长期记忆、文档归档、提交和发布都需要用户确认。
- 功能完成后可以执行 `npx @skrupellose/code-helper archive <中文功能名>` 归档文档。
- 不带功能名执行 `manual-test` 或 `archive` 时，TTY 终端会优先展示当前活动任务选择列表。
- 用户手动移动到 `archive/` 的任务会被识别为已结束任务。
- init 不会自动安装 Git hook；Git hook 只在显式执行 `hooks install git` 时安装。执行 `hooks install` 时会直接应用到项目，执行 `hooks uninstall` 会取消 code-helper 管理的 hooks。

## 功能管理

```bash
npx @skrupellose/code-helper skills register
npx @skrupellose/code-helper skills unregister
npx @skrupellose/code-helper hooks install agent
npx @skrupellose/code-helper hooks uninstall agent
npx @skrupellose/code-helper hooks install git
npx @skrupellose/code-helper hooks uninstall git
```

交互菜单中的“功能管理”会直接应用或取消 Skills、Agent hooks、Git hook，也可以刷新规则和模板。应用或取消项目级 Skills 时，可以选择 Codex、Claude Code、GitHub Copilot、全部，或使用当前项目识别到的默认 agent 工具；应用或取消 Agent hooks 时，只提供 Codex、Claude Code 和全部可用 Agent hooks，GitHub Copilot 不会安装 Agent hook。`features` 命令仍保留为高级配置接口，普通使用不需要先切换功能开关。

## Skills 管理

```bash
npx @skrupellose/code-helper skills list
npx @skrupellose/code-helper skills register githubcopilot
npx @skrupellose/code-helper skills doctor
npx @skrupellose/code-helper skills audit
```

- `skills doctor`：检查项目级 skills 的结构、frontmatter、description 和 code-helper 模板是否过期。
- `skills audit`：根据当前入口文档、专题规则和计划/归档目录，给出缺失注册或缺失 skill 的建议。

## Hooks 管理

```bash
npx @skrupellose/code-helper hooks list
npx @skrupellose/code-helper hooks install git
npx @skrupellose/code-helper hooks install codex
npx @skrupellose/code-helper hooks install claudecode
npx @skrupellose/code-helper hooks uninstall agent
```

- `hooks install` 会直接应用对应 hook，并同步内部状态。
- Agent hooks 只运行 `finish --check-only`，不会自动更新长期记忆、归档或提交。
- 卸载只移除 code-helper 管理的 hook，不删除用户自己的 hooks。
