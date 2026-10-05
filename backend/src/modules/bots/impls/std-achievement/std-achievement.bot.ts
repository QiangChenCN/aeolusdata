import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, BotReply, BotCheckResult, IncomingMessage } from '../../bot.interface';
import { parseQuery } from './parse';
import { formatReply } from './format-reply';
import { RiderQueryService, RiderQueryResult, StdAchievementConfig } from './rider-query.service';

type Candidate = NonNullable<RiderQueryResult['candidates']>[number];

/**
 * 运力达成查询 bot：把旧 Python `dingtalkbot/std-achievement` 的逻辑迁到 Nest。
 * 接收/发送由 dingtalk-stream.gateway 负责（Stream 原生），本类只做「解析→查询→格式化」。
 */
@Injectable()
export class StdAchievementBot implements Bot {
  readonly botId = 'std-achievement';
  readonly type = 'dingtalk';
  readonly displayName = '运力达成查询';
  private readonly logger = new Logger(StdAchievementBot.name);
  private readonly cfg: StdAchievementConfig;
  /** 同名歧义：记住最近一次给某用户展示的候选，供其回复序号选择（带过期）。 */
  private pending = new Map<string, { candidates: Candidate[]; ts: number }>();
  private static readonly PENDING_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly riderQuery: RiderQueryService,
  ) {
    this.cfg = this.loadConfig();
  }

  private loadConfig(): StdAchievementConfig {
    const teamIdsRaw =
      this.config.get<string>('DINGBOT_TEAM_IDS') ||
      '917521130,917521136,917521139';
    const teamIds = teamIdsRaw
      .split(',')
      .map((t) => parseInt(t.trim(), 10))
      .filter((n) => Number.isFinite(n));
    const teamNames: Record<string, string> = {
      '917521130': '黄江镇站',
      '917521136': '长安万科站',
      '917521139': '大岭山大学城站',
    };
    const timeCode = this.config.get<string>('DINGBOT_TIME_CODE') || '140';
    const rosterTtl = parseInt(
      this.config.get<string>('DINGBOT_ROSTER_TTL') || '120',
      10,
    );
    return {
      teamIds,
      teamNames,
      timeCode,
      rosterTtl: Number.isFinite(rosterTtl) ? rosterTtl : 120,
    };
  }

  async check(): Promise<BotCheckResult> {
    if (!this.cfg.teamIds.length) {
      return { ok: false, detail: '未配置 DINGBOT_TEAM_IDS' };
    }
    return {
      ok: true,
      detail: `teams=${this.cfg.teamIds.length}, timeCode=${this.cfg.timeCode}`,
    };
  }

  async diag(): Promise<Record<string, unknown>> {
    const c = await this.check();
    return { botId: this.botId, ok: c.ok, detail: c.detail, config: this.cfg };
  }

  async onMessage(msg: IncomingMessage): Promise<BotReply> {
    const query = parseQuery(msg.rawText);
    if (!query) {
      return {
        kind: 'markdown',
        content: '请 @我 并发送骑手姓名或 ID，例如：张三 / 608652258',
      };
    }
    const key = msg.senderStaffId || msg.senderId || msg.conversationId;

    // 回复序号：命中上一次同名歧义展示的候选选择（带过期）。
    if (/^\d+$/.test(query.trim()) && key) {
      const pend = this.pending.get(key);
      if (pend && Date.now() - pend.ts < StdAchievementBot.PENDING_TTL_MS) {
        const idx = parseInt(query.trim(), 10) - 1;
        const chosen = idx >= 0 && idx < pend.candidates.length ? pend.candidates[idx] : null;
        if (chosen?.knight_id) {
          this.pending.delete(key);
          return this.runQuery(chosen.knight_id);
        }
      }
      this.pending.delete(key); // 序号无效或已过期，按普通文本继续查
    }

    try {
      const data = await this.riderQuery.query(query, this.cfg);
      if (data.status === 'ambiguous' && data.candidates?.length && key) {
        this.pending.set(key, { candidates: data.candidates, ts: Date.now() });
      }
      const isAmbiguous = data.status === 'ambiguous';
      return {
        kind: 'markdown',
        content: formatReply(query, data),
        title: isAmbiguous ? '请选择骑手' : '查询结果',
        state: isAmbiguous ? 'ambiguous' : 'ok',
      };
    } catch (e) {
      this.logger.error('查询异常: ' + (e as Error).message);
      return {
        kind: 'markdown',
        content:
          '⚠️ 查询失败，请稍后重试；若持续失败请联系管理员查看服务日志。',
        title: '查询失败',
        state: 'error',
      };
    }
  }

  /** 按骑手 ID 精确查询并格式化（序号选择 / 直接 ID 查询共用）。 */
  private async runQuery(riderId: string): Promise<BotReply> {
    try {
      const data = await this.riderQuery.query(riderId, this.cfg);
      return {
        kind: 'markdown',
        content: formatReply(riderId, data),
        title: data.status === 'error' ? '查询失败' : '查询结果',
        state: data.status === 'error' ? 'error' : 'ok',
      };
    } catch (e) {
      this.logger.error('查询异常: ' + (e as Error).message);
      return {
        kind: 'markdown',
        content:
          '⚠️ 查询失败，请稍后重试；若持续失败请联系管理员查看服务日志。',
        title: '查询失败',
        state: 'error',
      };
    }
  }
}
