// 常量映射：状态文案/色、分组图标、导航图标（Element Plus 图标组件名，已全局注册）。
export const STATUS_TXT = {
  running: '执行中', failed: '失败', success: '成功', stopped: '已停止', queued: '排队中',
};
export const STATUS_CLS = {
  running: 'is-run', failed: 'is-fail', success: 'is-ok', stopped: 'is-stop', queued: 'is-queued',
};

// 业务分组 → Element Plus 图标名；未命中降级 grid
export const GROUP_ICONS = {
  attendance: 'UserFilled', task: 'Shop', equip: 'Lightning', delivery: 'Van',
  unsat: 'Warning', tool: 'Wrench',
};

export const NAV_ICONS = {
  home: 'HomeFilled', tasks: 'Grid', dash: 'DataLine', todo: 'List', admin: 'Setting',
};

// 参数控件类型 → Element Plus 组件提示（供 ParamForm 分发）
export const PARAM_CONTROL = {
  text: '文本', textarea: '多行文本', number: '数字', select: '下拉',
  date: '单日', daterange: '区间', multiselect: '多选', switch: '开关', file: '文件',
};
