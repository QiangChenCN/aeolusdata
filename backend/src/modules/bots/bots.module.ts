import { Module } from '@nestjs/common';
import { FetchModule } from '../fetch/fetch.module';
import { ConfigModule } from '../config/config.module';
import { BOTS } from './bot.interface';
import { BotConfigService } from './bot-config.service';
import { DingtalkClientProvider } from './dingtalk-client.provider';
import { BotRegistryService } from './bot-registry.service';
import { BotManifestService } from './bot-manifest.service';
import { DingtalkStreamGateway } from './dingtalk/dingtalk-stream.gateway';
import { DingtalkAiCardService } from './dingtalk/dingtalk-card.service';
import { BotController } from './bot.controller';
import { StdAchievementBot } from './impls/std-achievement/std-achievement.bot';
import { RiderQueryService } from './impls/std-achievement/rider-query.service';

/**
 * 机器人平台（控制面，运行在 Nest 进程内）。
 *
 *  - 复用 FetchModule 的风神单会话（AeolusCookieService / AttendanceFetchService）：
 *    取数委托 Nest 风神，单一登录态避免顶号。
 *  - 接收/发送走 dingtalk-stream.gateway（Stream 原生，不依赖 dws）。
 *  - bot 实例通过 `BOTS` 多提供令牌注入；新增 bot 只需在此追加一条 useClass 并在
 *    bots.manifest.ts 注册。
 */
/**
 * 共享的钉钉 Stream 长连接客户端由 DingtalkClientProvider 提供（按 BotConfigService 的
 * 「文件 + env」凭据懒建/重建，支持前端改配置后热重载）。未配置凭据时返回 null，网关据此不启动。
 */

@Module({
  imports: [FetchModule, ConfigModule],
  controllers: [BotController],
  providers: [
    BotConfigService,
    DingtalkClientProvider,
    BotManifestService,
    BotRegistryService,
    DingtalkStreamGateway,
    DingtalkAiCardService,
    RiderQueryService,
    // bot 实例：先作为普通 provider 注册，再用工厂把启用的 bot 收集成数组注入注册表。
    // （用显式数组工厂而非 `multi: true`，规避 Symbol 令牌在部分 Nest 版本下不被识别为数组的坑。）
    StdAchievementBot,
    { provide: BOTS, useFactory: (bot: StdAchievementBot) => [bot], inject: [StdAchievementBot] },
  ],
  exports: [BotRegistryService],
})
export class BotsModule {}
