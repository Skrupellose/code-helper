import type { SkillRegistrationTarget } from "../skills.js";
import type { CodeHelperConfig, OperationResult } from "../types.js";

/**
 * 初始化 code-helper 的入参。
 * 目前只需要项目根目录，保留对象形式方便后续扩展 dry-run 等选项。
 */
export interface InitializeOptions {
  projectRoot: string;
  /**
   * init 要应用的 agent 工具目标。
   * 不传时仅根据初始化前已有入口文件推断；传空数组表示调用方已经确认应保守跳过项目级能力安装。
   */
  skillRegistrationTargets?: SkillRegistrationTarget[];
  /**
   * 为 true 时强制用内置模板整文件覆盖 user-rules 中的内置规则文件。
   * 危险：会覆盖用户对内置规则的改动；默认 false 时仅安全刷新未改动规则。
   */
  refreshRules?: boolean;
}

/**
 * 升级项目中 code-helper 本地资产的可选参数。
 */
export interface UpdateOptions {
  /**
   * 为 true 时强制刷新内置规则全文（即使用户改过也覆盖）。
   * 默认 false：仅对「未改动的内置规则」整文件刷新，改动过的只更新入口小节。
   */
  refreshRules?: boolean;
}

/**
 * 初始化结果。
 * CLI 根据该结构统一输出所有创建、更新和跳过项。
 */
export interface InitializeResult {
  config: CodeHelperConfig;
  operations: OperationResult[];
}

/**
 * 更新项目中已经使用的 code-helper 受控资产。
 * update 不开启新能力，只刷新当前项目已有入口、已注册 skills 和已安装 hooks。
 */
export interface UpdateResult {
  config: CodeHelperConfig;
  operations: OperationResult[];
}
