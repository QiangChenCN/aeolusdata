import { Injectable } from '@nestjs/common';
import { DWClient } from 'dingtalk-stream';
import { BotConfigService, CredentialGroup } from './bot-config.service';

/**
 * 钉钉 Stream 长连接客户端提供方（多凭据分组）。
 *
 * 取代原单组工厂：按凭据分组的 `id`（即 bot 的 `credentialsRef`）各自懒建 / 重建一个
 * 独立的 `DWClient`。凭据变化（前端保存后 reload）时 `invalidate()` 清缓存，下次按新
 * 签名重建。某分组凭据缺失 / 未启用时返回 null，网关据此不为该分组建连。
 */
@Injectable()
export class DingtalkClientProvider {
  private cache = new Map<string, { client: DWClient; sig: string }>();

  constructor(private readonly cfg: BotConfigService) {}

  /** 取某分组的真实凭据。 */
  getGroup(ref: string): CredentialGroup | null {
    return this.cfg.getGroup(ref);
  }

  /** 取某分组的 DWClient；凭据缺失 / 未启用返回 null。 */
  getClient(ref: string): DWClient | null {
    const g = this.cfg.getGroup(ref);
    if (!g || !g.enabled || !g.clientId || !g.secret) return null;
    const s = `${g.clientId}|${g.secret}`;
    const hit = this.cache.get(ref);
    if (hit && hit.sig === s) return hit.client;
    const client = new DWClient({ clientId: g.clientId, clientSecret: g.secret, debug: false });
    this.cache.set(ref, { client, sig: s });
    return client;
  }

  getClientId(ref: string): string {
    return this.cfg.getGroup(ref)?.clientId || '';
  }

  /** 所有「已启用且凭据完整」的分组 id（供网关决定建连）。 */
  availableRefs(): string[] {
    return this.cfg
      .listGroups()
      .filter((g) => g.enabled && g.hasSecret)
      .map((g) => g.id);
  }

  /** 凭据变化后让所有缓存失效（reload 时调用，旧连接由网关统一断开）。 */
  invalidate(): void {
    this.cache.clear();
  }
}
