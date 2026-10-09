import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

/**
 * 入口页解析与机器令牌注入 —— ServeController 与 main.ts 的 SPA 深链接回退共用同一份逻辑，
 * 避免两处各写一套导致行为漂移（一处改了另一处没改）。
 */

/** 候选入口页（顺序即优先级）：生产构建产物 → web/ dev 入口。 */
export function resolveIndexHtml(projectRoot?: string): string | null {
  const root = projectRoot || path.resolve(process.cwd(), '..');
  const candidates = [
    path.join(root, 'web', 'dist', 'index.html'), // 生产构建产物
    path.join(root, 'web', 'index.html'), // web/ dev 入口（Vite root=web）
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf-8');
  }
  return null;
}

/** 把 __SERVER_API_TOKEN__ 占位符替换为真实机器令牌（未配置时替换为空串）。 */
export function injectMachineToken(html: string, token: string): string {
  return html.replace(/__SERVER_API_TOKEN__/g, token || '');
}
