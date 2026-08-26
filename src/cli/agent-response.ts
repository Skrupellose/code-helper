/** Agent 可稳定消费的诊断项。 */
export interface AgentDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  target?: string;
  fix?: string;
}

/** 所有新增结构化命令共享的单一 JSON 响应外壳。 */
export interface AgentResponse<T = unknown> {
  ok: boolean;
  action: string;
  status: string;
  data: T;
  diagnostics: AgentDiagnostic[];
  nextActions: string[];
}

/** stdout 只调用一次 console.log，保证每次 JSON 命令只输出一个完整文档。 */
export function printAgentResponse(response: AgentResponse): void {
  console.log(JSON.stringify(response, null, 2));
}

/** 构造成功响应，避免各命令分支遗漏协议字段。 */
export function createSuccessResponse<T>(
  action: string,
  data: T,
  nextActions: string[] = []
): AgentResponse<T> {
  return { ok: true, action, status: "success", data, diagnostics: [], nextActions };
}

/**
 * 构造携带业务数据的非成功响应。
 *
 * 文档冲突、完整性失败等结果既需要非零退出码，也需要保留完整预览数据；
 * 因此不能退化成只有空 data 的参数错误响应。
 */
export function createOutcomeResponse<T>(
  action: string,
  status: string,
  data: T,
  diagnostics: AgentDiagnostic[],
  nextActions: string[] = []
): AgentResponse<T> {
  return { ok: false, action, status, data, diagnostics, nextActions };
}

/** 构造失败响应；data 保持对象，方便调用方稳定解构。 */
export function createErrorResponse(
  action: string,
  status: string,
  diagnostic: AgentDiagnostic,
  nextActions: string[] = []
): AgentResponse<Record<string, never>> {
  return { ok: false, action, status, data: {}, diagnostics: [diagnostic], nextActions };
}
