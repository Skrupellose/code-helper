# code-helper

`code-helper` 是一个通用 agent 协作工作流 CLI，用于提高项目中多个 agent 协作时的规范度和上下文持久化能力。

## 使用方式

```bash
npx code-helper
```

交互菜单支持方向键移动，空格或回车确认。功能开关页面支持方向键移动、空格切换、回车保存。不支持按键交互的终端会回退为数字菜单，输入 `0` 返回上一级。

也可以使用非交互命令：

```bash
npx code-helper init
npx code-helper check
npx code-helper features list
npx code-helper plan docs/requirement.md my-feature
npx code-helper manual-test my-feature
npx code-helper archive my-feature
npx code-helper tasks
```

## 默认工作区

初始化后会创建：

- `.agent/code-helper/`：工具配置、内置 skills、hook sample 和检查结果
- `.agent/user-rules/`：长期专题规则
- `.agent/plan-doc/`：项目计划
- `.agent/result-doc/`：执行结果和手工测试文档
- `.agent/status-doc/`：当前状态驾驶舱
- `.agent/*/archive/`：已完成或已结束任务的归档文档

## 默认策略

- 默认维护 `AGENTS.md`，检测到或配置启用后可同步 `CLAUDE.md`。
- 初始化不会覆盖已有专题规则。
- 入口文档只更新 `<!-- code-helper:start -->` 和 `<!-- code-helper:end -->` 之间的受控区块。
- 页面相关测试只生成严格手工测试文档。
- 工具自己只执行纯逻辑测试，例如函数单元测试或非浏览器集成测试。
- 功能完成后可以执行 `npx code-helper archive <feature>` 归档文档。
- 用户手动移动到 `archive/` 的任务会被识别为已结束任务。
- Git hooks 默认关闭，只生成 sample 模板。

## 功能开关

```bash
npx code-helper features list
npx code-helper features disable testingPolicy
npx code-helper features enable gitHooks
```

功能关闭后，菜单和检查会跳过对应能力。修改开关后可重新执行 `npx code-helper init` 刷新入口索引和模板。
