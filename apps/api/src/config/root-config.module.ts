import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';
import { envValidationSchema } from './configuration';

/**
 * 全局配置模块：API 进程（AppModule）与 worker 进程（WorkerModule）共用同一份
 * ConfigModule.forRoot 配置，避免两处各写一份而漂移。
 *
 * 背景：worker 曾因自己的模块图里没有 ConfigModule，导致 PgService 注入
 * ConfigService 失败（Nest DI "lookupComponentInParentModules" 错），进程起不来。
 *
 * 单一配置来源 = 仓库根 .env（如 /opt/aeolusdata/.env）。systemd 的 EnvironmentFile
 * 注入同一份；这里显式读取它，不再读 backend/.env，避免两份漂移。数组第二项是
 * 本地开发的优雅回退（若根 .env 缺席、仍有 backend/.env 时可用）。
 *
 * 注意：不要在 .env 里设 `PROJECT_ROOT=..` 这类相对值 —— 后端现位于 apps/api，
 * 旧布局的相对值会把它解析错一层（如 apps/apps/api）。不设该变量时，
 * configuration.ts 的 resolveRepoRoot() 会自动向上查找「同时含 apps/ 与 services/」
 * 的目录得到仓库根，迁移前后均稳健。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      envFilePath: [
        path.resolve(process.cwd(), '..', '..', '.env'),
        path.resolve(process.cwd(), '.env'),
      ],
    }),
  ],
})
export class RootConfigModule {}
