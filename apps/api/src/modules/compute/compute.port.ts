/**
 * 计算能力端口（契约）。所有计算逻辑只能通过本接口暴露，
 * 调用方依赖接口而非实现（见 ADR-2026-09-20 / 开发规范 §6）。
 *
 * - run(): 受控计算（经 ComputeService 编排）
 * - proxy(): 透传 Python 生态独占端点（dashboard.standard.* / aeolus_sdk / group_picker /
 *   openpyxl 等），NestJS 侧只做转发 + 鉴权闸门 + 数据权限裁剪，不进进程内。
 */
export interface ComputeTaskInput {
  kind: string;
  payload: Record<string, unknown>;
}

export interface ProxyRequest {
  endpoint: string; // 原样路径（含查询串），如 /api/ov/assessment?date=...
  method: 'GET' | 'POST';
  body?: unknown;
  /** 请求头透传（如数据权限 x-scope / x-user，供 Python 侧在计算前裁剪）。 */
  headers?: Record<string, string>;
}

export interface ComputeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  /** 上游真实 HTTP 状态码（仅当确实收到上游响应时存在，如 403 / 404 / 500）。
   *  代理据此原样透传状态码，避免把「无权访问」粉饰成 200。
   *  网络不可达 / PYTHON_COMPUTE_URL 未配置等场景无此字段（维持旧降级行为）。 */
  status?: number;
}

export interface ComputePort {
  run(input: ComputeTaskInput): Promise<ComputeResult>;
  proxy(req: ProxyRequest): Promise<ComputeResult>;
}

/** DI Token：运行时按 COMPUTE_PROVIDER 切换 Node / Python 实现。 */
export const COMPUTE_PORT = 'COMPUTE_PORT';
