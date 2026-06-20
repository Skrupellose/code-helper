import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeDroppedPath } from "../dist/input-utils.js";

test("normalizeDroppedPath 会解析终端拖拽产生的路径格式", () => {
  // 该测试覆盖 macOS 终端常见拖拽格式。
  const projectRoot = "/tmp/code-helper-demo";

  assert.equal(
    normalizeDroppedPath("/tmp/code-helper-demo/docs/my\\ requirement.md", projectRoot),
    "docs/my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("'/tmp/code-helper-demo/docs/my requirement.md'", projectRoot),
    "docs/my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("\"/tmp/code-helper-demo/docs/my requirement.md\"", projectRoot),
    "docs/my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("file:///tmp/code-helper-demo/docs/my%20requirement.md", projectRoot),
    "docs/my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("/tmp/other/my\\ requirement.md", projectRoot),
    "/tmp/other/my requirement.md"
  );
});
