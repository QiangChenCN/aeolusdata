// 配送超时看板私有：数值格式化与着色（不与其他看板共享 —— 同名字段在不同看板可能有不同展示口径）。
export function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export function fmtRate(v) {
  return v == null ? '—' : v + '%';
}

export function fmtMin(v) {
  return v == null ? '—' : v;
}

/** 秒 → 分钟（到店 / 等餐 / 配送时长展示）。 */
export function fmtSecToMin(v) {
  if (v == null) return '—';
  const m = v / 60;
  return Number.isInteger(m) ? m : Math.round(m * 10) / 10;
}

/** 越高越好的比率着色（准时率）。 */
export function rateClsUp(v) {
  if (v == null) return 'is-none';
  if (v >= 95) return 'is-ok';
  if (v >= 90) return 'is-warn';
  return 'is-bad';
}

/** 严重度着色：8-15 较轻、15-30 偏重、≥30 严重。 */
export function sevCls(s) {
  if (s === '>=30') return 'sev--heavy';
  if (s === '15-30') return 'sev--mid';
  return 'sev--light';
}

export function sevText(s) {
  if (s === '>=30') return '≥30分';
  if (s === '15-30') return '15-30分';
  return '8-15分';
}

/** 数值列排序：null 永远排最后。 */
export function numSort(key) {
  return (a, b) => {
    const va = a[key];
    const vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}
