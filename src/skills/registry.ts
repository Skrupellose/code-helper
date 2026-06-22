import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "../config.js";
import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import { getSkillTemplates } from "../templates.js";
import type { OperationResult } from "../types.js";
import {
  assertSupportedTarget,
  formatSkillRegistrationTargetName,
  getProjectSkillsDirectory,
  getSkillFilePath,
  type SkillRegistrationTarget
} from "./targets.js";

/**
 * code-helper 内置 skill 到项目级目录的映射。
 * directoryName 使用 skill frontmatter 中的 name，便于不同 agent 工具直接识别。
 */
export const CODE_HELPER_SKILL_REGISTRATIONS = [
  // Agent 协作 skill 先注册，确保新会话能优先读取协作分工边界。
  {
    templateFileName: "agent-collaboration.SKILL.md",
    directoryName: "code-helper-agent-collaboration"
  },
  {
    templateFileName: "memory-tuning.SKILL.md",
    directoryName: "code-helper-memory-tuning"
  },
  {
    templateFileName: "plan-workbench.SKILL.md",
    directoryName: "code-helper-plan-workbench"
  },
  {
    templateFileName: "manual-test-workbench.SKILL.md",
    directoryName: "code-helper-manual-test-workbench"
  },
  {
    templateFileName: "document-archive.SKILL.md",
    directoryName: "code-helper-document-archive"
  },
  {
    templateFileName: "completion-review.SKILL.md",
    directoryName: "code-helper-completion-review"
  }
] as const;

/**
 * 单个项目级 skill 的注册状态。
 * CLI 用它展示当前项目是否已经注册 code-helper skills。
 */
export interface SkillRegistrationStatus {
  target: SkillRegistrationTarget;
  name: string;
  path: string;
  registered: boolean;
}

/**
 * 项目级 skills 注册选项。
 * update 需要刷新已经存在的受控 skills，但不能因此重新开启用户关闭的功能开关。
 */
export interface RegisterProjectSkillsOptions {
  respectFeatureToggle?: boolean;
}

/**
 * 注册 code-helper 内置 skills 到当前项目。
 * 注册结果按目标写入对应项目级 skills 目录，只影响当前项目。
 */
export async function registerProjectSkills(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex",
  options: RegisterProjectSkillsOptions = {}
): Promise<OperationResult[]> {
  assertSupportedTarget(target);

  const config = await loadConfig(projectRoot);
  const shouldRespectFeatureToggle = options.respectFeatureToggle ?? true;

  if (shouldRespectFeatureToggle && !config.features.skillRegistration.enabled) {
    throw new Error("管理项目 Skills 功能已关闭，请先执行 `code-helper features enable skillRegistration`。");
  }

  const operations: OperationResult[] = [];
  const templates = getSkillTemplates();

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const template = templates.find((item) => item.fileName === registration.templateFileName);

    if (template === undefined) {
      throw new Error(`缺少内置 skill 模板：${registration.templateFileName}`);
    }

    const targetPath = getSkillFilePath(projectRoot, target, registration.directoryName);
    const existing = await readTextIfExists(targetPath);

    if (existing === template.content) {
      operations.push({
        path: targetPath,
        action: "skipped",
        message: "项目级 skill 已是最新内容"
      });
      continue;
    }

    await writeText(targetPath, template.content);
    operations.push({
      path: targetPath,
      action: existing === undefined ? "created" : "updated",
      message: `已注册 ${formatSkillRegistrationTargetName(target)} 项目级 skill`
    });
  }

  return operations;
}

/**
 * 取消注册 code-helper 项目级 skills。
 * 只删除各目标目录下的 `code-helper-*` 受控目录，不触碰用户自己的 skills。
 */
export async function unregisterProjectSkills(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex"
): Promise<OperationResult[]> {
  assertSupportedTarget(target);

  const operations: OperationResult[] = [];

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const targetDirectory = projectPath(projectRoot, join(getProjectSkillsDirectory(target), registration.directoryName));
    const targetPath = join(targetDirectory, "SKILL.md");
    const existing = await readTextIfExists(targetPath);

    if (existing === undefined) {
      operations.push({
        path: targetPath,
        action: "skipped",
        message: "项目级 skill 未注册"
      });
      continue;
    }

    await rm(targetDirectory, { recursive: true, force: true });
    operations.push({
      path: targetDirectory,
      action: "updated",
      message: `已取消注册 ${formatSkillRegistrationTargetName(target)} 项目级 skill`
    });
  }

  const targetRoot = getProjectSkillsDirectory(target);
  await removeEmptyDirectory(projectPath(projectRoot, targetRoot));
  await removeEmptyDirectory(projectPath(projectRoot, dirname(targetRoot)));

  return operations;
}

/**
 * 查看 code-helper 项目级 skills 注册状态。
 * 该函数只检查 code-helper 管理的 skill 名称，不扫描用户自定义 skills。
 */
export async function listProjectSkillRegistrations(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex"
): Promise<SkillRegistrationStatus[]> {
  assertSupportedTarget(target);

  const statuses: SkillRegistrationStatus[] = [];

  for (const registration of CODE_HELPER_SKILL_REGISTRATIONS) {
    const targetPath = getSkillFilePath(projectRoot, target, registration.directoryName);
    statuses.push({
      target,
      name: registration.directoryName,
      path: targetPath,
      registered: (await readTextIfExists(targetPath)) !== undefined
    });
  }

  return statuses;
}

/**
 * 删除空目录。
 * 目录不存在或非空时保持现状，避免误删用户自定义 skills。
 */
async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    const entries = await readdir(path);

    if (entries.length === 0) {
      await rm(path, { recursive: false, force: true });
    }
  } catch {
    // 目录不存在或不可删除时不处理，取消注册不应影响用户文件。
  }
}
