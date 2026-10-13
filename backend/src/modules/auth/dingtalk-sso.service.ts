import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 钉钉单点登录客户端（钉钉侧的「用户登录本系统」，与 dws 的「服务端自身授权」是两回事）。
 *
 * 提供两条互补入口，最终都收敛到同一个钉钉身份（unionid），再交给 AuthService 映射到
 * 本地账号并发放同一套 wb_token 会话：
 *   1) JSAPI 免登（钉钉工作台内嵌 H5）：前端 `dd.getAuthCode` 取 authCode → 本服务用应用
 *      access_token 调 getuserinfo 拿 userid → 通讯录接口拿 unionid。
 *   2) OAuth2 网页登录（浏览器独立访问）：前端跳转钉钉授权页拿 code → 本服务换 userAccessToken
 *      → contact/users/me 拿 unionid。
 *
 * 凭证来源优先级：持久化配置（backend/data/.dingtalk_sso.json，由前端「钉钉设置」页维护）
 * 覆盖 环境变量（DT_APP_KEY / DT_APP_SECRET / DT_CORP_ID …）。二者皆未配置时 isEnabled() 为
 * false，相关端点返回友好提示，不影响既有的账密登录。
 */
export interface DingtalkSsoConfig {
  /**
   * 前台开关：false 时即使 AppKey/AppSecret 齐全也不展示钉钉登录入口（保留已填凭证，便于灰度/临时下线）。
   * 配置文件里没有该字段时（历史部署）沿用旧语义：凭证齐全即启用。
   */
  enabled: boolean;
  appKey: string;
  appSecret: string;
  corpId: string;
  oauthRedirectUri: string;
  frontendUrl: string;
}

export interface DingtalkIdentity {
  unionid: string;
  openid?: string;
  userid?: string;
  name?: string;
}

@Injectable()
export class DingtalkSsoService {
  private readonly logger = new Logger(DingtalkSsoService.name);
  private readonly ssoFile = path.join(process.cwd(), 'data', '.dingtalk_sso.json');
  private configCache: DingtalkSsoConfig | null = null;

  constructor(private readonly config: ConfigService) {}

  /** 持久化配置优先，未配置项回退到环境变量。结果缓存，saveSettingsConfig 时失效。 */
  private effectiveConfig(): DingtalkSsoConfig {
    if (this.configCache) return this.configCache;
    let persisted: Partial<DingtalkSsoConfig> = {};
    try {
      if (fs.existsSync(this.ssoFile)) {
        persisted = JSON.parse(fs.readFileSync(this.ssoFile, 'utf-8')) as Partial<DingtalkSsoConfig>;
      }
    } catch (e) {
      this.logger.warn('读取钉钉 SSO 配置失败，改用环境变量: ' + (e as Error).message);
    }
    const env = (k: string) => this.config.get<string>(k) || '';
    const appKey = (persisted.appKey ?? env('DT_APP_KEY')).trim();
    const appSecret = (persisted.appSecret ?? env('DT_APP_SECRET')).trim();
    this.configCache = {
      // enabled 未显式持久化（历史配置文件 / 纯环境变量部署）→ 沿用旧语义：凭证齐全即启用
      enabled: typeof persisted.enabled === 'boolean' ? persisted.enabled : !!(appKey && appSecret),
      appKey,
      appSecret,
      corpId: (persisted.corpId ?? env('DT_CORP_ID')).trim(),
      oauthRedirectUri: (persisted.oauthRedirectUri ?? env('DT_OAUTH_REDIRECT_URI')).trim(),
      frontendUrl: (persisted.frontendUrl ?? env('DT_FRONTEND_URL')).trim(),
    };
    return this.configCache;
  }

  private invalidateCache() {
    this.configCache = null;
  }

  /** 开关 + 凭证双闸门：开关关闭 → 钉钉入口下线；凭证缺失同样不可用（沿用历史行为）。 */
  isEnabled(): boolean {
    const c = this.effectiveConfig();
    return !!c.enabled && !!c.appKey && !!c.appSecret;
  }

  /** 给前端的公开配置：是否启用、corpId（JSAPI 免登需要）、OAuth 授权页地址。 */
  getPublicConfig(): Record<string, unknown> {
    if (!this.isEnabled()) return { enabled: false, corpId: '', authorizeUrl: '' };
    const c = this.effectiveConfig();
    return { enabled: true, corpId: c.corpId, authorizeUrl: this.buildAuthorizeUrl() };
  }

  /** 给设置页的脱敏配置（appSecret 不返回明文，仅用 appSecretSet 标记是否已设置）。 */
  getSettingsConfig(): Record<string, unknown> {
    const c = this.effectiveConfig();
    return {
      // enabled = 开关本身的配置值（供设置页的 switch 回填）；active = 实际生效与否
      enabled: !!c.enabled,
      active: this.isEnabled(),
      credReady: !!(c.appKey && c.appSecret),
      appKey: c.appKey,
      appSecretSet: !!c.appSecret,
      appSecret: '',
      corpId: c.corpId,
      oauthRedirectUri: c.oauthRedirectUri,
      frontendUrl: c.frontendUrl,
    };
  }

  /** 保存设置页提交的补丁：appSecret 为空表示「保持不变」（UI 不回显明文，始终提交空串除非重填）；
   *  其余字段空字符串表示显式清空。 */
  saveSettingsConfig(patch: Partial<DingtalkSsoConfig>): void {
    const cur = this.effectiveConfig();
    const next: DingtalkSsoConfig = {
      // 开关是布尔值，必须原样承接（false 也是有效值，不能被「假值清空」吃掉）
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      appKey: patch.appKey !== undefined ? patch.appKey : cur.appKey,
      // appSecret 为空 => 保留当前值（UI 约定：未重填即不改）；非空 => 覆盖
      appSecret: patch.appSecret && patch.appSecret.trim() ? patch.appSecret : cur.appSecret,
      corpId: patch.corpId !== undefined ? patch.corpId : cur.corpId,
      oauthRedirectUri: patch.oauthRedirectUri !== undefined ? patch.oauthRedirectUri : cur.oauthRedirectUri,
      frontendUrl: patch.frontendUrl !== undefined ? patch.frontendUrl : cur.frontendUrl,
    };
    // enabled 总是写入（含 false），其余字段沿用「空字符串表示清空」的约定
    const persist: Partial<DingtalkSsoConfig> = { enabled: next.enabled };
    // 只枚举字符串型字段（enabled 是布尔，上面已单独落盘）
    const keys: (keyof Omit<DingtalkSsoConfig, 'enabled'>)[] = [
      'appKey', 'appSecret', 'corpId', 'oauthRedirectUri', 'frontendUrl',
    ];
    for (const k of keys) {
      const v = (next[k] || '').trim();
      if (v) persist[k] = v;
    }
    try {
      const dir = path.dirname(this.ssoFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.ssoFile, JSON.stringify(persist, null, 2) + '\n', { mode: 0o600 });
      this.invalidateCache();
    } catch (e) {
      throw new Error('写入钉钉 SSO 配置失败: ' + (e as Error).message);
    }
  }

  /** 浏览器独立访问的钉钉 OAuth2 授权地址（redirect_uri 需与钉钉后台配置一致且为 HTTPS）。 */
  private buildAuthorizeUrl(): string {
    const c = this.effectiveConfig();
    return (
      'https://login.dingtalk.com/oauth2/auth?redirect_uri=' +
      encodeURIComponent(c.oauthRedirectUri) +
      '&client_id=' +
      encodeURIComponent(c.appKey) +
      // 必须同时申请 openid 与 Contact.User.Read：
      //   - openid 让换令牌的响应直接带 unionId（走捷径，省掉下面的通讯录接口）；
      //   - Contact.User.Read 是回退路径 /users/me 所需的 scope。
      // 注意「在控制台开通权限」≠「令牌带该 scope」——授权请求不申请，令牌就无权，
      // 这是此前一直报「权限不足」却怎么开通都没用的根因。
      '&response_type=code&scope=openid%20Contact.User.Read&state=wb'
    );
  }

  /** OAuth 回调/前端跳转回前端首页的地址：优先持久化/环境变量 DT_FRONTEND_URL，否则用请求来源。 */
  frontendUrl(req?: Request): string {
    const c = this.effectiveConfig();
    if (c.frontendUrl) return c.frontendUrl.replace(/\/+$/, '');
    if (req && req.get) {
      const host = req.get('host');
      const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
      if (host) return `${proto}://${host}`;
    }
    return '';
  }

  /** OAuth2 网页登录：code → userAccessToken → 当前用户 unionid。 */
  async exchangeOauthCode(code: string): Promise<DingtalkIdentity> {
    const c = this.effectiveConfig();
    const clientId = c.appKey;
    const clientSecret = c.appSecret;
    const tokRes = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, code, grantType: 'authorization_code' }),
    });
    const tok = await tokRes.json().catch(() => ({}));
    const accessToken = tok?.accessToken;
    if (!accessToken) throw new Error('钉钉 OAuth 换取用户令牌失败：' + JSON.stringify(tok));

    // 部分应用类型在换令牌的响应里就直接带 unionId —— 优先使用它，
    // 可省掉下面这个需要 Contact.User.Read 权限的通讯录接口。
    const direct = tok?.unionId || tok?.unionid;
    if (direct) {
      return { unionid: direct, openid: tok?.openId || tok?.openid, name: tok?.nick || tok?.name };
    }

    const meRes = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
    });
    const me = await meRes.json().catch(() => ({}));
    const unionid = me?.unionId || me?.unionid;
    if (!unionid) {
      // 权限不足是最常见原因，单独给出可执行的处理指引，别只丢一串英文给使用者。
      const denied = /PermissionDenied|AccessDenied/i.test(String(me?.code || ''));
      const scopes = me?.accessdenieddetail?.requiredScopes;
      if (denied) {
        throw new Error(
          '钉钉接口权限不足：' + (Array.isArray(scopes) && scopes.length ? scopes.join(', ') : '未知scope') +
            '。需满足两点：①开放平台「该应用→权限管理」已开通此权限；②本系统 OAuth 授权请求已申请该 scope' +
            '（当前 scope 含 openid Contact.User.Read）。若都符合仍被拒，多半是「钉钉设置」里填的 AppKey 指向了' +
            '另一个应用——请确认 AppKey/AppSecret 与本系统用的是同一个应用，然后重新发布。',
        );
      }
      throw new Error('钉钉 OAuth 获取用户信息失败：' + JSON.stringify(me));
    }
    return { unionid, openid: me?.openId || me?.openid, name: me?.nick || me?.name };
  }

  /** JSAPI 免登：authCode → userid → unionid（需开通通讯录读取权限）。 */
  async exchangeJsapiCode(authCode: string): Promise<DingtalkIdentity> {
    const c = this.effectiveConfig();
    const appKey = c.appKey;
    const appSecret = c.appSecret;
    const tokenRes = await fetch(
      'https://oapi.dingtalk.com/gettoken?appkey=' +
        encodeURIComponent(appKey) +
        '&appsecret=' +
        encodeURIComponent(appSecret),
    );
    const token = await tokenRes.json().catch(() => ({}));
    const accessToken = token?.access_token;
    if (!accessToken) throw new Error('钉钉获取应用令牌失败：' + JSON.stringify(token));
    const infoRes = await fetch(
      'https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=' + accessToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 注意：该接口的免登码参数名是 `code`（不是 authCode），名字写错会返回
        // errcode=40 "Missing required arguments:code"。
        body: JSON.stringify({ code: authCode }),
      },
    );
    const info = await infoRes.json().catch(() => ({}));
    const userid = info?.result?.userid;
    if (!userid) throw new Error('钉钉 JSAPI 获取 userid 失败：' + JSON.stringify(info));
    const userRes = await fetch(
      'https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + accessToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userid }),
      },
    );
    const user = await userRes.json().catch(() => ({}));
    const result = user?.result || {};
    const unionid = result?.unionid;
    if (!unionid) {
      throw new Error('钉钉获取 unionid 失败（需开通通讯录读取权限）：' + JSON.stringify(user));
    }
    return { unionid, userid, name: result?.name };
  }
}
