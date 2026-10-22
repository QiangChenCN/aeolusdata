export interface Diagnosis {
  kind: string;
  advice: string;
}

/** 已知错误模式 → 可读诊断建议（移植自 server.py diagnose）。 */
export function diagnose(full: string, exitCode: number): Diagnosis {
  const text = full || '';
  // 配置/资源缺失优先：参考样式快照丢失是 setup 问题，绝非鉴权失效
  if (/参考快照缺失|快照缺失|rule_native_reference/i.test(text)) {
    return {
      kind: '参考快照缺失',
      advice:
        '骑士规则文档所需的参考样式快照（apps/api/runtime/jobs/ruledoc/rule_native_reference*.html）缺失，' +
        '请从仓库恢复该文件（或重新抓取前台规则详情页快照）后重试。',
    };
  }
  // 鉴权失效：仅匹配真实鉴权失败文案，避免被登录阶段的无害日志（如「复用本地 cookie」）误触发
  if (/401|validToken|未登录|顶号|登录失败|会话失效|账号密码错误|未找到风神登录凭据|cookie\s*失效|cookie\s*无效|鉴权/i.test(text)) {
    return {
      kind: '鉴权失效',
      advice:
        '登录态失效或顶号，请重新登录风神后重试：调用 POST /api/fetch/aeolus-relogin（机器令牌）' +
        '强制重登，或在页面触发一次刷新（Nest 会自动重登）。' +
        '（旧的 `python -m aeolus_sdk.login` 已随 SDK 删除，勿再使用。）',
    };
  }
  if (/Timeout|超时|timed out/i.test(text)) {
    return {
      kind: '执行超时',
      advice: '任务超时，先用更小范围（单日/少量）确认能跑通再放大。',
    };
  }
  // 网络层故障：覆盖 Node fetch 的 `fetch failed` 与其 cause 的 errno
  // （ENOTFOUND / EAI_AGAIN = DNS，ECONNRESET / ECONNREFUSED = 连接，ETIMEDOUT / UND_ERR_* = 超时），
  // 以及 AeolusLoginService 透出的「登录页请求失败 / doLogin 请求异常」。
  if (
    /Network|连接|ECONN|socket|timeout|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|UND_ERR|fetch failed|登录页请求失败|doLogin 请求异常|cause=/i.test(
      text,
    )
  ) {
    return {
      kind: '网络异常',
      advice:
        '网络连接异常，检查本机网络 / DNS 与上游域名是否可用后重试。' +
        '若异地随意可达而本服务持续失败，多为长时间运行的后端进程内 DNS/连接池卡死，重启后端即可恢复。',
    };
  }
  if (/Traceback|Error|Exception|raise /i.test(text)) {
    return {
      kind: '脚本异常',
      advice: '脚本抛出异常，查看上方 Traceback 定位具体行。',
    };
  }
  return { kind: '未知错误', advice: `退出码 ${exitCode}，请查看完整日志定位原因。` };
}
