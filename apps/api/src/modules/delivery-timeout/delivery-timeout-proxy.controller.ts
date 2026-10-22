import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ComputeService } from '../compute/compute.service';
import { AuthService } from '../auth/auth.service';
import { DataPermService } from '../auth/data-perm.service';
import { ConfigService } from '../config/config.service';
import { DeliveryTimeoutConfigService } from './delivery-timeout-config.service';
import { forwardSession, forwardToCompute } from '../../common/proxy-forward.util';

/**
 * 配送超时看板的命名空间通配路由（2026-10-21 从 `ProxyController` 收回）。
 *
 *  · `/api/delivery-timeout/data`  → 转发 Python 计算（`analytics.delivery_timeout`）；
 *  · `/api/delivery-timeout/teams` → 配置端点（`isConfigPath` 命中时改派本模块的配置服务）。
 *
 * 为什么独立成第二个 controller，而不是把通配塞进 `DeliveryTimeoutController`：
 *  同前缀下「具体路由」必须先于「通配」挂载，否则 `refresh` / `raw` 会被通配吞掉。
 *  两个 controller 同前缀时，Nest 按 `controllers: []` 的声明顺序逐个挂载 Router，
 *  前一个没命中会 next() 到后一个 —— 本模块里的顺序是
 *  `DeliveryTimeoutController`（具体）→ `DeliveryTimeoutProxyController`（通配）。
 */
@Controller('api/delivery-timeout')
export class DeliveryTimeoutProxyController {
  constructor(
    private readonly compute: ComputeService,
    private readonly auth: AuthService,
    private readonly dataPerm: DataPermService,
    private readonly config: ConfigService,
    private readonly cfg: DeliveryTimeoutConfigService,
  ) {}

  @Get('{*path}')
  proxyGet(@Req() req: Request) {
    if (this.config.isConfigPath(req.path)) return this.handleConfig('GET', req);
    return forwardToCompute(req, 'GET', this.compute, this.auth, this.dataPerm);
  }

  @Post('{*path}')
  proxyPost(@Req() req: Request, @Body() body: unknown) {
    if (this.config.isConfigPath(req.path)) return this.handleConfig('POST', req, body);
    return forwardToCompute(req, 'POST', this.compute, this.auth, this.dataPerm, body);
  }

  /** `/teams` 的配置读写（改派 `DeliveryTimeoutConfigService`，不转发 Python）。 */
  private handleConfig(
    method: 'GET' | 'POST',
    req: Request,
    body?: unknown,
  ): Promise<unknown> {
    const sess = forwardSession(req, this.auth, this.dataPerm);
    if (!sess) return Promise.resolve({ ok: false, error: '未登录' });
    return method === 'GET'
      ? this.cfg.getTeams(sess.allowed)
      : Promise.resolve(this.cfg.setTeams(body));
  }
}
