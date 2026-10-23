import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { RawCacheService, todayYmd, nowStamp } from './raw-cache.service';

/**
 * 原始层落盘的跨语言契约测试。
 *
 * `RawCacheService` 是 `apps/api/runtime/raw/*.json` 的**唯一写入方**，读侧是 Python
 * （`dashboard/standard/cache.load_raw` 与 `dashboard/realtime/violations.load_team_raw`）。
 * 格式一错，Python 计算会静默读到 None（表现为「看板没数据」而不是报错），所以这里把
 * 字节级形状钉住；Python 侧对同一形状的消费行为见 `tests/test_data_scope.py`。
 */
describe('RawCacheService（原始层唯一写入方）', () => {
  let root: string;
  let svc: RawCacheService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rawcache-'));
    // 统一契约（paths.ts）通过 env 取仓库根；测试与其共用同一临时根，
    // 否则 production 的 dirs.runtime() 解析出的根与 spec 的 file() 不一致。
    process.env.PROJECT_ROOT = root;
    const cfg = {
      get: (k: string) => (k === 'PROJECT_ROOT' ? root : undefined),
    } as unknown as ConfigService;
    svc = new RawCacheService(cfg);
  });

  afterEach(() => {
    delete process.env.PROJECT_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = (kind: string, team: string, date: string) =>
    path.join(root, 'apps', 'api', 'runtime', 'raw', `${kind}_${team}_${date}.json`);
  const read = (kind: string, team: string, date: string) =>
    JSON.parse(fs.readFileSync(file(kind, team, date), 'utf-8'));

  it('路径与字节级格式与 Python save_raw 一致（无缩进、UTF-8 原样）', () => {
    const payload = [{ a: 1, 中文: '值' }];
    expect(svc.saveRaw('sched', '917521136', payload, '2026-09-21')).toBe(true);

    expect(fs.existsSync(file('sched', '917521136', '2026-09-21'))).toBe(true);
    // Python 侧是 json.dump(..., ensure_ascii=False)：不能有缩进、中文不能被转义成 \uXXXX
    expect(fs.readFileSync(file('sched', '917521136', '2026-09-21'), 'utf-8')).toBe(
      JSON.stringify(payload),
    );
    expect(fs.readFileSync(file('sched', '917521136', '2026-09-21'), 'utf-8')).toContain('中文');
  });

  it('空 payload 不写（避免把已有数据冲成空）', () => {
    expect(svc.saveRaw('orders', 't', [], '2026-09-21')).toBe(false);
    expect(svc.saveRaw('orders', 't', {}, '2026-09-21')).toBe(false);
    expect(svc.saveRaw('orders', 't', '', '2026-09-21')).toBe(false);
    expect(svc.saveRaw('orders', 't', null, '2026-09-21')).toBe(false);
    expect(fs.existsSync(file('orders', 't', '2026-09-21'))).toBe(false);
  });

  it('非空 payload 会覆盖旧文件', () => {
    svc.saveRaw('att', 't', { tc: '1', rows: [1, 2] }, '2026-09-21');
    svc.saveRaw('att', 't', { tc: '2', rows: [3] }, '2026-09-21');
    expect(read('att', 't', '2026-09-21')).toEqual({ tc: '2', rows: [3] });
  });

  it('kind 非法时抛错（与 Python save_raw 的 ValueError 对应）', () => {
    expect(() => svc.saveRaw('nope' as never, 't', [1], '2026-09-21')).toThrow(
      /未知原始数据类型/,
    );
  });

  describe('违规明细包装（与 Python load_team_raw 的跨语言契约）', () => {
    it('成功：fetch_ok=true、fetch_error=null、字段集与格式固定', () => {
      expect(svc.saveViolation('917521136', '2026-09-21', [{ a: 1 }])).toBe(true);

      const j = read('violation', '917521136', '2026-09-21');
      // 字段集固定：Python 读侧按这些键判断，多/少一个都会让「未刷新」与「已刷新」混淆
      expect(Object.keys(j).sort()).toEqual(
        ['date', 'fetch_error', 'fetch_ok', 'fetched_at', 'rows', 'team_id'].sort(),
      );
      expect(j).toMatchObject({
        date: '2026-09-21',
        team_id: '917521136', // 必须是字符串（Python 侧按 str 比对）
        fetch_ok: true,
        fetch_error: null,
        rows: [{ a: 1 }],
      });
      // fetched_at 是 Python 侧展示用的北京时间戳
      expect(j.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('失败：fetch_ok=false、错误截断 300 字符、旧 rows 保留、0 条也落盘', () => {
      svc.saveViolation('t', '2026-09-21', [], false, 'x'.repeat(500));

      const j = read('violation', 't', '2026-09-21');
      expect(j.fetch_ok).toBe(false);
      expect(j.fetch_error).toHaveLength(300); // 与 Python save_team 的 [:300] 一致
      // payload 是包装 dict（非空），所以「已刷新但 0 条」也必须落盘
      expect(fs.existsSync(file('violation', 't', '2026-09-21'))).toBe(true);
      expect(j.rows).toEqual([]);
    });

    it('失败但 error 为空时不写 null 以外的值', () => {
      svc.saveViolation('t', '2026-09-21', [{ a: 1 }], false, '');
      expect(read('violation', 't', '2026-09-21').fetch_error).toBeNull();
    });
  });

  it('todayYmd / nowStamp 用北京时间（UTC+8）', () => {
    // 2026-09-21 16:30 UTC == 2026-09-22 00:30 北京
    const d = new Date('2026-09-21T16:30:00Z');
    expect(todayYmd(d)).toBe('2026-09-22');
    expect(nowStamp(d)).toBe('2026-09-22 00:30:00');
  });
});
