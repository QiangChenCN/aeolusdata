// 骑手看板筛选纯函数：被 StandardView 的 computed 与单元测试共同复用，保证「逻辑即被验证的逻辑」。
//
// 在线状态口径（与 python/analytics/rider_dimension.py 的 _status_label 一致）：
//   workStatus == 3 -> "下线"；== 2 -> "小休"；其余（含 null）-> "在线"。
// 因此这里直接按展示文案 online_status 过滤，与「在线状态」列完全对应，
// 避免出现「列里显示在线、却筛不出来」的割裂。
// 注：数据侧 online_status 恒为 在线/小休/下线 三值之一（_status_label 不返回空），
//     故无需单独的「未知」选项。

/**
 * 按 姓名 / 达成标准 / 在线状态 过滤骑手行。
 * @param {Array} rows 骑手原始行（含 rider_name / achieved_standard / online_status）
 * @param {{name?:string, std?:string, online?:string}} f
 * @returns {Array}
 */
export function filterRiders(rows, { name = '', std = '', online = '' } = {}) {
  const f = (name || '').trim();
  const s = std || '';
  const o = (online || '').trim();
  return (rows || []).filter((r) => {
    if (f && !(r.rider_name || '').includes(f)) return false;
    if (s && r.achieved_standard !== s) return false;
    if (o && (r.online_status || '') !== o) return false;
    return true;
  });
}
