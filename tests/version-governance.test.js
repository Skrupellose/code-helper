import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VersionGovernanceError,
  classifyVersionGovernanceError,
  compareSemVer,
  createLocalVersionStatus,
  createVersionPolicy,
  describeChannelSelector,
  describeDistTagsQuery,
  describeExactVersionQuery,
  evaluateChannelCandidate,
  isCanaryVersion,
  isStableVersion,
  parseSemVer,
  parseVersionPolicyJson,
  selectChannelCandidate,
  serializeVersionPolicy
} from "../dist/versioning/index.js";

test("严格 SemVer 解析接受标准版本并保留预发布与 build 标识", () => {
  // 解析器必须为后续通道判断保留标识符，同时 build 不参与版本优先级。
  const parsed = parseSemVer("1.2.3-canary.10+linux.x64");

  assert.equal(parsed.major, 1);
  assert.equal(parsed.minor, 2);
  assert.equal(parsed.patch, 3);
  assert.deepEqual(parsed.prerelease, ["canary", "10"]);
  assert.deepEqual(parsed.build, ["linux", "x64"]);
  assert.equal(compareSemVer("1.2.3+one", "1.2.3+two"), 0);
});

test("严格 SemVer 解析拒绝宽松写法和非法前导零", () => {
  // v 前缀、缺失 patch、空标识符、数字预发布前导零和前后空白都不能进入版本治理。
  for (const version of ["v1.2.3", "1.2", "01.2.3", "1.2.3-01", "1.2.3-", " 1.2.3", "1.2.3 "]) {
    assert.throws(() => parseSemVer(version), {
      name: "VersionGovernanceError",
      code: "INVALID_SEMVER"
    });
  }
});

test("SemVer 比较遵循正式版与预发布标识优先级", () => {
  // 覆盖 SemVer 规范示例中的数字/字符串预发布排序，避免使用普通字符串比较。
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0"
  ];

  for (let index = 0; index < ordered.length - 1; index += 1) {
    assert.equal(compareSemVer(ordered[index], ordered[index + 1]) < 0, true);
  }
});

test("Stable 与 Canary 仅接受各自严格版本形式", () => {
  // Canary 必须以完整小写 canary 标识开头；两个发布通道均拒绝 build metadata。
  assert.equal(isStableVersion("2.0.0"), true);
  assert.equal(isStableVersion("2.0.0-canary.1"), false);
  assert.equal(isStableVersion("2.0.0+build.1"), false);
  assert.equal(isCanaryVersion("2.0.0-canary.1"), true);
  assert.equal(isCanaryVersion("2.0.0-canary.1+build.1"), false);
  assert.equal(isCanaryVersion("2.0.0-canary"), false);
  assert.equal(isCanaryVersion("2.0.0-canary.beta"), false);
  assert.equal(isCanaryVersion("2.0.0-Canary.1"), false);
  assert.equal(isCanaryVersion("2.0.0-canary1"), false);
});

test("版本策略严格解析、确定性序列化并拒绝未知字段", () => {
  // 未知字段不能被静默忽略，否则拼错 channel 时可能意外选择正式通道。
  const policy = parseVersionPolicyJson('{"schemaVersion":1,"channel":"canary"}');

  assert.deepEqual(policy, { schemaVersion: 1, channel: "canary" });
  assert.equal(serializeVersionPolicy(policy), '{\n  "schemaVersion": 1,\n  "channel": "canary"\n}\n');
  assert.deepEqual(createVersionPolicy(), { schemaVersion: 1, channel: "stable" });
  assert.throws(
    () => parseVersionPolicyJson('{"schemaVersion":1,"channel":"stable","fallback":"canary"}'),
    { code: "INVALID_POLICY_SHAPE" }
  );
  assert.throws(() => parseVersionPolicyJson("{"), { code: "INVALID_POLICY_JSON" });
});

test("本地 status 是纯逻辑并显式展示策略是否匹配当前版本", () => {
  // 当前安装版本和所选后续通道可以不同，但状态必须把差异暴露给 CLI。
  assert.deepEqual(createLocalVersionStatus("1.2.3", createVersionPolicy("canary")), {
    currentVersion: "1.2.3",
    currentChannel: "stable",
    selectedChannel: "canary",
    selectedDistTag: "canary",
    policyMatchesCurrentVersion: false
  });
});

test("通道候选支持升级与持平并禁止隐式降级", () => {
  // 切换通道不能绕过 SemVer 降级门禁；需要降级时必须由未来显式流程另行授权。
  assert.equal(evaluateChannelCandidate("1.0.0", "1.1.0", "stable").status, "update-available");
  assert.equal(evaluateChannelCandidate("1.1.0-canary.2", "1.1.0-canary.2", "canary").status, "current");
  assert.equal(evaluateChannelCandidate("1.2.0", "1.1.0-canary.9", "canary").status, "downgrade-blocked");
  assert.throws(() => selectChannelCandidate("1.2.0", "1.1.0-canary.9", "canary"), {
    code: "CHANNEL_DOWNGRADE_BLOCKED"
  });
  assert.throws(() => evaluateChannelCandidate("1.0.0", "1.1.0-beta.1", "canary"), {
    code: "INVALID_CHANNEL_VERSION"
  });
});

test("查询描述只生成安全 URL 和参数，不执行网络或 dist-tag 写入", () => {
  // 参数数组可由后续适配器直接使用，模块自身不依赖 fetch 或子进程。
  const tags = describeDistTagsQuery("@skrupellose/code-helper");
  const exact = describeExactVersionQuery("@skrupellose/code-helper", "0.3.0-canary.1");
  const selector = describeChannelSelector("@skrupellose/code-helper", "canary");

  assert.equal(tags.kind, "dist-tags");
  assert.match(tags.registryUrl, /%40skrupellose%2Fcode-helper/);
  assert.deepEqual(tags.npmArguments, ["view", "@skrupellose/code-helper", "dist-tags", "--json"]);
  assert.equal(exact.kind, "exact-version");
  assert.equal(exact.version, "0.3.0-canary.1");
  assert.deepEqual(selector.npmArguments, [
    "view",
    "@skrupellose/code-helper@canary",
    "version",
    "dist.integrity",
    "--json"
  ]);
});

test("错误分类依赖稳定 code 而不是提示文案", () => {
  // CLI 可据此设置稳定退出码，未知异常不得伪装成版本治理错误。
  const known = new VersionGovernanceError("INVALID_POLICY_SHAPE", "任意文案");

  assert.deepEqual(classifyVersionGovernanceError(known), {
    code: "INVALID_POLICY_SHAPE",
    category: "policy",
    retryable: false
  });
  assert.deepEqual(classifyVersionGovernanceError(new Error("任意错误")), {
    code: "UNKNOWN_VERSION_GOVERNANCE_ERROR",
    category: "unknown",
    retryable: false
  });
});
