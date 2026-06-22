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
  console.log("  code-helper skills register [all|codex|claudecode|githubcopilot]");
  console.log("  code-helper skills unregister [all|codex|claudecode|githubcopilot]");
  console.log("  code-helper skills doctor");
  console.log("  code-helper skills audit");
  console.log("说明：register/unregister 不带 target 时按当前项目已有 AGENTS.md / CLAUDE.md / GitHub Copilot 入口自动选择目标；无法识别时会跳过，请显式传 target。");
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
  code-helper init [target]           初始化项目规则和工作区，可指定 all|codex|claudecode|githubcopilot
  code-helper update                  按当前项目已启用能力刷新 code-helper 本地资产
  code-helper version                 查看当前 code-helper 版本
  code-helper npm-scripts install     写入常用 npm scripts（不覆盖同名脚本）
  code-helper sync-local              刷新本仓库本地模板并注册全部项目级 skills
  code-helper check [--write-report]  检查协作文档结构
  code-helper features list           查看高级功能配置
  code-helper features enable <key>   启用高级功能配置
  code-helper features disable <key>  关闭高级功能配置
  code-helper plan <需求文档> [中文功能名] 生成项目计划模板
  code-helper manual-test <中文功能名> [标题] 生成手工测试模板
  code-helper archive <中文功能名> [--resolve-mixed] 将功能文档移动到 archive 并识别为已结束
  code-helper finish [中文功能名]        检查当前功能是否完成并提示后续动作
  code-helper tasks [--json]           查看 active / archived / mixed 任务
  code-helper skills list              查看项目级 skills 注册状态
  code-helper skills register [target] 按项目入口或指定 target 注册项目级 skills
  code-helper skills unregister [target] 按项目入口或指定 target 取消注册项目级 skills
  code-helper skills doctor            检查项目级 skills 结构和质量
  code-helper skills audit             根据项目状态给出 skills 建议
  code-helper hooks list               查看 Git / Agent hooks 安装状态
  code-helper hooks install <target>   安装 Git / Agent hooks
  code-helper hooks uninstall <target> 卸载 code-helper 管理的 hooks
`);
}
