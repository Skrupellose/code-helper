import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { setFeatureEnabled } from "../dist/config.js";
import {
  listProjectSkillRegistrations,
  parseSkillRegistrationTargets,
  registerProjectSkills,
  resolveSkillRegistrationTargets,
  runSkillsAudit,
  runSkillsDoctor,
  unregisterProjectSkills
} from "../dist/skills.js";

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

    assert.equal(firstOperations.length, 4);
    assert.ok(firstOperations.every((operation) => operation.action === "created"));
    assert.ok(secondOperations.every((operation) => operation.action === "skipped"));
    assert.ok(statuses.every((status) => status.registered));
    assert.match(completionSkill, /name: code-helper-completion-review/);
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

    assert.equal(operations.length, 4);
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

    assert.equal(operations.length, 4);
    assert.ok(operations.every((operation) => operation.action === "created"));
    assert.ok(statuses.every((status) => status.target === "githubcopilot" && status.registered));
    assert.match(memorySkill, /name: code-helper-memory-tuning/);
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

    assert.equal(operations.length, 4);
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

    assert.equal(operations.length, 4);
    assert.ok(operations.every((operation) => operation.action === "updated"));
    assert.ok(statuses.every((status) => !status.registered));
    assert.match(userSkill, /name: user-skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseSkillRegistrationTargets 只解析显式 CLI 目标", () => {
  // 该测试锁定显式参数解析：全量注册必须传 all，不带 target 不在这里推断项目状态。
  assert.deepEqual(parseSkillRegistrationTargets(undefined), ["codex"]);
  assert.deepEqual(parseSkillRegistrationTargets("all"), ["codex", "claudecode", "githubcopilot"]);
  assert.deepEqual(parseSkillRegistrationTargets("codex"), ["codex"]);
  assert.deepEqual(parseSkillRegistrationTargets("claudecode"), ["claudecode"]);
  assert.deepEqual(parseSkillRegistrationTargets("claude-code"), ["claudecode"]);
  assert.deepEqual(parseSkillRegistrationTargets("githubcopilot"), ["githubcopilot"]);
  assert.deepEqual(parseSkillRegistrationTargets("github"), ["githubcopilot"]);
  assert.deepEqual(parseSkillRegistrationTargets("copilot"), ["githubcopilot"]);
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

test("runSkillsAudit 会根据项目入口推荐缺失注册", async () => {
  // 该测试确认 audit 只输出建议，不直接创建项目级 skills。
  const root = await mkdtemp(join(tmpdir(), "code-helper-skills-audit-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await mkdir(join(root, "code-helper-docs/user-rules"), { recursive: true });

    const recommendations = await runSkillsAudit(root);

    assert.ok(recommendations.some((item) => item.code === "missing-inferred-registration"));
    assert.ok(recommendations.some((item) => item.code === "missing-memory-skill"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
