import { Controller, Get } from '@nestjs/common';
import { CookieStatusService } from '../fetch/cookie-status.service';

/**
 * `GET /api/cookies/status` —— 登录态探针（顶部胶囊）。
 *
 * 迁移说明：本端点原先由 NestJS 代理到 Python（`compute_service/main.py` 的
 * `/api/cookies/status`）。现已原生化：
 *   · aeolus（风神 cookie.txt）→ `CookieStatusService.checkAeolus`
 *   · quark（DA cookie 缓存）  → `QuarkCredsService.cacheStatus`（带 HTTP 状态码区分）
 *
 * 权限：`view`（permissions.ts），前端 60s 轮询一次。
 */
@Controller('api')
export class CookieStatusController {
  constructor(private readonly status: CookieStatusService) {}

  @Get('cookies/status')
  check() {
    return this.status.check();
  }
}
