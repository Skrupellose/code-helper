import { projectPath, readTextIfExists } from "../fs-utils.js";
import type { CheckIssue, CodeHelperConfig } from "../types.js";

/**
 * 检查测试策略是否已经安装。
 * 如果用户关闭 testingPolicy，则跳过该检查。
 */
export async function checkTestingPolicy(projectRoot: string, config: CodeHelperConfig): Promise<CheckIssue[]> {
  if (!config.features.testingPolicy.enabled) {
    return [];
  }

  const policyPath = `${config.directories.userRules}/测试策略规范.md`;
  const content = await readTextIfExists(projectPath(projectRoot, policyPath));

  if (content === undefined) {
    return [
      {
        level: "error",
        code: "missing-testing-policy",
        message: "缺少测试策略规范",
        path: policyPath,
        suggestion: "运行 `npx @skrupellose/code-helper init` 安装默认测试策略规范。"
      }
    ];
  }

  if (!content.includes("页面相关测试全部生成严格手工测试文档")) {
    return [
      {
        level: "warning",
        code: "testing-policy-weakened",
        message: "测试策略规范可能缺少页面手工测试约束",
        path: policyPath,
        suggestion: "补充页面测试只生成手工测试文档、工具只执行纯逻辑测试的规则。"
      }
    ];
  }

  return [];
}
