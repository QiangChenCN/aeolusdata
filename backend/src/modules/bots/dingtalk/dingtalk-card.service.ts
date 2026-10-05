import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { DWClient } from 'dingtalk-stream';

/**
 * 钉钉 AI 互动卡片服务（纯 Node 复刻 `dingtalk_stream` 的 `AICardReplier` 协议）。
 *
 * 关键约定（对齐官方 Python SDK 与可工作的 Node 实现）：
 *  - 模板 ID：`382e4302-551d-4880-bf29-a30acfab2e71.schema`，流式内容键 `msgContent`。
 *  - 创建：`POST /v1.0/card/instances` + `POST /v1.0/card/instances/deliver`。
 *  - 流式打字：`PUT /v1.0/card/streaming`，请求体用 `outTrackId` = **服务器返回的 cardInstanceId**
 *    （create 响应的 `result` 字段），不是自生成的 outTrackId，也不另带 cardInstanceId 字段。
 *  - 终态：`PUT /v1.0/card/instances`。
 *  - `cardParamMap` 必须带 `sys_full_json_obj: JSON.stringify({ order: ['msgContent'] })`，
 *    否则模板不知道把哪个变量渲染为正文 → 卡片空白。
 *
 * 多连接网关下，卡片投放所需的 accessToken 必须取自**对应凭据分组**的 `DWClient`。
 */

const CARD_TEMPLATE_ID = '382e4302-551d-4880-bf29-a30acfab2e71.schema';
const OPENAPI = 'https://api.dingtalk.com/v1.0';
const STREAMING_KEY = 'msgContent';
const FULL_JSON_OBJ = JSON.stringify({ order: [STREAMING_KEY] });

/** AI Card 状态（对齐官方 AICardStatus）。 */
const AICardStatus = {
  PROCESSING: '1',
  INPUTING: '2',
  FINISHED: '3',
};

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

  /** 与 Python `gen_card_id` 对齐：因子串 SHA256 作为 outTrackId（创建用的业务幂等键）。 */
  private genCardId(ctx: AiCardContext): string {
    const factor = `${ctx.senderId}_${ctx.senderCorpId}_${ctx.conversationId}_${ctx.msgId}_${crypto.randomUUID()}`;
    return crypto.createHash('sha256').update(factor, 'utf-8').digest('hex');
  }

  private async post(url: string, body: unknown, token: string): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    const t = await res.text().catch(() => '');
    this.logger.warn(`[card-resp] POST ${url} -> ${res.status} ${t.slice(0, 400)}`);
    if (!res.ok) {
      throw new Error(`card POST ${url} -> ${res.status}: ${t.slice(0, 300)}`);
    }
    return t;
  }

  private async put(url: string, body: unknown, token: string): Promise<string> {
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    const t = await res.text().catch(() => '');
    this.logger.warn(`[card-resp] PUT ${url} -> ${res.status} ${t.slice(0, 400)}`);
    if (!res.ok) {
      throw new Error(`card PUT ${url} -> ${res.status}: ${t.slice(0, 300)}`);
    }
    return t;
  }

  /**
   * 创建并投放 AI 卡片（PROCESSING 态 + 加载文案），返回业务 outTrackId 与服务器 cardInstanceId。
   * 任一步失败抛错，由调用方降级到 webhook markdown。
   */
  async create(ctx: AiCardContext, client: DWClient, loadingTitle: string, loadingText: string): Promise<{ outTrackId: string; cardInstanceId: string }> {
    const token = await this.token(client);
    const outTrackId = this.genCardId(ctx);
    const robotCode = ctx.robotCode || '';
    const paramMap = {
      flowStatus: AICardStatus.PROCESSING,
      msgTitle: loadingTitle,
      msgContent: loadingText,
      staticMsgContent: '',
      sys_full_json_obj: FULL_JSON_OBJ,
    };

    // 步骤 1：创建卡片实例
    const createBody = await this.post(
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

    // 解析服务器返回的 cardInstanceId（= create 响应的 result 字段）；后续流式/终态以其为 outTrackId。
    let cardInstanceId = '';
    try {
      const j = JSON.parse(createBody);
      cardInstanceId = j.cardInstanceId || j.result || '';
    } catch {
      /* ignore */
    }

    // 步骤 2：投放到会话（robotCode 来自入站消息，确保使用正确机器人的空间）
    const deliver: Record<string, unknown> = { outTrackId, userIdType: 1 };
    if (ctx.conversationType === '1') {
      deliver.openSpaceId = `dtv1.card//IM_ROBOT.${ctx.senderId}`;
      deliver.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT' };
    } else {
      deliver.openSpaceId = `dtv1.card//IM_GROUP.${ctx.conversationId}`;
      deliver.imGroupOpenDeliverModel = { robotCode };
    }
    await this.post(`${OPENAPI}/card/instances/deliver`, deliver, token);

    this.logger.log('AI 卡片已创建并投放 outTrackId=%s instanceId=%s', outTrackId, cardInstanceId);
    return { outTrackId, cardInstanceId };
  }

  /** 单次流式推送（outTrackId = 服务器 cardInstanceId）。 */
  private async stream(cardInstanceId: string, client: DWClient, content: string, opts: { isFinalize?: boolean; isError?: boolean } = {}): Promise<void> {
    const token = await this.token(client);
    await this.put(
      `${OPENAPI}/card/streaming`,
      {
        outTrackId: cardInstanceId,
        guid: crypto.randomUUID(),
        key: STREAMING_KEY,
        content,
        isFull: true,
        isFinalize: opts.isFinalize ?? false,
        isError: opts.isError ?? false,
      },
      token,
    );
  }

  /** 流式前先切到 INPUTING 态（对齐可工作实现，带 sys_full_json_obj 让模板开始渲染 msgContent）。 */
  private async switchToInputing(cardInstanceId: string, client: DWClient): Promise<void> {
    const token = await this.token(client);
    await this.put(
      `${OPENAPI}/card/instances`,
      {
        outTrackId: cardInstanceId,
        cardData: {
          cardParamMap: {
            flowStatus: AICardStatus.INPUTING,
            msgContent: '',
            staticMsgContent: '',
            sys_full_json_obj: FULL_JSON_OBJ,
          },
        },
      },
      token,
    );
  }

  /**
   * 逐字打字：先切 INPUTING 态，再把 full 内容分片流式推送（isFull=true 全量替换 → 前缀递增形成
   * 打字机动画）。所有分片 isFinalize=false，最终定稿帧由 `finish` 发送。
   *  - 自适应：目标约 50 帧、帧间隔 25ms，长内容自动加大每帧字符数；
   *  - 按 Array.from 码点切分，不截断 emoji 等代理对；
   *  - 不把加粗标记 ** 切在中间，避免打字过程闪现裸 *。
   */
  async streamTyping(cardInstanceId: string, client: DWClient, full: string, opts: { isError?: boolean } = {}): Promise<void> {
    await this.switchToInputing(cardInstanceId, client);

    const chars = Array.from(full);
    const total = chars.length;
    if (total <= 24) {
      // 短内容直接一帧（finish 会再发最终定稿帧），这里先铺一层便于打字观感
      await this.stream(cardInstanceId, client, full, { isFinalize: false, isError: opts.isError });
      return;
    }
    const step = Math.min(60, Math.max(10, Math.ceil(total / 50)));
    const delayMs = 25;
    let done = 0;
    while (done < total) {
      let end = Math.min(done + step, total);
      if (end < total && chars[end - 1] === '*' && chars[end] === '*') end -= 1;
      done = end;
      await this.stream(cardInstanceId, client, chars.slice(0, done).join(''), {
        isFinalize: false,
        isError: opts.isError,
      });
      if (done < total) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  /** 终态落定：发最终定稿帧（isFinalize=true）+ 切 FINISHED 态（带 sys_full_json_obj，正文来自 msgContent）。 */
  async finish(cardInstanceId: string, client: DWClient, title: string, content: string): Promise<void> {
    // 1. 用最终内容关闭流式通道
    await this.stream(cardInstanceId, client, content, { isFinalize: true });

    // 2. 更新卡片状态为 FINISHED
    const token = await this.token(client);
    await this.put(
      `${OPENAPI}/card/instances`,
      {
        outTrackId: cardInstanceId,
        cardData: {
          cardParamMap: {
            flowStatus: AICardStatus.FINISHED,
            msgTitle: title,
            msgContent: content,
            staticMsgContent: '',
            sys_full_json_obj: FULL_JSON_OBJ,
          },
        },
      },
      token,
    );
  }
}
