import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'fs';
import { join } from 'path';
import { ServeController } from './serve.controller';

/**
 * 静态托管（移植自 server.py _serve_static_get）：web / vendor。
 *
 * 注意：dist（前端构建产物）的整站托管已改到 main.ts 手动挂载，并对 `/api` 显式跳过
 * （见 main.ts 的静态中间件）。原因：@nestjs/serve-static 把 `app.use('/', express.static)`
 * 挂在根路径，其默认 fallthrough:false 会把 `/api` 的 POST（找不到同名文件）误判成 404，
 * 导致所有写接口（含标准达成刷新）在网关层即被挡掉。此处只保留开发期 /web、/vendor 资产挂载，
 * 它们不拦截 `/api`，且为 GET/HEAD 专用，无此副作用。
 */
function staticConfig() {
  const root = process.cwd();
  const web = join(root, '..', 'apps', 'web');
  const vendor = join(root, '..', 'apps', 'web', 'vendor');
  const cfg: { rootPath: string; serveRoot: string }[] = [];
  if (existsSync(web)) cfg.push({ rootPath: web, serveRoot: '/web' });
  if (existsSync(vendor)) cfg.push({ rootPath: vendor, serveRoot: '/vendor' });
  return cfg;
}

@Module({
  imports: [ServeStaticModule.forRoot(...staticConfig())],
  controllers: [ServeController],
})
export class ServeModule {}
