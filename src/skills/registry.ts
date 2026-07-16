import { createHash } from "node:crypto";
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { loadConfig } from "../config.js";
import { projectPath, readTextIfExists, writeText } from "../fs-utils.js";
import { getSkillManifest } from "../templates.js";
import type { SkillTemplate } from "../templates/skills/types.js";
import type { OperationResult } from "../types.js";
import {
  readManagedSkillRecords,
  writeManagedSkillRecords,
  type ManagedSkillRecord,
  type ManagedSkillRecordsByTarget
} from "./state.js";
import {
  assertSupportedTarget,
  formatSkillRegistrationTargetName,
  getProjectSkillsDirectory,
  getSkillFilePath,
  type SkillRegistrationTarget
} from "./targets.js";

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
  /**
   * 单个 Skill 文件的写入实现。
   * 生产环境默认使用跨平台的 UTF-8 写入；测试可注入“先截断再失败”的实现，
   * 稳定验证当前文件和此前文件都会按快照恢复。
   */
  writeSkillFile?: (path: string, content: string) => Promise<void>;
}

/**
 * 一次批量注册中单个 skill 文件的原始状态。
 * 写入中途发生异常时使用该快照恢复，避免留下部分注册或部分更新状态。
 */
interface SkillRegistrationSnapshot {
  target: SkillRegistrationTarget;
  targetPath: string;
  existing: string | undefined;
  content: string;
  /**
   * 标记本轮写入是否已经完整成功。
   * 回滚时只有“原文件不存在且写入从未成功”的快照，才允许把 ENOTDIR 视为目标目录从未创建。
   */
  writeCompleted: boolean;
}

/**
 * 批量注册 code-helper 内置 skills 到一个或多个 agent 目标。
 *
 * 所有目标路径会先完成读取和模板校验，再开始实际写入。若任意写入失败，
 * 已变更文件会按快照逆序恢复，从而保证 `all` 等多目标操作不会只成功一部分。
 */
export async function registerProjectSkillsForTargets(
  projectRoot: string,
  targets: SkillRegistrationTarget[],
  options: RegisterProjectSkillsOptions = {}
): Promise<OperationResult[]> {
  const uniqueTargets = [...new Set(targets)];

  for (const target of uniqueTargets) {
    assertSupportedTarget(target);
  }

  const config = await loadConfig(projectRoot);
  const shouldRespectFeatureToggle = options.respectFeatureToggle ?? true;
  const writeSkillFile = options.writeSkillFile ?? writeText;

  if (shouldRespectFeatureToggle && !config.features.skillRegistration.enabled) {
    throw new Error("管理项目 Skills 功能已关闭，请先执行 `code-helper features enable skillRegistration`。");
  }

  const manifest = getValidatedSkillManifest();
  const managedRecords = await readManagedSkillRecords(projectRoot);
  const snapshots: SkillRegistrationSnapshot[] = [];

  // 先读取整批目标的原始状态。路径冲突等确定性错误会在任何写入前暴露。
  for (const target of uniqueTargets) {
    for (const skill of manifest) {
      const targetPath = getSkillFilePath(projectRoot, target, skill.directoryName);
      snapshots.push({
        target,
        targetPath,
        existing: await readTextIfExists(targetPath),
        content: skill.content,
        writeCompleted: false
      });
    }
  }

  const operations: OperationResult[] = [];
  const changedSnapshots: SkillRegistrationSnapshot[] = [];

  try {
    for (const snapshot of snapshots) {
      if (snapshot.existing === snapshot.content) {
        operations.push({
          path: snapshot.targetPath,
          action: "skipped",
          message: "项目级 skill 已是最新内容"
        });
        continue;
      }

      // 必须在开始写入前把当前文件纳入回滚范围。
      // Node 的 writeFile 可能已经截断目标文件后才因磁盘或设备错误失败；
      // 若等写入成功后再记录快照，当前文件将无法恢复。
      changedSnapshots.push(snapshot);
      await writeSkillFile(snapshot.targetPath, snapshot.content);
      snapshot.writeCompleted = true;
      operations.push({
        path: snapshot.targetPath,
        action: snapshot.existing === undefined ? "created" : "updated",
        message: `已注册 ${formatSkillRegistrationTargetName(snapshot.target)} 项目级 skill`
      });
    }
  } catch (error) {
    await rollbackSkillRegistrationAfterFailure(projectRoot, changedSnapshots, error);
  }

  const currentRecords = Object.fromEntries(
    manifest.map((skill) => [
      skill.directoryName,
      { contentFingerprint: createContentFingerprint(skill.content) }
    ])
  );
  const stagedManagedRecords = mergeManagedSkillRecords(
    managedRecords,
    uniqueTargets,
    currentRecords,
    true
  );

  try {
    // 先持久化“旧受控目录 + 当前 manifest”并集。
    // 若状态写入失败，回滚本轮 Skill 文件，避免出现已注册但无法追踪退休生命周期的状态。
    await writeManagedSkillRecords(projectRoot, stagedManagedRecords);
  } catch (error) {
    await rollbackSkillRegistrationAfterFailure(projectRoot, changedSnapshots, error);
  }

  const retirementResult = await removeRetiredManagedSkillDirectories(
    projectRoot,
    uniqueTargets,
    managedRecords,
    new Set(Object.keys(currentRecords))
  );
  operations.push(...retirementResult.operations);

  const finalManagedRecords = mergeManagedSkillRecords(
    stagedManagedRecords,
    uniqueTargets,
    currentRecords,
    false
  );

  for (const [target, retainedRecords] of retirementResult.retainedRecordsByTarget) {
    finalManagedRecords[target] = {
      ...(finalManagedRecords[target] ?? {}),
      ...retainedRecords
    };
  }

  try {
    await writeManagedSkillRecords(projectRoot, finalManagedRecords);
  } catch {
    // 前一次写入仍保留旧目录与当前 manifest 的并集，不会失去受控归属。
    // 下次 register/update 会重试退休清理，因此这里不破坏已经成功的注册结果。
    operations.push({
      path: projectPath(projectRoot, ".code-helper/state.json"),
      action: "skipped",
      message: "项目级 skills 已注册，但退休 Skill 状态收敛失败；下次更新会重试"
    });
  }

  return operations;
}

/**
 * 注册 code-helper 内置 skills 到单个 agent 目标。
 * 保留原公共 API，并复用批量事务保证单目标六个内置 Skills 也具备原子性。
 */
export async function registerProjectSkills(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex",
  options: RegisterProjectSkillsOptions = {}
): Promise<OperationResult[]> {
  return registerProjectSkillsForTargets(projectRoot, [target], options);
}

/**
 * 取消注册 code-helper 项目级 skills。
 * 当前 manifest 中的精确目录名始终属于 code-helper 受控范围，即使 SKILL.md
 * 缺失或损坏也可删除；退休目录则必须同时存在于 state.json 的目标记录中。
 */
export async function unregisterProjectSkills(
  projectRoot: string,
  target: SkillRegistrationTarget = "codex"
): Promise<OperationResult[]> {
  return unregisterProjectSkillsForTargets(projectRoot, [target]);
}

/**
 * 批量取消一个或多个 agent 目标的项目级 Skills。
 *
 * 整批操作只读取和写回一次所有权状态，避免并发单目标取消时互相覆盖
 * `managedSkillRecords`。磁盘删除仍按目标顺序执行，便于错误定位和安全重试。
 */
export async function unregisterProjectSkillsForTargets(
  projectRoot: string,
  targets: SkillRegistrationTarget[]
): Promise<OperationResult[]> {
  const uniqueTargets = [...new Set(targets)];

  for (const target of uniqueTargets) {
    assertSupportedTarget(target);
  }

  const manifest = getValidatedSkillManifest();
  const currentDirectoryNames = manifest.map((skill) => skill.directoryName);
  const managedRecords = await readManagedSkillRecords(projectRoot);
  const nextManagedRecords = { ...managedRecords };
  const operations: OperationResult[] = [];

  for (const target of uniqueTargets) {
    const retiredRecords = Object.fromEntries(
      Object.entries(managedRecords[target] ?? {}).filter(
        ([name]) => !currentDirectoryNames.includes(name) && isSafeManagedSkillDirectoryName(name)
      )
    );

    for (const directoryName of currentDirectoryNames) {
      const targetDirectory = projectPath(projectRoot, join(getProjectSkillsDirectory(target), directoryName));
      const exists = await pathExists(targetDirectory);

      if (!exists) {
        operations.push({
          path: join(targetDirectory, "SKILL.md"),
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

    const retirementResult = await removeRetiredManagedSkillDirectories(
      projectRoot,
      [target],
      { [target]: retiredRecords },
      new Set(currentDirectoryNames)
    );
    operations.push(...retirementResult.operations);

    const retainedRetiredRecords = retirementResult.retainedRecordsByTarget.get(target);
    if (retainedRetiredRecords === undefined || Object.keys(retainedRetiredRecords).length === 0) {
      delete nextManagedRecords[target];
    } else {
      nextManagedRecords[target] = retainedRetiredRecords;
    }
  }

  await writeManagedSkillRecords(projectRoot, nextManagedRecords);

  for (const target of uniqueTargets) {
    const targetRoot = getProjectSkillsDirectory(target);
    await removeEmptyDirectory(projectPath(projectRoot, targetRoot));
    await removeEmptyDirectory(projectPath(projectRoot, dirname(targetRoot)));
  }

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

  for (const skill of getValidatedSkillManifest()) {
    const targetPath = getSkillFilePath(projectRoot, target, skill.directoryName);
    statuses.push({
      target,
      name: skill.directoryName,
      path: targetPath,
      registered: (await readTextIfExists(targetPath)) !== undefined
    });
  }

  return statuses;
}

/**
 * 删除空目录。
 * 先显式确认目录为空，再使用跨平台可靠的 rmdir 删除；目录不存在或在检查后被写入时保持现状，
 * 避免误删用户自定义 skills。权限、路径形态或设备异常必须继续抛出，不能掩盖注册回滚失败。
 */
async function removeEmptyDirectory(
  path: string,
  options: { allowNotDirectory?: boolean } = {}
): Promise<void> {
  let entries: string[];

  try {
    entries = await readdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || (code === "ENOTDIR" && options.allowNotDirectory === true)) {
      return;
    }

    throw error;
  }

  if (entries.length > 0) {
    return;
  }

  try {
    await rmdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (
      code === "ENOENT" ||
      code === "ENOTEMPTY" ||
      (code === "ENOTDIR" && options.allowNotDirectory === true)
    ) {
      return;
    }

    throw error;
  }
}

/**
 * 返回并校验单一 manifest。
 * 注册目录必须是安全单层名称，且 frontmatter name、目录名和 manifest name 一致。
 */
function getValidatedSkillManifest(): readonly SkillTemplate[] {
  const manifest = getSkillManifest();
  const fileNames = new Set<string>();
  const directoryNames = new Set<string>();
  const names = new Set<string>();

  for (const skill of manifest) {
    if (!isSafeManagedSkillDirectoryName(skill.directoryName)) {
      throw new Error(`内置 skill 目录名不安全：${skill.directoryName}`);
    }

    if (skill.name !== skill.directoryName) {
      throw new Error(`内置 skill name 与目录名不一致：${skill.name} / ${skill.directoryName}`);
    }

    if (!skill.content.includes(`name: ${skill.name}`)) {
      throw new Error(`内置 skill 正文缺少匹配的 name：${skill.fileName}`);
    }

    if (fileNames.has(skill.fileName) || directoryNames.has(skill.directoryName) || names.has(skill.name)) {
      throw new Error(`内置 skill manifest 存在重复项：${skill.name}`);
    }

    fileNames.add(skill.fileName);
    directoryNames.add(skill.directoryName);
    names.add(skill.name);
  }

  return manifest;
}

/**
 * 只接受单层、带 code-helper 前缀的精确目录名。
 * 该函数不扫描 `code-helper-*`，只用于校验 manifest 或 state 中已经列出的单个名称。
 */
function isSafeManagedSkillDirectoryName(name: string): boolean {
  return (
    name.startsWith("code-helper-") &&
    name.length > "code-helper-".length &&
    !isAbsolute(name) &&
    basename(name) === name &&
    name !== "." &&
    name !== ".."
  );
}

/**
 * 合并目标的受控目录记录。
 * includePrevious=true 用于退休清理前的安全暂存；false 用于成功清理后的最终状态。
 */
function mergeManagedSkillRecords(
  existing: ManagedSkillRecordsByTarget,
  targets: SkillRegistrationTarget[],
  currentRecords: Record<string, ManagedSkillRecord>,
  includePrevious: boolean
): ManagedSkillRecordsByTarget {
  const next: ManagedSkillRecordsByTarget = { ...existing };

  for (const target of targets) {
    next[target] = {
      ...(includePrevious ? filterSafeManagedSkillRecords(existing[target] ?? {}) : {}),
      ...currentRecords
    };
  }

  return next;
}

/**
 * 清理已经从 manifest 退休、且曾被 state 明确记录为 code-helper 受控的目录。
 * 未记录的用户目录即使带 code-helper 前缀也不会进入候选集。
 */
async function removeRetiredManagedSkillDirectories(
  projectRoot: string,
  targets: SkillRegistrationTarget[],
  managedRecords: ManagedSkillRecordsByTarget,
  activeDirectoryNames: Set<string>
): Promise<{
  operations: OperationResult[];
  retainedRecordsByTarget: Map<SkillRegistrationTarget, Record<string, ManagedSkillRecord>>;
}> {
  const operations: OperationResult[] = [];
  const retainedRecordsByTarget = new Map<SkillRegistrationTarget, Record<string, ManagedSkillRecord>>();

  for (const target of targets) {
    const retiredRecords = Object.entries(managedRecords[target] ?? {}).filter(
      ([name]) => isSafeManagedSkillDirectoryName(name) && !activeDirectoryNames.has(name)
    );

    for (const [directoryName, record] of retiredRecords) {
      const targetDirectory = projectPath(projectRoot, join(getProjectSkillsDirectory(target), directoryName));

      try {
        if (!(await pathExists(targetDirectory))) {
          continue;
        }

        const entries = await readdir(targetDirectory);

        // 受控目录被清空后不可能承载用户内容，可安全删除目录壳。
        if (entries.length === 0) {
          await rm(targetDirectory, { recursive: true, force: true });
          operations.push({
            path: targetDirectory,
            action: "updated",
            message: `已清理 ${formatSkillRegistrationTargetName(target)} 空退休项目级 skill`
          });
          continue;
        }

        const skillPath = join(targetDirectory, "SKILL.md");
        const existingSkill = await readTextIfExists(skillPath);

        if (
          existingSkill === undefined ||
          createContentFingerprint(existingSkill) !== record.contentFingerprint
        ) {
          retainManagedSkillRecord(retainedRecordsByTarget, target, directoryName, record);
          operations.push({
            path: targetDirectory,
            action: "skipped",
            message: "退休项目级 skill 内容已变化或缺少受控 SKILL.md，已保留目录和所有权记录"
          });
          continue;
        }

        await rm(targetDirectory, { recursive: true, force: true });
        operations.push({
          path: targetDirectory,
          action: "updated",
          message: `已清理 ${formatSkillRegistrationTargetName(target)} 退休项目级 skill`
        });
      } catch {
        retainManagedSkillRecord(retainedRecordsByTarget, target, directoryName, record);
        operations.push({
          path: targetDirectory,
          action: "skipped",
          message: `退休项目级 skill 清理失败，已保留受控记录供下次更新重试`
        });
      }
    }
  }

  return { operations, retainedRecordsByTarget };
}

/** 对 Skill 正文计算稳定 SHA-256 指纹，作为退休清理的所有权证明。 */
function createContentFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 过滤 state 中不安全的目录名或损坏记录。 */
function filterSafeManagedSkillRecords(
  records: Record<string, ManagedSkillRecord>
): Record<string, ManagedSkillRecord> {
  return Object.fromEntries(
    Object.entries(records).filter(([name]) => isSafeManagedSkillDirectoryName(name))
  );
}

/** 将无法安全清理的退休记录保留到下一次更新或人工处理。 */
function retainManagedSkillRecord(
  retainedRecordsByTarget: Map<SkillRegistrationTarget, Record<string, ManagedSkillRecord>>,
  target: SkillRegistrationTarget,
  directoryName: string,
  record: ManagedSkillRecord
): void {
  retainedRecordsByTarget.set(target, {
    ...(retainedRecordsByTarget.get(target) ?? {}),
    [directoryName]: record
  });
}

/** 判断精确目标路径是否存在；文件或目录都视为存在并可按受控名称清理。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

/**
 * 逆序恢复本轮已经成功写入的 skill 文件。
 * 新建文件只删除 SKILL.md 并清理空目录，绝不递归删除可能已存在的同目录用户资产。
 */
async function rollbackSkillRegistration(
  projectRoot: string,
  changedSnapshots: SkillRegistrationSnapshot[]
): Promise<void> {
  const rollbackErrors: unknown[] = [];

  for (const snapshot of [...changedSnapshots].reverse()) {
    if (snapshot.existing === undefined) {
      const allowNotDirectory = !snapshot.writeCompleted;
      const cleanupSteps = [
        async (): Promise<void> => {
          try {
            await rm(snapshot.targetPath, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOTDIR" && allowNotDirectory) {
              return;
            }

            throw error;
          }
        },
        async (): Promise<void> => {
          await removeEmptyDirectory(dirname(snapshot.targetPath), { allowNotDirectory });
        },
        async (): Promise<void> => {
          await removeEmptyDirectory(projectPath(projectRoot, getProjectSkillsDirectory(snapshot.target)));
        },
        async (): Promise<void> => {
          await removeEmptyDirectory(projectPath(projectRoot, dirname(getProjectSkillsDirectory(snapshot.target))));
        }
      ];

      // 单个快照的各清理步骤也要尽力执行，避免一个异常阻止后续受控目录恢复。
      for (const cleanupStep of cleanupSteps) {
        try {
          await cleanupStep();
        } catch (error) {
          rollbackErrors.push(
            new Error(
              `回滚新建 Skill 失败：${snapshot.targetPath}：${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error }
            )
          );
        }
      }
      continue;
    }

    try {
      await writeText(snapshot.targetPath, snapshot.existing);
    } catch (error) {
      rollbackErrors.push(
        new Error(
          `恢复 Skill 原内容失败：${snapshot.targetPath}：${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      );
    }
  }

  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      rollbackErrors,
      `项目级 Skills 回滚未完整完成，共 ${rollbackErrors.length} 个错误`
    );
  }
}

/**
 * 注册失败后执行事务回滚。
 * 若回滚自身也失败，同时保留原始注册错误和回滚错误，避免任一故障被另一个故障掩盖。
 */
async function rollbackSkillRegistrationAfterFailure(
  projectRoot: string,
  changedSnapshots: SkillRegistrationSnapshot[],
  registrationError: unknown
): Promise<never> {
  try {
    await rollbackSkillRegistration(projectRoot, changedSnapshots);
  } catch (rollbackError) {
    const registrationMessage =
      registrationError instanceof Error ? registrationError.message : String(registrationError);
    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);

    throw new AggregateError(
      [registrationError, rollbackError],
      `项目级 Skills 注册失败：${registrationMessage}；回滚未完整完成：${rollbackMessage}`
    );
  }

  throw registrationError;
}
