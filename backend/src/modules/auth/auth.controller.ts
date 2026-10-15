import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { PERM_CATALOG } from './permissions';
import { DingtalkSsoService } from './dingtalk-sso.service';
import { extractToken } from '../../common/token.util';

// 注意：此前把 auth/* 路由挂在 @Controller('api') 下作为 /api 路由表的嵌套子路径时，
// Express5 / path-to-regexp v8 在 auth/ 静态子树下出现诡异 bug：auth/logout 这种特定静态
// POST 能匹配，而 auth/login/signin 等其它 auth/X POST 全部 404（与词/位置/方法名无关，
// xyz 这类全新路径也 404）。将其整体改到 @Controller('api/auth')（独立路由表挂到 /api/auth）
// 后问题消失。URL 路径保持 /api/auth/* 不变。详见重构记录。
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly ding: DingtalkSsoService,
  ) {}

  // 登录成功返回 200：Nest 的 @Post 默认 201，而前端 api.js login() 严格校验 200，
  // 返回 201 会让浏览器判定「登录失败」。显式改回 200（与旧 server.py 一致）。
  // 会话令牌不再由前端存取，而是后端种 HttpOnly Cookie（同源自动携带、XSS 不可读）；
  // 「记住我」勾选时附带 Max-Age=7d，否则为会话 Cookie（关闭浏览器才失效）。
  @Post('signin')
  @HttpCode(200)
  signin(
    @Body() b: { username?: string; password?: string; remember?: boolean },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = this.auth.login(b.username || '', b.password || '', '', b.remember === true);
    if (!r) return { ok: false, error: '用户名或密码错误' };
    this.setSessionCookie(res, r.token, b.remember === true, req.secure);
    return {
      ok: true,
      token: r.token,
      user: b.username,
      role: r.role,
      avatar: this.auth.getUser(b.username || '')?.avatar ?? null,
      name: this.auth.getUser(b.username || '')?.name ?? null,
      phone: this.auth.getUser(b.username || '')?.phone ?? null,
      email: this.auth.getUser(b.username || '')?.email ?? null,
      expires_in: r.expiresIn,
    };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.auth.logout(extractToken(req));
    this.clearSessionCookie(res, req.secure);
    return { ok: true };
  }

  /** 无会话也可访问（前端据此决定是否跳登录页）；返回当前有效权限点。 */
  @Get('me')
  me(@Req() req: Request) {
    const s = this.auth.getSession(extractToken(req));
    if (!s) return { authenticated: false, error: 'unauthorized' };
    return {
      authenticated: true,
      user: s.user,
      role: s.role,
      avatar: this.auth.getUser(s.user)?.avatar ?? null,
      name: this.auth.getUser(s.user)?.name ?? null,
      phone: this.auth.getUser(s.user)?.phone ?? null,
      email: this.auth.getUser(s.user)?.email ?? null,
      perms: [...this.auth.effectivePerms(s.role)],
      catalog: PERM_CATALOG,
    };
  }

  /** 前端探测：钉钉登录是否启用 + corpId + OAuth 授权地址（公开，用于决定是否渲染钉钉登录）。 */
  @Get('dingtalk/config')
  dingtalkConfig() {
    return this.ding.getPublicConfig();
  }

  /** 设置页读取钉钉 SSO 配置（脱敏；appSecret 不返回明文）。需 admin:bot。 */
  @Get('dingtalk/sso-config')
  dingtalkSsoConfig() {
    return { ok: true, config: this.ding.getSettingsConfig() };
  }

  /** 设置页保存钉钉 SSO 配置（持久化到 backend/data/.dingtalk_sso.json）。需 admin:bot。 */
  @Post('dingtalk/sso-config')
  @HttpCode(200)
  dingtalkSsoSave(@Body() b: Record<string, any>) {
    try {
      this.ding.saveSettingsConfig({
        enabled: b?.enabled === undefined ? undefined : b.enabled === true || b.enabled === 'true' || b.enabled === '1',
        appKey: String(b?.appKey ?? ''),
        appSecret: String(b?.appSecret ?? ''),
        corpId: String(b?.corpId ?? ''),
        oauthRedirectUri: String(b?.oauthRedirectUri ?? ''),
        frontendUrl: String(b?.frontendUrl ?? ''),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 钉钉工作台内 JSAPI 免登：前端 `dd.getAuthCode` 取 authCode 后调用。
   * 成功返回 token（前端改用 X-Token 头携带，绕开 iframe 第三方 Cookie 限制）；
   * 同源也顺手种上 Cookie 作为兜底。未绑定返回 needBind（带 unionid 供管理员绑定）。
   */
  @Post('dingtalk/jsapi')
  @HttpCode(200)
  async dingtalkJsapi(
    @Body() b: { authCode?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.ding.isEnabled()) return { ok: false, error: '钉钉登录未启用' };
    if (!b.authCode) return { ok: false, error: '缺少 authCode' };
    try {
      const id = await this.ding.exchangeJsapiCode(b.authCode);
      const r = this.auth.resolveDingtalkUser(id.unionid, id.name || '', this.ip(req), false);
      if ('needBind' in r) return { ok: false, needBind: true, unionid: r.unionid, name: r.name };
      this.setSessionCookie(res, r.token, false, req.secure);
      return { ok: true, token: r.token, user: r.user, role: r.role, avatar: this.auth.getUser(r.user)?.avatar ?? null, expires_in: r.expiresIn };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 浏览器独立访问的钉钉 OAuth2 回跳：钉钉授权后带 code 跳转至此。
   * 换取身份 → 解析本地账号 → 种会话 Cookie → 跳转前端首页（cookie 同源自动携带）。
   * 未绑定则跳转登录页并带 unionid 提示。
   */
  @Get('dingtalk/oauth-callback')
  async dingtalkOauthCallback(
    @Query('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.ding.isEnabled()) {
      res.redirect('/login?dingtalk=disabled');
      return;
    }
    if (!code) {
      res.redirect('/login?dingtalk=error');
      return;
    }
    try {
      const id = await this.ding.exchangeOauthCode(code);
      const r = this.auth.resolveDingtalkUser(id.unionid, id.name || '', this.ip(req), false);
      if ('needBind' in r) {
        res.redirect('/login?dingtalk=needbind&unionid=' + encodeURIComponent(r.unionid));
        return;
      }
      this.setSessionCookie(res, r.token, false, req.secure);
      const base = this.ding.frontendUrl(req);
      res.redirect(base ? base + '/' : '/');
    } catch (e) {
      res.redirect('/login?dingtalk=error&msg=' + encodeURIComponent((e as Error).message));
    }
  }

  /**
   * 绑定钉钉身份到本地账号：要求已登录会话。
   * 管理员（admin:users）可绑定任意 username；普通用户只能绑定自己（忽略传入 username）。
   */
  @Post('dingtalk/bind')
  @HttpCode(200)
  dingtalkBind(@Body() b: { username?: string; unionid?: string }, @Req() req: Request) {
    const s = this.auth.getSession(extractToken(req));
    if (!s) throw new UnauthorizedException('请先登录');
    const username = this.auth.hasPerm(s.role, 'admin:users') ? b.username || s.user : s.user;
    if (b.unionid === undefined) return { ok: false, error: '缺少 unionid' };
    this.auth.bindDingtalk(username, b.unionid);
    return { ok: true };
  }

  /**
   * 修改个人头像：仅允许修改「当前登录用户自己」的头像（用户名取自会话，不接受外部传入）。
   * 头像以 data URI 形式提交，由 AuthService.updateAvatar 校验格式与体积。
   */
  @Post('avatar')
  @HttpCode(200)
  setAvatar(@Body() b: { avatar?: string }, @Req() req: Request) {
    const s = this.auth.getSession(extractToken(req));
    if (!s) throw new UnauthorizedException('请先登录');
    try {
      const avatar = this.auth.updateAvatar(s.user, b.avatar || '');
      return { ok: true, avatar };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 更新个人资料（姓名 / 手机号 / 邮箱）：仅允许修改「当前登录用户自己」，用户名取自会话。
   * 手机号经 AuthService.assertPhone 校验、邮箱经 assertEmail 校验；
   * 角色、禁用等管理字段不可在此修改。
   */
  @Post('profile')
  @HttpCode(200)
  setProfile(@Body() b: { name?: string; phone?: string; email?: string }, @Req() req: Request) {
    const s = this.auth.getSession(extractToken(req));
    if (!s) throw new UnauthorizedException('请先登录');
    try {
      this.auth.updateProfile(s.user, b.name, b.phone, b.email);
      const u = this.auth.getUser(s.user);
      return { ok: true, name: u?.name ?? null, phone: u?.phone ?? null, email: u?.email ?? null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private ip(req: Request): string {
    return (req.ip as string) || req.socket?.remoteAddress || '';
  }

  private setSessionCookie(res: Response, token: string, remember: boolean, secure: boolean) {
    const parts = [`wb_token=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (remember) parts.push('Max-Age=604800'); // 记住我：7 天
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  private clearSessionCookie(res: Response, secure: boolean) {
    const parts = ['wb_token=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}
