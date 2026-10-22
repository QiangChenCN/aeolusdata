import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { extractToken } from '../../common/token.util';

// account/change-pw 与 auth/* 不同前缀，单独成控制器（避免与 @Controller('api/auth') 冲突）。
@Controller('api')
export class AccountController {
  constructor(private readonly auth: AuthService) {}

  @Post('account/change-pw')
  changePw(@Body() b: { old_password?: string; new_password?: string }, @Req() req: Request) {
    const s = this.auth.getSession(extractToken(req));
    if (!s) return { ok: false, error: 'unauthorized' };
    try {
      this.auth.changePassword(s.user, b.old_password || '', b.new_password || '');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
