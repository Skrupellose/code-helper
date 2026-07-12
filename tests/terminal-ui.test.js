import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  promptSelect,
  TerminalCancelError,
  TerminalInterruptError
} from "../dist/terminal-ui.js";

/**
 * 构造可模拟 raw mode 的假 TTY 流。
 * 与 init 多选测试一致：通过 emit("keypress") 驱动 promptSelect。
 */
function createFakeTtyStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const rawModeChanges = [];

  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled) => {
    rawModeChanges.push(enabled);
    input.isRaw = enabled;
    return input;
  };
  output.isTTY = true;
  // 进入前 pause，避免 PassThrough 默认可读状态干扰 resume/pause 断言
  input.pause();

  return { input, output, rawModeChanges };
}

test("TerminalCancelError 与 TerminalInterruptError 是可区分的错误类", () => {
  // 菜单层依赖 instanceof 分流：Cancel 回菜单，Interrupt 退出 130
  const cancel = new TerminalCancelError();
  const interrupt = new TerminalInterruptError();

  assert.equal(cancel.name, "TerminalCancelError");
  assert.equal(interrupt.name, "TerminalInterruptError");
  assert.ok(cancel instanceof Error);
  assert.ok(interrupt instanceof Error);
  assert.equal(cancel instanceof TerminalInterruptError, false);
  assert.equal(interrupt instanceof TerminalCancelError, false);
  assert.match(cancel.message, /取消/);
  assert.match(interrupt.message, /中断/);
});

test("promptSelect Esc 会 reject TerminalCancelError 并恢复终端", async () => {
  // Esc 只取消当前单选，不 process.exit；withRawMode 必须 restore raw mode 后抛出 Cancel
  const { input, output, rawModeChanges } = createFakeTtyStreams();
  const options = [
    { value: "1", label: "选项一" },
    { value: "0", label: "返回" }
  ];

  const prompt = promptSelect(input, output, "测试单选菜单", options);

  // 等 render 与 keypress 监听挂上后再发 Esc
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", "", { name: "escape" });

  await assert.rejects(() => prompt, (error) => {
    assert.ok(error instanceof TerminalCancelError);
    assert.equal(error.name, "TerminalCancelError");
    return true;
  });

  // 进入 raw 后应恢复为 false，避免终端卡在 raw mode
  assert.deepEqual(rawModeChanges, [true, false]);
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
});

test("promptSelect 回车会返回当前选中值", async () => {
  // 确认 Esc 改动未破坏正常确认路径
  const { input, output, rawModeChanges } = createFakeTtyStreams();
  const options = [
    { value: "alpha", label: "Alpha" },
    { value: "beta", label: "Beta" }
  ];

  const prompt = promptSelect(input, output, "确认选择", options);

  await new Promise((resolve) => setImmediate(resolve));
  // 默认停在第一项，下移后回车选 beta
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "return" });

  const value = await prompt;

  assert.equal(value, "beta");
  assert.deepEqual(rawModeChanges, [true, false]);
  assert.equal(input.isRaw, false);
});
