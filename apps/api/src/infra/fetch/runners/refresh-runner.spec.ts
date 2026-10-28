import { ForbiddenException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import * as os from 'os';
import { AuthService } from '../../../modules/auth/auth.service';
import { DataPermService } from '../../../modules/auth/data-perm.service';
import { ComputeService } from '../../../modules/compute/compute.service';
import { FetchPaceService } from './fetch-pace.service';
import { RefreshAllService } from './refresh-all.service';
import { RefreshRunnerService } from './refresh-runner.service';
import { TeamsFetchService } from '../sources/teams-fetch.service';
import { PgService } from '../../../modules/pg/pg.service';
import * as netErr from '../../../common/net-error';

/**
 * 全量刷新的「作用域收敛 / 频控 / 单飞 / 阶段 0 失败语义」回归。
 *
 * 这些用例原在 Python `tests/test_data_scope.py`（打桩 `RA.start` 捕获入参）。随编排迁到
 * NestJS 后，被测对象变成 `RefreshRunnerService` —— 用例跟着逻辑走，而不是留在 Python 里
 * 测一个已不存在的 handler。
 *
 * 覆盖的都是「改坏了不会报错、只会静默失效」的行为，其中两条是真边界：
 * 无可见站点时绝不能回落全量（越权）、阶段 0 失败绝不能降级（那会恢复已删除的本地拉取）。
 */
const ALL_TEAMS = ['917521130', '917521136', '917521139'];
/** 北京时区的今天（与编排的 todayYmd() 同口径），用于绕过「历史日期护栏」。 */
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
/** 与编排的 REFRESH_MAX_SEC 对齐：watchdog 触发阈值（毫秒）。 */
const WATCHDOG_MS = 900 * 1000;

function makeReq(user?: string): Request {
  const headers: Record<string, string> = {};
  if (user) headers['x-token'] = `tok-${user}`;
  return { headers, query: {}, ip: '127.0.0.1' } as unknown as Request;
}

describe('RefreshRunnerService —— 作用域收敛 / 频控 / 单飞', () => {
  let runner: RefreshRunnerService;
  let startSpy: jest.SpyInstance;
  let ordersStage: { refreshOrders: jest.Mock };
  let compute: { proxy: jest.Mock };
  let session: { user: string; role: string } | null;
  let allowed: string[] | null;

  beforeEach(async () => {
    session = null;
    allowed = null;
    ordersStage = { refreshOrders: jest.fn().mockResolvedValue({ ok: true, total: 0, hit: 0 }) };
    compute = { proxy: jest.fn().mockResolvedValue({ ok: true, data: { ok: true } }) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RefreshRunnerService,
        // PROJECT_ROOT 指到临时目录：编排会写日志文件，别污染仓库。
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'PROJECT_ROOT' ? os.tmpdir() : undefined) },
        },
        { provide: RefreshAllService, useValue: ordersStage },
        {
          provide: TeamsFetchService,
          useValue: {
            fetchAll: jest.fn().mockResolvedValue({
              ok: true,
              teams: [],
              source: 'xtop',
              stale: false,
              fetched_at: 0,
            }),
          },
        },
        {
          provide: FetchPaceService,
          useValue: { statsReset: jest.fn(), statsSnapshot: () => ({ requests: 0 }) },
        },
        { provide: ComputeService, useValue: compute },
        { provide: AuthService, useValue: { getSession: jest.fn(() => session) } },
        { provide: DataPermService, useValue: { resolveAllowed: jest.fn(() => allowed) } },
        // 失败现场取证会查连接池体检指标：给个空实现，避免用例依赖真实 PG。
        { provide: PgService, useValue: { poolStats: () => null } },
      ],
    }).compile();

    runner = moduleRef.get(RefreshRunnerService);
    // 「参与站点」由 Python teams-config 提供；这里打桩，聚焦作用域收敛本身。
    jest.spyOn(runner, 'configuredTeams').mockResolvedValue([...ALL_TEAMS]);
    // 现场取证（DNS/TCP/连接池）在单测里必须打桩：它默认会真的解析域名、连 443，
    // 既慢又依赖外网。它挂死曾经把整个刷新卡死过，故这里连「会不会被调用」一起测。
    jest.spyOn(netErr, 'probeRuntime').mockResolvedValue('probe=stub');
    // 不真跑刷新（会拉真实接口、耗时数分钟）：只捕获被下发的刷新范围。
    startSpy = jest.spyOn(runner, 'start').mockResolvedValue({ ok: true, msg: '已启动' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('无会话（系统 / iframe）：不收敛，由 start 自行取全量参与站点', async () => {
    await runner.startFromRequest(makeReq(), {});
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0][0].teams).toBeUndefined();
  });

  it('受限用户不指定站点：只刷「参与站点 ∩ 可见站点」', async () => {
    session = { user: 'u1', role: 'r' };
    allowed = ['917521136'];
    await runner.startFromRequest(makeReq('u1'), {});
    expect(startSpy.mock.calls[0][0].teams).toEqual(['917521136']);
  });

  it('显式指定越权站点：403 + DATA_SCOPE_DENIED，且不得启动刷新', async () => {
    session = { user: 'u1', role: 'r' };
    allowed = ['917521136'];

    await expect(
      runner.startFromRequest(makeReq('u1'), { teams: ['917521139'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('显式指定「授权 + 越权」混合：只保留授权站点', async () => {
    session = { user: 'u1', role: 'r' };
    allowed = ['917521136'];
    await runner.startFromRequest(makeReq('u1'), { teams: ['917521136', '917521139'] });
    expect(startSpy.mock.calls[0][0].teams).toEqual(['917521136']);
  });

  it('关键边界：可见站点与参与站点交集为空必须 403，绝不能回落成全量', async () => {
    // start() 内部有 `if (!teams.length) teams = await configuredTeams()`，空集会回落成
    // 全量参与站点 —— 等于「一个可见站点都没有的用户反而能刷全部」的越权。
    session = { user: 'u1', role: 'r' };
    allowed = ['000000000']; // 不在任何参与站点里

    await expect(runner.startFromRequest(makeReq('u1'), {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('单飞：已有刷新在跑时返回 already_running，不重复启动', async () => {
    (runner as unknown as { state: { running: boolean } }).state.running = true;
    const r = await runner.startFromRequest(makeReq(), {});
    expect(r.already_running).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('频控：窗口内的第二次请求返回 429 + RATE_LIMITED（含 retry_after）', async () => {
    await runner.startFromRequest(makeReq(), {});
    try {
      await runner.startFromRequest(makeReq(), {});
      throw new Error('第二次请求应当被频控拒绝');
    } catch (e) {
      const err = e as HttpException;
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      const body = err.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('RATE_LIMITED');
      expect(typeof body.retry_after).toBe('number');
    }
  });

  it('历史日期护栏：非当天且未 force → 拒绝启动', async () => {
    startSpy.mockRestore(); // 这里要测 start() 本体
    const r = await runner.start({ teams: [...ALL_TEAMS], start: '2020-01-01', end: '2020-01-01' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('拒绝刷新历史日期');
  });

  it('status 形状与迁移前一致（前端只读 running 与 error[]）', () => {
    const s = runner.status();
    expect(s).toMatchObject({ running: false, total: 0, done: 0, teams: [], error: null });
    expect(typeof s.server_time).toBe('string');
  });

  it('阶段 0 失败：整体失败，不降级为逐站拉取（本地回退路径已移除）', async () => {
    // 本地（Python）运单拉取已删除 ⇒ 阶段 0 是唯一来源，失败必须整体失败。
    ordersStage.refreshOrders.mockRejectedValueOnce(new Error('fetch boom'));
    const st = runner as unknown as {
      state: { teams: unknown[] };
      run: (t: string[], s: string, e: string) => Promise<void>;
    };
    st.state.teams = [
      { id: '917521136', name: 'A', status: 'pending', msg: '', rows: 0 },
    ];

    await st.run(['917521136'], '2026-09-23', '2026-09-23');

    const snap = runner.status();
    expect(snap.running).toBe(false);
    expect(snap.teams[0].status).toBe('error');
    expect(snap.error?.[0]?.error).toContain('阶段 0 取数失败');
    // 关键：一次计算步调用都不该发生（没有降级）。
    expect(compute.proxy).not.toHaveBeenCalled();
  });

  // ---- 卡死兜底（2026-10-27 事故回归）----
  // 事故：阶段 0 失败后进 catch 做现场取证，`dns.promises.lookup` 在宿主 DNS 无响应时
  // 永不 settle ⇒ catch 永不返回 ⇒ `finally` 不执行 ⇒ `running` 永久 true ⇒ 前端按钮
  // 永远「刷新中…」，只能重启后端。以下两例锁住「刷新永远不会把自己锁死」这条底线。
  it('watchdog：超时未完成会强制收尾，running 复位（按钮不会永久「刷新中」）', async () => {
    startSpy.mockRestore(); // 测 start() 本体：它会 arm watchdog
    jest.useFakeTimers();
    // 阶段 0 永久挂起：模拟某个 await 永不返回
    ordersStage.refreshOrders.mockReturnValue(new Promise(() => {}));

    await runner.start({ teams: [...ALL_TEAMS], start: TODAY, end: TODAY });
    expect(runner.status().running).toBe(true);

    jest.advanceTimersByTime(WATCHDOG_MS + 10);

    const snap = runner.status();
    expect(snap.running).toBe(false);
    expect(snap.error?.length).toBeGreaterThan(0);
    expect(String(snap.error?.[0]?.error)).toContain('强制结束');
    jest.useRealTimers();
  });

  it('watchdog 收尾后，迟到的那一轮不得把状态覆盖回「完成」', async () => {
    startSpy.mockRestore();
    jest.useFakeTimers();
    let release: () => void = () => {};
    ordersStage.refreshOrders.mockReturnValue(
      new Promise((r) => {
        release = () => r({ ok: true, total: 0, hit: 0, perTeam: [], distinctTeams: [] });
      }),
    );

    await runner.start({ teams: [...ALL_TEAMS], start: TODAY, end: TODAY });
    jest.advanceTimersByTime(WATCHDOG_MS + 10);
    expect(runner.status().running).toBe(false);
    expect(runner.status().current_stage).toBe('超时终止');

    // 卡住的 await 很久之后才返回：它的收尾必须被识别为「已过期」，不得抹掉超时结论。
    release();
    jest.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));

    const snap = runner.status();
    expect(snap.running).toBe(false);
    expect(snap.current_stage).toBe('超时终止');
    expect(snap.error?.length).toBeGreaterThan(0);
  });
});
