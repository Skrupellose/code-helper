# Agent 协作规则

<!-- code-helper:start -->
## code-helper 协作入口

### 核心规则

1. 开始新需求、迁移、重构或反馈修复前，先读取本区块索引到的专题规则。
2. 长期规则写入 `code-helper-docs/user-rules/`，短期过程写入 `code-helper-docs/result-doc/`，当前状态记录写入 `code-helper-docs/status-doc/`。
3. 不把一次性调试过程、临时失败细节或大段实现流水写进入口文档。
4. 主会话只做管理、分配、审阅和结果同步；具体执行任务必须交给子代理。当前 agent 工具没有子代理能力时，先说明限制并等待用户确认，再由主会话执行。

### 专题规则索引

- Agent 协作规范：开始新需求、迁移、重构或反馈修复时，读取 `code-helper-docs/user-rules/Agent协作规范.md`；主会话只做协调、分配、审阅和同步，具体执行任务必须交给子代理。
- 项目记忆规则优化：整理或更新 `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` 时，读取 `code-helper-docs/user-rules/项目记忆规则优化.md`。
- 项目计划优化：开始大型需求、迁移、重构或多阶段任务时，读取 `code-helper-docs/user-rules/项目计划管理规范.md`。
- 执行结果总结：完成小节点后，读取 `code-helper-docs/user-rules/执行结果总结规范.md` 并写入 result-doc。
- 测试策略约束：涉及页面的测试只生成手工测试文档；工具只执行纯逻辑测试，读取 `code-helper-docs/user-rules/测试策略规范.md`。
- 文档归档：功能完成或手动移动到 archive 后，任务视为已结束，读取 `code-helper-docs/user-rules/文档归档规范.md`。
- 功能完成检查：完成小节点、识别到功能变更、准备最终回复或切换任务前，读取 `code-helper-docs/user-rules/功能完成检查规范.md`，并按需运行 `npx @skrupellose/code-helper finish`。
- 规则检查：提交或阶段结束前运行 `npx @skrupellose/code-helper check`，确认协作文档结构仍完整。
- Skills 管理：需要让 Codex、Claude Code 或 GitHub Copilot 在当前项目自动发现 code-helper skills 时，执行 `npx @skrupellose/code-helper skills register`。

### 文档维护规则

- 入口文档只保留轻量索引和核心约束。
- 专题规则文档必须包含“功能描述 / 调用时机 / 调用入口文件 / 规则”四个小节。
- 计划、状态、结果和测试文档必须使用中文命名与中文总结。
- agent 识别到功能变更、项目结构变化、稳定规则变化或小节点完成时，必须主动判断是否需要更新过程文档、询问更新长期记忆、询问归档或继续当前节点。
- 新功能或重构形成稳定规则后，先询问用户是否更新项目记忆，不自动把短期任务状态写入长期记忆。
<!-- code-helper:end -->

## 项目专属规则索引

- code-helper 开发与发布规范：修改 CLI 交互、初始化、归档、文档生成、测试或发布流程时，读取 `code-helper-docs/user-rules/code-helper开发与发布规范.md`。
