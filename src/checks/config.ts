import { FEATURE_KEYS } from "../constants.js";
import { getConfigRelativePath } from "../config.js";
import { projectPath, readTextIfExists } from "../fs-utils.js";
import type { CheckIssue, CodeHelperConfig } from "../types.js";

/**
 * 检查原始配置文件结构。
 * loadConfig 会自动补默认值，因此缺失字段必须在合并前检查，否则会被默认配置掩盖。
 */
export async function checkRawConfig(projectRoot: string): Promise<CheckIssue[]> {
  const configPath = getConfigRelativePath();
  const raw = await readTextIfExists(projectPath(projectRoot, configPath));

  if (raw === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [
      {
        level: "error",
        code: "invalid-config-json",
        message: "code-helper 配置不是合法 JSON",
        path: configPath,
        suggestion: "修复 JSON 语法，或运行 `npx @skrupellose/code-helper init` 重新生成配置。"
      }
    ];
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [
      {
        level: "error",
        code: "invalid-config-shape",
        message: "code-helper 配置必须是 JSON 对象",
        path: configPath,
        suggestion: "运行 `npx @skrupellose/code-helper init` 重新生成配置。"
      }
    ];
  }

  const features = (parsed as { features?: unknown }).features;
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    return [
      {
        level: "error",
        code: "missing-feature-toggles",
        message: "配置缺少 features 功能开关对象",
        path: configPath,
        suggestion: "运行 `npx @skrupellose/code-helper init` 补齐默认功能开关。"
      }
    ];
  }

  return FEATURE_KEYS
    .filter((feature) => !(feature in features))
    .map((feature) => ({
      level: "error" as const,
      code: "missing-feature-toggle",
      message: `配置缺少功能开关：${feature}`,
      path: configPath,
      suggestion: "运行 `npx @skrupellose/code-helper init`，让工具补齐默认配置。"
    }));
}

/**
 * 检查配置本身是否保持完整。
 * 这能发现用户手工编辑 config.json 时误删功能项的问题。
 */
export async function checkConfig(config: CodeHelperConfig): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  for (const feature of FEATURE_KEYS) {
    if (config.features[feature] === undefined) {
      issues.push({
        level: "error",
        code: "missing-feature-toggle",
        message: `配置缺少功能开关：${feature}`,
        path: ".code-helper/config.json",
        suggestion: "重新运行 `npx @skrupellose/code-helper init`，让工具补齐默认配置。"
      });
    }
  }

  return issues;
}
