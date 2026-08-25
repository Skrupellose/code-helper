import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertValidReleaseSnapshot,
  fetchPublishedReleaseStatus,
  parseNpmDistTags,
  parseNpmVersionMetadata,
  readStoredVersionPolicy,
  writeStoredVersionPolicy,
  validateReleaseSnapshot
} from "../dist/versioning/index.js";

const STABLE_SRI = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const CANARY_SRI = "sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==";

test("npm dist-tag 与精确版本元数据解析器接受严格合法输入", () => {
  // registry 适配器只需把 JSON 交给纯解析器，发布规则不直接依赖网络实现。
  assert.deepEqual(parseNpmDistTags({
    latest: "0.3.0",
    stable: "0.3.0",
    canary: "0.4.0-canary.1",
    legacy: "0.2.1"
  }), {
    latest: "0.3.0",
    stable: "0.3.0",
    canary: "0.4.0-canary.1"
  });

  assert.deepEqual(parseNpmVersionMetadata({
    version: "0.3.0",
    dist: { integrity: STABLE_SRI, tarball: "https://example.invalid/package.tgz" }
  }), {
    version: "0.3.0",
    integrity: STABLE_SRI
  });
});

test("registry 解析器拒绝缺失标签、非法版本和非法 SRI", () => {
  // 不完整 registry 数据不能被当成可发布快照，避免在网络响应截断时给出假阳性。
  assert.throws(() => parseNpmDistTags({ latest: "0.3.0", stable: "0.3.0" }), {
    code: "INVALID_REGISTRY_METADATA"
  });
  assert.throws(() => parseNpmDistTags({ latest: "0.3", stable: "0.3.0", canary: "0.4.0-canary.1" }), {
    code: "INVALID_REGISTRY_METADATA"
  });
  assert.throws(() => parseNpmVersionMetadata({ version: "0.3.0", dist: { integrity: "md5-deadbeef" } }), {
    code: "INVALID_REGISTRY_METADATA"
  });
});

test("合法发布快照要求 latest/stable 同版本同 SRI 且 Canary 制品独立", () => {
  // 正式版与测试版可来自相邻版本线，但版本号和制品摘要均不得碰撞。
  const snapshot = createSnapshot();
  const result = validateReleaseSnapshot(snapshot);

  assert.deepEqual(result, { valid: true, issues: [] });
  assert.doesNotThrow(() => assertValidReleaseSnapshot(snapshot));
});

test("发布快照识别 latest/stable 标签与 SRI 分叉", () => {
  // 即使 tag 文本看似可用，只要精确元数据不一致就必须阻止发布验收。
  const snapshot = createSnapshot();
  const result = validateReleaseSnapshot({
    ...snapshot,
    distTags: { ...snapshot.distTags, latest: "0.3.1" },
    releases: {
      ...snapshot.releases,
      latest: {
        version: "0.3.1",
        integrity: "sha512-AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=="
      }
    }
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    "RELEASE_STABLE_TAG_MISMATCH",
    "RELEASE_STABLE_INTEGRITY_MISMATCH"
  ]);
});

test("正式标签不得指向预发布版本", () => {
  // latest 和 stable 即使相互一致，也不能共同指向 Canary 或其它预发布版本。
  const snapshot = createSnapshot();
  const result = validateReleaseSnapshot({
    ...snapshot,
    distTags: { ...snapshot.distTags, latest: "0.3.0-rc.1", stable: "0.3.0-rc.1" },
    releases: {
      ...snapshot.releases,
      latest: { version: "0.3.0-rc.1", integrity: STABLE_SRI },
      stable: { version: "0.3.0-rc.1", integrity: STABLE_SRI }
    }
  });

  assert.deepEqual(result.issues.map((issue) => issue.code), ["RELEASE_STABLE_PRERELEASE"]);
});

test("Canary 必须使用完整小写标识且版本和 SRI 均与正式通道独立", () => {
  // 同时覆盖错误通道标识和制品碰撞，验证器应一次返回全部可操作问题。
  const snapshot = createSnapshot();
  const result = validateReleaseSnapshot({
    ...snapshot,
    distTags: { ...snapshot.distTags, canary: "0.3.0" },
    releases: {
      ...snapshot.releases,
      canary: { version: "0.3.0", integrity: STABLE_SRI }
    }
  });

  assert.deepEqual(result.issues.map((issue) => issue.code), [
    "RELEASE_CANARY_IDENTIFIER_REQUIRED",
    "RELEASE_CANARY_VERSION_COLLISION",
    "RELEASE_CANARY_INTEGRITY_COLLISION"
  ]);
  assert.throws(() => assertValidReleaseSnapshot({
    ...snapshot,
    distTags: { ...snapshot.distTags, canary: "0.3.0" },
    releases: {
      ...snapshot.releases,
      canary: { version: "0.3.0", integrity: STABLE_SRI }
    }
  }), { code: "RELEASE_CANARY_IDENTIFIER_REQUIRED" });
});

test("发布快照识别 dist-tag 与精确版本元数据不一致", () => {
  // 精确版本查询结果必须与此前读取的 dist-tag 对应，避免两次查询之间标签移动造成竞态误判。
  const snapshot = createSnapshot();
  const result = validateReleaseSnapshot({
    ...snapshot,
    releases: {
      ...snapshot.releases,
      canary: { version: "0.4.0-canary.2", integrity: CANARY_SRI }
    }
  });

  assert.deepEqual(result.issues.map((issue) => issue.code), ["RELEASE_TAG_VERSION_MISMATCH"]);
});

test("版本策略默认只读使用 Stable，并支持显式持久化 Canary", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-helper-version-policy-"));
  try {
    assert.deepEqual(await readStoredVersionPolicy(root), {
      policy: { schemaVersion: 1, channel: "stable" },
      explicit: false,
      relativePath: ".code-helper/version-policy.json"
    });

    const stored = await writeStoredVersionPolicy(root, "canary");
    assert.equal(stored.explicit, true);
    assert.equal((await readStoredVersionPolicy(root)).policy.channel, "canary");
    assert.equal(
      await readFile(join(root, ".code-helper/version-policy.json"), "utf8"),
      '{\n  "schemaVersion": 1,\n  "channel": "canary"\n}\n'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("远端适配器查询 dist-tag 后按精确版本校验完整发布快照", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    const decoded = decodeURIComponent(String(url));
    if (decoded.endsWith("/-/package/@skrupellose/code-helper/dist-tags")) {
      return jsonResponse({ latest: "0.3.0", stable: "0.3.0", canary: "0.4.0-canary.1" });
    }
    if (decoded.endsWith("/0.3.0")) {
      return jsonResponse({ version: "0.3.0", dist: { integrity: STABLE_SRI } });
    }
    if (decoded.endsWith("/0.4.0-canary.1")) {
      return jsonResponse({ version: "0.4.0-canary.1", dist: { integrity: CANARY_SRI } });
    }
    return jsonResponse({}, 404);
  };

  const published = await fetchPublishedReleaseStatus({ fetchImpl });
  assert.equal(published.snapshot.distTags.canary, "0.4.0-canary.1");
  assert.equal(requested.length, 4);
});

test("Stable workflow 在 npm publish 前执行 Canary-first 严格门禁", async () => {
  // 发布动作不可逆，静态顺序回归确保 Canary 标签、严格版本和规范 SRI 均在上传前校验。
  const workflow = await readFile(join(import.meta.dirname, "../.github/workflows/npm-publish.yml"), "utf8");
  const gateIndex = workflow.indexOf("Require an existing Canary before Stable publish");
  const publishIndex = workflow.indexOf("- name: Publish package");

  assert.ok(gateIndex >= 0 && gateIndex < publishIndex);
  assert.match(workflow, /if: steps\.package\.outputs\.channel == 'stable'/u);
  assert.match(workflow, /dist-tags\.canary/u);
  assert.match(workflow, /canaryPattern/u);
  assert.match(workflow, /decoded\.length !== 64/u);
  assert.match(workflow, /decoded\.toString\('base64'\) !== encoded/u);
});

/** 创建最小 fetch Response 替身，测试只依赖适配器实际读取的字段。 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

/** 创建每个测试可独立修改的合法发布快照，避免样本之间共享可变状态。 */
function createSnapshot() {
  return {
    distTags: {
      latest: "0.3.0",
      stable: "0.3.0",
      canary: "0.4.0-canary.1"
    },
    releases: {
      latest: { version: "0.3.0", integrity: STABLE_SRI },
      stable: { version: "0.3.0", integrity: STABLE_SRI },
      canary: { version: "0.4.0-canary.1", integrity: CANARY_SRI }
    }
  };
}
