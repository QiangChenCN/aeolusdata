import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { DWClient } from 'dingtalk-stream';

/**
 * 钉钉 AI 互动卡片服务（纯 Node 复刻 Python `dingtalk_stream` 的 `AIMarkdownCardInstance`）。
 *
 * 背景：Node 版 `dingtalk-stream` 任何版本都只有低层 `DWClient`，没有 Python 那套
 * `AIMarkdownCardInstance` 卡片打字助手。本服务按 `card_replier.py` 的精确协议直连钉钉卡片
 * OpenAPI，还原「查询中」加载态 + 逐字打字 + 终态改标题：
 *  - 创建+投放：`POST /v1.0/card/instances` + `POST /v1.0/card/instances/deliver`
 *  - 流式打字：`PUT  /v1.0/card/streaming`
 *  - 终态落定：`PUT  /v1.0/card/instances`
 *
 * 多连接网关下，卡片投放所需的 accessToken 必须取自**对应凭据分组**的 `DWClient`（不同
 * 应用的机器人要用自己的 token，否则 robotCode 不匹配 / 无权限）。因此所有方法接收调用方
 * 按 `credentialsRef` 选定的 `client`，不再持有全局 provider。
 */

const CARD_TEMPLATE_ID = '382e4302-551d-4880-bf29-a30acfab2e71.schema';
const OPENAPI = 'https://api.dingtalk.com/v1.0';
// AICardStatus：PROCESSING=1 / INPUTING=2 / FINISHED=3 / EXECUTING=4 / FAILED=5
const FLOW_PROCESSING = 1;

/** 投放卡片所需的会话上下文（取自入站机器人消息）。 */
export interface AiCardContext {
  conversationId: string;
  /** '2' 群聊，'1' 单聊 */
  conversationType: string;
  senderId: string;
  senderCorpId: string;
  msgId: string;
  robotCode: string;
}

@Injectable()
export class DingtalkAiCardService {
  private readonly logger = new Logger(DingtalkAiCardService.name);

  private async token(client: DWClient): Promise<string> {
    return client.getAccessToken();
  }

  private headers(token: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-acs-dingtalk-access-token': String(token),
    };
  }

  /** 与 Python `gen_card_id` 对齐：因子串 SHA256 作为 outTrackId（= 卡片实例 ID）。 */
  private genCardId(ctx: AiCardContext): string {
    const factor = `${ctx.senderId}_${ctx.senderCorpId}_${ctx.conversationId}_${ctx.msgId}_${crypto.randomUUID()}`;
    return crypto.createHash('sha256').update(factor, 'utf-8').digest('hex');
  }

  /** 组装 cardParamMap 并补上 sys_full_json_obj（模板渲染顺序）。 */
  private cardData(paramMap: Record<string, unknown>): Record<string, unknown> {
    const sys = { order: ['msgTitle', 'msgContent', 'staticMsgContent'] };
    return { ...paramMap, sys_full_json_obj: JSON.stringify(sys) };
  }

  private async post(url: string, body: unknown, token: string): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`card POST ${url} -> ${res.status}: ${t.slice(0, 300)}`);
    }
  }

  private async put(url: string, body: unknown, token: string): Promise<void> {
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`card PUT ${url} -> ${res.status}: ${t.slice(0, 300)}`);
    }
  }

  /**
   * 创建并投放 AI 卡片（PROCESSING 态 + 加载文案），返回 outTrackId。
   * 任一步失败抛错，由调用方降级到 webhook markdown。
   * 群聊投放必须使用消息自带的 `ctx.robotCode`（对应凭据分组的机器人）。
   */
  async create(ctx: AiCardContext, client: DWClient, loadingTitle: string, loadingText: string): Promise<string> {
    const token = await this.token(client);
    const outTrackId = this.genCardId(ctx);
    const paramMap = this.cardData({
      msgTitle: loadingTitle,
      msgContent: loadingText,
      staticMsgContent: '',
      flowStatus: FLOW_PROCESSING,
    });

    // 步骤 1：创建卡片实例
    await this.post(
      `${OPENAPI}/card/instances`,
      {
        cardTemplateId: CARD_TEMPLATE_ID,
        outTrackId,
        cardData: { cardParamMap: paramMap },
        callbackType: 'STREAM',
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
      },
      token,
    );

    // 步骤 2：投放到会话（robotCode 来自入站消息，确保使用正确机器人的空间）
    const deliver: Record<string, unknown> = { outTrackId, userIdType: 1 };
    const robotCode = ctx.robotCode || '';
    if (ctx.conversationType === '1') {
      deliver.openSpaceId = `dtv1.card//IM_ROBOT.${ctx.senderId}`;
      deliver.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT' };
    } else {
      deliver.openSpaceId = `dtv1.card//IM_GROUP.${ctx.conversationId}`;
      deliver.imGroupOpenDeliverModel = { robotCode };
    }
    await this.post(`${OPENAPI}/card/instances/deliver`, deliver, token);

    this.logger.log('AI 卡片已创建并投放 outTrackId=%s', outTrackId);
    return outTrackId;
  }

  /** 单次流式推送（对齐 Python `streaming`）。 */
  async stream(
    outTrackId: string,
    client: DWClient,
    content: string,
    opts: { isFinalize?: boolean; isError?: boolean } = {},
  ): Promise<void> {
    const token = await this.token(client);
    await this.put(
      `${OPENAPI}/card/streaming`,
      {
        outTrackId,
        guid: crypto.randomUUID(),
        key: 'msgContent',
        content,
        isFull: true,
        isFinalize: opts.isFinalize ?? false,
        isError: opts.isError ?? false,
      },
      token,
    );
  }

  /**
   * 逐字打字：把 full 内容分片流式推送（isFull=true 全量替换 → 前缀递增形成打字机动画），
   * 最后一帧 isFinalize=true 收尾。
   */
  async streamTyping(outTrackId: string, client: DWClient, full: string, opts: { isError?: boolean } = {}): Promise<void> {
    const step = 30;
    const delayMs = 25;
    if (full.length <= step) {
      await this.stream(outTrackId, client, full, { isFinalize: true, isError: opts.isError });
      return;
    }
    for (let i = step; i < full.length; i += step) {
      await this.stream(outTrackId, client, full.slice(0, i), { isFinalize: false, isError: opts.isError });
      await new Promise((r) => setTimeout(r, delayMs));
    }
    await this.stream(outTrackId, client, full, { isFinalize: true, isError: opts.isError });
  }

  /** 终态落定：改标题 + 定稿内容（对齐 Python `update`/`finish`）。staticMsgContent 恒空，避免重复渲染。 */
  async finish(outTrackId: string, client: DWClient, title: string, content: string): Promise<void> {
    const token = await this.token(client);
    await this.put(
      `${OPENAPI}/card/instances`,
      {
        outTrackId,
        cardData: {
          cardParamMap: this.cardData({
            msgTitle: title,
            msgContent: content,
            staticMsgContent: '',
          }),
        },
      },
      token,
    );
  }
}
