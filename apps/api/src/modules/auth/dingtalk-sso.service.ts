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
 *   2) 钉钉登录(OAuth2 网页登录，浏览器独立访问)：前端跳转钉钉授权页拿 code → 本服务换
 *      userAccessToken，再用这个「用户 AccessToken」调 contact/users/me 取 unionid
 *      （需要 Contact.User.Read 权限）。这是内部应用浏览器登录的标准做法，并不依赖 openid scope。
 *
 * 凭证来源优先级：持久化配置（apps/api/runtime/.dingtalk_sso.json，由前端「钉钉设置」页维护）
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
  private readonly ssoFile = path.join(process.cwd(), 'runtime', '.dingtalk_sso.json');
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

  /** 浏览器独立访问的钉钉登录（钉钉登录 OAuth2 产品）授权地址。
   *  内部应用浏览器登录：先用 userAccessToken 这个「用户 AccessToken」去调 contact/users/me
   *  取 unionid，因此授权 scope 必须包含 Contact.User.Read（通讯录个人信息读权限）。
   *  同时带上 openid 作为兜底——若令牌响应直接带回 unionId 则可省一次调用。 */
  private buildAuthorizeUrl(): string {
    const c = this.effectiveConfig();
    const state = 'wb';
    return (
      'https://login.dingtalk.com/oauth2/auth?redirect_uri=' +
      encodeURIComponent(c.oauthRedirectUri) +
      '&client_id=' + encodeURIComponent(c.appKey) +
      '&response_type=code&scope=' + encodeURIComponent('openid Contact.User.Read') +
      '&state=' + state +
      '&prompt=consent'
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

  /**
   * 钉钉登录（OAuth2 产品，浏览器独立访问）：code → userAccessToken → 用户身份。
   *
   * 内部应用的浏览器登录标准做法（即「用 AccessToken 取身份」，不依赖 openid）：
   *   1) 用 code 换 userAccessToken（用户 AccessToken）；
   *   2) 若令牌响应直接带 unionId/openid（openid scope 生效时）→ 直接用；
   *   3) 否则用该 userAccessToken 调 contact/users/me 取当前登录用户的 unionId
   *      （要求授权时用户授予了 Contact.User.Read，且应用在「钉钉登录」产品的权限范围里勾选了它）；
   *   4) 再不行用 oauth2/userinfo 兜底。
   */
  async exchangeOauthCode(code: string): Promise<DingtalkIdentity> {
    const c = this.effectiveConfig();
    const clientId = c.appKey;
    const clientSecret = c.appSecret;
    this.logger.warn(
      '[钉钉OAuth][STEP1] 用 code 换 userAccessToken：clientId=' + clientId +
        ' code长度=' + (code ? code.length : 0) + ' scope(授权页)=openid Contact.User.Read',
    );
    const tokRes = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, code, grantType: 'authorization_code' }),
    });
    this.logger.warn('[钉钉OAuth][STEP2] 令牌端点 HTTP 状态=' + tokRes.status);
    const tok = await tokRes.json().catch(() => ({}));
    const accessToken = tok?.accessToken;
    if (!accessToken) {
      this.logger.warn('[钉钉OAuth][STEP2-FAIL] 未拿到 accessToken；完整响应=' + JSON.stringify(tok).slice(0, 800));
      throw new Error('钉钉 OAuth 换取用户令牌失败：' + JSON.stringify(tok));
    }
    this.logger.warn(
      '[钉钉OAuth][STEP2-OK] 令牌响应: accessToken已得' +
        ' unionId=' + (tok?.unionId || tok?.unionid || '空') +
        ' openId=' + (tok?.openId || tok?.openid || '空') +
        ' nick=' + (tok?.nick || '空'),
    );

    // 第 2 步：令牌响应直接带回 unionId/openid（openid scope 生效时）。
    const unionidFromToken = tok?.unionId || tok?.unionid;
    if (unionidFromToken) {
      this.logger.warn('[钉钉OAuth][STEP3] 令牌直接带 unionId，返回（无需再调通讯录）');
      return { unionid: unionidFromToken, openid: tok?.openId || tok?.openid, name: tok?.nick };
    }

    // 第 3 步：用 userAccessToken（用户 AccessToken）调 contact/users/me 取当前用户 unionId。
    this.logger.warn('[钉钉OAuth][STEP3] 令牌未直接带 unionId，用 userAccessToken 调 contact/users/me');
    const meRes = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
    });
    this.logger.warn('[钉钉OAuth][STEP4] /contact/users/me(GET) HTTP 状态=' + meRes.status);
    const me = await meRes.json().catch(() => ({}));
    // 该接口可能把字段放在 result 下或直接在顶层，unionId 大小写两种都兼容。
    const meUnion =
      me?.result?.unionId || me?.result?.unionid || me?.unionId || me?.unionid;
    if (meUnion) {
      this.logger.warn('[钉钉OAuth][STEP4-OK] 通过 /contact/users/me 拿到 unionid=' + meUnion);
      const meName = me?.result?.name || me?.name;
      return { unionid: meUnion, name: meName };
    }
    this.logger.warn('[钉钉OAuth][STEP4-FAIL] /contact/users/me 未取得 unionId: ' + JSON.stringify(me).slice(0, 500));

    // 第 4 步兜底：oauth2/userinfo（部分应用/区域不存在，会 404，仅作最后尝试）。
    this.logger.warn('[钉钉OAuth][STEP5] 兜底尝试 /oauth2/userinfo');
    const uiRes = await fetch('https://api.dingtalk.com/v1.0/oauth2/userinfo', {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': accessToken, 'Content-Type': 'application/json' },
      body: '{}',
    });
    this.logger.warn('[钉钉OAuth][STEP6] /oauth2/userinfo(POST) HTTP 状态=' + uiRes.status);
    const ui = await uiRes.json().catch(() => ({}));
    const uiUnion = ui?.unionId || ui?.unionid;
    if (uiUnion) {
      this.logger.warn('[钉钉OAuth][STEP6-OK] 通过 /oauth2/userinfo 拿到 unionid=' + uiUnion);
      return { unionid: uiUnion, openid: ui?.openId || ui?.openid, name: ui?.nick || ui?.name };
    }
    this.logger.warn('[钉钉OAuth][STEP6-FAIL] /oauth2/userinfo 未取得 unionId: ' + JSON.stringify(ui).slice(0, 500));
    throw new Error(
      '钉钉 OAuth 未能取得用户 unionId（令牌/contact/users/me/userinfo 均未返回身份）：' +
        JSON.stringify(tok).slice(0, 200) + ' | ' + JSON.stringify(me).slice(0, 200) + ' | ' + JSON.stringify(ui).slice(0, 200),
    );
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
