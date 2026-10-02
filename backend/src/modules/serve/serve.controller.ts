import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';

/**
 * 单文件 / 入口页（serve-static 不便托管的）：
 *  · `/`、`/index.html`：读取构建产物（或仓库根 dev 入口），把 `__SERVER_API_TOKEN__`
 *    占位符替换为真实 AUTH_TOKEN 后下发 —— 对齐 Vite 插件与旧 Python server 的注入逻辑，
 *    使浏览器能携带机器令牌调用 /api（闭合鉴权环路）。
 *  · `tokens.css`、`favicon.ico`、`health`。
 */
@Controller()
export class ServeController {
  constructor(private readonly config: ConfigService) {}

  /** 机器令牌只取自 env AUTH_TOKEN（不再回退 .api_token 文件）。 */
  private resolveToken(): string {
    return this.config.get<string>('AUTH_TOKEN') || '';
  }

  private resolveHtml(): string | null {
    const root =
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..');
    const candidates = [
      path.join(root, 'web', 'dist', 'index.html'), // 生产构建产物
      path.join(root, 'web', 'index.html'), // web/ dev 入口（Vite root=web）
    ];
    for (const c of candidates) {
      if (existsSync(c)) return readFileSync(c, 'utf-8');
    }
    return null;
  }

  @Get()
  @Get('index.html')
  index(@Res() res: Response): void {
    const html = this.resolveHtml();
    if (html == null) {
      res.status(404).end();
      return;
    }
    res.type('text/html').send(html.replace(/__SERVER_API_TOKEN__/g, this.resolveToken()));
  }

  @Get('tokens.css')
  tokensCss(@Res() res: Response): void {
    const f = path.join(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
      'web',
      'tokens.css',
    );
    if (!existsSync(f)) {
      res.status(404).end();
      return;
    }
    res.type('text/css').sendFile(f);
  }

  @Get('favicon.ico')
  favicon(@Res() res: Response): void {
    res.status(204).end();
  }

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
