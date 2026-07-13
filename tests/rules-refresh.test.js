import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { loadConfig } from "../dist/config.js";
import {
  createRuleDocumentFingerprint,
  isUnmodifiedBuiltinRuleDocument,
  normalizeRuleDocumentForCompare
} from "../dist/fs-utils.js";
import {
  initializeProject,
  installRuleTemplates,
  refreshRuleTemplates,
  updateProject
} from "../dist/init.js";
import { getRuleTemplates } from "../dist/templates.js";
import { getCurrentPackageVersion } from "../dist/version-check.js";

/**
 * 捕获 console.log，避免 CLI 摘要刷屏。
 */
async function runCliSilently(args, projectRoot) {
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (...items) => {
      logs.push(items.join(" "));
    };

    return {
      exitCode: await runCli(args, projectRoot),
      logs
    };
  } finally {
    console.log = originalLog;
  }
}

/**
 * 在已生成的规则正文中替换「调用入口文件」小节内容，保留其余段落。
 * 用于构造「仅入口不同」的未改动变体。
 */
function replaceEntrySectionBody(content, newBody) {
  return content.replace(
    /## 调用入口文件\n\n[\s\S]*?(?=\n## )/,
    `## 调用入口文件\n\n${newBody}\n`
  );
}

/**
 * 根据 fixture 文件名解析对应内置规则名（LEGACY 表的 key）。
 * 约定：`{规则基名}-{版本或提交}.md`，例如 `Agent协作规范-0.1.0.md`。
 */
function resolveLegacyRuleNameFromFixture(fixtureFileName, legacyKeys) {
  for (const ruleName of legacyKeys) {
    const baseName = ruleName.replace(/\.md$/u, "");
    if (fixtureFileName.startsWith(`${baseName}-`) && fixtureFileName.endsWith(".md")) {
      return ruleName;
    }
  }

  return undefined;
}

test("tests/fixtures/user-rules 中每个 fixture 都能被历史指纹矩阵识别", async () => {
  const fixturesDir = join(process.cwd(), "tests/fixtures/user-rules");
  const fixtureFiles = (await readdir(fixturesDir)).filter((name) => name.endsWith(".md"));
  assert.ok(fixtureFiles.length > 0, "应至少存在一个历史规则 fixture");

  for (const fixtureFile of fixtureFiles) {
    const root = await mkdtemp(join(tmpdir(), "code-helper-rules-fixture-matrix-"));

    try {
      await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
      await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

      const config = await loadConfig(root);
      const ruleNames = getRuleTemplates(config).map((template) => template.fileName);
      const ruleName = resolveLegacyRuleNameFromFixture(fixtureFile, ruleNames);
      assert.ok(ruleName, `无法从 fixture 文件名解析规则名：${fixtureFile}`);

      const rulePath = join(root, config.directories.userRules, ruleName);
      const currentTemplate = await readFile(rulePath, "utf8");
      const historicalTemplate = await readFile(join(fixturesDir, fixtureFile), "utf8");
      await writeFile(rulePath, historicalTemplate, "utf8");

      // 模拟指纹机制上线前的项目，通过真实升级结果验证 fixture 已登记，
      // 避免为测试对外暴露可篡改生产判定的指纹表引用。
      const statePath = join(root, ".code-helper/state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      delete state.ruleTemplateFingerprints;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

      await updateProject(root);
      assert.equal(
        await readFile(rulePath, "utf8"),
        currentTemplate,
        `fixture ${fixtureFile} 未被历史指纹矩阵识别并升级`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("normalizeRuleDocumentForCompare 忽略入口小节差异", () => {
  // 入口列表变化不应影响「正文是否被用户改过」的判定。
  const base = `# 标题

## 功能描述

说明。

## 调用入口文件

- \`AGENTS.md\`

## 规则

1. 第一条。
`;
  const onlyEntryChanged = replaceEntrySectionBody(
    base,
    "- `AGENTS.md`\n- `CLAUDE.md`"
  );
  const bodyChanged = base.replace("说明。", "用户改过的说明。");

  assert.equal(
    normalizeRuleDocumentForCompare(base),
    normalizeRuleDocumentForCompare(onlyEntryChanged)
  );
  assert.notEqual(
    normalizeRuleDocumentForCompare(base),
    normalizeRuleDocumentForCompare(bodyChanged)
  );
  assert.equal(isUnmodifiedBuiltinRuleDocument(onlyEntryChanged, base), true);
  assert.equal(isUnmodifiedBuiltinRuleDocument(bodyChanged, base), false);
});

test("首次 init 创建内置规则，state.json 含 packageVersion", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-created-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    const result = await initializeProject({
      projectRoot: root,
      skillRegistrationTargets: []
    });

    const rulePath = join(root, "code-helper-docs/user-rules/项目记忆规则优化.md");
    const ruleContent = await readFile(rulePath, "utf8");
    const state = JSON.parse(await readFile(join(root, ".code-helper/state.json"), "utf8"));
    const packageVersion = await getCurrentPackageVersion();
    const createdRules = result.operations.filter(
      (op) => op.path.includes("user-rules") && op.action === "created"
    );

    assert.match(ruleContent, /# 项目记忆规则优化/);
    assert.match(ruleContent, /## 调用入口文件/);
    assert.ok(createdRules.length >= 1);
    assert.equal(state.packageVersion, packageVersion);
    assert.ok(Array.isArray(state.enabledFeatures));
    assert.equal(typeof state.ruleTemplateFingerprints["项目记忆规则优化.md"], "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("无指纹旧 state 中的真实历史模板在 update 时自动刷新正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-version-upgrade-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const ruleName = "Agent协作规范.md";
    const rulePath = join(root, "code-helper-docs/user-rules", ruleName);
    const currentTemplate = await readFile(rulePath, "utf8");
    const historicalTemplate = await readFile(
      join(process.cwd(), "tests/fixtures/user-rules/Agent协作规范-4d342b9.md"),
      "utf8"
    );
    await writeFile(rulePath, historicalTemplate, "utf8");

    // 模拟指纹机制上线前的旧 state：保留真实旧字段，但完全不含 ruleTemplateFingerprints。
    const statePath = join(root, ".code-helper/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.ruleTemplateFingerprints;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await updateProject(root);
    const afterUpdate = await readFile(rulePath, "utf8");
    assert.equal(afterUpdate, currentTemplate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0.1.0 的真实 Agent 规则在无指纹 state 下整文件升级", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-010-release-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const rulePath = join(root, "code-helper-docs/user-rules/Agent协作规范.md");
    const earlyTemplate = await readFile(
      join(process.cwd(), "tests/fixtures/user-rules/Agent协作规范-0.1.0.md"),
      "utf8"
    );
    assert.equal(
      createRuleDocumentFingerprint(earlyTemplate),
      "2fd5b5ed5ab66564129f1c7f635311d8843a2ac5cf92d390bb59334815e2268e"
    );
    await writeFile(rulePath, earlyTemplate, "utf8");

    const statePath = join(root, ".code-helper/state.json");
    const oldState = JSON.parse(await readFile(statePath, "utf8"));
    delete oldState.ruleTemplateFingerprints;
    oldState.packageVersion = "0.1.0";
    await writeFile(statePath, `${JSON.stringify(oldState, null, 2)}\n`, "utf8");

    await updateProject(root);
    const afterUpdate = await readFile(rulePath, "utf8");
    assert.notEqual(afterUpdate, earlyTemplate);
    // 0.1.0 只有五条基础规则；以下正文断言证明已完整刷新到当前模板。
    assert.match(afterUpdate, /主会话定位为协调者/);
    assert.match(afterUpdate, /如果当前会话收到主会话派发/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0.1.1 至 0.1.2 的真实 Agent 规则在无指纹 state 下整文件升级", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-early-release-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const rulePath = join(root, "code-helper-docs/user-rules/Agent协作规范.md");
    const earlyTemplate = await readFile(
      join(process.cwd(), "tests/fixtures/user-rules/Agent协作规范-0.1.2.md"),
      "utf8"
    );
    assert.equal(
      createRuleDocumentFingerprint(earlyTemplate),
      "8b17d40ea5a6dcdf096050f52a9c60002c883c7128dbcba9c9d6236e29d7586b"
    );
    await writeFile(rulePath, earlyTemplate, "utf8");

    const statePath = join(root, ".code-helper/state.json");
    const oldState = JSON.parse(await readFile(statePath, "utf8"));
    delete oldState.ruleTemplateFingerprints;
    oldState.packageVersion = "0.1.2";
    await writeFile(statePath, `${JSON.stringify(oldState, null, 2)}\n`, "utf8");

    await updateProject(root);
    const afterUpdate = await readFile(rulePath, "utf8");
    assert.notEqual(afterUpdate, earlyTemplate);
    // 这两条只存在于 0.1.3 之后的模板，能证明发生了正文整文件刷新，而非仅入口同步。
    assert.match(afterUpdate, /如果当前会话收到主会话派发/);
    assert.match(afterUpdate, /执行子代理发现自身缺少必要工具、权限或上下文时/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0.1.6 至 0.1.8 的真实项目记忆规则在无指纹 state 下自动刷新", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-release-upgrade-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const ruleName = "项目记忆规则优化.md";
    const rulePath = join(root, "code-helper-docs/user-rules", ruleName);
    const releasedTemplate = await readFile(
      join(process.cwd(), "tests/fixtures/user-rules/项目记忆规则优化-0.1.6.md"),
      "utf8"
    );
    // 该 fixture 来自 0.1.6 发布提交，0.1.7/0.1.8 沿用同一正文；固定指纹防止 fixture 漂移。
    assert.equal(
      createRuleDocumentFingerprint(releasedTemplate),
      "004980664656826a58eb3e9402a496145650f0727d7264ce9d147f8a82e82439"
    );
    await writeFile(rulePath, releasedTemplate, "utf8");

    const statePath = join(root, ".code-helper/state.json");
    const oldState = JSON.parse(await readFile(statePath, "utf8"));
    delete oldState.ruleTemplateFingerprints;
    oldState.packageVersion = "0.1.8";
    await writeFile(statePath, `${JSON.stringify(oldState, null, 2)}\n`, "utf8");
    await writeFile(join(root, "CLAUDE.md"), "# Claude\n", "utf8");

    await updateProject(root);
    const afterUpdate = await readFile(rulePath, "utf8");
    assert.notEqual(afterUpdate, releasedTemplate);
    assert.match(afterUpdate, /CLAUDE\.md/);
    // 同时核对当前模板正文的稳定规则，避免测试只验证入口列表发生变化。
    assert.match(
      afterUpdate,
      /15\. 新功能、小节点或重构形成稳定规则后，agent 必须主动询问用户是否更新记忆/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("用户修改过的真实历史模板在无指纹 state 下保留正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-version-custom-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const ruleName = "Agent协作规范.md";
    const rulePath = join(root, "code-helper-docs/user-rules", ruleName);
    const historicalTemplate = await readFile(
      join(process.cwd(), "tests/fixtures/user-rules/Agent协作规范-4d342b9.md"),
      "utf8"
    );
    const customizedV1 = `${historicalTemplate.trimEnd()}\n\n## 用户补充\n\n这段内容必须保留。\n`;
    await writeFile(rulePath, customizedV1, "utf8");

    const statePath = join(root, ".code-helper/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.ruleTemplateFingerprints;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await updateProject(root);
    const afterUpdate = await readFile(rulePath, "utf8");
    assert.match(afterUpdate, /这段内容必须保留/);
    // 历史模板原有正文与用户补充应同时保留，证明默认路径没有整文件覆盖用户版本。
    assert.match(afterUpdate, /16\. Agent hooks 只作为完成检查提醒和兜底/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state 指纹字段形状错误时 update 不抛错并保守保留未知正文", async () => {
  for (const invalidState of [null, [], { ruleTemplateFingerprints: null }, { ruleTemplateFingerprints: [] }, { ruleTemplateFingerprints: { "Agent协作规范.md": 42 } }]) {
    const root = await mkdtemp(join(tmpdir(), "code-helper-rules-invalid-state-"));

    try {
      await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
      await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
      const rulePath = join(root, "code-helper-docs/user-rules/Agent协作规范.md");
      const customContent = `${await readFile(rulePath, "utf8")}\n## 未知自定义正文\n\n必须保留。\n`;
      await writeFile(rulePath, customContent, "utf8");
      await writeFile(
        join(root, ".code-helper/state.json"),
        `${JSON.stringify(invalidState, null, 2)}\n`,
        "utf8"
      );

      await updateProject(root);
      assert.match(await readFile(rulePath, "utf8"), /必须保留/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("writeStateFile 保留合法 state 的未知字段并覆盖受控字段", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-state-merge-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });
    const statePath = join(root, ".code-helper/state.json");
    const before = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(
      statePath,
      `${JSON.stringify({ ...before, extensionField: { keep: true }, packageVersion: "旧值" }, null, 2)}\n`,
      "utf8"
    );

    await updateProject(root);
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(after.extensionField, { keep: true });
    assert.equal(after.packageVersion, await getCurrentPackageVersion());
    assert.equal(typeof after.ruleTemplateFingerprints["Agent协作规范.md"], "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("未改动内置规则（仅入口不同）在 update 时整文件刷新为当前模板", async () => {
  // 模拟：磁盘正文与模板一致，仅入口列表是旧的 → 应整文件写成当前模板。
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-safe-refresh-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const rulePath = join(root, "code-helper-docs/user-rules/Agent协作规范.md");
    const afterInit = await readFile(rulePath, "utf8");
    const staleEntryOnly = replaceEntrySectionBody(afterInit, "- `旧入口.md`");
    await writeFile(rulePath, staleEntryOnly, "utf8");

    // 新增入口后 update，期望未改动规则被整文件刷新为含 CLAUDE.md 的当前模板。
    await writeFile(join(root, "CLAUDE.md"), "# Claude\n", "utf8");
    const result = await updateProject(root);

    const afterUpdate = await readFile(rulePath, "utf8");
    const config = await loadConfig(root);
    const expectedTemplate = getRuleTemplates(config).find(
      (item) => item.fileName === "Agent协作规范.md"
    );
    assert.ok(expectedTemplate);

    assert.equal(afterUpdate.trimEnd(), expectedTemplate.content.trimEnd());
    assert.match(afterUpdate, /CLAUDE\.md/);
    assert.doesNotMatch(afterUpdate, /旧入口\.md/);

    const refreshOp = result.operations.find((op) => op.path.endsWith("Agent协作规范.md"));
    assert.ok(refreshOp);
    assert.equal(refreshOp.action, "updated");
    assert.match(refreshOp.message, /已刷新未改动的内置规则/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("用户改过的规则在 update 时保留自定义段落，只更新入口", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-user-edit-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const rulePath = join(root, "code-helper-docs/user-rules/项目记忆规则优化.md");
    const original = await readFile(rulePath, "utf8");
    const customMarker = "## 用户自定义段落\n\n这是用户维护的内容，不得被 update 覆盖。\n";
    const userEdited = `${original.trimEnd()}\n\n${customMarker}`;
    await writeFile(rulePath, userEdited, "utf8");

    await writeFile(join(root, "CLAUDE.md"), "# Claude\n", "utf8");
    await updateProject(root);

    const afterUpdate = await readFile(rulePath, "utf8");
    assert.match(afterUpdate, /这是用户维护的内容，不得被 update 覆盖/);
    assert.match(afterUpdate, /## 用户自定义段落/);
    // 入口应被同步为双入口。
    assert.match(afterUpdate, /AGENTS\.md/);
    assert.match(afterUpdate, /CLAUDE\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("force / --refresh-rules 会覆盖用户改动的内置规则，不碰用户自建 md", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-force-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const rulePath = join(root, "code-helper-docs/user-rules/测试策略规范.md");
    const original = await readFile(rulePath, "utf8");
    await writeFile(
      rulePath,
      `${original.trimEnd()}\n\n## 用户自定义段落\n\n强制刷新前的用户内容。\n`,
      "utf8"
    );

    // 用户自建文件：强制刷新也不得删除或改写。
    const userRulePath = join(root, "code-helper-docs/user-rules/我的自定义规则.md");
    await writeFile(
      userRulePath,
      "# 我的自定义规则\n\n## 功能描述\n\n用户自建。\n\n## 调用时机\n\n随时。\n\n## 调用入口文件\n\n- `AGENTS.md`\n\n## 规则\n\n1. 保留。\n",
      "utf8"
    );

    const forceResult = await updateProject(root, { refreshRules: true });
    const afterForce = await readFile(rulePath, "utf8");
    const userRuleAfter = await readFile(userRulePath, "utf8");
    const config = await loadConfig(root);
    const expected = getRuleTemplates(config).find((item) => item.fileName === "测试策略规范.md");
    assert.ok(expected);

    assert.equal(afterForce.trimEnd(), expected.content.trimEnd());
    assert.doesNotMatch(afterForce, /强制刷新前的用户内容/);
    assert.match(userRuleAfter, /用户自建/);

    const forceOp = forceResult.operations.find((op) => op.path.endsWith("测试策略规范.md"));
    assert.ok(forceOp);
    assert.equal(forceOp.action, "updated");
    assert.match(forceOp.message, /强制刷新/);

    // CLI 入口同样支持 --refresh-rules。
    await writeFile(
      rulePath,
      `${expected.content.trimEnd()}\n\n## 再次自定义\n\nCLI 强制前。\n`,
      "utf8"
    );
    const cliResult = await runCliSilently(["update", "--refresh-rules"], root);
    assert.equal(cliResult.exitCode, 0);
    const afterCli = await readFile(rulePath, "utf8");
    assert.doesNotMatch(afterCli, /CLI 强制前/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshRuleTemplates 与 installRuleTemplates 不触碰用户自建 md", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-custom-only-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const userRulePath = join(root, "code-helper-docs/user-rules/本地约定.md");
    const customContent = "# 本地约定\n\n不要改我。\n";
    await writeFile(userRulePath, customContent, "utf8");

    const beforeNames = new Set(await readdir(join(root, "code-helper-docs/user-rules")));
    await refreshRuleTemplates(root, { force: false });

    const config = await loadConfig(root);
    await installRuleTemplates(root, config, { refreshRules: true });

    const afterContent = await readFile(userRulePath, "utf8");
    const afterNames = new Set(await readdir(join(root, "code-helper-docs/user-rules")));

    assert.equal(afterContent, customContent);
    assert.ok(beforeNames.has("本地约定.md"));
    assert.ok(afterNames.has("本地约定.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update 非法参数与 --refresh-rules 解析", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-rules-cli-args-"));

  try {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await initializeProject({ projectRoot: root, skillRegistrationTargets: [] });

    const bad = await runCliSilently(["update", "--unknown"], root);
    assert.equal(bad.exitCode, 1);

    const ok = await runCliSilently(["update", "--refresh-rules"], root);
    assert.equal(ok.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
