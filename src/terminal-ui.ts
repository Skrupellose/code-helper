import { clearScreenDown, cursorTo, emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

/**
 * 用户按 Ctrl+C 中断交互时抛出。
 * keypress handler 不得直接 process.exit，否则会跳过 withRawMode 的终端恢复逻辑。
 */
export class TerminalInterruptError extends Error {
  constructor(message = "用户中断") {
    super(message);
    this.name = "TerminalInterruptError";
  }
}

/**
 * 单选菜单项。
 * value 是程序内部使用的稳定值，label 是展示给用户看的文案。
 */
export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /**
   * disabled 用于展示不可选的分组标题。
   * 单选菜单会跳过这些项，避免用户把分组标题当成功能动作确认。
   */
  disabled?: boolean;
}

/**
 * 多选菜单项。
 * checked 表示当前是否启用，通常用于功能开关列表。
 */
export interface MultiSelectOption<T extends string> extends SelectOption<T> {
  checked: boolean;
}

/**
 * 多选菜单结果。
 * cancelled 表示用户按 Esc 返回，不保存任何更改。
 */
export interface MultiSelectResult<T extends string> {
  options: Array<MultiSelectOption<T>>;
  cancelled: boolean;
}

/**
 * 判断当前进程是否支持原始按键交互。
 * 非 TTY 环境例如 CI、管道输入或日志采集场景，应回退到普通文本输入。
 */
export function canUseInteractiveKeys(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream
): input is ReadStream {
  return Boolean(input.isTTY && output.isTTY && typeof (input as ReadStream).setRawMode === "function");
}

/**
 * 渲染单选菜单，并通过方向键移动、空格或回车确认。
 * 该函数不依赖第三方包，便于 code-helper 保持轻量安装体积。
 */
export async function promptSelect<T extends string>(
  input: ReadStream,
  output: WriteStream,
  title: string,
  options: Array<SelectOption<T>>
): Promise<T> {
  let selectedIndex = findNextEnabledOptionIndex(options, -1, 1);

  return withRawMode(input, output, () => {
    return new Promise<T>((resolve, reject) => {
      /**
       * 重新绘制菜单。
       * 每次按键后清空当前屏幕区域，避免列表残影。
       */
      const render = (): void => {
        cursorTo(output, 0, 0);
        clearScreenDown(output);
        output.write(`${title}\n`);
        output.write("使用 ↑/↓ 移动，空格或回车确认，Ctrl+C 退出。\n\n");

        for (const [index, option] of options.entries()) {
          const pointer = !option.disabled && index === selectedIndex ? ">" : " ";
          output.write(`${pointer} ${option.label}\n`);
        }
      };

      /**
       * 处理键盘输入。
       * 支持方向键，也支持 j/k，方便不同终端习惯。
       * Ctrl+C：先 cleanup 再 reject，由 withRawMode 恢复终端后以 130 退出。
       */
      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(new TerminalInterruptError());
          return;
        }

        if (key.name === "up" || key.name === "k") {
          selectedIndex = findNextEnabledOptionIndex(options, selectedIndex, -1);
          render();
          return;
        }

        if (key.name === "down" || key.name === "j") {
          selectedIndex = findNextEnabledOptionIndex(options, selectedIndex, 1);
          render();
          return;
        }

        if (key.name === "return" || key.name === "space") {
          const selectedValue = options[selectedIndex]?.value;
          if (selectedValue === undefined || options[selectedIndex]?.disabled) {
            render();
            return;
          }
          cleanup();
          resolve(selectedValue);
        }
      };

      /**
       * 清理按键监听并把光标放到菜单下方。
       */
      const cleanup = (): void => {
        input.off("keypress", onKeypress);
        cursorTo(output, 0, options.length + 4);
      };

      input.on("keypress", onKeypress);
      render();
    });
  });
}

/**
 * 查找下一个可选菜单项。
 * 分组标题等 disabled 项只参与展示，不参与方向键停留和确认。
 */
function findNextEnabledOptionIndex<T extends string>(
  options: Array<SelectOption<T>>,
  currentIndex: number,
  direction: 1 | -1
): number {
  for (let step = 1; step <= options.length; step += 1) {
    const candidateIndex = (currentIndex + direction * step + options.length) % options.length;

    if (!options[candidateIndex]?.disabled) {
      return candidateIndex;
    }
  }

  return 0;
}

/**
 * 渲染多选菜单。
 * 空格切换当前项，回车保存所有选择，适合功能开关批量修改。
 */
export async function promptMultiSelect<T extends string>(
  input: ReadStream,
  output: WriteStream,
  title: string,
  options: Array<MultiSelectOption<T>>
): Promise<MultiSelectResult<T>> {
  let selectedIndex = 0;
  const nextOptions = options.map((option) => ({ ...option }));

  return withRawMode(input, output, () => {
    return new Promise<MultiSelectResult<T>>((resolve, reject) => {
      /**
       * 重新绘制多选菜单。
       * checked 用 [x] / [ ] 展示，用户可以直接看到切换结果。
       */
      const render = (): void => {
        cursorTo(output, 0, 0);
        clearScreenDown(output);
        output.write(`${title}\n`);
        output.write("使用 ↑/↓ 移动，空格切换，回车保存，Esc 返回，Ctrl+C 退出。\n\n");

        for (const [index, option] of nextOptions.entries()) {
          const pointer = index === selectedIndex ? ">" : " ";
          const marker = option.checked ? "[x]" : "[ ]";
          output.write(`${pointer} ${marker} ${option.label}\n`);
        }
      };

      /**
       * 处理多选菜单键盘输入。
       * 回车只保存，不切换当前项，避免误操作。
       * Ctrl+C 与单选一致：reject 专用错误，禁止直接 process.exit。
       */
      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(new TerminalInterruptError());
          return;
        }

        if (key.name === "up" || key.name === "k") {
          selectedIndex = (selectedIndex - 1 + nextOptions.length) % nextOptions.length;
          render();
          return;
        }

        if (key.name === "down" || key.name === "j") {
          selectedIndex = (selectedIndex + 1) % nextOptions.length;
          render();
          return;
        }

        if (key.name === "space") {
          nextOptions[selectedIndex].checked = !nextOptions[selectedIndex].checked;
          render();
          return;
        }

        if (key.name === "return") {
          cleanup();
          resolve({ options: nextOptions, cancelled: false });
          return;
        }

        if (key.name === "escape") {
          cleanup();
          resolve({ options, cancelled: true });
        }
      };

      /**
       * 清理按键监听并把光标放到菜单下方。
       */
      const cleanup = (): void => {
        input.off("keypress", onKeypress);
        cursorTo(output, 0, nextOptions.length + 4);
      };

      input.on("keypress", onKeypress);
      render();
    });
  });
}

/**
 * 等待用户确认后继续。
 * 用于菜单动作结束后暂停，避免下一次菜单重绘把执行结果立即清掉。
 */
export async function promptContinue(input: ReadStream, output: WriteStream, message = "按回车返回菜单..."): Promise<void> {
  return withRawMode(input, output, () => {
    return new Promise<void>((resolve, reject) => {
      output.write(`\n${message}`);

      /**
       * 处理继续按键。
       * 回车、空格或 Esc 都视为确认返回菜单；Ctrl+C 走统一中断路径。
       */
      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(new TerminalInterruptError());
          return;
        }

        if (key.name === "return" || key.name === "space" || key.name === "escape") {
          cleanup();
          resolve();
        }
      };

      /**
       * 清理按键监听并换行，避免下一次菜单贴在提示后面。
       */
      const cleanup = (): void => {
        input.off("keypress", onKeypress);
        output.write("\n");
      };

      input.on("keypress", onKeypress);
    });
  });
}

/**
 * 在 raw mode 下执行交互函数，并确保结束时恢复终端状态。
 * 正常结束、业务异常、用户 Ctrl+C 都会走同一套 restore，避免终端卡在隐藏光标或 raw mode。
 */
async function withRawMode<T>(
  input: ReadStream,
  output: WriteStream,
  action: () => Promise<T>
): Promise<T> {
  emitKeypressEvents(input);

  // 记录进入前的 raw 状态，结束时原样还原
  const wasRaw = input.isRaw;
  // 幂等恢复：catch 里可能先 restore 再 exit，finally 也会再调一次
  let restored = false;

  /**
   * 同步恢复 setRawMode、显示光标并 pause stdin。
   * 必须在 process.exit 之前调用：exit 会立刻终止进程，可能跳过尚未执行的 finally。
   */
  const restore = (): void => {
    if (restored) {
      return;
    }

    restored = true;
    restoreTerminalAfterRawMode(input, output, wasRaw);
  };

  input.setRawMode(true);
  input.resume();
  // 隐藏光标，减少菜单重绘时的闪烁
  output.write("\x1B[?25l");

  try {
    return await action();
  } catch (error) {
    // 先恢复终端，再处理中断退出；顺序不可颠倒
    restore();

    if (error instanceof TerminalInterruptError) {
      process.exit(130);
    }

    throw error;
  } finally {
    restore();
  }
}

/**
 * 同步恢复 raw mode 交互对终端的改动。
 * 独立成函数便于 catch / finally 共用，并在单测或排错时一眼看清恢复步骤。
 */
function restoreTerminalAfterRawMode(
  input: ReadStream,
  output: WriteStream,
  wasRaw: boolean
): void {
  try {
    // 显示光标（进入 raw mode 时用 \x1B[?25l 隐藏）
    output.write("\x1B[?25h");
  } catch {
    // 输出流已关闭时忽略，避免二次异常掩盖原始错误
  }

  try {
    if (typeof input.setRawMode === "function") {
      input.setRawMode(wasRaw);
    }
  } catch {
    // stdin 不可用时忽略
  }

  try {
    // 释放 stdin 对事件循环的引用；后续菜单会在进入下一次交互时重新 resume
    input.pause();
  } catch {
    // pause 失败时忽略
  }
}
