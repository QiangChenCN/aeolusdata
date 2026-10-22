import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './modules/worker/worker.module';

/**
 * worker 进程入口（任务执行，与 API 进程解耦）。
 *
 * 不监听 HTTP（不调用 app.listen），仅通过 Nest 生命周期触发 WorkerService 的抢占循环。
 * 由 systemd 单元 aeolusdata-worker.service 以 `node dist/src/main-worker` 拉起。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  await app.init();
  // 进程靠 WorkerService 的定时器与 in-flight 任务保持存活；无需 listen。
}

void bootstrap();
