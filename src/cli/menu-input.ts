import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { canUseInteractiveKeys, promptContinue } from "../terminal-ui.js";

export type MenuReadline = ReturnType<typeof createInterface>;

/**
 * TTY 菜单动作结束后暂停，避免下一轮菜单清屏导致结果一闪而过。
 * 非 TTY 兜底模式不暂停，保证管道和脚本执行不会被阻塞。
 */
export async function pauseAfterMenuAction(enabled: boolean): Promise<void> {
  if (enabled && canUseInteractiveKeys(input, output)) {
    await promptContinue(input, output);
  }
}

/**
 * 打印需要用户输入的动作提示。
 * 这让用户能区分“正在等待输入”和“程序没有响应”。
 */
export function printInputHint(message: string): void {
  console.log(`\n请输入信息：${message}`);
}

/**
 * 读取必填菜单输入。
 * 空回车或输入 0 都表示返回上一级，避免用户误入流程后无法退出。
 */
export async function askRequiredMenuInput(
  rl: MenuReadline,
  question: string
): Promise<string | undefined> {
  const answer = (await askQuestionOrDefault(rl, question, "0")).trim();

  if (answer === "" || answer === "0") {
    return undefined;
  }

  return answer;
}

/**
 * 读取可选菜单输入。
 * 空回车表示接受默认值，输入 0 表示返回上一级。
 */
export async function askOptionalMenuInput(
  rl: MenuReadline,
  question: string
): Promise<string | undefined> {
  const answer = (await askQuestionOrDefault(rl, question, "")).trim();

  if (answer === "0") {
    return undefined;
  }

  return answer;
}

/**
 * 安全读取用户输入。
 * 当 stdin 已关闭或管道输入提前结束时，返回默认值，避免兜底交互崩溃。
 */
export async function askQuestionOrDefault(
  rl: MenuReadline,
  question: string,
  defaultAnswer: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    /**
     * stdin 提前结束时，readline 在部分 Node 版本不会让 question promise settle。
     * 这里主动监听 close，并用默认值返回，避免交互流程悬挂。
     */
    const onClose = (): void => {
      if (!settled) {
        settled = true;
        resolve(defaultAnswer);
      }
    };

    rl.once("close", onClose);

    rl.question(question)
      .then((answer) => {
        if (!settled) {
          settled = true;
          rl.off("close", onClose);
          resolve(answer);
        }
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        rl.off("close", onClose);

        if (error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE") {
          resolve(defaultAnswer);
          return;
        }

        reject(error);
      });
  });
}
