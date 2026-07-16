import { join } from "node:path";

import { loadConfig } from "../config.js";
import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import {
  ALL_SKILL_REGISTRATION_TARGETS,
  type SkillRegistrationTarget
} from "./targets.js";

/**
 * state.json 中按 agent 目标记录的 code-helper 受控 Skill 目录。
 *
 * 该记录用于识别未来已经从 manifest 退休的目录。没有记录的目录即使名称以
 * `code-helper-` 开头，也不能据此推断为工具受控内容。
 */
export type ManagedSkillDirectoriesByTarget = Partial<Record<SkillRegistrationTarget, string[]>>;

/** 单个受控 Skill 的所有权证明。 */
export interface ManagedSkillRecord {
  /**
   * code-helper 最近一次写入该 SKILL.md 时的 SHA-256 指纹。
   * 退休清理前必须重新计算并匹配，避免误删用户后来同名重建的内容。
   */
  contentFingerprint: string;
}

/** 按 agent 目标和精确目录名记录的受控 Skill 所有权。 */
export type ManagedSkillRecordsByTarget = Partial<
  Record<SkillRegistrationTarget, Record<string, ManagedSkillRecord>>
>;

interface PersistedSkillState {
  managedSkillDirectories?: ManagedSkillDirectoriesByTarget;
  managedSkillRecords?: ManagedSkillRecordsByTarget;
}

/** 判断 JSON 值是否为可安全展开的普通对象。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取完整 state 对象。
 * 旧项目缺少文件或字段、状态文件损坏时采用保守兼容，不猜测任何退休目录归属。
 */
async function readStateObject(projectRoot: string): Promise<Record<string, unknown>> {
  const config = await loadConfig(projectRoot);
  const statePath = projectPath(projectRoot, join(config.directories.workspace, "state.json"));
  const content = await readTextIfExists(statePath);

  if (content === undefined) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(content);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读取由 code-helper 明确记录的受控 Skill 目录。
 * 字段内部逐目标、逐名称校验，避免损坏状态污染文件系统操作。
 */
export async function readManagedSkillDirectories(
  projectRoot: string
): Promise<ManagedSkillDirectoriesByTarget> {
  const state = await readStateObject(projectRoot) as PersistedSkillState;
  const rawManagedDirectories = state.managedSkillDirectories;

  if (!isJsonObject(rawManagedDirectories)) {
    return {};
  }

  const result: ManagedSkillDirectoriesByTarget = {};

  for (const target of ALL_SKILL_REGISTRATION_TARGETS) {
    const names = rawManagedDirectories[target];

    if (!Array.isArray(names)) {
      continue;
    }

    result[target] = [...new Set(names.filter((name): name is string => typeof name === "string"))];
  }

  return result;
}

/**
 * 读取带内容指纹的受控 Skill 所有权记录。
 * 旧版只有 managedSkillDirectories 时返回空记录，退休清理必须保守跳过。
 */
export async function readManagedSkillRecords(
  projectRoot: string
): Promise<ManagedSkillRecordsByTarget> {
  const state = await readStateObject(projectRoot) as PersistedSkillState;
  const rawRecords = state.managedSkillRecords;

  if (!isJsonObject(rawRecords)) {
    return {};
  }

  const result: ManagedSkillRecordsByTarget = {};

  for (const target of ALL_SKILL_REGISTRATION_TARGETS) {
    const targetRecords = rawRecords[target];

    if (!isJsonObject(targetRecords)) {
      continue;
    }

    result[target] = Object.fromEntries(
      Object.entries(targetRecords).filter((entry): entry is [string, ManagedSkillRecord] => {
        const record = entry[1];
        return (
          isJsonObject(record) &&
          typeof record.contentFingerprint === "string" &&
          record.contentFingerprint.length > 0
        );
      })
    );
  }

  return result;
}

/**
 * 写回带指纹的受控 Skill 所有权记录，并保留 state.json 中其它字段。
 * 旧版 managedSkillDirectories 不在这里删除，便于后续显式迁移或人工审计。
 */
export async function writeManagedSkillRecords(
  projectRoot: string,
  managedSkillRecords: ManagedSkillRecordsByTarget
): Promise<void> {
  const config = await loadConfig(projectRoot);
  const statePath = projectPath(projectRoot, join(config.directories.workspace, "state.json"));
  const existingState = await readStateObject(projectRoot);
  const nextState = {
    ...existingState,
    managedSkillRecords
  };

  await writeText(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
}
