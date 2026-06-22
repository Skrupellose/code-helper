import type { CodeHelperConfig, FeatureKey } from "../types.js";

/**
 * 判断功能是否启用。
 * 这个小工具让调用方不需要直接访问配置内部结构。
 */
export function isFeatureEnabled(config: CodeHelperConfig, feature: FeatureKey): boolean {
  return config.features[feature]?.enabled === true;
}
