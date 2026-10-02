import { Body, Controller, Get, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PERM_CATALOG } from './permissions';

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
  @Post('signin')
  @HttpCode(200)
  signin(
    @Body() b: { username?: string; password?: string },
    @Headers('x-token') xToken?: string,
  ) {
    const res = this.auth.login(b.username || '', b.password || '', '');
    if (!res) return { ok: false, error: '用户名或密码错误' };
    return {
      ok: true,
      token: res.token,
      user: b.username,
      role: res.role,
      expires_in: res.expiresIn,
    };
  }

  @Post('logout')
  logout(@Body() b: { token?: string }, @Headers('x-token') xToken?: string) {
    this.auth.logout(xToken || b.token);
    return { ok: true };
  }

  /** 无会话也可访问（前端据此决定是否弹登录框）；返回当前有效权限点。 */
  @Get('me')
  me(@Query('token') token?: string, @Headers('x-token') xToken?: string) {
    const s = this.auth.getSession(xToken || token);
    if (!s) return { authenticated: false, error: 'unauthorized' };
    return {
      authenticated: true,
      user: s.user,
      role: s.role,
      perms: [...this.auth.effectivePerms(s.role)],
      catalog: PERM_CATALOG,
    };
  }
}
