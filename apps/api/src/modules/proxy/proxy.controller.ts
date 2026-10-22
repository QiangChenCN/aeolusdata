import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { UpstreamHttpException } from '../../common/exceptions/upstream-http.exception';
import { Request } from 'express';
import { ComputeService } from '../compute/compute.service';
import { ComputeResult } from '../compute/compute.port';
import { AuthService } from '../auth/auth.service';
import { DataPermService } from '../auth/data-perm.service';
import { RefreshRunnerService } from '../../infra/fetch/runners/refresh-runner.service';
import { ConfigService } from '../config/config.service';
// 走看板的公开面（barrel），不深引其内部实现文件 —— 由 apps/api/scripts/check-arch.mjs 的 R6 强制。
import { ImContactConfigService } from '../im-contact';
import { extractToken } from '../../common/token.util';

/**
 * Python 生态独占端点转发（见 server.py→NestJS 映射文档 §6）。
 * 这些端点逻辑在 Python 侧（dashboard.standard.* / aeolus_sdk / group_picker / openpyxl），
 * 按 ADR 经 ComputePort 委托；NestJS 在委托前先算数据权限范围（team 维度），
 * 经请求头 x-scope 下发 ——「数据权限在 NestJS 侧执行，再委托 Python 计算」。
 *
 * 路由表与迁移前的 server.py 对齐：standard/* attend-period/* overview/* assessment/* sheet。
 * （groups / teams / cookies-status 已原生化，见各自模块；auth/* / account/change-pw / admin/* /
 *   policy / data-perms 由 Nest 内置控制器处理。）
 * 注：原 std/* ov/* ap/* 是死配置（前端与 server 均未使用这些前缀），已移除。
 *
 * 重要（Express5 / path-to-regexp v8 坑）：
 *  - 不要把多个 @Get/@Post 装饰器叠在同一方法上（只会注册其中一个，其余静默丢弃 → 404）。
 *  - 同一前缀下「精确 GET /groups」与「通配 POST /groups/{*path}」若按 GET 在前注册，
 *    通配 POST 会被 path-to-regexp 丢弃；必须把通配 POST 注册在精确 GET 之前（通配优先）。
 *  - groups 子路由的 used/forget 用通配 `groups/{*path}` 统一代理（覆盖 /api/groups/used、
 *    /api/groups/forget），权限仍按 permissions.ts 的 `/api/groups/.*` → groups:write 裁决。
 *  - 注：曾误判"静态 POST 整体注册失败"，实为 PowerShell + curl.exe 传递含引号 JSON 请求体被
 *    命令行破坏造成的测试假象（用 `--data-binary @file.json` 即可复现正常）。静态 POST 路由本身可用。
 */
@Controller('api')
export class ProxyController {
  constructor(
    private readonly compute: ComputeService,
    private readonly auth: AuthService,
    private readonly dataPerm: DataPermService,
    private readonly refreshRunner: RefreshRunnerService,
    private readonly config: ConfigService,
    private readonly imCfg: ImContactConfigService,
  ) {}

  /** 计算当前调用者的数据可见范围，下发 x-scope（'*' 表示不限）。 */
  private scopeHeaders(req: Request): Record<string, string> {
    const t = extractToken(req);
    const s = this.auth.getSession(t);
    let scope = '*';
    if (s) {
      const ids = this.dataPerm.resolveAllowed(s.user, s.role, 'team');
      scope = ids === null ? '*' : JSON.stringify([...ids]);
    }
    const headers: Record<string, string> = { 'x-scope': scope, 'x-user': s?.user || '' };
    // 透传用户会话令牌给计算服务（8900）：8900 会用它作为 nest_client 会话令牌去 Nest
    // 取风神数据（见 compute_api/main.py 的 set_session_token）。缺省为空会导致下游
    // /api/fetch/* 取数被 401，表现为「时段出勤/看板无数据」。数据权限仍由上面的 x-scope 约束。
    if (t) headers['x-token'] = t;
    return headers;
  }

  /**
   * 看板配置端点（grade-global / service-quality/targets / attend-period/config /
   * attend-period/teams）已迁 Nest 原生
   * （config.service.ts），不再转发 Python。这里在通配前拦截并改派，避免依赖注册顺序。
   */
  private configSession(
    req: Request,
  ): { user: string; allowed: Set<string> | null } | null {
    const t = extractToken(req);
    const s = this.auth.getSession(t);
    if (!s) return null;
    return { user: s.user, allowed: this.dataPerm.resolveAllowed(s.user, s.role, 'team') };
  }
  private handleConfig(method: 'GET' | 'POST', req: Request, body?: unknown): Promise<unknown> {
    const sess = this.configSession(req);
    if (!sess) return Promise.resolve({ ok: false, error: '未登录' });
    return this.config.dispatch(
      method,
      req.path,
      body,
      req.query as Record<string, any>,
      sess.user,
      sess.allowed,
    ) as Promise<unknown>;
  }

  /** 构造一次代理请求（不含拆包）。 */
  private proxyReq(req: Request, method: 'GET' | 'POST', body?: unknown) {
    return this.compute.proxy({
      endpoint: req.url,
      method,
      body,
      headers: this.scopeHeaders(req),
    });
  }

  private async unwrap(p: Promise<ComputeResult>) {
    const r = await p;
    if (!r.ok) {
      // 上游有明确状态码（403/404/500…）时原样透传，保留 body 里的 code
      //（如 DATA_SCOPE_DENIED），让前端能区分「没权限」与「出错了」。
      // 网络不可达等拿不到状态码的场景维持旧行为（200 + ok:false），
      // 避免计算服务宕机时前端到处弹错误。
      if (r.status) {
        throw new UpstreamHttpException(r.data, r.status);
      }
      return { ok: false, error: r.error || 'compute upstream unavailable' };
    }
    return r.data;
  }

  // ---------- 命名空间通配（大计算端点：standard / attend-period / overview）----------
  // 与 server.py 的真实路由前缀对齐（原 std/ov/ap 是死配置，前端与 server 均未使用，已移除）。
  // 通配路由统一靠前注册，避免与精确路由冲突导致 404；计算服务侧由 /api/{*path} 捕获并复用
  // server.py 的 GET_ROUTES/POST_ROUTES 派发表，按 x-scope 做数据权限裁决。
  @Get('standard/{*path}')
  proxyStandardGet(@Req() req: Request) {
    // 配置端点（grade-global）已迁 Nest 原生，优先拦截。
    if (this.config.isConfigPath(req.path)) return this.handleConfig('GET', req);
    // refresh-all-status 已原生化（RefreshController → RefreshRunnerService）。通配会把它一起
    // 吞掉（path-to-regexp 不支持负向断言，靠模块注册顺序又易碎），故在此显式改派 ——
    // 两处共用同一个 service，语义不会分叉。
    if (req.path === '/api/standard/refresh-all-status') {
      return { ok: true, status: this.refreshRunner.status() };
    }
    return this.unwrap(this.proxyReq(req, 'GET'));
  }
  @Post('standard/{*path}')
  proxyStandardPost(@Req() req: Request, @Body() body: unknown) {
    if (this.config.isConfigPath(req.path)) return this.handleConfig('POST', req, body);
    // refresh-all 同理（频控 / 数据权限收敛 / 单飞全在 runner 里）。
    if (req.path === '/api/standard/refresh-all') {
      return this.refreshRunner.startFromRequest(
        req,
        body as { teams?: unknown; start?: string; end?: string },
      );
    }
    return this.unwrap(this.proxyReq(req, 'POST', body));
  }
  @Get('attend-period/{*path}')
  proxyAttendGet(@Req() req: Request) {
    if (this.config.isConfigPath(req.path)) return this.handleConfig('GET', req);
    return this.unwrap(this.proxyReq(req, 'GET'));
  }
  @Post('attend-period/{*path}')
  proxyAttendPost(@Req() req: Request, @Body() body: unknown) {
    if (this.config.isConfigPath(req.path)) return this.handleConfig('POST', req, body);
    return this.unwrap(this.proxyReq(req, 'POST', body));
  }
  @Get('overview/{*path}')
  proxyOverviewGet(@Req() req: Request) {
    return this.unwrap(this.proxyReq(req, 'GET'));
  }
  @Post('overview/{*path}')
  proxyOverviewPost(@Req() req: Request, @Body() body: unknown) {
    return this.unwrap(this.proxyReq(req, 'POST', body));
  }
  // 实时在线播报：仅 assessment/station（实时聚合计算）转发 Python，
  // 其余配置端点（service-quality/targets 等）已迁 Nest 原生（config.service.ts）。
  @Get('assessment/{*path}')
  proxyAssessmentGet(@Req() req: Request) {
    if (this.config.isConfigPath(req.path)) return this.handleConfig('GET', req);
    return this.unwrap(this.proxyReq(req, 'GET'));
  }
  @Post('assessment/{*path}')
  proxyAssessmentPost(@Req() req: Request, @Body() body: unknown) {
    if (this.config.isConfigPath(req.path)) return this.handleConfig('POST', req, body);
    return this.unwrap(this.proxyReq(req, 'POST', body));
  }

  // IM 电联看板：与 delivery-timeout 解耦的独立命名空间。
  //  · /data   → 转发 Python 计算（analytics.im_contact）。
  //  · /teams  → 配置端点（isConfigPath 命中 /api/im-contact/teams），改派 ImContactConfigService。
  // 取数端点不走这里：/api/im-contact-fetch/* 由 ImContactController 原生处理（前缀避开通配）。
  @Get('im-contact/{*path}')
  proxyImContactGet(@Req() req: Request) {
    if (this.config.isConfigPath(req.path)) return this.handleImContactConfig('GET', req);
    return this.unwrap(this.proxyReq(req, 'GET'));
  }
  @Post('im-contact/{*path}')
  proxyImContactPost(@Req() req: Request, @Body() body: unknown) {
    if (this.config.isConfigPath(req.path)) return this.handleImContactConfig('POST', req, body);
    return this.unwrap(this.proxyReq(req, 'POST', body));
  }
  private handleImContactConfig(
    method: 'GET' | 'POST',
    req: Request,
    body?: unknown,
  ): Promise<unknown> {
    const sess = this.configSession(req);
    if (!sess) return Promise.resolve({ ok: false, error: '未登录' });
    return method === 'GET'
      ? this.imCfg.getTeams(sess.allowed)
      : Promise.resolve(this.imCfg.setTeams(body));
  }

  // 服务质量考核设置（service-quality/targets）：纯配置端点，已迁 Nest 原生，不转发 Python。
  @Get('service-quality/{*path}')
  proxyServiceQualityGet(@Req() req: Request) {
    return this.handleConfig('GET', req);
  }
  @Post('service-quality/{*path}')
  proxyServiceQualityPost(@Req() req: Request, @Body() body: unknown) {
    return this.handleConfig('POST', req, body);
  }

  // 注意：以下三个端点已原生化，必须从这里**移除**路由：
  //   · /api/groups          → GroupsModule（Python group_picker 已删）
  //   · /api/teams           → TeamsModule（取数在 FetchModule.TeamsFetchService + 数据权限过滤）
  //   · /api/cookies/status  → StatusModule（探针在 FetchModule.CookieStatusService）
  // 同路径重复注册时 Express 只会保留先注册的那个，另一个静默失效 —— 排查成本极高。
  @Get('sheet')
  getSheet(@Req() req: Request) {
    return this.unwrap(this.proxyReq(req, 'GET'));
  }
}
