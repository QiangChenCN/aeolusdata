import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 钉钉机器人连接配置（原仅 .env 的 DING_CLIENT_ID / DING_CLIENT_SECRET）。
 *
 * 现升级为多「凭据分组」：管理员可在前端「机器人配置 → 凭据分组」直接维护多组
 * 钉钉应用凭据（clientId/secret），每个 bot 实例通过 `credentialsRef` 绑定其中一组，
 * 运行时按分组各自建立独立的 Stream 长连接（多连接网关）。落盘到
 * `<PROJECT_ROOT>/apps/api/runtime/bot_config.json`（不进 git，便于部署覆盖）。
 *
 *  - 读取：`listGroups()` 脱敏列表（secret 永不外泄，仅给 hasSecret 标记）；
 *    `getGroup(id)` 供运行时取真实凭据；老的单组字段（dingClientId/secret）自动迁移为
 *    `dingtalk:default` 分组，保证历史部署向后兼容。
 *  - 写入：`saveGroups()` 原子写盘；secret 留空表示「不修改」原有值；id 必填且唯一。
 *  - 全局开关（不按分组）：botEnabled（总开关）。查询超时改为按机器人实例单独设置，
 *    不再有全局默认。
 */

/** 一组钉钉应用凭据（含明文 secret，仅落盘/内存，对外脱敏）。 */
export interface CredentialGroup {
  id: string;
  label: string;
  clientId: string;
  secret: string;
  enabled: boolean;
  /** AI 卡片打字效果（按凭据分组控制；缺省视为开）。 */
  aiCardTyping?: boolean;
  /** 渠道类型：钉钉(dingtalk) / 企微(wecom) 等，便于以后扩展非钉钉推送渠道。 */
  type?: string;
}

interface BotConfigFile {
  credentials?: CredentialGroup[];
  // 以下为历史单组字段，读取时迁移为 dingtalk:default，saveGroups 时清掉
  dingClientId?: string;
  dingClientSecret?: string;
  botEnabled?: boolean;
}

@Injectable()
export class BotConfigService {
  private readonly logger = new Logger(BotConfigService.name);
  private readonly file: string;

  constructor(private readonly nest: NestConfigService) {
    const root = path.resolve(
      this.nest.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.file = path.join(root, 'apps', 'api', 'runtime', 'bot_config.json');
  }

  private readFile(): BotConfigFile {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf-8')) || {};
    } catch {
      return {};
    }
  }
  private writeFile(obj: BotConfigFile): void {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  /** 归一化凭据分组：优先用文件里的 credentials 数组；否则把老单组字段迁成 default 组。 */
  private readGroups(): CredentialGroup[] {
    const f = this.readFile();
    if (Array.isArray(f.credentials) && f.credentials.length) {
      return f.credentials.filter((g) => g && typeof g.id === 'string');
    }
    if (f.dingClientId || f.dingClientSecret) {
      return [
        {
          id: 'dingtalk:default',
          label: '默认',
          clientId: f.dingClientId || '',
          secret: f.dingClientSecret || '',
          enabled: true,
          type: 'dingtalk',
        },
      ];
    }
    // 文件无凭据时，回落读取 .env 的 DING_CLIENT_ID / DING_CLIENT_SECRET（兼容旧部署约定）。
    // 旧版 Python dingbot 凭据全在 .env，若只迁移了代码而没在前端配置 bot_config.json，
    // 这里能保证机器人依旧可用，避免出现「配置了却不连」的静默失败。
    const envId = (this.nest.get<string>('DING_CLIENT_ID') || '').trim();
    const envSecret = (this.nest.get<string>('DING_CLIENT_SECRET') || '').trim();
    if (envId || envSecret) {
      return [
        {
          id: 'dingtalk:default',
          label: '默认（来自 .env）',
          clientId: envId,
          secret: envSecret,
          enabled: true,
          type: 'dingtalk',
        },
      ];
    }
    return [];
  }

  /** 脱敏后的凭据分组列表（前端展示，secret 不外泄）。 */
  listGroups(): { id: string; label: string; clientId: string; hasSecret: boolean; enabled: boolean; aiCardTyping: boolean; type: string }[] {
    return this.readGroups().map((g) => ({
      id: g.id,
      label: g.label,
      clientId: g.clientId,
      hasSecret: !!g.secret,
      enabled: g.enabled,
      aiCardTyping: g.aiCardTyping !== false,
      type: g.type || '',
    }));
  }

  /** 运行时真实凭据（按分组 id）；不存在返回 null。 */
  getGroup(id: string): CredentialGroup | null {
    return this.readGroups().find((g) => g.id === id) || null;
  }

  /**
   * 保存凭据分组（整体替换）。校验 id 非空且唯一；secret 留空表示该组沿用旧 secret。
   * 非法输入抛错，由调用方捕获为 {ok:false, error}。
   */
  saveGroups(
    input: { id?: unknown; label?: unknown; clientId?: unknown; secret?: unknown; enabled?: unknown; aiCardTyping?: unknown; type?: unknown }[],
  ): { id: string; label: string; clientId: string; hasSecret: boolean; enabled: boolean; aiCardTyping: boolean; type: string }[] {
    const groups: CredentialGroup[] = [];
    const seen = new Set<string>();
    const existing = this.readGroups();
    for (const g of input || []) {
      const id = typeof g.id === 'string' ? g.id.trim() : '';
      if (!id) throw new Error('凭据分组 id 不能为空');
      if (seen.has(id)) throw new Error('凭据分组 id 重复: ' + id);
      seen.add(id);
      const label = typeof g.label === 'string' && g.label.trim() ? g.label.trim() : id;
      const clientId = typeof g.clientId === 'string' ? g.clientId.trim() : '';
      const secretInput = typeof g.secret === 'string' ? g.secret : '';
      const enabled = g.enabled !== false;
      const aiCardTyping = g.aiCardTyping !== false;
      const type = typeof g.type === 'string' && g.type.trim() ? g.type.trim() : '';
      // secret 留空 → 沿用同 id 旧组的 secret
      const old = existing.find((x) => x.id === id);
      const secret = secretInput.length ? secretInput : (old?.secret || '');
      groups.push({ id, label, clientId, secret, enabled, aiCardTyping, type });
    }
    const f = this.readFile();
    f.credentials = groups;
    delete f.dingClientId;
    delete f.dingClientSecret;
    this.writeFile(f);
    this.logger.log('凭据分组已保存，共 %d 组', groups.length);
    return this.listGroups();
  }

  /** 向后兼容：返回 default 组或第一个「已启用且完整」的组（单组旧逻辑使用）。 */
  getCredentials(): { clientId: string; clientSecret: string } {
    const groups = this.readGroups();
    const g =
      groups.find((x) => x.id === 'dingtalk:default') ||
      groups.find((x) => x.enabled && x.clientId && x.secret) ||
      groups[0];
    if (!g) return { clientId: '', clientSecret: '' };
    return { clientId: g.clientId, clientSecret: g.secret };
  }

  /**
   * AI 卡片打字效果：按凭据分组（ref）读取；分组未显式设置时回落默认「开」。
   * 不再使用全局打字开关——打字是「每个机器人(应用)的回复表现」，跟随连接(ref)生效。
   * @param ref 凭据分组 id；缺省返回默认（开）。
   */
  isTypingEnabled(ref?: string): boolean {
    if (ref) {
      const g = this.getGroup(ref);
      if (g) return g.aiCardTyping !== false;
    }
    return true; // 默认开
  }
  isBotEnabled(): boolean {
    const f = this.readFile();
    if (typeof f.botEnabled === 'boolean') return f.botEnabled;
    return true; // 默认开
  }

  /** 全局开关脱敏快照（前端「全局配置」卡片）。查询超时已移至按实例设置。 */
  getConfig(): Record<string, unknown> {
    return {
      botEnabled: this.isBotEnabled(),
      groupCount: this.listGroups().length,
    };
  }

  /** 保存全局开关（仅总开关；凭据走 saveGroups，查询超时按实例设置）。返回脱敏快照。 */
  saveConfig(patch: {
    botEnabled?: unknown;
  }): Record<string, unknown> {
    const f = this.readFile();
    if (typeof patch.botEnabled === 'boolean') f.botEnabled = patch.botEnabled;
    this.writeFile(f);
    this.logger.log('机器人全局开关已保存');
    return this.getConfig();
  }
}
