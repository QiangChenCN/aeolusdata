// 已知站点兜底清单（id + 站点名）—— 与后端 dashboard/standard/teams_config.py::TEAM_NAMES 同步。
// 真实站点目录由风神上游 /api/teams 提供；本常量仅在上游失败、选择器需兜底时使用，绝不让其空白。
export const FALLBACK_TEAMS = [
  { id: "917521130", name: "东莞市黄江镇站-UB" },
  { id: "917521136", name: "东莞市长安万科站-UB" },
  { id: "917521139", name: "东莞市大岭山大学城站-UB" },
];
export const FALLBACK_TEAM_ID = "917521136";
