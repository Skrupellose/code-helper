# code-helper

`code-helper` 是一个通用 agent 协作工作流 CLI，用于提高项目中多个 agent 协作时的规范度和上下文持久化能力。

## 使用方式

```bash
npx @skrupellose/code-helper
```

交互菜单支持方向键移动，空格或回车确认。功能开关页面支持方向键移动、空格切换、回车保存。不支持按键交互的终端会回退为数字菜单，输入 `0` 返回上一级。菜单动作会打印开始和完成状态，并在 TTY 模式下等待回车后再返回菜单，避免执行结果一闪而过。

也可以使用非交互命令：

```bash
npx @skrupellose/code-helper init
npx @skrupellose/code-helper check
npx @skrupellose/code-helper features list
npx @skrupellose/code-helper plan docs/订单管理需求.md 订单管理升级
npx @skrupellose/code-helper manual-test 订单管理升级
npx @skrupellose/code-helper archive 订单管理升级
npx @skrupellose/code-helper tasks
npx @skrupellose/code-helper skills register
```

在交互式“项目计划优化”里，可以直接把需求文档拖到终端；工具会识别引号、`file://`、反斜杠转义空格和项目内绝对路径。

## 默认工作区

初始化后会创建：

- `.code-helper/`：工具配置、内置 skills 模板、hook sample 和检查结果
- `.agents/skills/`：Codex 项目级 skills 注册目录，当前项目需要 Codex 时注册 code-helper skills
- `.claude/skills/`：Claude Code 项目级 skills 注册目录，当前项目需要 Claude Code 时注册 code-helper skills
- `.github/skills/`：GitHub Copilot 项目级 skills 注册目录，当前项目需要 GitHub Copilot Agent Skills 时注册 code-helper skills
- `code-helper-docs/user-rules/`：长期专题规则
- `code-helper-docs/plan-doc/`：项目计划
- `code-helper-docs/result-doc/`：执行结果和手工测试文档
- `code-helper-docs/status-doc/`：当前状态记录
- `code-helper-docs/*/archive/`：已完成或已结束任务的归档文档

## 默认策略

- 默认维护 `AGENTS.md`，检测到或配置启用后可同步 `CLAUDE.md`。
- 初始化不会覆盖已有专题规则。
- `.code-helper/skills/` 只是内置 skills 模板源，不会被 Codex 或 Claude Code 默认识别。
- `npx @skrupellose/code-helper init` 会根据初始化前的入口文档注册项目级 skills：只有 `AGENTS.md` 时只注册 Codex，只有 `CLAUDE.md` 时只注册 Claude Code，存在 `.github/copilot-instructions.md` 或 `.github/skills/` 时注册 GitHub Copilot；完全无法判断的新项目默认注册全部三类目标。
- `npx @skrupellose/code-helper skills register` 不带 target 时按当前项目已有 `AGENTS.md` / `CLAUDE.md` / GitHub Copilot 入口自动选择目标；传 `all` 时强制注册全部三类目标。
- 入口文档只更新 `<!-- code-helper:start -->` 和 `<!-- code-helper:end -->` 之间的受控区块。
- 计划、结果、状态和测试文档必须使用中文命名与中文总结，例如 `code-helper-docs/plan-doc/订单管理升级.md`、`code-helper-docs/result-doc/订单管理升级/实施记录.md`、`code-helper-docs/status-doc/订单管理升级-状态.md`。
- 页面相关测试只生成严格手工测试文档。
- 工具自己只执行纯逻辑测试，例如函数单元测试或非浏览器集成测试。
- 功能完成后可以执行 `npx @skrupellose/code-helper archive <中文功能名>` 归档文档。
- 用户手动移动到 `archive/` 的任务会被识别为已结束任务。
- Git hooks 默认关闭，只生成 sample 模板。

## 功能开关

```bash
npx @skrupellose/code-helper features list
npx @skrupellose/code-helper features disable testingPolicy
npx @skrupellose/code-helper features enable gitHooks
```

功能关闭后，菜单和检查会跳过对应能力。修改开关后可重新执行 `npx @skrupellose/code-helper init` 刷新入口索引和模板。

## Skills 管理

```bash
npx @skrupellose/code-helper skills list
npx @skrupellose/code-helper skills register githubcopilot
npx @skrupellose/code-helper skills doctor
npx @skrupellose/code-helper skills audit
```

- `skills doctor`：检查项目级 skills 的结构、frontmatter、description 和 code-helper 模板是否过期。
- `skills audit`：根据当前入口文档、专题规则和计划/归档目录，给出缺失注册或缺失 skill 的建议。
