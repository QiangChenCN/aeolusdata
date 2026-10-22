import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { existsSync } from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { injectMachineToken, resolveIndexHtml } from '../../common/serve-html.util';

/**
 * 单文件 / 入口页（serve-static 不便托管的）：
 *  · `/`、`/index.html`：读取构建产物（或仓库根 dev 入口），把 `__SERVER_API_TOKEN__`
 *    占位符替换为真实 AUTH_TOKEN 后下发 —— 对齐 Vite 插件与旧 Python server 的注入逻辑，
 *    使浏览器能携带机器令牌调用 /api（闭合鉴权环路）。
 *  · `tokens.css`、`favicon.ico`、`health`。
 *  · SPA 深链接（/tasks、/bot/global 等）不在此处理：由 main.ts 的 Express 中间件回退
 *    index.html。原因见那里的注释 —— 交给 Nest 路由会被全局 AccessGuard 拦成 401。
 */
@Controller()
export class ServeController {
  constructor(private readonly config: ConfigService) {}

  /** 机器令牌只取自 env AUTH_TOKEN（不再回退 .api_token 文件）。 */
  private resolveToken(): string {
    return this.config.get<string>('AUTH_TOKEN') || '';
  }

  @Get()
  @Get('index.html')
  index(@Res() res: Response): void {
    const html = resolveIndexHtml(this.config.get<string>('PROJECT_ROOT'));
    if (html == null) {
      res.status(404).end();
      return;
    }
    res.type('text/html').send(injectMachineToken(html, this.resolveToken()));
  }

  @Get('tokens.css')
  tokensCss(@Res() res: Response): void {
    const f =     path.join(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
      'apps',
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
