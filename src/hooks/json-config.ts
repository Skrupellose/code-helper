import { readTextIfExists } from "../fs-utils.js";

import type { AgentHookInstallTarget } from "./targets.js";
import {
  CODE_HELPER_AGENT_HOOK_SCRIPT,
  CODE_HELPER_HOOK_COMMAND_WINDOWS,
  CODE_HELPER_LEGACY_HOOK_COMMAND,
  CODE_HELPER_LEGACY_HOOK_COMMAND_WINDOWS,
  renderClaudeHookHandler,
  renderCodexHookHandler
} from "./renderers.js";

/**
 * 读取 JSON 对象。
 * 文件不存在时返回空对象；非对象 JSON 视为配置异常。
 */
export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const raw = await readTextIfExists(path);

  if (raw === undefined || raw.trim() === "") {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`JSON 配置必须是对象：${path}`);
  }

  return parsed as Record<string, unknown>;
}

/**
 * 给配置对象追加 code-helper Stop hook。
 * 已存在时先移除再追加，保证命令内容升级后能稳定刷新。
 */
export function addCodeHelperStopHook(
  config: Record<string, unknown>,
  target: AgentHookInstallTarget
): Record<string, unknown> {
  const nextConfig = removeCodeHelperStopHook(config);
  const hooks = getOrCreateObject(nextConfig, "hooks");
  const stopGroups = getOrCreateArray(hooks, "Stop");
  const handler = target === "codex" ? renderCodexHookHandler() : renderClaudeHookHandler();

  stopGroups.push({
    hooks: [handler]
  });

  return nextConfig;
}

/**
 * 从配置对象中移除 code-helper Stop hook。
 * 只删除识别为 code-helper 管理的 handler，保留用户自定义 Stop hook。
 */
export function removeCodeHelperStopHook(config: Record<string, unknown>): Record<string, unknown> {
  const nextConfig = structuredClone(config) as Record<string, unknown>;
  const hooks = nextConfig.hooks;

  if (!isRecord(hooks)) {
    return nextConfig;
  }

  const stopGroups = hooks.Stop;
  if (!Array.isArray(stopGroups)) {
    return nextConfig;
  }

  hooks.Stop = stopGroups
    .map((group) => removeCodeHelperHandlersFromGroup(group))
    .filter((group) => group !== undefined);

  return nextConfig;
}

/**
 * 收集 Stop 事件下的所有 handler。
 * 状态检测只关心 Stop hook，不读取其他生命周期事件。
 */
export function collectStopHandlers(config: Record<string, unknown>): unknown[] {
  const hooks = config.hooks;
  if (!isRecord(hooks) || !Array.isArray(hooks.Stop)) {
    return [];
  }

  return hooks.Stop.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return [];
    }

    return group.hooks;
  });
}

/**
 * 判断 handler 是否由 code-helper 管理。
 * 同时识别历史直连 npx 命令，确保升级后能清理旧配置。
 */
export function isCodeHelperHookHandler(handler: unknown): boolean {
  if (!isRecord(handler)) {
    return false;
  }

  if (typeof handler.command !== "string") {
    return false;
  }

  const command = handler.command;

  return command.includes(CODE_HELPER_AGENT_HOOK_SCRIPT)
    || command.includes(CODE_HELPER_HOOK_COMMAND_WINDOWS)
    || command.includes(CODE_HELPER_LEGACY_HOOK_COMMAND)
    || command.includes(CODE_HELPER_LEGACY_HOOK_COMMAND_WINDOWS);
}

/**
 * 从单个 Stop matcher group 中移除 code-helper handler。
 * 如果该 group 只剩 code-helper handler，整个 group 会被删除。
 */
function removeCodeHelperHandlersFromGroup(group: unknown): unknown | undefined {
  if (!isRecord(group)) {
    return group;
  }

  const handlers = group.hooks;
  if (!Array.isArray(handlers)) {
    return group;
  }

  const nextHandlers = handlers.filter((handler) => !isCodeHelperHookHandler(handler));

  if (nextHandlers.length === 0) {
    return undefined;
  }

  return {
    ...group,
    hooks: nextHandlers
  };
}

/**
 * 返回或创建对象字段。
 * 已存在但类型不正确时会覆盖为对象，避免后续写入产生运行时错误。
 */
function getOrCreateObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = target[key];

  if (isRecord(existing)) {
    return existing;
  }

  const nextValue: Record<string, unknown> = {};
  target[key] = nextValue;
  return nextValue;
}

/**
 * 返回或创建数组字段。
 * Stop hook 配置必须是数组；类型不匹配时按新安装配置重建。
 */
function getOrCreateArray(target: Record<string, unknown>, key: string): unknown[] {
  const existing = target[key];

  if (Array.isArray(existing)) {
    return existing;
  }

  const nextValue: unknown[] = [];
  target[key] = nextValue;
  return nextValue;
}

/**
 * 判断未知值是否是普通对象。
 * JSON 配置处理需要频繁收窄 unknown，统一在这里避免重复判断。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
