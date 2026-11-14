/**
 * 通知相关业务配置（移植自 common/ding_common.py，单一事实来源）。
 *
 * 迁到 Nest 的原因：@人 / 站点映射 / 目标群原本散在 Python 脚本常量里，
 * 迁移后所有任务共用此表，避免多处真相。
 */

/** 生产目标群（群名，由 dingtalk 模块按名解析 openConversationId）。 */
export const PRODUCTION_GROUP_NAME = '站点日常管理通知群';

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

/** 站点简称 -> 站长姓名（找不到返回空数组）。 */
export function stationManagers(station: string): string[] {
  return STATION_MANAGERS[(station || '').trim()] || [];
}

// ── 站点负责人运行时配置（station-managers.service 落盘 / UI 维护）──

export interface StationManagerEntry {
  /** 负责人姓名（须与钉钉显示名一致，用于展示与按姓名引用）。 */
  name: string;
  /** 手机号（可空，仅信息展示）。 */
  mobile?: string;
  /** 职位（可空，仅信息展示）。 */
  title?: string;
  /** 是否在播报/@ 名单中排除此人（true = 只挂名不 @，默认 false）。 */
  no_at?: boolean;
  /** 钉钉 openDingTalkId（@ 占位符用的真实 ID）。 */
  open_id: string;
}

export interface StationEntry {
  /** 站点ID（业务系统站点标识，可空；匹配时也参与）。 */
  station_id?: string;
  /** 站点名称（全称，如 东莞市黄江镇站-UB）。 */
  station_name?: string;
  /** 站点简称（如 黄江）。 */
  name: string;
  /** 站点地址（可空，仅信息展示）。 */
  address?: string;
  /** 团队名别名（兼容旧数据；站点名称会自动并入匹配）。 */
  teams?: string[];
  /** 该站点负责人姓名列表（须存在于 managers 中）。 */
  managers: string[];
}

export interface StationManagersCfg {
  managers: StationManagerEntry[];
  stations: StationEntry[];
}

/** 由硬编码常量导出的默认配置：runtime JSON 不存在时的兜底，也是 UI 首次保存的种子数据。 */
export function defaultStationManagersConfig(): StationManagersCfg {
  const seen = new Set<string>();
  const managers: StationManagerEntry[] = [];
  for (const [name, openId] of Object.entries(MANAGER_OPENID)) {
    if (seen.has(openId)) continue; // 房志才/房铭瑞/房瑞铭 同人异名共用一个 openid，去重保首个
    seen.add(openId);
    managers.push({ name, open_id: openId });
  }
  const alias: Record<string, string[]> = {};
  for (const [team, st] of Object.entries(TEAM_TO_STATION)) {
    (alias[st] ||= []).push(team);
  }
  return {
    managers,
    stations: Object.entries(STATION_MANAGERS).map(([name, ms]) => ({
      name,
      station_name: (alias[name] || [])[0] || '',
      station_id: '',
      teams: alias[name] || [],
      managers: [...ms],
    })),
  };
}

/** 团队名称 -> 站点简称（找不到返回 `未匹配:<team>`，与旧 Python 一致）。 */
export function teamToStation(team: string): string {
  return TEAM_TO_STATION[(team || '').trim()] || `未匹配:${team}`;
}
