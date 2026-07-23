import type { SelectOption } from "../terminal-ui.js";
import type { VersionUpdateState } from "../version-check.js";

/**
 * 主菜单条目。
 * value 是数字兜底菜单和 switch 分发共用的稳定值，name 与 description 共同组成用户可见文案。
 */
export interface MainMenuItem {
  value: string;
  name: string;
  description: string;
}

/**
 * 主菜单分组。
 * 交互式 raw mode 菜单和非 raw mode 数字菜单都从这里生成，避免两套文案不同步。
 */
export interface MainMenuGroup {
  title: string;
  items: MainMenuItem[];
}

/**
 * 主菜单信息架构。
 * 只保留「项目准备」与「工具设置」：初始化/刷新与 Skills/Hooks 管理仍由用户交互完成。
 * 任务推进（plan / manual-test / finish）与项目维护（tasks / archive / check）
 * 不再进入交互主菜单，改由 agent 按项目规则和适用 Skills 执行，必要时调用保留的 CLI 子命令。
 */
export const MAIN_MENU_GROUPS: MainMenuGroup[] = [
  {
    title: "项目准备",
    items: [
      {
        value: "1",
        name: "初始化/刷新项目配置",
        description: "创建或更新工作区、入口索引、规则模板、Skills 和可用 hooks"
      }
    ]
  },
  {
    title: "工具设置",
    items: [
      {
        value: "2",
        name: "功能管理",
        description: "应用或取消项目级 Skills、Agent hooks 和 Git hook"
      },
      {
        value: "3",
        name: "管理项目 Skills",
        description: "查看、注册、取消注册、检查或分析项目级 Skills"
      },
      {
        value: "4",
        name: "管理 Hooks",
        description: "查看、安装或卸载 code-helper 管理的 Git / Agent hooks"
      }
    ]
  }
];

/** 主菜单功能名补齐到固定终端列，保证说明文案对齐。 */
export const MAIN_MENU_NAME_COLUMN_WIDTH = 24;

/** 快捷升级在菜单分发中使用的内部稳定值，不作为普通数字菜单项展示。 */
export const QUICK_UPGRADE_MENU_VALUE = "__quick_upgrade_code_helper__";

/**
 * 导出主菜单分组，供测试锁定菜单分组、命名和说明。
 * 返回深拷贝，避免测试或外部调用意外修改 CLI 的菜单定义。
 */
export function getMainMenuGroups(): MainMenuGroup[] {
  return MAIN_MENU_GROUPS.map((group) => ({
    title: group.title,
    items: group.items.map((item) => ({ ...item }))
  }));
}

/**
 * 渲染主菜单分组标题。
 * 标题使用中文常见的书名号式括号，和功能项形成明确视觉区分，且不依赖 ANSI 样式。
 */
export function formatMainMenuGroupTitle(title: string): string {
  return `【${title}】`;
}

/**
 * 渲染 raw mode 菜单中的单行功能项。
 * 功能名按终端显示宽度补齐，保证说明从稳定列开始，便于快速扫描。
 */
export function formatMainMenuSelectItemLabel(item: MainMenuItem): string {
  return `  ${item.value.padStart(2, " ")}. ${padMenuText(item.name, MAIN_MENU_NAME_COLUMN_WIDTH)} ${item.description}`;
}

/**
 * 渲染数字兜底菜单中的功能项。
 * 数字兜底没有高亮能力，因此把功能名和说明拆成两行，避免长说明挤在同一行。
 */
export function formatMainMenuTextItemLines(item: MainMenuItem): string[] {
  return [`  ${item.value.padStart(2, " ")}. ${item.name}`, `      ${item.description}`];
}

/**
 * 渲染 raw mode 菜单顶部的快捷升级项。
 * 该项不属于 MAIN_MENU_GROUPS，避免被误认为普通项目准备动作。
 */
export function formatVersionUpgradeSelectItemLabel(versionUpdate: VersionUpdateState): string {
  return `  U. ${padMenuText("安装或升级到最新版本", MAIN_MENU_NAME_COLUMN_WIDTH)} 安装或升级本地开发依赖，再调用新版 update 刷新入口、Skills 和 Hooks（${versionUpdate.currentVersion} -> ${versionUpdate.latestVersion}）`;
}

/**
 * 渲染数字兜底菜单顶部的快捷升级项。
 * 文案和 raw mode 保持同一语义，只是拆行以便普通终端阅读。
 */
export function formatVersionUpgradeTextItemLines(versionUpdate: VersionUpdateState): string[] {
  return [
    "  U. 安装或升级到最新版本",
    `      安装或升级本地开发依赖，再调用新版 update 刷新入口、Skills 和 Hooks（${versionUpdate.currentVersion} -> ${versionUpdate.latestVersion}）`
  ];
}

/**
 * 构造 raw mode 单选菜单。
 * 分组标题和分组间空行作为 disabled 选项展示，方向键会自动跳过。
 */
export function buildMainMenuSelectOptions(versionUpdate?: VersionUpdateState): Array<SelectOption<string>> {
  const options: Array<SelectOption<string>> = [];

  if (versionUpdate?.outdated) {
    options.push({
      value: QUICK_UPGRADE_MENU_VALUE,
      label: formatVersionUpgradeSelectItemLabel(versionUpdate)
    });
    options.push({
      value: "__spacer_quick_upgrade",
      label: "",
      disabled: true
    });
  }

  for (const [groupIndex, group] of MAIN_MENU_GROUPS.entries()) {
    if (groupIndex > 0) {
      options.push({
        value: `__spacer_${group.title}`,
        label: "",
        disabled: true
      });
    }

    options.push({
      value: `__group_${group.title}`,
      label: formatMainMenuGroupTitle(group.title),
      disabled: true
    });

    for (const item of group.items) {
      options.push({
        value: item.value,
        label: formatMainMenuSelectItemLabel(item)
      });
    }
  }

  options.push({ value: "__spacer_exit", label: "", disabled: true });
  options.push({ value: "0", label: "   0. 退出                 关闭 code-helper 菜单" });
  return options;
}

/**
 * 根据主菜单数字取回用户可见功能名。
 * 菜单动作回显复用这里的名称，避免旧文案散落在 switch 分支里。
 */
export function getMainMenuItemName(value: string): string {
  return MAIN_MENU_GROUPS.flatMap((group) => group.items).find((item) => item.value === value)?.name ?? value;
}

/**
 * 归一化主菜单输入。
 * raw mode 返回内部快捷值，数字兜底菜单返回用户输入的 U/u；这里统一成同一个动作值，便于后续 switch 分发。
 */
export function normalizeMainMenuAnswer(answer: string, versionUpdate?: VersionUpdateState): string {
  const trimmedAnswer = answer.trim();

  if (versionUpdate?.outdated && trimmedAnswer.toLowerCase() === "u") {
    return QUICK_UPGRADE_MENU_VALUE;
  }

  return trimmedAnswer;
}

/**
 * 按终端显示宽度补齐文本。
 * 中文字符通常占两个终端列，这里做轻量宽字符判断，避免主菜单说明列明显错位。
 */
function padMenuText(text: string, width: number): string {
  const paddingLength = Math.max(width - getMenuTextWidth(text), 0);
  return `${text}${" ".repeat(paddingLength)}`;
}

/**
 * 计算菜单文本在常见等宽终端中的显示宽度。
 * 该函数只用于菜单排版，不参与业务逻辑；宽字符范围覆盖中文、日文、韩文和全角符号。
 */
function getMenuTextWidth(text: string): number {
  return Array.from(text).reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return width + (isWideMenuCharacter(codePoint) ? 2 : 1);
  }, 0);
}

/**
 * 判断字符是否通常按双列宽度显示。
 * 范围参考 Unicode 中常见 CJK 和全角字符区间，避免引入额外依赖。
 */
function isWideMenuCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}
