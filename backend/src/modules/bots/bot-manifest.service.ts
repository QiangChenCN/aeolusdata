import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { BOT_MANIFEST, ManifestBot } from './bots.manifest';

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
  private overrides: Record<string, { enabled?: boolean; credentialsRef?: string }> = {};

  constructor(private readonly nest: NestConfigService) {
    const root = path.resolve(
      this.nest.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.file = path.join(root, 'bot_manifest.json');
    this.overrides = this.readFile();
  }

  private readFile(): Record<string, { enabled?: boolean; credentialsRef?: string }> {
    try {
      const obj = JSON.parse(fs.readFileSync(this.file, 'utf-8')) || {};
      const raw = (obj.overrides && typeof obj.overrides === 'object' ? obj.overrides : {}) as Record<
        string,
        unknown
      >;
      const out: Record<string, { enabled?: boolean; credentialsRef?: string }> = {};
      for (const [k, v] of Object.entries(raw)) {
        // 兼容旧版 { [botId]: boolean } 写法
        if (typeof v === 'boolean') out[k] = { enabled: v };
        else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          out[k] = {
            enabled: typeof o.enabled === 'boolean' ? o.enabled : undefined,
            credentialsRef: typeof o.credentialsRef === 'string' ? o.credentialsRef : undefined,
          };
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

  /** 合并后的凭据分组绑定：覆盖优先，否则编译默认值（可为 undefined = 未绑定）。 */
  getCredentialsRef(botId: string): string | undefined {
    const o = this.overrides[botId];
    if (o && typeof o.credentialsRef === 'string') return o.credentialsRef;
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
    const refVal = ref && ref.trim() ? ref.trim() : undefined;
    this.overrides[botId] = { ...(this.overrides[botId] || {}), credentialsRef: refVal };
    this.writeFile();
    this.logger.log('bot %s 凭据绑定已设为 %s', botId, refVal || '(未绑定)');
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
