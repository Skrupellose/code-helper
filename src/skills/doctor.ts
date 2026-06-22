import { join } from "node:path";

import { projectPath, readTextIfExists } from "../fs-utils.js";
import { getSkillTemplates } from "../templates.js";
import { CODE_HELPER_SKILL_REGISTRATIONS } from "./registry.js";
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
  const templates = getSkillTemplates();

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const template = templates.find((item) => item.fileName === registration.templateFileName);
    const skillPath = getSkillFilePath(projectRoot, target, registration.directoryName);
    const existing = await readTextIfExists(skillPath);

    if (existing === undefined) {
      continue;
    }

    if (template !== undefined && existing !== template.content) {
      issues.push({
        level: "warning",
        code: "outdated-code-helper-skill",
        message: `${formatSkillRegistrationTargetName(target)} 中的 ${registration.directoryName} 与当前内置模板不一致。`,
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
  const frontmatter = parseSkillFrontmatter(content);

  if (frontmatter === undefined) {
    issues.push({
      level: "error",
      code: "missing-frontmatter",
      message: `${formatSkillRegistrationTargetName(target)} skill 缺少 YAML frontmatter：${directoryName}`,
      path: skillPath,
      suggestion: "在文件开头补充包含 name 和 description 的 frontmatter。"
    });
    return issues;
  }

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

/**
 * 解析 skill frontmatter 中的 name 和 description。
 * 这里只做轻量解析，避免为了静态检查引入 YAML 依赖。
 */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);

  if (match === null) {
    return undefined;
  }

  const result: { name?: string; description?: string } = {};

  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^(name|description):\s*(.*)$/u.exec(line);

    if (field !== null) {
      result[field[1] as "name" | "description"] = field[2].trim();
    }
  }

  return result;
}
