import { clearScreenDown, cursorTo, emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

/**
 * 单选菜单项。
 * value 是程序内部使用的稳定值，label 是展示给用户看的文案。
 */
export interface SelectOption<T extends string> {
  value: T;
  label: string;
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
  let selectedIndex = 0;

  return withRawMode(input, output, () => {
    return new Promise<T>((resolve) => {
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
          const pointer = index === selectedIndex ? ">" : " ";
          output.write(`${pointer} ${option.label}\n`);
        }
      };

      /**
       * 处理键盘输入。
       * 支持方向键，也支持 j/k，方便不同终端习惯。
       */
      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          process.exit(130);
        }

        if (key.name === "up" || key.name === "k") {
          selectedIndex = (selectedIndex - 1 + options.length) % options.length;
          render();
          return;
        }

        if (key.name === "down" || key.name === "j") {
          selectedIndex = (selectedIndex + 1) % options.length;
          render();
          return;
        }

        if (key.name === "return" || key.name === "space") {
          const selectedValue = options[selectedIndex]?.value;
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
    return new Promise<MultiSelectResult<T>>((resolve) => {
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
       */
      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          process.exit(130);
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
    return new Promise<void>((resolve) => {
      output.write(`\n${message}`);

      /**
       * 处理继续按键。
       * 回车、空格或 Esc 都视为确认返回菜单。
       */
      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          process.exit(130);
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
 * 这样即使交互中抛错，也不会让用户终端停留在不可输入状态。
 */
async function withRawMode<T>(
  input: ReadStream,
  output: WriteStream,
  action: () => Promise<T>
): Promise<T> {
  emitKeypressEvents(input);

  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  output.write("\x1B[?25l");

  try {
    return await action();
  } finally {
    output.write("\x1B[?25h");
    input.setRawMode(wasRaw);
  }
}
