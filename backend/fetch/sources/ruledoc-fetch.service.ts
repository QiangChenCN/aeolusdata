import { Injectable } from '@nestjs/common';
import { AeolusCookieService } from '../creds/aeolus-cookie.service';

/**
 * 骑士规则中心取数（移植自 get_data/ruledoc.py，单一来源）。
 *
 * POST xtop.robot.admin.ruleInfoViewFs.queryRuleInfo/1.0，返回 result.data（规则快照）。
 */
export const RULEDOC_API =
  'https://httpizza.ele.me/xtop/xtop.robot.admin.ruleInfoViewFs.queryRuleInfo/1.0';

/** 规则接口业务错误（规则不存在 / 已下线等），信息与 Python RuleQueryError 一致。 */
export class RuleQueryError extends Error {
  constructor(
    public ruleId: number | string,
    public isHistory: boolean,
    public innerCode: unknown,
    message: string,
    public raw: unknown,
  ) {
    const mode = isHistory ? '历史版本' : '现行有效版本';
    const head = `规则 ${ruleId}（${mode}）查询失败：${message || '未知业务错误'}`;
    let hint = '';
    if ((message || '').includes('规则不存在') && !isHistory) {
      hint = ' —— 该规则可能已从现行版本下架，请把版本改回「历史版本(全量)」再试';
    } else if ((message || '').includes('规则不存在') && isHistory) {
      hint = ' —— 历史快照里也找不到该 rule ID，请核对输入';
    }
    super(head + hint);
    this.name = 'RuleQueryError';
  }
}

@Injectable()
export class RuledocFetchService {
  constructor(private readonly cookies: AeolusCookieService) {}

  async queryRule(
    ruleId: number | string,
    isHistory: boolean,
    cookie?: string,
  ): Promise<Record<string, any>> {
    const ck = cookie || (await this.cookies.ensure());
    const payload = { params: { request: { isHistory, id: ruleId } } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let resp: Record<string, any>;
    try {
      const res = await fetch(RULEDOC_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ck },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new Error(`规则接口 HTTP ${res.status}（rule_id=${ruleId}）：${text}`);
      }
      try {
        resp = (await res.json()) as Record<string, any>;
      } catch (e) {
        throw new Error(`规则接口响应不是合法 JSON（rule_id=${ruleId}）：${(e as Error).message}`);
      }
    } catch (e) {
      if ((e as Error).message.startsWith('规则接口')) throw e;
      throw new Error(`规则接口网络异常（rule_id=${ruleId}）：${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const outerCode = resp.code;
    if (outerCode != null && Number(outerCode) !== 200) {
      throw new Error(
        `规则接口外层 code=${outerCode}（rule_id=${ruleId}）：${JSON.stringify(resp).slice(0, 300)}`,
      );
    }

    const inner = resp.result || {};
    const innerCode = inner.code;
    if (innerCode == null) {
      throw new Error(
        `规则接口响应缺 result.code（rule_id=${ruleId}）：${JSON.stringify(resp).slice(0, 300)}`,
      );
    }
    if (Number(innerCode) !== 200) {
      throw new RuleQueryError(ruleId, isHistory, innerCode, inner.message, resp);
    }
    const data = inner.data;
    if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
      throw new RuleQueryError(ruleId, isHistory, innerCode, inner.message || 'result.data 为空', resp);
    }
    return data;
  }
}
