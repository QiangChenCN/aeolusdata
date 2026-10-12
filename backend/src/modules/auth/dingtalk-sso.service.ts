import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

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
 * 凭证全部来自环境变量（DT_APP_KEY / DT_APP_SECRET / DT_CORP_ID …），未配置时 isEnabled() 为
 * false，相关端点返回友好提示，不影响既有的账密登录。
 */
export interface DingtalkIdentity {
  unionid: string;
  openid?: string;
  userid?: string;
  name?: string;
}

@Injectable()
export class DingtalkSsoService {
  private readonly logger = new Logger(DingtalkSsoService.name);
  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return !!(this.config.get<string>('DT_APP_KEY') && this.config.get<string>('DT_APP_SECRET'));
  }

  /** 给前端的公开配置：是否启用、corpId（JSAPI 免登需要）、OAuth 授权页地址。 */
  getPublicConfig(): Record<string, unknown> {
    if (!this.isEnabled()) return { enabled: false, corpId: '', authorizeUrl: '' };
    return { enabled: true, corpId: this.config.get<string>('DT_CORP_ID') || '', authorizeUrl: this.buildAuthorizeUrl() };
  }

  /** 浏览器独立访问的钉钉 OAuth2 授权地址（redirect_uri 需与钉钉后台配置一致且为 HTTPS）。 */
  private buildAuthorizeUrl(): string {
    const clientId = this.config.get<string>('DT_APP_KEY') || '';
    const redirectUri = this.config.get<string>('DT_OAUTH_REDIRECT_URI') || '';
    return (
      'https://login.dingtalk.com/oauth2/auth?redirect_uri=' +
      encodeURIComponent(redirectUri) +
      '&client_id=' +
      encodeURIComponent(clientId) +
      '&response_type=code&scope=openid&state=wb'
    );
  }

  /** OAuth 回调/前端跳转回前端首页的地址：优先 DT_FRONTEND_URL，否则用请求来源。 */
  frontendUrl(req?: Request): string {
    const cfg = this.config.get<string>('DT_FRONTEND_URL');
    if (cfg) return cfg.replace(/\/+$/, '');
    if (req && req.get) {
      const host = req.get('host');
      const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
      if (host) return `${proto}://${host}`;
    }
    return '';
  }

  /** OAuth2 网页登录：code → userAccessToken → 当前用户 unionid。 */
  async exchangeOauthCode(code: string): Promise<DingtalkIdentity> {
    const clientId = this.config.get<string>('DT_APP_KEY') || '';
    const clientSecret = this.config.get<string>('DT_APP_SECRET') || '';
    const tokRes = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, code, grantType: 'authorization_code' }),
    });
    const tok = await tokRes.json().catch(() => ({}));
    const accessToken = tok?.accessToken;
    if (!accessToken) throw new Error('钉钉 OAuth 换取用户令牌失败：' + JSON.stringify(tok));
    const meRes = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
    });
    const me = await meRes.json().catch(() => ({}));
    const unionid = me?.unionId || me?.unionid;
    if (!unionid) throw new Error('钉钉 OAuth 获取用户信息失败：' + JSON.stringify(me));
    return { unionid, openid: me?.openId || me?.openid, name: me?.nick || me?.name };
  }

  /** JSAPI 免登：authCode → userid → unionid（需开通通讯录读取权限）。 */
  async exchangeJsapiCode(authCode: string): Promise<DingtalkIdentity> {
    const appKey = this.config.get<string>('DT_APP_KEY') || '';
    const appSecret = this.config.get<string>('DT_APP_SECRET') || '';
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
        body: JSON.stringify({ authCode }),
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
