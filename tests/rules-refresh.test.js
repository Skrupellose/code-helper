import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../dist/cli.js";
import { loadConfig } from "../dist/config.js";
import {
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
