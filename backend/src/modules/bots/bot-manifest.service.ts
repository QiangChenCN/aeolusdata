import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { BOT_MANIFEST, ManifestBot } from './bots.manifest';

/** 查询超时内置安全默认（秒）：仅当某实例未单独设置时使用，非可配置全局默认。 */
const DEFAULT_QUERY_TIMEOUT = 60;

/**
 * bot 清单的运行时覆盖（实例在线启停 + 凭据分组绑定）。
 *
 * 编译期清单 `bots.manifest.ts` 定义静态基线；本服务把「是否启用」「凭据分组绑定」
 * 的可写状态落盘到 `<PROJECT_ROOT>/bot_manifest.json`
 * （{ overrides: { [botId]: { enabled?, credentialsRef? } } }），使前端操作在重启后保留。
 *
 *  - getEnabled / getCredentialsRef：覆盖优先，否则回落编译默认值。
 *  - setEnabled / setCredentialsRef：写盘覆盖（botId 必须存在于编译清单）。
 *  - listBots()：合并后给出全部实例 + 当前启用态 + 凭据分组引用。
 */
@Injectable()
export class BotManifestService {
  private readonly logger = new Logger(BotManifestService.name);
  private readonly file: string;
  private overrides: Record<string, { enabled?: boolean; credentialsRef?: string; displayName?: string; queryTimeout?: number }> = {};

  constructor(private readonly nest: NestConfigService) {
    const root = path.resolve(
      this.nest.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.file = path.join(root, 'bot_manifest.json');
    this.overrides = this.readFile();
  }

  private readFile(): Record<string, { enabled?: boolean; credentialsRef?: string; displayName?: string; queryTimeout?: number }> {
    try {
      const obj = JSON.parse(fs.readFileSync(this.file, 'utf-8')) || {};
      const raw = (obj.overrides && typeof obj.overrides === 'object' ? obj.overrides : {}) as Record<
        string,
        unknown
      >;
      const out: Record<string, { enabled?: boolean; credentialsRef?: string; displayName?: string; queryTimeout?: number }> = {};
      for (const [k, v] of Object.entries(raw)) {
        // 兼容旧版 { [botId]: boolean } 写法
        if (typeof v === 'boolean') {
          out[k] = { enabled: v };
          continue;
        }
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          const entry: { enabled?: boolean; credentialsRef?: string; displayName?: string; queryTimeout?: number } = {};
          if (typeof o.enabled === 'boolean') entry.enabled = o.enabled;
          // 仅当原文件里确实存在 credentialsRef 才写入该键：这样「覆盖里显式解绑（空串）」
          // 会保留键、读回为空串→回落 undefined（未绑定）；而「覆盖只改过启用态、从没碰过
          // 绑定」则不含该键，继续沿用编译清单默认（保证老部署开箱即用）。
          if (typeof o.credentialsRef === 'string') entry.credentialsRef = o.credentialsRef;
          if (typeof o.displayName === 'string' && o.displayName.trim()) entry.displayName = o.displayName.trim();
          if (typeof o.queryTimeout === 'number') entry.queryTimeout = o.queryTimeout;
          out[k] = entry;
        }
      }
      return out;
    } catch {
      return {};
    }
  }
  private writeFile(): void {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ overrides: this.overrides }, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  private manifestRef(botId: string): string | undefined {
    return BOT_MANIFEST.bots.find((x) => x.botId === botId)?.credentialsRef;
  }

  /** 合并后的启用态：覆盖优先，否则编译默认值。 */
  getEnabled(botId: string): boolean {
    const o = this.overrides[botId];
    if (o && typeof o.enabled === 'boolean') return o.enabled;
    const m = BOT_MANIFEST.bots.find((x) => x.botId === botId);
    return m ? m.enabled : false;
  }

  /** 合并后的凭据分组绑定：
   *  - 覆盖里显式设置过凭据绑定（含空串=解除绑定）时，尊重覆盖、不再回落编译默认；
   *  - 仅当覆盖不存在、或覆盖从没触碰过绑定（无 credentialsRef 键）时，才沿用编译清单默认
   *    （保证老部署从 .env 单组凭据自动迁移后开箱即用）。 */
  getCredentialsRef(botId: string): string | undefined {
    const o = this.overrides[botId];
    if (o && Object.prototype.hasOwnProperty.call(o, 'credentialsRef')) {
      const r = o.credentialsRef;
      return typeof r === 'string' && r.trim() ? r.trim() : undefined;
    }
    return this.manifestRef(botId);
  }

  /** 写启用态并落盘；botId 不存在返回 false。 */
  setEnabled(botId: string, enabled: boolean): boolean {
    const exists = BOT_MANIFEST.bots.some((x) => x.botId === botId);
    if (!exists) return false;
    this.overrides[botId] = { ...(this.overrides[botId] || {}), enabled };
    this.writeFile();
    this.logger.log('bot %s 启用态已设为 %s', botId, enabled);
    return true;
  }

  /** 写凭据分组绑定（ref 空串表示解除绑定）并落盘；botId 不存在返回 false。 */
  setCredentialsRef(botId: string, ref: string): boolean {
    const exists = BOT_MANIFEST.bots.some((x) => x.botId === botId);
    if (!exists) return false;
    // 空串表示显式解除绑定（对应前端「未绑定」选项）；存为空串而非 undefined，
    // 以区分「覆盖里已显式解绑」与「覆盖压根没碰过绑定（应回落编译默认）」。
    const refVal = ref && ref.trim() ? ref.trim() : '';
    this.overrides[botId] = { ...(this.overrides[botId] || {}), credentialsRef: refVal };
    this.writeFile();
    this.logger.log('bot %s 凭据绑定已设为 %s', botId, refVal || '(未绑定)');
    return true;
  }

  /** 合并后的展示名：覆盖优先，否则编译清单默认 displayName。 */
  getDisplayName(botId: string): string {
    const o = this.overrides[botId];
    if (o && typeof o.displayName === 'string' && o.displayName.trim()) return o.displayName.trim();
    const m = BOT_MANIFEST.bots.find((x) => x.botId === botId);
    return m ? m.displayName : botId;
  }

  /** 写展示名覆盖并落盘；botId 不存在返回 false。 */
  setDisplayName(botId: string, name: string): boolean {
    const exists = BOT_MANIFEST.bots.some((x) => x.botId === botId);
    if (!exists) return false;
    const n = name && name.trim() ? name.trim() : undefined;
    this.overrides[botId] = { ...(this.overrides[botId] || {}), displayName: n };
    this.writeFile();
    this.logger.log('bot %s 展示名已设为 %s', botId, n || '(默认)');
    return true;
  }

  /** 合并后的查询超时（秒）：实例单独设置优先，否则用内置安全默认。 */
  getQueryTimeout(botId: string): number {
    const o = this.overrides[botId];
    if (o && typeof o.queryTimeout === 'number' && o.queryTimeout > 0) return o.queryTimeout;
    return DEFAULT_QUERY_TIMEOUT;
  }

  /** 查询超时内置安全默认（秒），仅当实例未单独设置时使用。 */
  getDefaultQueryTimeout(): number {
    return DEFAULT_QUERY_TIMEOUT;
  }

  /** 写查询超时覆盖并落盘；botId 不存在或数值非法返回 false。 */
  setQueryTimeout(botId: string, sec: number): boolean {
    const exists = BOT_MANIFEST.bots.some((x) => x.botId === botId);
    if (!exists) return false;
    const v = Number(sec);
    if (!Number.isFinite(v) || v < 5 || v > 600) return false;
    this.overrides[botId] = { ...(this.overrides[botId] || {}), queryTimeout: Math.floor(v) };
    this.writeFile();
    this.logger.log('bot %s 查询超时已设为 %d 秒', botId, Math.floor(v));
    return true;
  }

  /** 合并编译清单与运行时覆盖，给出前端展示用的全部实例。 */
  listBots(): ManifestBot[] {
    return BOT_MANIFEST.bots.map((m) => ({
      ...m,
      enabled: this.getEnabled(m.botId),
      credentialsRef: this.getCredentialsRef(m.botId),
    }));
  }
}
