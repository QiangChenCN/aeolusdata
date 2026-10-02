/** 机器人平台通用契约（与具体渠道无关）。 */

/** 多 bot 注册令牌：每个 bot 以 `useClass` + `multi: true` 注入此令牌的数组。 */
export const BOTS = Symbol('BOTS');

/** 经网关归一后的入站消息（屏蔽渠道差异）。 */
export interface IncomingMessage {
  /** 已剥离 @前缀的纯查询文本 */
  rawText: string;
  /** 会话 ID（群/单聊） */
  conversationId: string;
  /** 消息 ID，用于 ack */
  msgId: string;
  /** 发送者昵称 */
  senderNick: string;
  /** 发送者 staffId（@ 用） */
  senderStaffId: string;
  /** Stream 回执 webhook：Stream 原生回复通道，不走 dws */
  sessionWebhook: string;
  /** 机器人 robotCode，用于按 bot 路由 */
  robotCode: string;
  /** 消息类型，如 text */
  msgtype: string;
  /** 群/单聊：'2' 群聊，'1' 单聊（卡片投放用） */
  conversationType?: string;
  /** 发送者 open id（卡片 outTrackId 生成用） */
  senderId?: string;
  /** 发送者企业 id */
  senderCorpId?: string;
}

/** bot 给出的回复（由网关负责实际发送，bot 不感知渠道）。 */
export interface BotReply {
  kind: 'text' | 'markdown';
  content: string;
  /** AI 卡片终态标题；缺省「查询结果」 */
  title?: string;
  /** 终态类别，用于卡片标题与降级文案 */
  state?: 'ok' | 'timeout' | 'error';
}

export interface BotCheckResult {
  ok: boolean;
  detail?: string;
}

/** 所有 bot 必须实现的契约。 */
export interface Bot {
  readonly botId: string;
  readonly type: string;
  readonly displayName: string;
  /** 启动前/健康检查：配置是否齐备。 */
  check(): Promise<BotCheckResult>;
  /** 自测诊断：返回可用于排障的快照。 */
  diag(): Promise<Record<string, unknown>>;
  /** 处理一条入站消息，返回回复（或 void 表示无需回复）。 */
  onMessage(msg: IncomingMessage): Promise<BotReply | void>;
}
