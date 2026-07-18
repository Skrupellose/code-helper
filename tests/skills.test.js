import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test } from "node:test";

import { loadConfig, setFeatureEnabled } from "../dist/config.js";
import { runCli } from "../dist/cli.js";
import { writeText } from "../dist/fs-utils.js";
import {
  getSkillManifest,
  listProjectSkillRegistrations,
  parseSkillRegistrationTargets,
  registerProjectSkills,
  registerProjectSkillsForTargets,
  resolveSkillRegistrationTargets,
  runSkillsAudit,
  runSkillsDoctor,
  unregisterProjectSkills
} from "../dist/skills.js";
import { getProjectSkillsDirectory } from "../dist/skills/targets.js";

const CODE_HELPER_SKILL_NAMES = getSkillManifest().map((skill) => skill.directoryName);
const CODE_HELPER_SKILL_COUNT = CODE_HELPER_SKILL_NAMES.length;

/**
 * 返回测试目标对应的项目级 Skills 根目录。
 * 测试显式覆盖四类 agent，避免路径断言只在 Codex 目录下成立。
 */
function getTargetSkillsRoot(root, target) {
  if (target === "codex") {
    return join(root, ".agents/skills");
  }

  if (target === "claudecode") {
    return join(root, ".claude/skills");
  }

  if (target === "githubcopilot") {
    return join(root, ".github/skills");
  }

  return join(root, ".grok/skills");
}

/**
 * 在测试项目 state.json 中追加受控 Skill 目录记录。
 * 用于模拟未来版本从 manifest 移除 Skill 后的安全退休迁移。
 */
async function recordManagedSkillDirectories(root, target, directoryNames) {
  const statePath = join(root, ".code-helper/state.json");
  let state = {};

  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    // 旧项目可能尚未生成 state.json，测试从空状态开始即可。
  }

  state.managedSkillDirectories = {
    ...(state.managedSkillDirectories ?? {}),
    [target]: directoryNames
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * 写入带内容指纹的新版本受控 Skill 记录。
 */
async function recordManagedSkillFingerprints(root, target, records) {
  const statePath = join(root, ".code-helper/state.json");
  let state = {};

  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    // 测试允许从尚未初始化的空项目开始。
  }

  state.managedSkillRecords = {
    ...(state.managedSkillRecords ?? {}),
    [target]: Object.fromEntries(
      Object.entries(records).map(([directoryName, content]) => [
        directoryName,
        {
          contentFingerprint: createHash("sha256").update(content, "utf8").digest("hex")
        }
      ])
    )
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

test("内置 Skill 单一 manifest 的名称、目录、模板文件和正文保持一致", () => {
  const manifest = getSkillManifest();

  assert.equal(manifest.length, 7);
  assert.ok(manifest.some((skill) => skill.name === "code-helper-review-fix"));
  assert.equal(new Set(manifest.map((skill) => skill.fileName)).size, manifest.length);
  assert.equal(new Set(manifest.map((skill) => skill.directoryName)).size, manifest.length);
  assert.equal(new Set(manifest.map((skill) => skill.name)).size, manifest.length);

  for (const skill of manifest) {
    assert.equal(skill.name, skill.directoryName);
    assert.match(skill.directoryName, /^code-helper-[a-z0-9-]+$/u);
    assert.match(skill.fileName, /\.SKILL\.md$/u);
    assert.match(skill.content, new RegExp(`^---[\\s\\S]*?name: ${skill.name}\\n`, "u"));
  }
});

test("getSkillManifest 返回运行时冻结清单，JavaScript 调用方无法污染后续结果", () => {
  const manifest = getSkillManifest();
  const originalName = manifest[0].name;
  const originalLength = manifest.length;

  assert.equal(Object.isFrozen(manifest), true);
  assert.ok(manifest.every((skill) => Object.isFrozen(skill)));
  assert.throws(
    () => manifest.push(manifest[0]),
    TypeError
  );
  assert.throws(
    () => {
      manifest[0].name = "code-helper-polluted";
    },
    TypeError
  );

  const nextManifest = getSkillManifest();
  assert.equal(nextManifest.length, originalLength);
  assert.equal(nextManifest[0].name, originalName);
});

test("registerProjectSkills 会注册 Codex 项目级 skills 并保持幂等", async () => {
  // 该测试确认 code-helper skills 只注册到当前项目的 .agents/skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-register-"));

  try {
    const firstOperations = await registerProjectSkills(root);
    const secondOperations = await registerProjectSkills(root);
    const statuses = await listProjectSkillRegistrations(root);
    const completionSkill = await readFile(
      join(root, ".agents/skills/code-helper-completion-review/SKILL.md"),
      "utf8"
    );
    const collaborationSkill = await readFile(
      join(root, ".agents/skills/code-helper-agent-collaboration/SKILL.md"),
      "utf8"
    );
    const manualTestSkill = await readFile(
      join(root, ".agents/skills/code-helper-manual-test-workbench/SKILL.md"),
      "utf8"
    );
    const reviewFixSkill = await readFile(
      join(root, ".agents/skills/code-helper-review-fix/SKILL.md"),
      "utf8"
    );

    assert.equal(firstOperations.length, CODE_HELPER_SKILL_COUNT);
    assert.ok(firstOperations.every((operation) => operation.action === "created"));
    assert.ok(secondOperations.every((operation) => operation.action === "skipped"));
    assert.ok(statuses.every((status) => status.registered));
    assert.match(completionSkill, /name: code-helper-completion-review/);
    // 新增协作 skill 必须能被注册，并包含对子代理协作边界的明确说明。
    assert.match(collaborationSkill, /name: code-helper-agent-collaboration/);
    assert.match(collaborationSkill, /子代理/);
    assert.match(collaborationSkill, /你现在是执行子代理/);
    assert.match(collaborationSkill, /不再套用“主会话必须派发子代理”的职责/);
    assert.match(manualTestSkill, /name: code-helper-manual-test-workbench/);
    assert.match(manualTestSkill, /manual-test.*只负责生成结构化模板/s);
    assert.match(manualTestSkill, /测试环境、前置数据、操作步骤、预期结果、回归范围和阻塞记录/);
    assert.match(reviewFixSkill, /name: code-helper-review-fix/);
    assert.match(reviewFixSkill, /主问题已解决/);
    assert.match(reviewFixSkill, /RF-P1-001/);
    assert.match(reviewFixSkill, /只有用户明确表达以下意图时才进入修复/);
    assert.match(reviewFixSkill, /按原 ID 逐项复审/);
    assert.match(reviewFixSkill, /不要创建.*代码审查\.md/s);
    assert.match(reviewFixSkill, /不自动提交、推送、归档、发布或更新长期记忆/);
    assert.match(reviewFixSkill, /Codex、Claude、Grok、GitHub Copilot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 支持 Claude Code 项目级 skills", async () => {
  // 该测试确认 Claude Code 注册目标写入当前项目的 .claude/skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-claude-"));

  try {
    const operations = await registerProjectSkills(root, "claudecode");
    const statuses = await listProjectSkillRegistrations(root, "claudecode");
    const memorySkill = await readFile(
      join(root, ".claude/skills/code-helper-memory-tuning/SKILL.md"),
      "utf8"
    );

    assert.equal(operations.length, CODE_HELPER_SKILL_COUNT);
    assert.ok(operations.every((operation) => operation.action === "created"));
    assert.ok(statuses.every((status) => status.target === "claudecode" && status.registered));
    assert.match(memorySkill, /name: code-helper-memory-tuning/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 支持 GitHub Copilot 项目级 skills", async () => {
  // 该测试确认 GitHub Copilot 注册目标写入当前项目的 .github/skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-github-"));

  try {
    const operations = await registerProjectSkills(root, "githubcopilot");
    const statuses = await listProjectSkillRegistrations(root, "githubcopilot");
    const memorySkill = await readFile(
      join(root, ".github/skills/code-helper-memory-tuning/SKILL.md"),
      "utf8"
    );

    assert.equal(operations.length, CODE_HELPER_SKILL_COUNT);
    assert.ok(operations.every((operation) => operation.action === "created"));
    assert.ok(statuses.every((status) => status.target === "githubcopilot" && status.registered));
    assert.match(memorySkill, /name: code-helper-memory-tuning/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 支持 Grok Build 原生项目级 skills", async () => {
  // Grok Build 显式目标必须写入原生 .grok/skills，不能借 Claude Code 目录冒充独立注册。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-grok-"));

  try {
    const operations = await registerProjectSkills(root, "grok");
    const statuses = await listProjectSkillRegistrations(root, "grok");
    const memorySkill = await readFile(
      join(root, ".grok/skills/code-helper-memory-tuning/SKILL.md"),
      "utf8"
    );

    assert.equal(operations.length, CODE_HELPER_SKILL_COUNT);
    assert.ok(operations.every((operation) => operation.action === "created"));
    assert.ok(statuses.every((status) => status.target === "grok" && status.registered));
    assert.match(memorySkill, /name: code-helper-memory-tuning/);
    await assert.rejects(() => stat(join(root, ".claude/skills")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 会尊重 skillRegistration 功能开关", async () => {
  // 该测试确保用户关闭项目级 skills 注册后，不会继续写入 .agents/skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-disabled-"));

  try {
    await setFeatureEnabled(root, "skillRegistration", false);

    await assert.rejects(
      () => registerProjectSkills(root),
      /管理项目 Skills 功能已关闭/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 路径冲突时不会留下单目标部分注册", async () => {
  // 冲突位于内置清单后半段，用于确认前面的 Skills 不会先写入后残留。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-atomic-single-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");

  try {
    await mkdir(skillsRoot, { recursive: true });
    await writeFile(join(skillsRoot, "code-helper-document-archive"), "路径冲突", "utf8");

    await assert.rejects(
      () => registerProjectSkills(root),
      /ENOTDIR|not a directory/u
    );

    // 先移除人为冲突，随后统一读取状态，确认冲突前排在清单前面的 Skills 也未被写入。
    await rm(join(skillsRoot, "code-helper-document-archive"), { force: true });
    const statuses = await listProjectSkillRegistrations(root);
    assert.ok(statuses.every((status) => !status.registered));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 当前文件截断后写入失败时会恢复整批原内容", async () => {
  // 注入确定性的“先截断再抛错”写入器，避免依赖磁盘满、权限或平台特有文件系统行为。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-atomic-truncated-write-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const firstPath = join(skillsRoot, CODE_HELPER_SKILL_NAMES[0], "SKILL.md");
  const failingPath = join(skillsRoot, CODE_HELPER_SKILL_NAMES[1], "SKILL.md");
  const firstOriginal = "# 第一项旧内容\n";
  const failingOriginal = "# 第二项旧内容\n";

  try {
    await registerProjectSkills(root);
    await writeFile(firstPath, firstOriginal, "utf8");
    await writeFile(failingPath, failingOriginal, "utf8");

    await assert.rejects(
      () => registerProjectSkills(root, "codex", {
        writeSkillFile: async (path, content) => {
          if (path === failingPath) {
            // 模拟 writeFile 已经把目标截断并写入部分内容，随后底层设备才报告失败。
            await writeFile(path, content.slice(0, 12), "utf8");
            throw new Error("模拟截断后写入失败");
          }

          await writeText(path, content);
        }
      }),
      /模拟截断后写入失败/u
    );

    assert.equal(await readFile(firstPath, "utf8"), firstOriginal);
    assert.equal(await readFile(failingPath, "utf8"), failingOriginal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 回滚会删除空目录并保留并发写入的用户内容", async () => {
  // 该用例同时锁定 Windows 空目录删除和回滚期间目录变为非空时的用户内容保护。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-atomic-empty-directory-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const emptyDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[0]);
  const userOwnedDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[1]);
  const userOwnedFile = join(userOwnedDirectory, "用户附件.txt");
  const failingPath = join(skillsRoot, CODE_HELPER_SKILL_NAMES[2], "SKILL.md");

  try {
    await assert.rejects(
      () => registerProjectSkills(root, "codex", {
        writeSkillFile: async (path, content) => {
          if (path === failingPath) {
            throw new Error("模拟后续 Skill 写入失败");
          }

          await writeText(path, content);

          if (path === join(userOwnedDirectory, "SKILL.md")) {
            // 模拟注册尚未结束时外部进程写入同目录，回滚只能删除受控 SKILL.md。
            await writeFile(userOwnedFile, "用户内容", "utf8");
          }
        }
      }),
      /模拟后续 Skill 写入失败/u
    );

    await assert.rejects(() => stat(emptyDirectory), /ENOENT/u);
    await assert.rejects(() => stat(join(userOwnedDirectory, "SKILL.md")), /ENOENT/u);
    assert.equal(await readFile(userOwnedFile, "utf8"), "用户内容");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 写入目标父路径变为普通文件时仍完整回滚此前目录", async () => {
  // 模拟 Windows smoke 中预读完成后，第三个 Skill 目录位置才被普通文件占用的竞态。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-atomic-parent-file-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const firstDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[0]);
  const secondDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[1]);
  const conflictDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[2]);
  const failingPath = join(conflictDirectory, "SKILL.md");

  try {
    await assert.rejects(
      () => registerProjectSkills(root, "codex", {
        writeSkillFile: async (path, content) => {
          if (path === failingPath) {
            await writeFile(conflictDirectory, "保留的普通文件", "utf8");
          }

          await writeText(path, content);
        }
      }),
      /EEXIST|ENOTDIR|file already exists|not a directory/u
    );

    await assert.rejects(() => stat(firstDirectory), /ENOENT/u);
    await assert.rejects(() => stat(secondDirectory), /ENOENT/u);
    assert.equal(await readFile(conflictDirectory, "utf8"), "保留的普通文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkills 单个快照清理失败时继续回滚其余快照并汇总错误", async () => {
  // 把第二个已成功写入的 Skill 目录替换成普通文件，确定性制造回滚 ENOTDIR。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-atomic-rollback-errors-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const firstDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[0]);
  const secondDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[1]);
  const failingPath = join(skillsRoot, CODE_HELPER_SKILL_NAMES[2], "SKILL.md");

  try {
    await assert.rejects(
      () => registerProjectSkills(root, "codex", {
        writeSkillFile: async (path, content) => {
          if (path === failingPath) {
            await rm(secondDirectory, { recursive: true, force: true });
            await writeFile(secondDirectory, "模拟回滚路径异常", "utf8");
            throw new Error("模拟注册写入失败");
          }

          await writeText(path, content);
        }
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /注册失败.*回滚未完整完成/u);
        return true;
      }
    );

    // 第二项回滚失败不能阻止更早创建的第一项继续清理。
    await assert.rejects(() => stat(firstDirectory), /ENOENT/u);
    assert.equal(await readFile(secondDirectory, "utf8"), "模拟回滚路径异常");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills register all 失败时由 CLI 统一捕获且不启用配置或写入其它目标", async () => {
  // Claude Code 目标制造路径冲突；Codex 目标虽然排在前面，也不能被部分写入。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-atomic-all-"));
  const errors = [];
  const originalError = console.error;

  try {
    await setFeatureEnabled(root, "skillRegistration", false);
    const claudeSkillsRoot = getTargetSkillsRoot(root, "claudecode");
    await mkdir(claudeSkillsRoot, { recursive: true });
    await writeFile(join(claudeSkillsRoot, "code-helper-plan-workbench"), "路径冲突", "utf8");
    console.error = (...items) => {
      errors.push(items.join(" "));
    };

    const exitCode = await runCli(["skills", "register", "all"], root);
    const config = await loadConfig(root);
    const codexStatuses = await listProjectSkillRegistrations(root, "codex");
    const githubStatuses = await listProjectSkillRegistrations(root, "githubcopilot");
    const grokStatuses = await listProjectSkillRegistrations(root, "grok");

    assert.equal(exitCode, 1);
    assert.equal(config.features.skillRegistration.enabled, false);
    assert.ok(codexStatuses.every((status) => !status.registered));
    assert.ok(githubStatuses.every((status) => !status.registered));
    assert.ok(grokStatuses.every((status) => !status.registered));
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /\n\s+at /u);
    assert.match(errors[0], /ENOTDIR|not a directory/u);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("skills unregister all 单次写回会清空四类 managedSkillRecords 并保留用户 Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-unregister-all-"));
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...items) => {
      logs.push(items.join(" "));
    };
    assert.equal(await runCli(["skills", "register", "all"], root), 0);

    for (const target of ["codex", "claudecode", "githubcopilot", "grok"]) {
      const userDirectory = join(getTargetSkillsRoot(root, target), "code-helper-user-owned");
      await mkdir(userDirectory, { recursive: true });
      await writeFile(join(userDirectory, "SKILL.md"), `用户 ${target} Skill`, "utf8");
    }

    const exitCode = await runCli(["skills", "unregister", "all"], root);
    const state = JSON.parse(await readFile(join(root, ".code-helper/state.json"), "utf8"));

    assert.equal(exitCode, 0);
    assert.deepEqual(state.managedSkillRecords, {});
    for (const target of ["codex", "claudecode", "githubcopilot", "grok"]) {
      assert.ok((await listProjectSkillRegistrations(root, target)).every((status) => !status.registered));
      assert.equal(
        await readFile(join(getTargetSkillsRoot(root, target), "code-helper-user-owned/SKILL.md"), "utf8"),
        `用户 ${target} Skill`
      );
    }
    assert.ok(logs.some((line) => line.includes("已取消注册")));
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("skills unregister all 状态读取失败时不删除已注册或用户 Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-unregister-all-failure-"));
  const errors = [];
  const originalError = console.error;
  const originalLog = console.log;

  try {
    console.log = () => {};
    assert.equal(await runCli(["skills", "register", "all"], root), 0);
    const userDirectory = join(getTargetSkillsRoot(root, "codex"), "code-helper-user-owned");
    await mkdir(userDirectory, { recursive: true });
    await writeFile(join(userDirectory, "SKILL.md"), "用户内容", "utf8");
    await rm(join(root, ".code-helper/state.json"), { force: true });
    await mkdir(join(root, ".code-helper/state.json"), { recursive: true });
    console.error = (...items) => {
      errors.push(items.join(" "));
    };

    const exitCode = await runCli(["skills", "unregister", "all"], root);

    assert.equal(exitCode, 1);
    assert.ok((await listProjectSkillRegistrations(root, "codex")).every((status) => status.registered));
    assert.ok((await listProjectSkillRegistrations(root, "claudecode")).every((status) => status.registered));
    assert.ok((await listProjectSkillRegistrations(root, "githubcopilot")).every((status) => status.registered));
    assert.ok((await listProjectSkillRegistrations(root, "grok")).every((status) => status.registered));
    assert.equal(await readFile(join(userDirectory, "SKILL.md"), "utf8"), "用户内容");
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkillsForTargets 会完整注册多目标事务", async () => {
  // 成功路径确认批量事务按“目标数 × manifest 数量”输出全部操作。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-atomic-success-"));

  try {
    const operations = await registerProjectSkillsForTargets(root, ["codex", "claudecode"]);

    assert.equal(operations.length, CODE_HELPER_SKILL_COUNT * 2);
    assert.ok((await listProjectSkillRegistrations(root, "codex")).every((status) => status.registered));
    assert.ok((await listProjectSkillRegistrations(root, "claudecode")).every((status) => status.registered));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerProjectSkillsForTargets 在 Grok Build 写入失败时回滚前置目标", async () => {
  // Grok Build 排在 all 事务最后，模拟其首个 Skill 写入失败，确认前三个目标不留部分成果。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-grok-rollback-"));
  const failingPath = join(
    getTargetSkillsRoot(root, "grok"),
    CODE_HELPER_SKILL_NAMES[0],
    "SKILL.md"
  );

  try {
    await assert.rejects(
      () => registerProjectSkillsForTargets(
        root,
        ["codex", "claudecode", "githubcopilot", "grok"],
        {
          writeSkillFile: async (path, content) => {
            if (path === failingPath) {
              throw new Error("模拟 Grok Build 写入失败");
            }

            await writeText(path, content);
          }
        }
      ),
      /模拟 Grok Build 写入失败/u
    );

    for (const target of ["codex", "claudecode", "githubcopilot", "grok"]) {
      assert.ok((await listProjectSkillRegistrations(root, target)).every((status) => !status.registered));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unregisterProjectSkills 只删除 code-helper 管理的项目级 skills", async () => {
  // 该测试避免取消注册时误删用户自己的 Codex 项目级 skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-unregister-"));

  try {
    await registerProjectSkills(root);
    await mkdir(join(root, ".agents/skills/user-skill"), { recursive: true });
    await writeFile(join(root, ".agents/skills/user-skill/SKILL.md"), "---\nname: user-skill\n---\n", "utf8");

    const operations = await unregisterProjectSkills(root);
    const statuses = await listProjectSkillRegistrations(root);
    const userSkill = await readFile(join(root, ".agents/skills/user-skill/SKILL.md"), "utf8");

    assert.equal(operations.length, CODE_HELPER_SKILL_COUNT);
    assert.ok(operations.every((operation) => operation.action === "updated"));
    assert.ok(statuses.every((status) => !status.registered));
    assert.match(userSkill, /name: user-skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unregisterProjectSkills 不会删除用户自己的 Claude Code skills", async () => {
  // 该测试避免取消注册时误删用户自己的 Claude Code 项目级 skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-claude-unregister-"));

  try {
    await registerProjectSkills(root, "claudecode");
    await mkdir(join(root, ".claude/skills/user-skill"), { recursive: true });
    await writeFile(join(root, ".claude/skills/user-skill/SKILL.md"), "---\nname: user-skill\n---\n", "utf8");

    const operations = await unregisterProjectSkills(root, "claudecode");
    const statuses = await listProjectSkillRegistrations(root, "claudecode");
    const userSkill = await readFile(join(root, ".claude/skills/user-skill/SKILL.md"), "utf8");

    assert.equal(operations.length, CODE_HELPER_SKILL_COUNT);
    assert.ok(operations.every((operation) => operation.action === "updated"));
    assert.ok(statuses.every((status) => !status.registered));
    assert.match(userSkill, /name: user-skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unregisterProjectSkills 会清理四类目标中缺失或损坏 SKILL.md 的精确受控目录", async () => {
  for (const target of ["codex", "claudecode", "githubcopilot", "grok"]) {
    const root = await mkdtemp(join(tmpdir(), `code-helper-skills-unregister-damaged-${target}-`));
    const skillsRoot = getTargetSkillsRoot(root, target);
    const missingSkillDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[0]);
    const damagedSkillDirectory = join(skillsRoot, CODE_HELPER_SKILL_NAMES[1]);
    const userDirectory = join(skillsRoot, "code-helper-user-owned");

    try {
      await registerProjectSkills(root, target);
      await rm(join(missingSkillDirectory, "SKILL.md"), { force: true });
      await writeFile(join(missingSkillDirectory, "用户附件.txt"), "应随受控目录清理", "utf8");
      await writeFile(join(damagedSkillDirectory, "SKILL.md"), "损坏内容", "utf8");
      await mkdir(userDirectory, { recursive: true });
      await writeFile(join(userDirectory, "SKILL.md"), "用户自定义内容", "utf8");

      await unregisterProjectSkills(root, target);

      await assert.rejects(() => readFile(join(missingSkillDirectory, "用户附件.txt"), "utf8"), /ENOENT/u);
      await assert.rejects(() => readFile(join(damagedSkillDirectory, "SKILL.md"), "utf8"), /ENOENT/u);
      assert.equal(await readFile(join(userDirectory, "SKILL.md"), "utf8"), "用户自定义内容");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("registerProjectSkills 只清理指纹匹配且已从 manifest 退休的目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-retired-cleanup-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const retiredName = "code-helper-retired-example";
  const userName = "code-helper-user-owned";

  try {
    await registerProjectSkills(root);
    await mkdir(join(skillsRoot, retiredName), { recursive: true });
    const retiredContent = "旧版受控 Skill";
    await writeFile(join(skillsRoot, retiredName, "SKILL.md"), retiredContent, "utf8");
    await mkdir(join(skillsRoot, userName), { recursive: true });
    await writeFile(join(skillsRoot, userName, "SKILL.md"), "用户自定义 Skill", "utf8");
    await recordManagedSkillFingerprints(root, "codex", { [retiredName]: retiredContent });

    const operations = await registerProjectSkills(root);
    const state = JSON.parse(await readFile(join(root, ".code-helper/state.json"), "utf8"));

    assert.ok(operations.some((operation) => operation.message.includes("退休项目级 skill")));
    await assert.rejects(() => readFile(join(skillsRoot, retiredName, "SKILL.md"), "utf8"), /ENOENT/u);
    assert.equal(await readFile(join(skillsRoot, userName, "SKILL.md"), "utf8"), "用户自定义 Skill");
    assert.deepEqual(Object.keys(state.managedSkillRecords.codex), CODE_HELPER_SKILL_NAMES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧项目无受控记录时不会按 code-helper 前缀猜测并删除退休目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-retired-legacy-safe-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const unknownLegacyName = "code-helper-unknown-legacy";

  try {
    await mkdir(join(skillsRoot, unknownLegacyName), { recursive: true });
    await writeFile(join(skillsRoot, unknownLegacyName, "SKILL.md"), "归属未知，必须保留", "utf8");

    await registerProjectSkills(root);

    assert.equal(
      await readFile(join(skillsRoot, unknownLegacyName, "SKILL.md"), "utf8"),
      "归属未知，必须保留"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧版仅目录名 state 不足以证明退休目录所有权", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-retired-legacy-state-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const retiredName = "code-helper-retired-example";

  try {
    await registerProjectSkills(root);
    await mkdir(join(skillsRoot, retiredName), { recursive: true });
    await writeFile(join(skillsRoot, retiredName, "SKILL.md"), "用户后来同名重建", "utf8");
    await recordManagedSkillDirectories(root, "codex", [...CODE_HELPER_SKILL_NAMES, retiredName]);

    const operations = await registerProjectSkills(root);

    assert.equal(await readFile(join(skillsRoot, retiredName, "SKILL.md"), "utf8"), "用户后来同名重建");
    assert.equal(operations.some((operation) => operation.path.includes(retiredName)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("退休 Skill 指纹不匹配时保留同名用户内容和所有权记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-retired-user-recreated-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const retiredName = "code-helper-retired-example";

  try {
    await registerProjectSkills(root);
    await mkdir(join(skillsRoot, retiredName), { recursive: true });
    await writeFile(join(skillsRoot, retiredName, "SKILL.md"), "用户后来同名重建", "utf8");
    await recordManagedSkillFingerprints(root, "codex", { [retiredName]: "旧版受控正文" });

    const operations = await registerProjectSkills(root);
    const state = JSON.parse(await readFile(join(root, ".code-helper/state.json"), "utf8"));

    assert.equal(await readFile(join(skillsRoot, retiredName, "SKILL.md"), "utf8"), "用户后来同名重建");
    assert.ok(operations.some(
      (operation) => operation.path.includes(retiredName) && operation.action === "skipped"
    ));
    assert.ok(state.managedSkillRecords.codex[retiredName]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("退休 Skill 缺少 SKILL.md 时只清理空目录，非空目录保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-retired-empty-boundary-"));
  const skillsRoot = getTargetSkillsRoot(root, "codex");
  const emptyRetiredName = "code-helper-retired-empty";
  const nonEmptyRetiredName = "code-helper-retired-non-empty";

  try {
    await registerProjectSkills(root);
    await mkdir(join(skillsRoot, emptyRetiredName), { recursive: true });
    await mkdir(join(skillsRoot, nonEmptyRetiredName), { recursive: true });
    await writeFile(join(skillsRoot, nonEmptyRetiredName, "用户文件.txt"), "必须保留", "utf8");
    await recordManagedSkillFingerprints(root, "codex", {
      [emptyRetiredName]: "旧版空目录对应正文",
      [nonEmptyRetiredName]: "旧版非空目录对应正文"
    });

    const operations = await registerProjectSkills(root);
    const state = JSON.parse(await readFile(join(root, ".code-helper/state.json"), "utf8"));

    await assert.rejects(() => readFile(join(skillsRoot, emptyRetiredName, "SKILL.md"), "utf8"), /ENOENT/u);
    assert.equal(await readFile(join(skillsRoot, nonEmptyRetiredName, "用户文件.txt"), "utf8"), "必须保留");
    assert.ok(operations.some(
      (operation) => operation.path.includes(emptyRetiredName) && operation.action === "updated"
    ));
    assert.ok(operations.some(
      (operation) => operation.path.includes(nonEmptyRetiredName) && operation.action === "skipped"
    ));
    assert.equal(state.managedSkillRecords.codex[emptyRetiredName], undefined);
    assert.ok(state.managedSkillRecords.codex[nonEmptyRetiredName]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unregisterProjectSkills 会校验退休指纹并保留未记录用户目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-retired-unregister-"));
  const skillsRoot = getTargetSkillsRoot(root, "githubcopilot");
  const retiredName = "code-helper-retired-example";
  const userName = "code-helper-user-owned";
  const outsideSentinel = join(root, ".github/code-helper-越界");

  try {
    await registerProjectSkills(root, "githubcopilot");
    const retiredContent = "退休受控正文";
    await mkdir(join(skillsRoot, retiredName), { recursive: true });
    await writeFile(join(skillsRoot, retiredName, "SKILL.md"), retiredContent, "utf8");
    await mkdir(join(skillsRoot, userName), { recursive: true });
    await writeFile(join(skillsRoot, userName, "SKILL.md"), "用户内容", "utf8");
    await mkdir(outsideSentinel, { recursive: true });
    await writeFile(join(outsideSentinel, "保留.txt"), "越界保护", "utf8");
    await recordManagedSkillFingerprints(root, "githubcopilot", {
      [retiredName]: retiredContent,
      "../code-helper-越界": "越界内容"
    });

    await unregisterProjectSkills(root, "githubcopilot");

    await assert.rejects(() => readFile(join(skillsRoot, retiredName, "SKILL.md"), "utf8"), /ENOENT/u);
    assert.equal(await readFile(join(skillsRoot, userName, "SKILL.md"), "utf8"), "用户内容");
    assert.equal(await readFile(join(outsideSentinel, "保留.txt"), "utf8"), "越界保护");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseSkillRegistrationTargets 只解析显式 CLI 目标", () => {
  // 该测试锁定显式参数解析：全量注册必须传 all，不带 target 不在这里推断项目状态。
  assert.deepEqual(parseSkillRegistrationTargets(undefined), ["codex"]);
  assert.deepEqual(parseSkillRegistrationTargets("all"), ["codex", "claudecode", "githubcopilot", "grok"]);
  assert.deepEqual(parseSkillRegistrationTargets("codex"), ["codex"]);
  assert.deepEqual(parseSkillRegistrationTargets("claudecode"), ["claudecode"]);
  assert.deepEqual(parseSkillRegistrationTargets("claude-code"), ["claudecode"]);
  assert.deepEqual(parseSkillRegistrationTargets("githubcopilot"), ["githubcopilot"]);
  assert.deepEqual(parseSkillRegistrationTargets("github"), ["githubcopilot"]);
  assert.deepEqual(parseSkillRegistrationTargets("copilot"), ["githubcopilot"]);
  assert.deepEqual(parseSkillRegistrationTargets("grok"), ["grok"]);
  assert.deepEqual(parseSkillRegistrationTargets("grok-build"), ["grok"]);
});

test("Grok Build Skills 相对路径可由 macOS 与 Windows 路径 API 安全组合", () => {
  // 目标映射保持平台无关相对路径；实际写入继续由 node:path 在当前平台完成分隔符转换。
  const relativeDirectory = getProjectSkillsDirectory("grok");

  assert.equal(relativeDirectory, ".grok/skills");
  assert.equal(posix.join("/workspace", relativeDirectory, "demo", "SKILL.md"), "/workspace/.grok/skills/demo/SKILL.md");
  assert.equal(
    win32.join("C:\\workspace", relativeDirectory, "demo", "SKILL.md"),
    "C:\\workspace\\.grok\\skills\\demo\\SKILL.md"
  );
});

test("resolveSkillRegistrationTargets 会根据入口文件推断 agent 工具", async () => {
  // 该测试覆盖当前项目注册策略：已有入口文件按实际工具注册，没有入口文件时保守返回空目标。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-resolve-"));

  try {
    assert.deepEqual(await resolveSkillRegistrationTargets(root), []);

    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    assert.deepEqual(await resolveSkillRegistrationTargets(root), ["codex"]);

    await writeFile(join(root, "CLAUDE.md"), "# Claude\n", "utf8");
    assert.deepEqual(await resolveSkillRegistrationTargets(root), ["codex", "claudecode"]);

    await rm(join(root, "AGENTS.md"), { force: true });
    assert.deepEqual(await resolveSkillRegistrationTargets(root), ["claudecode"]);

    await rm(join(root, "CLAUDE.md"), { force: true });
    await mkdir(join(root, ".github"), { recursive: true });
    await writeFile(join(root, ".github/copilot-instructions.md"), "# Copilot\n", "utf8");
    assert.deepEqual(await resolveSkillRegistrationTargets(root), ["githubcopilot"]);

    await rm(join(root, ".github"), { recursive: true, force: true });
    await writeFile(join(root, "AGENTS.md"), "# Shared entry\n", "utf8");
    assert.deepEqual(await resolveSkillRegistrationTargets(root), ["codex"]);
    await mkdir(join(root, ".grok/skills"), { recursive: true });
    assert.deepEqual(await resolveSkillRegistrationTargets(root), ["codex", "grok"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsDoctor 会发现缺失 SKILL.md 和 description 过短", async () => {
  // 该测试覆盖 doctor 的纯静态检查，不执行任何 skill 内容。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-doctor-"));

  try {
    await mkdir(join(root, ".agents/skills/empty-skill"), { recursive: true });
    await mkdir(join(root, ".agents/skills/weak-skill"), { recursive: true });
    await writeFile(
      join(root, ".agents/skills/weak-skill/SKILL.md"),
      "---\nname: weak-skill\ndescription: 太短\n---\n# Weak\n",
      "utf8"
    );

    const issues = await runSkillsDoctor(root);

    assert.ok(issues.some((issue) => issue.code === "missing-skill-md"));
    assert.ok(issues.some((issue) => issue.code === "weak-skill-description"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsDoctor 接受合法 YAML 多行 description、引号、注释和 CRLF", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-doctor-yaml-valid-"));
  const skillPath = join(root, ".agents/skills/yaml-valid/SKILL.md");

  try {
    await mkdir(join(skillPath, ".."), { recursive: true });
    await writeFile(
      skillPath,
      [
        "---",
        "# 合法注释不能影响字段解析",
        'name: "yaml-valid"',
        "description: >",
        "  当用户需要验证合法 YAML frontmatter 时使用，",
        "  支持折叠多行描述和常见引号写法。",
        "---",
        "## 说明",
        "",
        "正文内容。",
        ""
      ].join("\r\n"),
      "utf8"
    );

    const issues = await runSkillsDoctor(root);

    assert.ok(!issues.some((issue) => issue.path === skillPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsDoctor 将 YAML 解析和字段类型错误报告为 invalid-frontmatter", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-doctor-yaml-invalid-"));
  const syntaxPath = join(root, ".agents/skills/yaml-syntax/SKILL.md");
  const typePath = join(root, ".agents/skills/yaml-type/SKILL.md");

  try {
    await mkdir(join(syntaxPath, ".."), { recursive: true });
    await mkdir(join(typePath, ".."), { recursive: true });
    await writeFile(
      syntaxPath,
      "---\nname: yaml-syntax\ndescription: [未闭合\n---\n## 说明\n",
      "utf8"
    );
    await writeFile(
      typePath,
      "---\nname: yaml-type\ndescription:\n  - 第一项\n  - 第二项\n---\n## 说明\n",
      "utf8"
    );

    const issues = await runSkillsDoctor(root);
    const invalidIssues = issues.filter((issue) => issue.code === "invalid-frontmatter");

    assert.equal(invalidIssues.length, 2);
    assert.ok(invalidIssues.some((issue) => issue.path === syntaxPath && issue.message.includes("无法解析")));
    assert.ok(invalidIssues.some((issue) => issue.path === typePath && issue.message.includes("description 必须是字符串")));
    assert.ok(!issues.some(
      (issue) => issue.code === "weak-skill-description" && (issue.path === syntaxPath || issue.path === typePath)
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsDoctor 会把 skills 根目录中的普通文件识别为结构问题", async () => {
  // 该测试覆盖用户误把普通文件放进 skills 根目录时的兼容行为。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-doctor-file-"));

  try {
    await mkdir(join(root, ".agents/skills"), { recursive: true });
    await writeFile(join(root, ".agents/skills/README.md"), "# Skills\n", "utf8");

    const issues = await runSkillsDoctor(root);

    assert.ok(issues.some((issue) => issue.code === "missing-skill-md" && issue.path.endsWith("README.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsDoctor 会发现过期的 code-helper skill", async () => {
  // 该测试确保内置模板更新后，doctor 能提示用户刷新项目级 skill。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-outdated-"));

  try {
    await registerProjectSkills(root);
    await writeFile(
      join(root, ".agents/skills/code-helper-memory-tuning/SKILL.md"),
      "---\nname: code-helper-memory-tuning\ndescription: 这是一个被人为改旧的项目记忆维护 skill。\n---\n# Old\n",
      "utf8"
    );

    const issues = await runSkillsDoctor(root);

    assert.ok(issues.some((issue) => issue.code === "outdated-code-helper-skill"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsDoctor 会在四类 agent 目标只保留一个 Skill 时报告其余缺项", async () => {
  // 四类目标分别验证，防止完整性检查只对某一种项目目录生效。
  for (const target of ["codex", "claudecode", "githubcopilot", "grok"]) {
    const root = await mkdtemp(join(tmpdir(), `code-helper-skills-doctor-one-${target}-`));

    try {
      await registerProjectSkills(root, target);
      const skillsRoot = getTargetSkillsRoot(root, target);

      for (const skillName of CODE_HELPER_SKILL_NAMES.slice(1)) {
        await rm(join(skillsRoot, skillName), { recursive: true, force: true });
      }

      const issues = await runSkillsDoctor(root);
      const missingIssues = issues.filter(
        (issue) => issue.code === "missing-code-helper-skill" && issue.path.startsWith(skillsRoot)
      );

      assert.equal(missingIssues.length, CODE_HELPER_SKILL_COUNT - 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("runSkillsDoctor 会在完整注册中缺少一个 Skill 时准确报告唯一缺项", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-doctor-five-"));
  const missingName = "code-helper-completion-review";

  try {
    await registerProjectSkills(root);
    await rm(join(getTargetSkillsRoot(root, "codex"), missingName), { recursive: true, force: true });

    const missingIssues = (await runSkillsDoctor(root)).filter(
      (issue) => issue.code === "missing-code-helper-skill"
    );

    assert.equal(missingIssues.length, 1);
    assert.match(missingIssues[0].message, new RegExp(missingName, "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsDoctor 会把完整 manifest 注册判断为健康", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-doctor-complete-"));

  try {
    await registerProjectSkills(root);

    const issues = await runSkillsDoctor(root);

    assert.ok(!issues.some((issue) => issue.code === "missing-code-helper-skill"));
    assert.ok(!issues.some((issue) => issue.level === "error"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsAudit 会根据项目入口推荐缺失注册", async () => {
  // 该测试确认 audit 只输出建议，不直接创建项目级 skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-audit-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await mkdir(join(root, "code-helper-docs/user-rules"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/result-doc/页面验收能力"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/result-doc/页面验收能力/手工测试.md"), "# 页面验收能力手工测试\n", "utf8");

    const recommendations = await runSkillsAudit(root);

    assert.ok(recommendations.some((item) => item.code === "missing-inferred-registration"));
    assert.ok(recommendations.some((item) => item.code === "missing-memory-skill"));
    assert.ok(recommendations.some((item) => item.code === "missing-manual-test-skill"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsAudit 会对 .grok 项目推荐 Grok Build 原生注册", async () => {
  // Grok 资产是独立推断证据；audit 只给出建议，不应在读取检查中写入 Skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-audit-grok-"));

  try {
    await mkdir(join(root, ".grok"), { recursive: true });
    await writeFile(join(root, ".grok/config.toml"), "# Grok Build 项目配置\n", "utf8");

    const recommendations = await runSkillsAudit(root);
    const grokRecommendation = recommendations.find(
      (item) => item.code === "missing-inferred-registration" && item.message.includes("Grok Build")
    );

    assert.ok(grokRecommendation);
    assert.match(grokRecommendation.suggestion, /skills register grok/u);
    await assert.rejects(() => stat(join(root, ".grok/skills")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsAudit 不会把初始化预建的空 archive 目录当成归档任务", async () => {
  // init 会创建三类 archive 目录；目录为空时不应触发 document-archive skill 推荐。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-audit-empty-archive-"));

  try {
    await mkdir(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/result-doc/archive"), { recursive: true });
    await mkdir(join(root, "code-helper-docs/status-doc/archive"), { recursive: true });

    const recommendations = await runSkillsAudit(root);

    assert.equal(recommendations.some((item) => item.code === "missing-archive-skill"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsAudit 发现实际 archived 任务时会推荐归档 skill", async () => {
  // 任一真实归档任务文档即可证明项目使用了归档生命周期，不要求三类文档同时存在。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-audit-archived-task-"));

  try {
    await mkdir(join(root, "code-helper-docs/plan-doc/archive"), { recursive: true });
    await writeFile(join(root, "code-helper-docs/plan-doc/archive/真实归档任务.md"), "# 真实归档任务\n", "utf8");

    const recommendations = await runSkillsAudit(root);

    assert.ok(recommendations.some((item) => item.code === "missing-archive-skill"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("内置完成检查与归档 skill 描述会收窄触发和手工测试条件", async () => {
  // 注册输出直接来自模板源，可防止后续又恢复普通最终回复、空目录或无条件手工测试触发。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-trigger-boundary-"));

  try {
    await registerProjectSkills(root);
    const completionSkill = await readFile(
      join(root, ".agents/skills/code-helper-completion-review/SKILL.md"),
      "utf8"
    );
    const archiveSkill = await readFile(
      join(root, ".agents/skills/code-helper-document-archive/SKILL.md"),
      "utf8"
    );

    assert.match(completionSkill, /完成实现、文档或功能变更节点后准备最终回复/u);
    assert.match(completionSkill, /普通问答、只读 review.*不触发/u);
    assert.match(completionSkill, /mixed 任务必须优先/u);
    assert.match(completionSkill, /没有 active 且没有 mixed 任务时/u);
    assert.match(completionSkill, /仅报告当前没有活动任务/u);
    assert.match(archiveSkill, /初始化预建的空 archive 目录不触发/u);
    assert.match(archiveSkill, /仅当任务涉及页面、可视化、浏览器真实链路、人工业务验收/u);
    assert.match(archiveSkill, /纯逻辑任务以自动化测试/u);
    assert.doesNotMatch(archiveSkill, /确认 实施记录\.md、手工测试\.md 和 status-doc/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("内置 review-fix skill 会保持只读审查、授权修复和逐项复审边界", async () => {
  // 注册后的正文直接来自单一 manifest；该测试锁定 review 和 fix 之间的授权边界。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-review-fix-boundary-"));

  try {
    await registerProjectSkills(root);
    const reviewFixSkill = await readFile(
      join(root, ".agents/skills/code-helper-review-fix/SKILL.md"),
      "utf8"
    );

    assert.match(reviewFixSkill, /用户只要求审查、检查或评估时，不修改源码、测试、配置、过程文档或生成副本/u);
    assert.match(reviewFixSkill, /纯只读审查的 findings 也默认只输出到当前对话/u);
    assert.match(reviewFixSkill, /活动任务本身不构成写入实施记录或状态记录的授权/u);
    assert.match(reviewFixSkill, /主问题部分解决/u);
    assert.match(reviewFixSkill, /ID 格式固定为.*RF-P0-001.*RF-P1-001.*RF-P2-001/su);
    assert.match(reviewFixSkill, /“看看”“review”“检查一下”“有什么问题”“给建议”都不构成修复授权/u);
    assert.match(reviewFixSkill, /修复完成后必须回到原 findings 清单，按原 ID 逐项复审/u);
    assert.match(reviewFixSkill, /实施记录\.md/u);
    assert.match(reviewFixSkill, /用户另行明确授权记录本次 review：只记录审查结论和 findings，不因此获得任何代码修改权限/u);
    assert.match(reviewFixSkill, /没有记录授权时，findings 只保留在当前对话，不写入任何过程文档/u);
    assert.match(reviewFixSkill, /不自动提交、推送、归档、发布或更新长期记忆/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runSkillsAudit 不会把跨目标错位的部分 Skills 拼成完整注册", async () => {
  // Codex 保留一项、Claude Code 保留其余项；全局名称虽齐全，但两个目标都不可独立使用。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-audit-misaligned-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await writeFile(join(root, "CLAUDE.md"), "# Claude\n", "utf8");
    await registerProjectSkillsForTargets(root, ["codex", "claudecode"]);

    const codexRoot = getTargetSkillsRoot(root, "codex");
    const claudeRoot = getTargetSkillsRoot(root, "claudecode");
    for (const skillName of CODE_HELPER_SKILL_NAMES.slice(1)) {
      await rm(join(codexRoot, skillName), { recursive: true, force: true });
    }
    await rm(join(claudeRoot, CODE_HELPER_SKILL_NAMES[0]), { recursive: true, force: true });

    const recommendations = await runSkillsAudit(root);
    const missingTargets = recommendations.filter((item) => item.code === "missing-inferred-registration");

    assert.equal(missingTargets.length, 2);
    assert.ok(missingTargets.some((item) => item.message.includes("Codex")));
    assert.ok(missingTargets.some((item) => item.message.includes("Claude Code")));
    assert.ok(recommendations.some((item) => item.code === "doctor-has-findings" && item.priority === "high"));
    assert.ok(!recommendations.some((item) => item.code === "skills-healthy"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
