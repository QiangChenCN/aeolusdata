import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DWClient, TOPIC_ROBOT, EventAck, DWClientDownStream } from 'dingtalk-stream';
import { BotRegistryService } from '../bot-registry.service';
import { BotReply, IncomingMessage } from '../bot.interface';
import { BotConfigService } from '../bot-config.service';
import { DingtalkClientProvider } from '../dingtalk-client.provider';
import { AiCardContext, DingtalkAiCardService } from './dingtalk-card.service';

/** 钉钉机器人回调下行的字段（仅取回复所需）。 */
interface RobotMessageShape {
  msgId?: string;
  conversationId?: string;
  conversationType?: string;
  senderId?: string;
  senderCorpId?: string;
  senderNick?: string;
  senderStaffId?: string;
  sessionWebhook?: string;
  robotCode?: string;
  msgtype?: string;
  text?: { content?: string };
}

/**
 * DingTalk Stream 多连接网关：基于官方 `dingtalk-stream` v2 SDK 的 `DWClient` 长连接收消息。
 *
 * 每个「已配置且被启用 bot 引用」的凭据分组（credentialsRef）各自建立一条独立的 Stream
 * 长连接；入站消息携带其来源分组 `ref`，`registry.dispatch(msg, ref)` 只路由给绑定该分组的
 * bot。回复所需的卡片 token 取自对应分组的 client（见 DingtalkAiCardService）。
 *
 * 回复路径（用户选定 B：AI 互动卡片打字效果）：
 *  - 收到消息后先建「查询中」AI 卡片（加载态），再统一查询一次，最后把结果流式打字推入卡片
 *    并 PUT 改标题为「查询结果」；查询超时/异常也保证卡片离开「查询中」态。
 *  - AI 卡片任一步失败 → 降级走 sessionWebhook 发 markdown（Stream 原生，不依赖 dws）。
 *  - 卡片流式协议由 `DingtalkAiCardService` 直连钉钉 OpenAPI 复刻（Node SDK 无高层卡片助手）。
 *
 * 接收：registerCallbackListener(TOPIC_ROBOT) + registerAllEventListener(SUCCESS ack)。
 */
@Injectable()
export class DingtalkStreamGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DingtalkStreamGateway.name);
  /** 凭据分组 ref → 该分组专属的 Stream 长连接 client。 */
  private readonly clients = new Map<string, DWClient>();

  constructor(
    private readonly clientProvider: DingtalkClientProvider,
    private readonly cfg: BotConfigService,
    private readonly registry: BotRegistryService,
    private readonly card: DingtalkAiCardService,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.isBotEnabled()) {
      this.logger.warn('钉钉机器人已禁用（botEnabled=false），Stream 网关不启动');
      return;
    }
    this.connectAll();
  }

  /** 应建连的分组：凭据可用（已启用且凭据完整）且被启用 bot 引用。 */
  private refsToConnect(): string[] {
    const avail = new Set(this.clientProvider.availableRefs());
    const used = this.registry.activeRefs();
    return used.filter((r) => avail.has(r));
  }

  private connectRef(ref: string): void {
    const client = this.clientProvider.getClient(ref);
    if (!client) {
      this.logger.warn('凭据分组 %s 缺少凭据，跳过建连', ref);
      return;
    }
    this.clients.set(ref, client);
    client.registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
      void this.handle(res, ref);
    });
    client.registerAllEventListener(() => ({ status: EventAck.SUCCESS }));
    client
      .connect()
      .catch((e) => this.logger.error('Stream 连接失败 ref=%s: %s', ref, (e as Error).message));
    this.logger.log('DingTalk Stream 网关已启动 ref=%s', ref);
  }

  private connectAll(): void {
    for (const ref of this.refsToConnect()) this.connectRef(ref);
    this.logger.log('DingTalk Stream 网关共建立 %d 个连接', this.clients.size);
  }

  /**
   * 热重载：凭据/开关/绑定变化后重连。返回当前状态快照（供前端展示）。
   *  - 禁用：断开全部，网关停摆。
   *  - 否则：使凭据缓存失效 → 断开全部 → 按最新 refsToConnect 重建（凭据变化总是全量重建，
   *    连接数通常为个位数，秒级完成，可接受）。
   */
  async reload(): Promise<{ ok: boolean; started: boolean; detail: string }> {
    if (!this.cfg.isBotEnabled()) {
      this.detachAll();
      return { ok: true, started: false, detail: '机器人已禁用，网关未启动' };
    }
    this.clientProvider.invalidate();
    this.detachAll();
    this.connectAll();
    const n = this.clients.size;
    return {
      ok: true,
      started: n > 0,
      detail: n > 0 ? `已重连 ${n} 个连接` : '无可用凭据或未被引用，网关未启动',
    };
  }

  private detachAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  /** 当前是否至少有一条「真实建立」的连接（供状态查询）。
   *  必须以 SDK 的 client.connected 为准，不能用 clients.has(ref)——
   *  后者在 connect() 异步完成前就为 true，会制造「显示已连接但实际没连上」的假象。 */
  isConnected(): boolean {
    return Array.from(this.clients.values()).some((c) => c.connected);
  }

  /** 连接明细（前端展示每个凭据分组的连接状态）。
   *  - connected：以 SDK 真实连接态 client.connected 为准（WebSocket open 后才为 true）。
   *  - missingCredential：该 ref 被启用的 bot 引用，但凭据分组不存在/未启用/缺 secret，
   *    导致根本不会建连——这是「设置看着正常却无响应」的典型成因，显式标红。 */
  listConnections(): { ref: string; clientId: string; connected: boolean; missingCredential: boolean }[] {
    const active = new Set(this.registry.activeRefs());
    const avail = new Set(this.clientProvider.availableRefs());
    const refs = new Set<string>([...active, ...avail]);
    return [...refs].map((ref) => {
      const client = this.clients.get(ref);
      return {
        ref,
        clientId: this.clientProvider.getClientId(ref),
        connected: client?.connected ?? false,
        missingCredential: active.has(ref) && !avail.has(ref),
      };
    });
  }

  onModuleDestroy(): void {
    this.detachAll();
  }

  private toIncoming(data: RobotMessageShape, messageId: string): IncomingMessage {
    return {
      rawText: data.text?.content ?? '',
      conversationId: data.conversationId ?? '',
      msgId: data.msgId ?? messageId,
      senderNick: data.senderNick ?? '',
      senderStaffId: data.senderStaffId ?? '',
      sessionWebhook: data.sessionWebhook ?? '',
      robotCode: data.robotCode ?? '',
      msgtype: data.msgtype ?? 'text',
      conversationType: data.conversationType ?? '2',
      senderId: data.senderId ?? '',
      senderCorpId: data.senderCorpId ?? '',
    };
  }

  private toCardContext(data: RobotMessageShape, messageId: string): AiCardContext {
    return {
      conversationId: data.conversationId ?? '',
      conversationType: data.conversationType ?? '2',
      senderId: data.senderId ?? '',
      senderCorpId: data.senderCorpId ?? '',
      msgId: data.msgId ?? messageId,
      robotCode: data.robotCode ?? '',
    };
  }

  private async handle(res: DWClientDownStream, ref: string): Promise<void> {
    const messageId = res.headers?.messageId ?? '';
    try {
      const data = JSON.parse(res.data) as RobotMessageShape;
      this.logger.warn(
        '[card-debug] robotCode=%s convType=%s convId=%s keys=%s',
        data.robotCode,
        data.conversationType,
        data.conversationId,
        Object.keys(data).join(','),
      );
      const msg = this.toIncoming(data, messageId);
      const ctx = this.toCardContext(data, messageId);
      await this.replyWithCard(msg, ctx, ref);
    } catch (e) {
      this.logger.error('处理入站消息异常: ' + (e as Error).message);
    } finally {
      if (messageId) {
        try {
          this.clients.get(ref)?.socketCallBackResponse(messageId, { status: 'SUCCESS' });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** AI 卡片主路径（内置 markdown AI 卡片）：建加载卡 → 查询 → 打字 → 终态；
   * 任何卡片步骤失败降级 webhook markdown。原生打字光标由钉钉 AI 卡片模板提供。 */
  private async replyWithCard(msg: IncomingMessage, ctx: AiCardContext, ref: string): Promise<void> {
    const client = this.clients.get(ref);
    if (!client) {
      this.logger.warn('ref %s 无可用连接，跳过消息', ref);
      return;
    }
    let card: { outTrackId: string; cardInstanceId: string } | null = null;
    try {
      card = await this.card.create(ctx, client, '查询中', '🔎 查询中… 请稍候…');
    } catch (e) {
      this.logger.warn('AI 卡片创建失败，降级 webhook markdown: ' + (e as Error).message);
      const r = await this.queryWithTimeout(msg, ref);
      if (r) await this.sendReply(msg.sessionWebhook, r, client);
      return;
    }

    const reply = await this.queryWithTimeout(msg, ref);
    this.logger.warn(`[card-debug] reply state=${reply?.state} title=${this.pickTitle(reply)} content=${(reply?.content ?? 'NULL').replace(/\n/g, ' ').slice(0, 160)}`);
    try {
      const content = reply?.content ?? '（无返回）';
      const title = this.pickTitle(reply);
      if (this.cfg.isTypingEnabled(ref)) {
        await this.card.streamTyping(card.cardInstanceId, client, content, { isError: reply?.state === 'error' });
        await this.card.finish(card.cardInstanceId, client, title, content);
      } else {
        await this.card.finish(card.cardInstanceId, client, title, content);
      }
    } catch (e) {
      this.logger.error('AI 卡片终态失败，降级 webhook: ' + (e as Error).message);
      if (reply) await this.sendReply(msg.sessionWebhook, reply, client);
    }
  }

  /** 统一查询一次，超时返回「查询超时」终态回复（绝不无限停在「查询中」）。 */
  private async queryWithTimeout(msg: IncomingMessage, ref: string): Promise<BotReply> {
    const timeoutSec = this.registry.timeoutForRef(ref);
    let reply: BotReply | void;
    try {
      reply = await Promise.race([
        this.registry.dispatch(msg, ref),
        new Promise<BotReply>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutSec * 1000),
        ),
      ]);
    } catch {
      return {
        kind: 'markdown',
        content:
          `⏳ 查询超时（超过 ${timeoutSec} 秒）。\n` +
          '可能是风神接口响应慢或登录态失效，请稍后重试。',
        title: '查询超时',
        state: 'timeout',
      };
    }
    return (
      reply ?? { kind: 'markdown', content: '（无返回）', title: '查询结果', state: 'ok' }
    );
  }

  private pickTitle(r?: BotReply): string {
    if (!r) return '查询结果';
    if (r.title) return r.title;
    if (r.state === 'timeout') return '查询超时';
    if (r.state === 'error') return '查询失败';
    return '查询结果';
  }

  /** Stream 原生回复（降级通道，走 sessionWebhook，使用对应凭据的 token）。 */
  private async sendReply(webhook: string, reply: BotReply, client: DWClient): Promise<void> {
    if (!webhook || !client) return;
    try {
      const token = await client.getAccessToken();
      const body =
        reply.kind === 'markdown'
          ? { msgtype: 'markdown', markdown: { title: reply.title || '运力达成查询', text: reply.content } }
          : { msgtype: 'text', text: { content: reply.content } };
      await fetch(webhook, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': String(token),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      this.logger.error('回复发送失败: ' + (e as Error).message);
    }
  }
}
