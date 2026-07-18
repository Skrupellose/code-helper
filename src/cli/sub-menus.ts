import type { SelectOption } from "../terminal-ui.js";
import { askQuestionOrDefault, type MenuReadline } from "./menu-input.js";

/**
 * 子菜单条目。
 * value 是数字兜底菜单、raw mode 选项和 switch 分发共用的稳定值；
 * label 是用户可见名称，raw / text 两套入口都从同一份数据生成，避免编号漂移。
 */
export interface SubMenuItem {
  value: string;
  label: string;
  /** 可选说明；当前子菜单以短标签为主，预留扩展。 */
  description?: string;
}

/**
 * 项目 Skills 管理子菜单。
 * 编号与历史交互保持一致，勿随意重排 value。
 */
export const SKILL_MENU_ITEMS: SubMenuItem[] = [
  { value: "1", label: "查看注册状态" },
  { value: "2", label: "按当前项目注册 Skills" },
  { value: "3", label: "按当前项目取消注册 Skills" },
  { value: "4", label: "仅注册 Codex" },
  { value: "5", label: "仅注册 Claude Code" },
  { value: "6", label: "仅注册 GitHub Copilot" },
  { value: "7", label: "注册全部" },
  { value: "8", label: "取消注册全部" },
  { value: "9", label: "Skills 质量检查" },
  { value: "10", label: "Skills 建议分析" },
  // 新目标追加新编号，避免改变既有脚本或用户习惯中的历史编号。
  { value: "11", label: "仅注册 Grok Build" },
  { value: "0", label: "返回" }
];

/**
 * Hooks 管理子菜单。
 * 编号与历史交互保持一致，勿随意重排 value。
 */
export const HOOKS_MENU_ITEMS: SubMenuItem[] = [
  { value: "1", label: "查看 Hooks 状态" },
  { value: "2", label: "安装 Git pre-commit hook" },
  { value: "3", label: "卸载 Git pre-commit hook" },
  { value: "4", label: "安装 Codex Agent hook" },
  { value: "5", label: "卸载 Codex Agent hook" },
  { value: "6", label: "安装 Claude Code Agent hook" },
  { value: "7", label: "卸载 Claude Code Agent hook" },
  { value: "8", label: "安装全部 Hooks" },
  { value: "9", label: "卸载全部 Hooks" },
  { value: "0", label: "返回" }
];

/**
 * 功能管理子菜单。
 * 编号与历史交互保持一致，勿随意重排 value。
 */
export const APPLY_MENU_ITEMS: SubMenuItem[] = [
  { value: "1", label: "应用项目级 Skills" },
  { value: "2", label: "取消项目级 Skills" },
  { value: "3", label: "应用 Agent hooks" },
  { value: "4", label: "取消 Agent hooks" },
  { value: "5", label: "应用 Git hook" },
  { value: "6", label: "取消 Git hook" },
  { value: "7", label: "刷新规则和模板" },
  { value: "8", label: "查看应用状态" },
  { value: "0", label: "返回" }
];

/**
 * 导出子菜单深拷贝，供测试锁定 value/label 契约。
 * 避免测试或外部调用意外修改 CLI 的菜单定义。
 */
export function getSkillMenuItems(): SubMenuItem[] {
  return cloneSubMenuItems(SKILL_MENU_ITEMS);
}

/** @see getSkillMenuItems */
export function getHooksMenuItems(): SubMenuItem[] {
  return cloneSubMenuItems(HOOKS_MENU_ITEMS);
}

/** @see getSkillMenuItems */
export function getApplyMenuItems(): SubMenuItem[] {
  return cloneSubMenuItems(APPLY_MENU_ITEMS);
}

/**
 * 构造 raw mode 单选菜单选项。
 * label 与历史行为一致：不带编号前缀，由 promptSelect 的指针高亮当前项。
 */
export function buildSubMenuSelectOptions(items: SubMenuItem[]): Array<SelectOption<string>> {
  return items.map((item) => ({
    value: item.value,
    label: item.label
  }));
}

/**
 * 渲染数字兜底菜单的可见行。
 * 格式为「value. label」，与历史 askText* 输出一致。
 */
export function formatSubMenuTextLines(items: SubMenuItem[]): string[] {
  return items.map((item) => `${item.value}. ${item.label}`);
}

/**
 * 打印数字兜底子菜单标题与条目。
 * 与 askTextSubMenu 共用，便于测试单独断言渲染结果。
 */
export function printSubMenuText(title: string, items: SubMenuItem[]): void {
  console.log(`\n${title}`);
  for (const line of formatSubMenuTextLines(items)) {
    console.log(line);
  }
}

/**
 * 非 TTY 环境下的统一子菜单兜底。
 * raw / text 共用同一 items，输入 0（默认）返回上一级。
 */
export async function askTextSubMenu(
  rl: MenuReadline,
  title: string,
  items: SubMenuItem[]
): Promise<string> {
  printSubMenuText(title, items);
  return askQuestionOrDefault(rl, "请选择操作：", "0");
}

/**
 * 深拷贝子菜单项列表，避免外部修改污染常量。
 */
function cloneSubMenuItems(items: SubMenuItem[]): SubMenuItem[] {
  return items.map((item) => ({ ...item }));
}
