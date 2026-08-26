import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINIMUM_NODE_VERSION,
  resolveRuntimeBootstrap
} from "../dist/runtime.js";

test("低于 Node 22.5 时给出明确不支持诊断", () => {
  const decision = resolveRuntimeBootstrap("v22.4.1", []);
  assert.equal(decision.kind, "unsupported");
  assert.match(decision.message, new RegExp(MINIMUM_NODE_VERSION.replaceAll(".", "\\."), "u"));
});

test("Node 22.5 至 22.12 自动补充 SQLite 实验参数且不会循环重启", () => {
  assert.deepEqual(resolveRuntimeBootstrap("v22.5.0", []), {
    kind: "reexec",
    execArgv: ["--experimental-sqlite"]
  });
  assert.deepEqual(resolveRuntimeBootstrap("22.12.9", ["--experimental-sqlite"]), { kind: "ready" });
});

test("Node 22.13 及更新版本直接运行完整模式", () => {
  assert.deepEqual(resolveRuntimeBootstrap("v22.13.0", []), { kind: "ready" });
  assert.deepEqual(resolveRuntimeBootstrap("v24.0.0", []), { kind: "ready" });
});
