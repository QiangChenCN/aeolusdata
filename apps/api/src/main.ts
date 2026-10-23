import './instrumentation'; // 必须最先执行：在 NestFactory 之前注册 OTel 插桩（默认关闭，见 instrumentation.ts）
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import { existsSync } from 'fs';
import * as path from 'path';
import compression from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { loadAppConfig } from './config/configuration';
import { injectMachineToken, resolveIndexHtml } from './common/serve-html.util';
import { dirs } from './config/paths';
import { AEOLUS_MONOREPO_NAME } from '@aeolus/shared';

// 跨应用共享包（workspace 依赖）冒烟：确认 @aeolus/shared 在 api 侧可被解析与打包
console.log(`[shared] monorepo name = ${AEOLUS_MONOREPO_NAME}`);

/**
 * 请求体上限。
 *
 * Express 默认只有 **100kb**，会把「写原始层」这类大 payload 直接挡掉
 * （实时考勤快照 ≈340KB、违规明细整日数据、排班展平行都在百 KB 级）。
 *
 * 更麻烦的是**症状极具误导性**：body-parser 的 `PayloadTooLargeError`（413）在 Nest 里
 * 最终表现为默认的「未匹配路由」处理，客户端收到的是
 * `404 {"message":"Cannot POST /api/...","code":404}` —— 看起来像「路由没注册」，
 * 实际是「body 超限」。排查时极易走错方向（本次迁移中就踩了一次）。
 * 故显式抬高上限，并把这段原因留在这里。
 */
const BODY_LIMIT = '16mb';

async function bootstrap(): Promise<void> {
  // bodyParser: false —— 必须自己注册：框架默认那对解析器（100kb）会先于下面注册，
  // 大 body 仍然会被它先拒掉，`useBodyParser` 加在默认之后是无效的（顺序即生效顺序）。
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // 响应压缩：前端 bundle / API JSON 经 gzip 传输，显著降低首屏与刷新的传输体积。
  // 跳过 SSE（text/event-stream）实时日志流，避免缓冲破坏逐块推送。
  app.use(
    compression({
      filter: (req, res) => {
        const ct = String(res.getHeader('Content-Type') || '');
        if (ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
  const config = loadAppConfig();

  // 静态资源托管（替代 @nestjs/serve-static 挂在 `/` 的整站拦截）：
  // serve-static 默认 fallthrough:false，会把 `/api` 的 POST（找不到同名文件）误判成 404，
  // 导致「标准达成刷新」等所有写接口在网关层即 404，永远不出结果。
  // 这里手动挂载 express.static，但凡命中 `/api`（含任意子路径）一律 next() 交给 Nest 路由，
  // 其余路径（前端构建产物）按文件服务，找不到则 fallthrough 到 ServeController（入口页 token 注入）。
  const distDir = dirs.appsWebDist();
  if (existsSync(distDir)) {
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      // /api 一律交给 Nest 路由（含 POST 写接口）；入口页 / 与 /index.html 交给
      // ServeController 做 __SERVER_API_TOKEN__ 注入（闭合浏览器→/api 的机器令牌环路）。
      if (
        req.path.startsWith('/api') ||
        req.path === '/' ||
        req.path === '/index.html'
      ) {
        return next();
      }
      return express.static(distDir, {
        fallthrough: true,
        // 带内容 hash 的资源（Vite 产物 assets/ 下）可永久缓存，刷新不再重复下载；
        // 入口页 index.html 不缓存，保证发版即时生效。
        setHeaders: (res, filePath) => {
          const isHashed =
            filePath.includes(path.sep + 'assets' + path.sep) ||
            /-[A-Za-z0-9_]+\.(js|css|woff2?|ttf|png|jpe?g|svg|gif|ico)$/.test(filePath);
          res.setHeader(
            'Cache-Control',
            isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      })(req, res, next);
    });
  }

  // SPA 深链接回退（History 模式必需）：前端去掉 hash 后，/tasks、/bot/global 这类前端路由
  // 会直接打到服务器。静态中间件找不到同名文件 → 必须回退到 index.html，否则「刷新页面」或
  // 「直接打开链接」会 404。
  //
  // 为什么做在 Express 中间件层，而不是给 ServeController 加 @Get('*') 通配路由：
  // 通配路由属于 Nest 路由，会被全局 AccessGuard 拦截 —— 冷启动访问深链接时浏览器还没有会话
  // （也没有机器令牌），机器令牌闸门会把它挡成 401，浏览器收到的是 401 JSON 而不是登录页。
  // 动态 API 响应禁缓存：否则浏览器会缓存 grade-global 等 GET 响应（响应还带 ETag），
  // 配置/数据已变仍展示陈旧结果——曾因缓存了一份 configured:false 导致标准达成看板误报「未配置」。
  // 仅对 /api 生效；静态资源（Vite 产物带内容哈希）仍可正常缓存。
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 做在 Express 层与静态资源同级，在 Nest 路由之前短路返回，不经过守卫。
  if (existsSync(distDir)) {
    // 必须继续交给 Nest 处理的非页面路径（加了通配回退后不能被吞掉）
    const NON_SPA_PATHS = new Set(['/', '/index.html', '/health', '/tokens.css', '/favicon.ico']);
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      const m = (req.method || 'GET').toUpperCase();
      if (m !== 'GET' && m !== 'HEAD') return next();
      const p = req.path;
      if (p.startsWith('/api') || NON_SPA_PATHS.has(p)) return next();
      // 只认浏览器导航；XHR/fetch 误命中时不要返回 HTML 页面
      if (!(req.headers.accept || '').includes('text/html')) return next();
      // 带扩展名的按静态资源处理：找不到就让它 404，而不是回退成页面
      if (/\.[A-Za-z0-9]+$/.test(p)) return next();
      const html = resolveIndexHtml(config.projectRoot);
      if (html == null) return next();
      res.type('text/html').send(injectMachineToken(html, config.authToken));
    });
  }

  // 入参校验：白名单 + 自动转换；非法字段直接 400
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // 统一异常结构
  app.useGlobalFilters(new HttpExceptionFilter());

  // SSE / 跨源 iframe：EventSource 无法带自定义头，token 走 ?token= 查询参数
  app.enableCors({ origin: true, credentials: true });

  await app.listen(config.port);
}

void bootstrap();
