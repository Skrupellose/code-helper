/**
 * 打印功能开关帮助。
 * 保持简短，避免交互和自动化场景输出过重。
 */
export function printFeatureHelp(): void {
  console.log("用法：");
  console.log("  code-helper features list");
  console.log("  code-helper features enable <featureKey>");
  console.log("  code-helper features disable <featureKey>");
}

/**
 * 打印项目级 skills 命令帮助。
 */
export function printSkillsHelp(): void {
  console.log("用法：");
  console.log("  code-helper skills list");
  console.log("  code-helper skills register [all|codex|claudecode|githubcopilot|grok]");
  console.log("  code-helper skills unregister [all|codex|claudecode|githubcopilot|grok]");
  console.log("  code-helper skills profiles");
  console.log("  code-helper skills profile [full|delivery|essential]");
  console.log("  code-helper skills modules [core,quality,collaboration,memory]");
  console.log("  code-helper skills doctor");
  console.log("  code-helper skills audit");
  console.log("说明：profile/modules 保存期望集合，register 按该集合注册并安全清理已不再选择的受控 Skill；旧配置默认 full。register/unregister 不带 target 时按当前项目入口推断目标。");
}

/**
 * 打印 hooks 命令帮助。
 */
export function printHooksHelp(): void {
  console.log("用法：");
  console.log("  code-helper hooks list");
  console.log("  code-helper hooks install <git|codex|claudecode|agent|all>");
  console.log("  code-helper hooks uninstall <git|codex|claudecode|agent|all>");
  console.log("说明：hooks install 会直接应用对应 hook，并同步内部开关；init 只会安装选中 agent 对应的 Agent hooks，不会安装 Git hook。");
}

/**
 * 打印 CLI 帮助。
 * 所有子命令都提供非交互入口，便于测试和集成到脚本。
 */
export function printHelp(): void {
  console.log(`code-helper

用法：
  code-helper                         打开交互菜单
  code-helper init [target] [--refresh-rules]
                                      初始化项目规则和工作区，可指定 all|codex|claudecode|githubcopilot|grok；
                                      --refresh-rules 强制覆盖内置规则全文（危险，会丢掉用户改动）
  code-helper update [--refresh-rules]
                                      按当前项目已启用能力刷新 code-helper 本地资产；
                                      默认安全刷新未改动的内置规则；--refresh-rules 强制覆盖
  code-helper version [--json]        查看当前 code-helper 版本
  code-helper version status [--json] 本地查看正式版/测试版通道状态
  code-helper version check [--json]  联网检查 Stable/Canary 发布状态
  code-helper version set <stable|canary> [--json] 显式选择后续跟随通道
  code-helper npm-scripts install     写入常用 npm scripts（不覆盖同名脚本）
  code-helper sync-local              (开发) 刷新本仓库本地模板并注册全部项目级 skills（普通用户不需要）
  code-helper check [--write-report]  检查协作文档结构
  code-helper features list           查看高级功能配置
  code-helper features enable <key>   启用高级功能配置
  code-helper features disable <key>  关闭高级功能配置
  code-helper plan <需求文档> [中文功能名] 生成项目计划模板
  code-helper record <中文功能名>       创建直接执行任务的终态完成记录
  code-helper manual-test <中文功能名> [标题] 生成手工测试模板
  code-helper archive <中文功能名> [--resolve-mixed] 将功能文档移动到 archive 并识别为已结束
  code-helper finish [中文功能名] [--check-only] [--json] 检查当前功能是否完成并提示后续动作
  code-helper tasks [--json]           查看 active / archived / mixed 任务
  code-helper requirement explore --input <JSON 文件> [--json]
                                      从模糊需求生成澄清问题和探索文档
  code-helper requirement specify --input <JSON 文件> [--json]
                                      从探索结果生成带稳定验收 ID 的规格
  code-helper requirement clarify --input <JSON 文件> [--json]
                                      合并开放问题回答并生成新一轮探索或规格；answer 为等价别名
  code-helper analyze --input <JSON 文件> [--task <任务>] [--json]
                                      只读检查规格、计划、状态与验证证据；--task 从 SQLite 读取最新回执
  code-helper evaluate [--scenario <JSON 文件>] [--samples <N>] [--baseline <报告文件>] [--process-timeout-ms <N>] [--process-output-limit-bytes <N>]
                       [--token-observations <N,unknown,...>] [--agent-runner <可执行文件>] [--json]
                                      在临时项目重复执行声明式工作流并输出验收与效率报告；默认内置场景运行 3 次
  code-helper task status <任务> [--json]  读取 SQLite 权威任务状态
  code-helper task transition <任务> <状态> [--current-node <节点>] [--json]
                                      更新任务状态或当前节点
  code-helper task next <任务> [--json] 读取任务状态和下一动作
  code-helper document show <任务> <类型> [--json]
                                      读取 SQLite 当前文档
  code-helper document update <任务> <类型> <--body <正文>|--body-file <路径>|--body-stdin>
                                      <--expected-revision <N>|--expected-content-hash <摘要>> [--summary <摘要>] [--json]
                                      CAS 更新 SQLite 后自动刷新当前任务 Markdown 投影；人工修改会在数据库写入前阻断
  code-helper document history <任务> <类型> [--json]
                                      读取不可变修订历史
  code-helper validation record <任务> --command <命令> --working-directory <目录>
                                      --exit-code <代码> --summary <摘要> [--baseline <基线>]
                                      [--acceptance-criteria <AC-ID,...>] [--plan-items <计划项ID,...>] [--json]
  code-helper validation list <任务> [--json] 读取任务验证回执
  code-helper git link <任务> <commit> [--subject <主题>] [--scope <范围>] [--json]
                                      记录 Git 关联，不执行 Git 操作
  code-helper git list <任务> [--json] 读取任务 Git 关联
  code-helper documents migrate [--apply] [--json] 预览或显式导入旧版 Markdown 文档
  code-helper documents import [--apply] [--json]  仅供显式人工编辑或旧项目兼容：预览/导入 Markdown 单边修改
  code-helper documents export [--tracked] [--force] [--json]  从 SQLite 导出兼容 Markdown 视图；--tracked 写入可提交副本
  code-helper documents check [--json] 检查 SQLite 文档数据库完整性
  code-helper skills list              查看项目级 skills 注册状态
  code-helper skills register [target] 按项目入口或指定 target 注册项目级 skills
  code-helper skills unregister [target] 按项目入口或指定 target 取消注册项目级 skills
  code-helper skills profiles          查看内置 Skills profiles
  code-helper skills profile [name]    查看或选择 full / delivery / essential profile
  code-helper skills modules [list]    查看或显式选择 core,quality,collaboration,memory 模块
  code-helper skills doctor            检查项目级 skills 结构和质量
  code-helper skills audit             根据项目状态给出 skills 建议
  code-helper hooks list               查看 Git / Agent hooks 安装状态
  code-helper hooks install <target>   安装 Git / Agent hooks
  code-helper hooks uninstall <target> 卸载 code-helper 管理的 hooks

JSON 契约：带 --json 的主要脚本命令统一返回
  { ok, action, status, data, diagnostics, nextActions }
stdout 恰好一个 JSON 文档；成功退出 0，文档冲突退出 2，其它失败退出 1。
`);
}
