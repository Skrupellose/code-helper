# code-helper 开发与发布规范

## 功能描述

沉淀 code-helper 本项目在 CLI 交互、初始化兼容、文档生成、测试边界、归档和发布提交方面的稳定约束，避免后续开发反复偏离用户预期。

## 调用时机

- 修改 CLI 菜单、输入流程、功能开关、初始化、检查、计划文档、归档、任务状态、跨平台路径处理或用户可见文案时
- 修改 `code-helper-docs/plan-doc/`、`code-helper-docs/result-doc/`、`code-helper-docs/status-doc/` 文档生成规则时
- 修改测试策略、发布流程、GitHub 仓库初始化或提交推送流程时
- 回答用户如何本地测试、分享、打包或发布 code-helper 时

## 调用入口文件

- `AGENTS.md`

## 规则

1. 不主动提交、推送或发布；涉及 `git commit`、`git push`、创建仓库、发包前必须先询问用户并等待确认。
2. `example/` 目录不上传、不纳入 npm 包发布内容；它只作为本地参考和验证材料。
3. 初始化必须兼容新项目和老项目：已有 `AGENTS.md`、`CLAUDE.md` 或专题规则时，保留用户原内容，只更新 code-helper 受控区块或缺失的模板文件。
4. `init` 必须识别用户手动创建的 `CLAUDE.md`，并保持 `AGENTS.md` 与 `CLAUDE.md` 的 code-helper 入口索引幂等，不允许重复追加同一入口项。
5. 所有交互菜单优先支持方向键移动、空格或回车确认；不支持 raw mode 的终端回退为数字菜单。
6. 所有子流程必须提供明确取消或返回入口；数字兜底菜单使用 `0` 返回，用户输错不应是唯一退出方式。
7. 用户输入 `0` 或直接回车取消时，应立即返回上一级，不再要求额外按一次回车。
8. 菜单动作开始和结束都要打印回显；TTY 模式下成功执行动作后可等待回车再返回菜单，避免结果一闪而过。
9. 需要路径输入的流程必须支持终端文件拖拽格式，包括引号、`file://`、反斜杠转义空格和项目内绝对路径转相对路径。
10. 依赖已有任务的流程不能只要求用户手动输入功能名；生成手工测试文档、文档归档等动作必须优先从 `plan-doc`、`result-doc`、`status-doc` 的活动任务中选择，并保留手动输入作为兼容入口。
11. 计划、结果、状态和测试文档必须强制使用中文命名与中文总结；新文档路径使用 `<中文功能名>.md`、`实施记录.md`、`<中文功能名>-状态.md` 和 `手工测试.md`。
12. 旧英文任务文档只做兼容读取、检查提示和归档迁移，不作为新文档生成规则。
13. 页面相关测试全部只生成严格手工测试文档，由用户执行；工具自己只执行纯逻辑测试，例如函数单元测试、数据转换测试或非浏览器集成测试。
14. 功能完成后应支持将计划、结果和状态文档移动到 `archive/`；用户手动移动到 `archive/` 的任务也必须识别为已结束。
15. 功能开关必须支持选择性关闭；关闭后菜单、检查或初始化行为应尊重配置。
16. `.code-helper/skills/` 只是内置 skills 模板源，不默认被 Codex 或 Claude Code 识别。
17. Skills 注册必须同时支持 Codex、Claude Code 和 GitHub Copilot：Codex 写入 `.agents/skills/code-helper-*`，Claude Code 写入 `.claude/skills/code-helper-*`，GitHub Copilot 写入 `.github/skills/code-helper-*`。
18. `npx @skrupellose/code-helper init` 必须根据初始化前的入口文档决定注册目标：只有 `AGENTS.md` 时只注册 Codex，只有 `CLAUDE.md` 时只注册 Claude Code，存在 `.github/copilot-instructions.md` 或 `.github/skills/` 时注册 GitHub Copilot；完全无法判断的新项目默认注册全部三类目标。
19. 用户执行 `npx @skrupellose/code-helper skills register` 或在菜单中选择“按当前项目注册 Skills”时，必须根据当前项目已有 `AGENTS.md` / `CLAUDE.md` / GitHub Copilot 入口自动选择目标。
20. 用户可以用 `npx @skrupellose/code-helper skills register all` 强制注册全部三类目标，也可以用 `npx @skrupellose/code-helper skills register codex`、`npx @skrupellose/code-helper skills register claudecode` 或 `npx @skrupellose/code-helper skills register githubcopilot` 只注册单个 agent 工具。
21. 取消注册只删除 `.agents/skills/code-helper-*`、`.claude/skills/code-helper-*` 和 `.github/skills/code-helper-*` 受控目录，不触碰用户自己的 skills 内容。
22. 本地验证优先运行 `npm test`、`npm run check`、`npm pack --dry-run`，必要时再用同级 demo 项目验证真实 CLI 流程。
23. 所有用户可见文案、README、规则文档和 skill 内容必须符合中文产品语境，避免“状态驾驶舱”“计划工作台”“执行工作台”“阶段收口”“当前推进建议”“阻塞回归入口”等生硬表达；优先使用“状态记录”“计划文档”“执行计划”“阶段结束”“下一步建议”“后续检查点”等自然表述。
24. `code-helper-plan-workbench` 的内容必须保持通用，不应默认任务是前端页面或组件；计划描述要覆盖 CLI、后端服务、数据任务、平台能力、跨模块协作和页面等多种项目类型。
25. 修改 `src/templates.ts` 中的内置 skill 或规则模板后，必须同步刷新 `.code-helper/skills/`，并在本项目同时刷新 `.agents/skills/code-helper-*`、`.claude/skills/code-helper-*` 与 `.github/skills/code-helper-*`，保证 Codex、Claude Code 和 GitHub Copilot 看到的项目级 skills 内容一致。
26. 新增或修改 TypeScript 代码时，公共函数、复杂分支和跨平台兼容逻辑应保留清晰中文注释；简单自解释代码不添加空泛注释。
27. 工具必须同时兼容 macOS 和 Windows。新增路径、文件移动、归档、拖拽输入、CLI 参数解析、skills 注册和文档生成逻辑时，必须使用跨平台路径 API，避免硬编码 `/`、反斜杠、盘符假设或仅适用于单一系统的 shell 行为；涉及路径的改动必须补充或更新 Windows 与 macOS 兼容用例。
