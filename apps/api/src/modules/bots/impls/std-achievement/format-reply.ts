import { Standard } from './standards';
import { RiderQueryResult } from './rider-query.service';

export interface StandardResult {
  current: number;
  next: number | null;
  gap_orders: number;
  gap_hours: number;
  is_max: boolean;
}

/**
 * 根据有效单量 + 有效在线时长，返回该骑手当前达成的运力等级 + 距下一级的差距。
 * 等级 N 的单量阈值与时长阈值同时满足才算达成 N 级（取两者短板）。
 */
export function computeStandard(
  orders: number | null | undefined,
  hours: number | null | undefined,
  levels: Standard[],
): StandardResult | null {
  if (orders == null || hours == null) return null;
  if (!levels || !levels.length) return null;
  const o = Number(orders);
  const h = Number(hours);
  if (Number.isNaN(o) || Number.isNaN(h)) return null;
  let current = 0;
  for (const s of levels) {
    if (o >= s.orders && h >= s.hours) current = s.level;
  }
  const top = levels[levels.length - 1];
  if (current >= top.level) {
    return { current, next: null, gap_orders: 0, gap_hours: 0, is_max: true };
  }
  const nxt: Standard = levels[current]; // current=0 → 标准1
  const lo = current === 0 ? 0 : levels[current - 1].orders;
  const hi = nxt.orders;
  return {
    current,
    next: nxt.level,
    gap_orders: Math.max(0, nxt.orders - Math.floor(o)),
    gap_hours: Math.round(Math.max(0, nxt.hours - h) * 100) / 100,
    is_max: false,
  };
}

function riderHeader(data: RiderQueryResult): string {
  const name = data.rider_name || data.rider_id || '—';
  const kid = data.knight_id || '—';
  const site = data.team_name || '—';
  return `👤 骑手：**${name}**\n🆔 ID：${kid}\n🏠 站点：${site}`;
}

/**
 * 根据查询结果生成回复文本（markdown）。
 *
 * 卡片美化样式规则（钉钉 AI 卡片 markdown 能力边界内）：
 *  - 不渲染 --- 水平线与整行加粗 → 区块分隔用连续细线 ──────────────，强调只用行内加粗；
 *  - 区块固定顺序：身份 → 单量 → 时长 → 运力等级，区块标题格式「emoji + 加粗短语」；
 *  - 强调两级：结论指标（有效单量/有效时长/运力等级）加粗，过程指标不加粗；
 *  - 状态 emoji 语义化：✅ 有效 🏆 最高级 🔍 未查到 ⚠️ 出错；空值统一 —。
 */
export function formatReply(
  riderId: string,
  data: RiderQueryResult,
  withHeader = true,
  levels: Standard[],
): string {
  const status = data.status;
  if (status === 'ok') {
    const d = data.order_detail || {};
    const fmt = (v: unknown): unknown => (v == null ? '—' : v);
    const total = fmt(d.total_success);
    const reverse = fmt(d.reverse);
    const reassign = fmt(d.reassign);
    const valid = fmt(d.valid);
    const excluded = d.excluded_accept || 0;
    const online = fmt(data.online_duration_hours);
    const dur = fmt(data.valid_duration_hours);

    const excludedLine = excluded > 0 ? `• 非今日接单：${excluded} 单\n` : '';
    const separator = '\n\n──────────────\n\n';

    const header = withHeader ? riderHeader(data) + separator : '';

    const ordersBlock =
      `📊 **单量明细**\n` +
      `• 总配送成功：**${total}** 单\n` +
      excludedLine +
      `• 逆向单：${reverse} 单　• 改派单：${reassign} 单\n` +
      `✅ 最终有效单量：**${valid} 单**`;

    const durationBlock =
      `⏱ **在线时长**\n` +
      `• 在线总时长：${online} 小时\n` +
      `• 有效时长：**${dur} 小时**`;

    const std = computeStandard(d.valid as number, data.valid_duration_hours as number, levels);
    let stdBlock: string;
    if (std == null) {
      stdBlock = '🎯 运力等级：—（数据不全）';
    } else if (std.is_max) {
      stdBlock = `🏆 运力等级：**标准 ${std.current}**（已达最高级）`;
    } else {
      stdBlock =
        `🎯 **运力等级：标准 ${std.current}**\n` +
        `• 距下一级还差：${std.gap_orders} 单 / ${std.gap_hours} 小时`;
    }

    return header + ordersBlock + separator + durationBlock + separator + stdBlock;
  }
  if (status === 'ambiguous') {
    const input = (data.rider_id || '').trim();
    const list = (data.candidates || [])
      .map((c, i) => {
        const name = c.rider_name || '—';
        const kid = c.knight_id || '—';
        const site = c.team_name || '—';
        return `${i + 1}. 👤 **${name}**　🆔 ID：${kid}　🏠 站点：${site}`;
      })
      .join('\n');
    return (
      `🔍 有多名「${input}」，请选择要查询的骑手：\n` +
      `（直接回复序号 **1** / **2** … 即可查询）\n\n` +
      list
    );
  }
  if (status === 'not_found') {
    const extra = data.note ? `\n\n（系统提示：${data.note}）` : '';
    return `🔍 **未查到相关记录**\n请核对骑手姓名，或改用骑手ID查询。${extra}`;
  }
  if (status === 'empty') {
    return '💬 请 @我 并发送骑手姓名或ID\n例如：张三 / 608652258';
  }
  return `⚠️ **查询出错**：${data.note || '未知错误'}`;
}


