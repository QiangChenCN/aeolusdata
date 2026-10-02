/**
 * 通知相关业务配置（移植自 common/ding_common.py，单一事实来源）。
 *
 * 迁到 Nest 的原因：@人 / 站点映射 / 目标群原本散在 Python 脚本常量里，
 * 迁移后所有任务共用此表，避免多处真相。
 */

/** 生产目标群（群名，由 dingtalk 模块按名解析 openConversationId）。 */
export const PRODUCTION_GROUP_NAME = '站点日常管理通知群';

/** 发送时禁止 @ 的人员（仍保留在 MANAGER_OPENID 中用于其它用途，仅从 @ 名单剔除）。 */
export const DO_NOT_AT = new Set(['裴笑天', '陈强']);

/** 站长 openDingTalkId（唯一来源，单点维护）。 */
export const MANAGER_OPENID: Record<string, string> = {
  印立澳: 'DPfqe5kgpkHx7AXNrf7BrKGrxqcvKvxSd',
  黄志兵: 'DPfqe5kgpkHwYiSpjMUkVyV61DO1Mrjbsy',
  陈冬冬: 'DPfqe5kgpkHzNdAcGHhJxfeqUVOX9yXkT',
  黄山山: 'DPfqe5kgpkHyd91NTC90G2IiSxB0RkiivpA',
  薛再: 'DPfqe5kgpkHyYiisIOCs5WscmzrIDCGJDd',
  朱星林: 'DPfqe5kgpkHzIRNj5mq36BbDKbd0yzdGv',
  房志才: 'DPfqe5kgpkHxKyooghHBVTfeWdOFyxXfd', // 钉钉显示名
  房铭瑞: 'DPfqe5kgpkHxKyooghHBVTfeWdOFyxXfd', // 风神旧写法
  房瑞铭: 'DPfqe5kgpkHxKyooghHBVTfeWdOFyxXfd', // 2026-09-01 起改名后的写法
  // 以下为任务执行人解析补充（非站点站长）
  陈强: 'DPfqe5kgpkHxba3uvPNyVEysCiiDE1gleG',
  裴笑天: 'DPfqe5kgpkHxkxs0mCRvvELW9k9ApiSgRH',
};

/** 去重保序的全部站长 id（供「@全部站长」场景）；已剔除 DO_NOT_AT。 */
export const ALL_MANAGER_IDS: string[] = [
  ...new Set(Object.entries(MANAGER_OPENID).filter(([k]) => !DO_NOT_AT.has(k)).map(([, v]) => v)),
];

/** 团队名称(风神/CSV) -> 站点简称。 */
export const TEAM_TO_STATION: Record<string, string> = {
  '东莞市黄江镇站-UB': '黄江',
  '东莞市长安万科站-UB': '万科',
  '东莞市大岭山大学城站-UB': '大岭山大学城',
};

/** 站点简称 -> 站长姓名列表。 */
export const STATION_MANAGERS: Record<string, string[]> = {
  黄江: ['印立澳', '黄志兵'],
  万科: ['陈冬冬', '黄山山', '薛再'],
  大岭山大学城: ['房铭瑞', '朱星林'],
};

/** 姓名集合 -> { resolved: [[姓名, openid]...], missing: [姓名...] }，自动跳过 DO_NOT_AT。 */
export function resolveOpenIds(names: Iterable<string>): {
  resolved: [string, string][];
  missing: string[];
} {
  const resolved: [string, string][] = [];
  const missing: string[] = [];
  for (const n of [...new Set(names)].filter(Boolean).sort()) {
    if (DO_NOT_AT.has(n)) continue;
    if (MANAGER_OPENID[n]) resolved.push([n, MANAGER_OPENID[n]]);
    else missing.push(n);
  }
  return { resolved, missing };
}

/** 站点简称 -> 站长姓名（找不到返回空数组）。 */
export function stationManagers(station: string): string[] {
  return STATION_MANAGERS[(station || '').trim()] || [];
}

/** 团队名称 -> 站点简称（找不到返回 `未匹配:<team>`，与旧 Python 一致）。 */
export function teamToStation(team: string): string {
  return TEAM_TO_STATION[(team || '').trim()] || `未匹配:${team}`;
}
