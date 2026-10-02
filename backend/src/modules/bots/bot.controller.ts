import { Body, Controller, Get, Post } from '@nestjs/common';
import { BotConfigService } from './bot-config.service';
import { BotRegistryService } from './bot-registry.service';
import { DingtalkStreamGateway } from './dingtalk/dingtalk-stream.gateway';

/**
 * 钉钉机器人配置端点（前端「机器人配置」独立菜单调用）。
 * 路由→权限由 AccessGuard 按 permissions.ts 自动裁决（admin:bot）。
 */
@Controller('api')
export class BotController {
  constructor(
    private readonly cfg: BotConfigService,
    private readonly gateway: DingtalkStreamGateway,
    private readonly registry: BotRegistryService,
  ) {}

  /** 读取脱敏后的全局开关配置（AI 打字 / 超时 / 总开关）。 */
  @Get('bot/config')
  getConfig() {
    return { ok: true, config: this.cfg.getConfig() };
  }

  /** 机器人实例清单 + 各凭据分组连接状态（独立菜单「实例与状态」区）。 */
  @Get('bot/status')
  botStatus() {
    const connections = this.gateway.listConnections();
    return {
      ok: true,
      gatewayConnected: connections.some((c) => c.connected),
      botEnabled: this.cfg.isBotEnabled(),
      connections,
      bots: this.registry.listStatus(),
    };
  }

  /** 保存全局开关并热重载 Stream 长连接（凭据变化即时生效）。 */
  @Post('bot/config')
  async saveConfig(@Body() b: Record<string, any>) {
    const config = this.cfg.saveConfig({
      aiCardTyping: b?.aiCardTyping,
      dingbotQueryTimeout: b?.dingbotQueryTimeout,
      botEnabled: b?.botEnabled,
    });
    const reload = await this.gateway.reload();
    return { ok: true, config, reload };
  }

  /** 凭据分组列表（脱敏，secret 不外泄）。 */
  @Get('bot/credentials')
  getCredentials() {
    return { ok: true, groups: this.cfg.listGroups() };
  }

  /** 保存凭据分组（整体替换；secret 留空表示不修改）。保存后热重载连接。 */
  @Post('bot/credentials')
  async saveCredentials(@Body() b: Record<string, any>) {
    try {
      const groups = this.cfg.saveGroups(b?.groups || []);
      const reload = await this.gateway.reload();
      return { ok: true, groups, reload };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 仅重新连接 Stream（不动配置）。 */
  @Post('bot/reload')
  async reload() {
    return { ok: true, reload: await this.gateway.reload() };
  }

  /**
   * 单个机器人实例配置：在线启停（enabled）与凭据分组绑定（credentialsRef）。
   * 仅改 enabled 不需重连；改 credentialsRef 需重建连接（自动 reload）。
   */
  @Post('bot/bots')
  async setBot(@Body() b: { botId?: string; enabled?: boolean; credentialsRef?: string }) {
    if (!b?.botId) return { ok: false, error: 'botId 必填' };
    let needReload = false;
    if (typeof b.enabled === 'boolean') {
      if (!this.registry.setEnabled(b.botId, b.enabled)) {
        return { ok: false, error: '未知 botId: ' + b.botId };
      }
    }
    if (typeof b.credentialsRef === 'string') {
      if (!this.registry.setCredentialsRef(b.botId, b.credentialsRef)) {
        return { ok: false, error: '凭据绑定失败（botId 不存在）' };
      }
      needReload = true;
    }
    const reload = needReload ? await this.gateway.reload() : null;
    return { ok: true, bots: this.registry.listStatus(), reload };
  }
}
