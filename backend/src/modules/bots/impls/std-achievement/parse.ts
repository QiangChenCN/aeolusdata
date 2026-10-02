/**
 * 从钉钉回调消息 content 中解析骑手查询字符串。
 *
 * 群聊 @机器人 时，钉钉投递的 text 里 @前缀用的是机器人显示名（如「数据查询」），
 * 而机器人内部名可能不同（如 test），因此不能写死匹配。
 * 做法：剥离开头所有 @词（可能连续 @机器人 又 @别人），取剩余文本作为查询。
 */
export function parseQuery(
  content: string | null | undefined,
  _botName = '数据查询',
): string | null {
  if (!content) return null;
  let text = content.trim();
  // 循环剥离开头所有 @词：@ 后跟非空白字符直到空白或结尾
  for (;;) {
    const m = /^@\s*(\S+)\s*([\s\S]*)$/.exec(text);
    if (m && m[1]) text = m[2];
    else break;
  }
  text = text.trim();
  return text || null;
}
