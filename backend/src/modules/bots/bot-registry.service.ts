import { Inject, Injectable, Logger } from '@nestjs/common';
import { BOTS, Bot, BotReply, IncomingMessage } from './bot.interface';
import { BOT_MANIFEST } from './bots.manifest';
import { BotManifestService } from './bot-manifest.service';

/**
 * bot 注册表：把清单里启用的 bot 实例收集进来，并负责按渠道 + 凭据分组分发入站消息。
 *
 * 设计要点：
 *  - bot 实例通过 `BOTS` 多提供令牌注入，新增 bot 只需在模块里追加一条 `useClass`。
 *  - 分发按渠道类型 + `credentialsRef` 路由（多连接网关下，来自某凭据分组的消息只交给
 *    绑定该分组的 bot），多 bot 同分组时按注册顺序首个命中。
 *  - `enabled` / `credentialsRef` 均为运行时可写状态（经 BotManifestService 落盘），通过
 *    setEnabled / setCredentialsRef 在线修改，不影响其它分组的连接。
 *  - 单条消息处理异常被隔离，绝不冒泡到 Stream 连接。
 */
@Injectable()
export class BotRegistryService {
  private readonly logger = new Logger(BotRegistryService.name);
  private readonly all = new Map<string, Bot>();
  private readonly active = new Map<string, Bot>();

  constructor(
    @Inject(BOTS) private readonly bots: Bot[],
    private readonly manifest: BotManifestService,
  ) {
    for (const b of bots) {
      this.all.set(b.botId, b);
      if (this.manifest.getEnabled(b.botId)) {
        this.active.set(b.botId, b);
        this.logger.log('已启用 bot: %s (%s)', b.botId, b.displayName);
      } else {
        this.logger.warn('bot %s 未启用，跳过分发', b.botId);
      }
    }
  }

  /** 某 bot 当前绑定的凭据分组（运行时覆盖优先）。 */
  refOf(botId: string): string | undefined {
    return this.manifest.getCredentialsRef(botId);
  }

  /** 某连接(ref)对应的查询超时：取绑定该 ref 的首个实例的设置，否则回落默认。 */
  timeoutForRef(ref: string): number {
    for (const b of this.active.values()) {
      if (b.type !== 'dingtalk') continue;
      if (this.refOf(b.botId) === ref) return this.manifest.getQueryTimeout(b.botId);
    }
    return this.manifest.getDefaultQueryTimeout();
  }

  /** 按类型 + 凭据分组路由分发；只交给「绑定该 ref 且已启用」的 bot。 */
  async dispatch(msg: IncomingMessage, ref: string): Promise<BotReply | void> {
    let reply: BotReply | undefined;
    for (const b of this.active.values()) {
      if (b.type !== 'dingtalk') continue;
      if (this.refOf(b.botId) !== ref) continue;
      try {
        const r = await b.onMessage(msg);
        if (r) reply = r;
      } catch (e) {
        this.logger.error('bot %s 处理消息异常: %s', b.botId, (e as Error).message);
      }
    }
    return reply;
  }

  /** 运行时启停某个 bot（不影响全局 Stream 连接，仅决定其是否参与消息分发）。 */
  setEnabled(botId: string, enabled: boolean): boolean {
    const ok = this.manifest.setEnabled(botId, enabled);
    if (!ok) return false;
    if (enabled) {
      const b = this.all.get(botId);
      if (b) this.active.set(botId, b);
    } else {
      this.active.delete(botId);
    }
    return true;
  }

  /** 运行时改凭据分组绑定（不影响连接本身，但路由随之变化；需 reload 网关建/断对应连接）。 */
  setCredentialsRef(botId: string, ref: string): boolean {
    return this.manifest.setCredentialsRef(botId, ref);
  }

  /** 启用 bot 所引用的凭据分组集合（供网关决定建连）。 */
  activeRefs(): string[] {
    const refs = new Set<string>();
    for (const b of this.active.values()) {
      const r = this.refOf(b.botId);
      if (r) refs.add(r);
    }
    return [...refs];
  }

  /** 全部实例（含启用态与凭据分组），供前端「实例与状态」区展示与启停/绑定。 */
  listStatus(): {
    botId: string;
    displayName: string;
    type: string;
    enabled: boolean;
    credentialsRef?: string;
  }[] {
    return [...this.all.values()].map((b) => ({
      botId: b.botId,
      displayName: this.manifest.getDisplayName(b.botId),
      type: b.type,
      enabled: this.manifest.getEnabled(b.botId),
      credentialsRef: this.manifest.getCredentialsRef(b.botId),
      queryTimeout: this.manifest.getQueryTimeout(b.botId),
    }));
  }
}
