import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import {
  DeliveryRawService,
  SLEEP_MAX,
  coarseSleep,
} from '../../fetch/delivery-raw.service';
import { DbCfg, DeliveryDbService } from '../../fetch/delivery-db.service';
import { DeliveryCsvService } from '../../fetch/delivery-csv.service';

const DB_ARG_KEYS: (keyof DbCfg)[] = ['host', 'port', 'user', 'password', 'database'];

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 东八区「今天 00:00」的 Date 分量。 */
function bjNowParts(): { y: number; m: number; d: number } {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function addDays(y: number, m: number, d: number, delta: number): [number, number, number] {
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const dt = new Date(t);
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${p2(m)}-${p2(d)}`;
}

/** 运单明细入库流水线（原 jobs/delivery/run_delivery_pipeline.py）。 */
@Injectable()
export class DeliveryPipeline implements TaskHandler {
  readonly id = 'delivery_pipeline';
  readonly stages: TaskStage[] = [
    { id: 'init', name: '⚠️ DROP 重建表' },
    { id: 'raw', name: '抓运单原始层 JSONL' },
    { id: 'load', name: '逐日 upsert 入库' },
    { id: 'verify', name: '核对行数对账' },
  ];

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly raw: DeliveryRawService,
    private readonly db: DeliveryDbService,
    private readonly csv: DeliveryCsvService,
  ) {
    this.handlers.register(this);
  }

  /** --date > 区间 > 默认昨天。 */
  private resolveDays(args: Record<string, unknown>): string[] {
    const date = args['--date'] ? String(args['--date']) : '';
    const sd = args['--start-date'] ? String(args['--start-date']) : '';
    const ed = args['--end-date'] ? String(args['--end-date']) : '';
    if (date) return [date];
    if (sd || ed) {
      const [aY, aM, aD] = (sd || ed).split('-').map(Number);
      const [bY, bM, bD] = (ed || sd).split('-').map(Number);
      const start = Date.UTC(aY, aM - 1, aD);
      const end = Date.UTC(bY, bM - 1, bD);
      const out: string[] = [];
      for (let t = start; t <= end; t += 86400000) {
        const d = new Date(t);
        out.push(iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
      }
      return out;
    }
    const { y, m, d } = bjNowParts();
    const [yy, mm, dd] = addDays(y, m, d, -1);
    return [iso(yy, mm, dd)];
  }

  private dbArgs(args: Record<string, unknown>): Partial<DbCfg> {
    const out: Record<string, unknown> = {};
    for (const k of DB_ARG_KEYS) {
      const v = args[`--${k}`];
      if (v !== null && v !== undefined && v !== '') out[k] = v;
    }
    return out as Partial<DbCfg>;
  }

  private userPassed(args: Record<string, unknown>, flag: string): boolean {
    return args[flag] !== undefined && args[flag] !== null && args[flag] !== '';
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const a = ctx.args;
    const days = this.resolveDays(a);
    if (!days.length) {
      ctx.log('  ⏹ 无可抓取日期');
      return;
    }
    const hasReinit = Boolean(a['--reinit']) || Boolean(a['--confirm-init']);
    const userBegin = this.userPassed(a, '--begin');
    const userEnd = this.userPassed(a, '--end');
    const forceRawChoice = a['--force-raw'] ? true : a['--keep-raw'] ? false : null;
    const forceRaw = forceRawChoice === null ? days.length === 1 : forceRawChoice;
    const sleep = a['--sleep'] !== undefined && a['--sleep'] !== '' ? Number(a['--sleep']) : SLEEP_MAX;
    const withCsv = Boolean(a['--with-csv']);

    // 区间推断（与 Python main() 一致）：默认 raw→verify；--reinit 则 init→verify。
    if (!userBegin) {
      a['--begin'] = hasReinit ? 'init' : 'raw';
    } else if (hasReinit) {
      a['--begin'] = 'init';
      ctx.log('[reinit] 已确认「DROP 重建表」，起始节点强制改为 init（重建必须走 init，否则表建不起来）');
    }
    if (!userEnd) a['--end'] = 'verify';
    ctx.log(`[区间] 起始节点 = ${a['--begin']}（${userBegin ? '用户显式指定' : '按开关推断'}）`);

    const state: { days: string[] } = { days };
    const p = new Pipeline(ctx, state);

    p.stage('init', '⚠️ DROP 重建表', async () => {
      if (!(a['--reinit'] || a['--confirm-init'])) {
        throw new Error(
          'init 节点是危险操作（会清空全部已入库数据）。请在运行配置中勾选「DROP 重建表」，或命令行追加 --reinit / --confirm-init 后再重试。',
        );
      }
      ctx.log('⚠️ 已确认：即将 DROP 并重建 ods_delivery_tracking 表，已有数据全部丢失。');
      await this.db.doInit(this.db.loadCfg(this.dbArgs(a)), (m) => ctx.log(m));
    });

    p.stage('raw', '抓运单原始层 JSONL', async () => {
      await this.raw.initCookie();
      ctx.log(
        `[raw] 抓 ${days.length} 天: ${days[0]} ~ ${days[days.length - 1]}（force=${forceRaw}，${forceRaw ? '重抓' : '断点续传'}）`,
      );
      let ok = 0;
      let tot = 0;
      for (const d of days) {
        if (ctx.isStopped()) throw new Error('已请求终止');
        try {
          const m = await this.raw.fetchDay(d, sleep, forceRaw, (s) => ctx.log(s));
          if (m.ok) {
            ok += 1;
            tot += m.fetched || 0;
          }
        } catch (e) {
          ctx.log(`  ! ${d} 失败: ${(e as Error).name} ${(e as Error).message}`);
        }
        await coarseSleep();
      }
      ctx.log(`[raw] 完成: ${ok}/${days.length} 天成功, 共 ${tot} 条`);
      if (withCsv) this.exportCsv(days, ctx);
    });

    p.stage('load', '逐日 upsert 入库', async () => {
      const date = a['--date'] ? String(a['--date']) : null;
      await this.db.doLoad(this.db.loadCfg(this.dbArgs(a)), date, (m) => ctx.log(m));
    });

    p.stage('verify', '核对行数对账', async () => {
      await this.db.doVerify(this.db.loadCfg(this.dbArgs(a)), (m) => ctx.log(m));
    });

    await p.run();
  }

  /** 把已抓的 JSONL 本地平铺成 CSV（不打接口）。 */
  private exportCsv(days: string[], ctx: TaskRunContext): void {
    const rows: Record<string, any>[] = [];
    const miss: string[] = [];
    for (const d of days) {
      const p = path.join(this.raw.rawDir, `${d}.jsonl`);
      if (!fs.existsSync(p)) {
        miss.push(d);
        continue;
      }
      for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
        const s = line.trim();
        if (s) rows.push(JSON.parse(s));
      }
    }
    if (miss.length) {
      ctx.log(`  ⚠ 以下 ${miss.length} 天没有 JSONL 产物，已跳过：${miss.join(', ')}`);
      ctx.log('    CSV 由 raw 的 JSONL 转换而来 —— 上面这些天 raw 没抓到（或抓取失败），请先确认 raw 节点跑成功。');
    }
    if (!rows.length) {
      ctx.log('  ⏹ 没有可转换的数据，未生成 CSV');
      return;
    }
    const first = days[0].replace(/-/g, '');
    const last = days[days.length - 1].replace(/-/g, '');
    const out = `aeolus_delivery_${first}_${last}.csv`;
    this.csv.writeCsv(rows, out);
    ctx.log(`  ✓ 由 ${days.length - miss.length} 天 JSONL 转换 ${rows.length} 条 -> ${out}`);
  }
}
