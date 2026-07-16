import { join } from "node:path";
import { parseDocument } from "yaml";

import { projectPath, readTextIfExists } from "../fs-utils.js";
import { getSkillManifest } from "../templates.js";
import { readDirectoryIfExists, readSkillDocumentIfExists } from "./shared.js";
import {
  ALL_SKILL_REGISTRATION_TARGETS,
  formatSkillRegistrationTargetName,
  getProjectSkillsDirectory,
  getSkillFilePath,
  type SkillRegistrationTarget
} from "./targets.js";

/**
 * skills doctor 的检查结果。
 * warning 用于可改进项，error 用于会导致 skill 无法被识别的结构问题。
 */
export interface SkillDoctorIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  path: string;
  suggestion: string;
}

/**
 * 检查当前项目 skills 的结构和质量。
 * 该函数只做静态检查，不执行任何 skill 中的脚本或命令。
 */
export async function runSkillsDoctor(projectRoot: string): Promise<SkillDoctorIssue[]> {
  const issues: SkillDoctorIssue[] = [];

  for (const target of ALL_SKILL_REGISTRATION_TARGETS) {
    issues.push(...(await checkCodeHelperRegistration(projectRoot, target)));
    issues.push(...(await checkSkillDirectory(projectRoot, target)));
  }

  return issues;
}

/**
 * 检查 code-helper 管理的 skill 是否缺失或过期。
 */
async function checkCodeHelperRegistration(
  projectRoot: string,
  target: SkillRegistrationTarget
): Promise<SkillDoctorIssue[]> {
  const issues: SkillDoctorIssue[] = [];
  const manifest = getSkillManifest();
  const registrations = await Promise.all(
    manifest.map(async (skill) => {
      const skillPath = getSkillFilePath(projectRoot, target, skill.directoryName);

      return {
        skill,
        skillPath,
        existing: await readTextIfExists(skillPath)
      };
    })
  );
  const hasAnyCodeHelperSkill = registrations.some((item) => item.existing !== undefined);

  for (const { skill, skillPath, existing } of registrations) {
    if (existing === undefined) {
      // 完全未使用该目标时保持安静；一旦出现任一内置 skill，就必须校验整套注册完整性。
      if (hasAnyCodeHelperSkill) {
        issues.push({
          level: "error",
          code: "missing-code-helper-skill",
          message: `${formatSkillRegistrationTargetName(target)} 的 code-helper skills 注册不完整，缺少 ${skill.directoryName}。`,
          path: skillPath,
          suggestion: `运行 \`code-helper skills register ${target}\` 补齐全部 code-helper 管理的 skills。`
        });
      }
      continue;
    }

    if (existing !== skill.content) {
      issues.push({
        level: "warning",
        code: "outdated-code-helper-skill",
        message: `${formatSkillRegistrationTargetName(target)} 中的 ${skill.directoryName} 与当前内置模板不一致。`,
        path: skillPath,
        suggestion: `运行 \`code-helper skills register ${target}\` 刷新 code-helper 管理的 skill。`
      });
    }
  }

  return issues;
}

/**
 * 检查指定 agent skills 目录下的所有 SKILL.md。
 */
async function checkSkillDirectory(projectRoot: string, target: SkillRegistrationTarget): Promise<SkillDoctorIssue[]> {
  const issues: SkillDoctorIssue[] = [];
  const skillsRoot = projectPath(projectRoot, getProjectSkillsDirectory(target));
  const entries = await readDirectoryIfExists(skillsRoot);

  if (entries === undefined) {
    return issues;
  }

  for (const entry of entries) {
    const skillPath = join(skillsRoot, entry, "SKILL.md");
    const content = await readSkillDocumentIfExists(skillPath);

    if (content === undefined) {
      issues.push({
        level: "error",
        code: "missing-skill-md",
        message: `${formatSkillRegistrationTargetName(target)} skill 目录缺少 SKILL.md：${entry}`,
        path: join(skillsRoot, entry),
        suggestion: "补齐 SKILL.md，或删除空的 skill 目录。"
      });
      continue;
    }

    issues.push(...checkSkillDocument(target, entry, skillPath, content));
  }

  return issues;
}

/**
 * 检查单个 SKILL.md 的基本结构。
 */
function checkSkillDocument(
  target: SkillRegistrationTarget,
  directoryName: string,
  skillPath: string,
  content: string
): SkillDoctorIssue[] {
  const issues: SkillDoctorIssue[] = [];
  const frontmatterResult = parseSkillFrontmatter(content);

  if (frontmatterResult.status === "missing") {
    issues.push({
      level: "error",
      code: "missing-frontmatter",
      message: `${formatSkillRegistrationTargetName(target)} skill 缺少 YAML frontmatter：${directoryName}`,
      path: skillPath,
      suggestion: "在文件开头补充包含 name 和 description 的 frontmatter。"
    });
    return issues;
  }

  if (frontmatterResult.status === "invalid") {
    issues.push({
      level: "error",
      code: "invalid-frontmatter",
      message: `${formatSkillRegistrationTargetName(target)} skill 的 YAML frontmatter 无法解析：${directoryName}（${frontmatterResult.message}）`,
      path: skillPath,
      suggestion: "修复 YAML 语法或将 name、description 调整为字符串字段后重新检查。"
    });
    return issues;
  }

  const frontmatter = frontmatterResult.value;

  if (frontmatter.name === undefined || frontmatter.name.trim() === "") {
    issues.push({
      level: "error",
      code: "missing-skill-name",
      message: `${formatSkillRegistrationTargetName(target)} skill 缺少 name：${directoryName}`,
      path: skillPath,
      suggestion: "在 frontmatter 中补充稳定的 name 字段。"
    });
  } else if (frontmatter.name !== directoryName) {
    issues.push({
      level: "warning",
      code: "skill-name-directory-mismatch",
      message: `${formatSkillRegistrationTargetName(target)} skill 的 name 与目录名不一致：${directoryName}`,
      path: skillPath,
      suggestion: "优先保持目录名与 frontmatter name 一致，降低不同 agent 工具识别差异。"
    });
  }

  if (frontmatter.description === undefined || frontmatter.description.trim().length < 20) {
    issues.push({
      level: "warning",
      code: "weak-skill-description",
      message: `${formatSkillRegistrationTargetName(target)} skill 的 description 过短或缺失：${directoryName}`,
      path: skillPath,
      suggestion: "补充包含触发场景、输入条件和输出目标的 description。"
    });
  }

  if (!content.includes("## ")) {
    issues.push({
      level: "warning",
      code: "missing-skill-sections",
      message: `${formatSkillRegistrationTargetName(target)} skill 缺少二级标题结构：${directoryName}`,
      path: skillPath,
      suggestion: "至少补充目标、适用场景、流程或边界规则等小节，便于 agent 按需读取。"
    });
  }

  return issues;
}

type SkillFrontmatterParseResult =
  | { status: "missing" }
  | { status: "invalid"; message: string }
  | { status: "valid"; value: { name?: string; description?: string } };

/**
 * 解析 skill frontmatter 中的 name 和 description。
 * 使用标准 YAML 解析器兼容块字符串、引号、注释和 CRLF；解析或字段类型失败时
 * 返回独立状态，避免损坏 YAML 被继续误报为 description 过短。
 */
function parseSkillFrontmatter(content: string): SkillFrontmatterParseResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);

  if (match === null) {
    return { status: "missing" };
  }

  const document = parseDocument(match[1], {
    prettyErrors: false,
    strict: true
  });

  if (document.errors.length > 0) {
    return {
      status: "invalid",
      message: document.errors[0].message
    };
  }

  let value: unknown;

  try {
    value = document.toJS();
  } catch (error) {
    // YAML 别名展开限制等错误可能在转换阶段出现，也应归入可定位的 frontmatter 解析问题。
    return {
      status: "invalid",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      status: "invalid",
      message: "frontmatter 顶层必须是键值对象"
    };
  }

  const record = value as Record<string, unknown>;

  if (record.name !== undefined && typeof record.name !== "string") {
    return {
      status: "invalid",
      message: "name 必须是字符串"
    };
  }

  if (record.description !== undefined && typeof record.description !== "string") {
    return {
      status: "invalid",
      message: "description 必须是字符串"
    };
  }

  return {
    status: "valid",
    value: {
      name: record.name,
      description: record.description
    }
  };
}
