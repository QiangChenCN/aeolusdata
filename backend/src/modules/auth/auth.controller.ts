import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { PERM_CATALOG } from './permissions';
import { extractToken } from '../../common/token.util';

// 注意：此前把 auth/* 路由挂在 @Controller('api') 下作为 /api 路由表的嵌套子路径时，
// Express5 / path-to-regexp v8 在 auth/ 静态子树下出现诡异 bug：auth/logout 这种特定静态
// POST 能匹配，而 auth/login/signin 等其它 auth/X POST 全部 404（与词/位置/方法名无关，
// xyz 这类全新路径也 404）。将其整体改到 @Controller('api/auth')（独立路由表挂到 /api/auth）
// 后问题消失。URL 路径保持 /api/auth/* 不变。详见重构记录。
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
      perms: [...this.auth.effectivePerms(s.role)],
      catalog: PERM_CATALOG,
    };
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
