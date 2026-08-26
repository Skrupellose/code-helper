import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { loadConfig, setFeatureEnabled } from "../dist/config.js";
import { getSkillManifest, resolveExpectedSkillManifest } from "../dist/skills.js";

const SKILL_NAMES = getSkillManifest().map((skill) => skill.directoryName);

/**
 * 捕获 runCli 的标准输出和错误输出，验证真实命令分发、退出码和用户可见结果。
 */
async function runCapturedCli(args, projectRoot) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;

  try {
    console.log = (...items) => {
      stdout.push(items.join(" "));
    };
    console.error = (...items) => {
      stderr.push(items.join(" "));
    };

    const exitCode = await runCli(args, projectRoot);
    return {
      exitCode,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n")
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/**
 * 返回四类 agent 的项目级 Skills 根目录。
 */
function getSkillsRoots(projectRoot) {
  return [
    join(projectRoot, ".agents/skills"),
    join(projectRoot, ".claude/skills"),
    join(projectRoot, ".github/skills"),
    join(projectRoot, ".grok/skills")
  ];
}

test("runCli skills register/list/unregister all 成功、重复且保留用户内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-success-"));
  const userSkillPaths = getSkillsRoots(root).map((skillsRoot) => join(skillsRoot, "user-owned/SKILL.md"));

  try {
    for (const userSkillPath of userSkillPaths) {
      await mkdir(join(userSkillPath, ".."), { recursive: true });
      await writeFile(userSkillPath, "# 用户 Skill\n", "utf8");
    }

    const firstRegister = await runCapturedCli(["skills", "register", "all"], root);
    const secondRegister = await runCapturedCli(["skills", "register", "all"], root);
    const list = await runCapturedCli(["skills", "list"], root);

    assert.equal(firstRegister.exitCode, 0);
    assert.equal(secondRegister.exitCode, 0);
    assert.match(firstRegister.stdout, /created/u);
    assert.match(secondRegister.stdout, /skipped/u);
    assert.equal(list.exitCode, 0);
    assert.equal((list.stdout.match(/已注册/gu) ?? []).length, SKILL_NAMES.length * 4);

    const unregister = await runCapturedCli(["skills", "unregister", "all"], root);
    const config = await loadConfig(root);

    assert.equal(unregister.exitCode, 0);
    assert.equal(config.features.skillRegistration.enabled, false);
    for (const userSkillPath of userSkillPaths) {
      assert.equal(await readFile(userSkillPath, "utf8"), "# 用户 Skill\n");
    }
    for (const skillsRoot of getSkillsRoots(root)) {
      for (const skillName of SKILL_NAMES) {
        await assert.rejects(() => stat(join(skillsRoot, skillName)), /ENOENT/u);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skills register 无入口时保守跳过且不创建 agent 目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-no-entry-"));

  try {
    const result = await runCapturedCli(["skills", "register"], root);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /未识别到明确的 agent 工具/u);
    for (const skillsRoot of getSkillsRoots(root)) {
      await assert.rejects(() => stat(skillsRoot), /ENOENT/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skills 非法 target 返回 1 并输出明确错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-invalid-target-"));

  try {
    const result = await runCapturedCli(["skills", "register", "unknown-agent"], root);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /不支持的 skills 注册目标：unknown-agent/u);
    assert.doesNotMatch(result.stderr, /\n\s+at /u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skills register 路径冲突时返回 1 且保持配置和磁盘原子性", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-conflict-"));
  const skillsRoot = join(root, ".agents/skills");
  const conflictPath = join(skillsRoot, SKILL_NAMES[2]);

  try {
    await setFeatureEnabled(root, "skillRegistration", false);
    await mkdir(skillsRoot, { recursive: true });
    // 用“目录位置被普通文件占用”制造跨平台确定性失败，不依赖 Unix 权限位。
    await writeFile(conflictPath, "确定性路径冲突", "utf8");

    const result = await runCapturedCli(["skills", "register", "codex"], root);
    const config = await loadConfig(root);

    assert.equal(result.exitCode, 1);
    assert.notEqual(result.stderr, "");
    assert.doesNotMatch(result.stderr, /\n\s+at /u);
    assert.equal(config.features.skillRegistration.enabled, false);
    for (const skillName of SKILL_NAMES) {
      if (skillName !== SKILL_NAMES[2]) {
        await assert.rejects(() => stat(join(skillsRoot, skillName)), /ENOENT/u);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skills doctor 健康时返回 0，YAML 错误时返回 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-doctor-"));

  try {
    await runCapturedCli(["skills", "register", "codex"], root);
    const healthy = await runCapturedCli(["skills", "doctor"], root);

    assert.equal(healthy.exitCode, 0);
    assert.match(healthy.stdout, /skills doctor 通过/u);

    const invalidSkillPath = join(root, ".agents/skills/invalid-yaml/SKILL.md");
    await mkdir(join(invalidSkillPath, ".."), { recursive: true });
    await writeFile(
      invalidSkillPath,
      "---\nname: invalid-yaml\ndescription: [未闭合\n---\n## 说明\n",
      "utf8"
    );

    const invalid = await runCapturedCli(["skills", "doctor"], root);

    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stdout, /invalid-frontmatter/u);
    assert.match(invalid.stdout, /YAML frontmatter 无法解析/u);
    assert.doesNotMatch(invalid.stdout, /weak-skill-description.*invalid-yaml/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skills audit 返回建议且不修改磁盘注册状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-audit-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");

    const result = await runCapturedCli(["skills", "audit"], root);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /missing-inferred-registration/u);
    await assert.rejects(() => stat(join(root, ".agents/skills")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skills profile/modules 会保存选择并让 register 收敛期望集合", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-selection-"));

  try {
    const profiles = await runCapturedCli(["skills", "profiles"], root);
    assert.equal(profiles.exitCode, 0);
    assert.match(profiles.stdout, /full: core,quality,collaboration,memory/u);

    const selectedProfile = await runCapturedCli(["skills", "profile", "delivery"], root);
    assert.equal(selectedProfile.exitCode, 0);
    assert.match(selectedProfile.stdout, /profile:delivery/u);

    await runCapturedCli(["skills", "register", "codex"], root);
    const deliveryConfig = await loadConfig(root);
    const deliveryNames = new Set(resolveExpectedSkillManifest(deliveryConfig).map((skill) => skill.directoryName));
    for (const name of SKILL_NAMES) {
      if (deliveryNames.has(name)) {
        assert.equal((await stat(join(root, ".agents/skills", name))).isDirectory(), true);
      } else {
        await assert.rejects(() => stat(join(root, ".agents/skills", name)), /ENOENT/u);
      }
    }

    const selectedModules = await runCapturedCli(["skills", "modules", "memory,core,memory"], root);
    assert.equal(selectedModules.exitCode, 0);
    assert.match(selectedModules.stdout, /modules:core,memory/u);
    await runCapturedCli(["skills", "register", "codex"], root);

    const moduleConfig = await loadConfig(root);
    assert.deepEqual(moduleConfig.skills, { mode: "modules", modules: ["core", "memory"] });
    const moduleNames = new Set(resolveExpectedSkillManifest(moduleConfig).map((skill) => skill.directoryName));
    for (const name of SKILL_NAMES) {
      if (moduleNames.has(name)) {
        assert.equal((await stat(join(root, ".agents/skills", name))).isDirectory(), true);
      } else {
        await assert.rejects(() => stat(join(root, ".agents/skills", name)), /ENOENT/u);
      }
    }

    const doctor = await runCapturedCli(["skills", "doctor"], root);
    assert.equal(doctor.exitCode, 0);
    assert.match(doctor.stdout, /skills doctor 通过/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skills profile/modules 对非法选择返回明确错误且不覆盖旧配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-invalid-selection-"));

  try {
    await runCapturedCli(["skills", "profile", "essential"], root);
    const invalidProfile = await runCapturedCli(["skills", "profile", "unknown"], root);
    const invalidModules = await runCapturedCli(["skills", "modules", "core,unknown"], root);
    const config = await loadConfig(root);

    assert.equal(invalidProfile.exitCode, 1);
    assert.match(invalidProfile.stderr, /不支持的 Skills profile：unknown/u);
    assert.equal(invalidModules.exitCode, 1);
    assert.match(invalidModules.stderr, /不支持的 Skills 模块：unknown/u);
    assert.deepEqual(config.skills, { mode: "profile", profile: "essential" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile 收敛会保留含用户附件的退休受控 Skill 目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-profile-attachment-"));
  try {
    await runCapturedCli(["skills", "register", "codex"], root);
    const retiredDirectory = join(root, ".agents/skills/code-helper-manual-test-workbench");
    const attachmentPath = join(retiredDirectory, "用户附件.md");
    await writeFile(attachmentPath, "# 用户补充资料\n", "utf8");

    await runCapturedCli(["skills", "profile", "essential"], root);
    const result = await runCapturedCli(["skills", "register", "codex"], root);

    assert.match(result.stdout, /含用户附件/u);
    assert.equal(await readFile(attachmentPath, "utf8"), "# 用户补充资料\n");
    assert.equal((await stat(join(retiredDirectory, "SKILL.md"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills audit 不会把显式排除的模块误报为注册缺失", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-cli-audit-selection-"));

  try {
    await mkdir(join(root, "code-helper-docs/user-rules"), { recursive: true });
    await runCapturedCli(["skills", "profile", "delivery"], root);
    await runCapturedCli(["skills", "register", "codex"], root);
    const result = await runCapturedCli(["skills", "audit"], root);

    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /missing-memory-skill/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
