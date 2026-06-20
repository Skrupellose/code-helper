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
  assert.equal(
    normalizeDroppedPath("docs/my\\ requirement.md", projectRoot),
    "docs/my requirement.md"
  );
});

test("normalizeDroppedPath 会保留 Windows 路径分隔符", () => {
  // 该测试覆盖 Windows 终端拖拽、手工输入和 file URL 形态，避免反斜杠被误当成 shell 转义。
  const projectRoot = "C:\\Users\\qingchen\\code\\code-helper-demo";

  assert.equal(
    normalizeDroppedPath("C:\\Users\\qingchen\\code\\code-helper-demo\\docs\\my requirement.md", projectRoot),
    "docs\\my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("\"C:\\Users\\qingchen\\code\\code-helper-demo\\docs\\my requirement.md\"", projectRoot),
    "docs\\my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("file:///C:/Users/qingchen/code/code-helper-demo/docs/my%20requirement.md", projectRoot),
    "docs\\my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("docs\\my requirement.md", projectRoot),
    "docs\\my requirement.md"
  );
  assert.equal(
    normalizeDroppedPath("C:\\Users\\qingchen\\other\\my requirement.md", projectRoot),
    "C:\\Users\\qingchen\\other\\my requirement.md"
  );
});
