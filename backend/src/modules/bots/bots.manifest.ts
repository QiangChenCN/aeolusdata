/** bot 注册清单（清单驱动启用/路由；不写死任何 bot 实例）。 */

export interface ManifestBot {
  botId: string;
  type: string;
  displayName: string;
  enabled: boolean;
  /** 凭据引用，指向平台集中管理的密钥分组；缺省（不写）即「未绑定」，需在前端「实例绑定」中手动选择。 */
  credentialsRef?: string;
}

export interface BotManifest {
  bots: ManifestBot[];
}

export const BOT_MANIFEST: BotManifest = {
  bots: [
    {
      botId: 'std-achievement',
      type: 'dingtalk',
      displayName: '运力达成查询',
      enabled: true,
    },
  ],
};
