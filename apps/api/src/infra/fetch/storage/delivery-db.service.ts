import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { Client as PgClient } from 'pg';
import { FIELD_ORDER } from './delivery-columns';
import { TABLE, genPgDdl, loadProfile } from './delivery-schema';
import { DeliveryRawService } from '../sources/delivery-raw.service';

/** 运单明细入库（移植 jobs/delivery/load_delivery_db.py）。 */
export interface DbCfg {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export type LogFn = (msg: string) => void;

const BATCH = 500;

@Injectable()
export class DeliveryDbService {
  private readonly logger = new Logger(DeliveryDbService.name);
  private readonly deliveryDir: string;
  private readonly cfgPath: string;

  constructor(
    private readonly config: ConfigService,
    private readonly raw: DeliveryRawService,
  ) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.deliveryDir = path.join(root, 'apps', 'api', 'runtime', 'jobs', 'delivery');
    this.cfgPath = path.join(this.deliveryDir, 'db_config.json');
  }

  /** 连接配置：默认 < db_config.json < 环境变量 < 显式覆盖。 */
  loadCfg(overrides: Partial<DbCfg> = {}): DbCfg {
    const cfg: Record<string, unknown> = {
      host: '127.0.0.1',
      port: 5432,
      user: 'admin',
      password: '',
      database: 'postgres',
    };
    if (fs.existsSync(this.cfgPath)) {
      Object.assign(cfg, JSON.parse(fs.readFileSync(this.cfgPath, 'utf-8')));
    }
    const envMap: [string, string][] = [
      ['host', 'DB_HOST'],
      ['port', 'DB_PORT'],
      ['user', 'DB_USER'],
      ['password', 'DB_PASSWORD'],
      ['database', 'DB_NAME'],
    ];
    for (const [k, env] of envMap) {
      const v = process.env[env];
      if (v) cfg[k] = k === 'port' ? Number(v) : v;
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== null && v !== undefined && v !== '') cfg[k] = v;
    }
    cfg.port = Number(cfg.port);
    return cfg as unknown as DbCfg;
  }

  private async connect(cfg: DbCfg): Promise<PgClient> {
    const c = new PgClient({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
    await c.connect();
    return c;
  }

  /** 原值保真：null→NULL，标量→字符串原样，复合→紧凑 JSON。 */
  private toCell(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  }

  /** 业务日期：trackingFinishAt → completeAt → trackingCreatedAt（北京时间）。 */
  private statDateOf(rec: Record<string, any>, fallback: string): string {
    const ts = rec.trackingFinishAt || rec.completeAt || rec.trackingCreatedAt;
    const ms = Number(String(ts));
    if (!Number.isFinite(ms) || ms <= 0) return fallback;
    const d = new Date(ms + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  private async execStatements(cfg: DbCfg, ddl: string): Promise<void> {
    const conn = await this.connect(cfg);
    try {
      for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
    } finally {
      await conn.end();
    }
  }

  /** DROP + 重建表（危险：清空全部已入库数据）。 */
  async doInit(cfg: DbCfg, log: LogFn): Promise<void> {
    const prof = loadProfile(this.deliveryDir);
    await this.execStatements(cfg, genPgDdl(prof, true));
    log(
      `已在 PG \`${cfg.database}\` 建表 \`${TABLE}\`（${FIELD_ORDER.length} 原始列 + 4 派生列，中文名写入 COMMENT）`,
    );
  }

  private async tableExists(cfg: DbCfg): Promise<boolean> {
    const conn = await this.connect(cfg);
    try {
      const r = await conn.query('SELECT to_regclass($1) IS NOT NULL AS e', [TABLE]);
      return Boolean(r.rows[0]?.e);
    } finally {
      await conn.end();
    }
  }

  /** load 前兜底：表不在就建（CREATE IF NOT EXISTS，不 DROP）。返回是否新建。 */
  async ensureTable(cfg: DbCfg, log: LogFn): Promise<boolean> {
    if (await this.tableExists(cfg)) return false;
    const prof = loadProfile(this.deliveryDir);
    await this.execStatements(cfg, genPgDdl(prof, false));
    log(`[auto-init] 表 \`${TABLE}\` 不存在，已自动创建（${FIELD_ORDER.length} 原始列 + 4 派生列）`);
    return true;
  }

  private insertCols(): string[] {
    return [...FIELD_ORDER, 'stat_date', 'extra_json'];
  }

  private buildSql(): string {
    const cols = this.insertCols();
    const colsQuoted = cols.map((c) => `"${c}"`).join(',');
    const upd = cols
      .filter((c) => c !== 'trackingId')
      .map((c) => `"${c}"=EXCLUDED."${c}"`)
      .join(',');
    return `INSERT INTO "${TABLE}" (${colsQuoted}) VALUES %%VALUES%% ON CONFLICT ("trackingId") DO UPDATE SET ${upd}`;
  }

  private async loadFile(conn: PgClient, file: string, sqlTemplate: string, log: LogFn): Promise<number> {
    const day = path.basename(file).replace('.jsonl', '');
    const known = new Set(FIELD_ORDER);
    const cols = this.insertCols();
    const rows: (string | null)[][] = [];
    const extraKeys = new Set<string>();
    let skipped = 0;

    const content = fs.readFileSync(file, 'utf-8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const rec = JSON.parse(line) as Record<string, any>;
      if (!rec.trackingId) {
        skipped += 1;
        continue;
      }
      const ex: Record<string, any> = {};
      for (const [k, v] of Object.entries(rec)) if (!known.has(k)) ex[k] = v;
      for (const k of Object.keys(ex)) extraKeys.add(k);
      const vals = FIELD_ORDER.map((c) => this.toCell(rec[c]));
      vals.push(this.statDateOf(rec, day));
      vals.push(Object.keys(ex).length ? JSON.stringify(ex) : null);
      rows.push(vals);
    }

    let affected = 0;
    const colCount = cols.length;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const placeholders = chunk
        .map(
          (_, ri) =>
            `(${cols.map((_, ci) => `$${ri * colCount + ci + 1}`).join(',')})`,
        )
        .join(',');
      const sql = sqlTemplate.replace('%%VALUES%%', placeholders);
      const r = await conn.query(sql, chunk.flat());
      affected += r.rowCount ?? 0;
    }
    let note = extraKeys.size ? ` 新增字段${JSON.stringify([...extraKeys].sort())}` : '';
    if (skipped) note += ` 跳过无ID ${skipped} 行`;
    log(`  ${day}: 读取 ${rows.length} 行 -> upsert 影响 ${affected}${note}`);
    return rows.length;
  }

  async doLoad(cfg: DbCfg, onlyDate: string | null, log: LogFn): Promise<void> {
    const dir = this.raw.rawDir;
    let files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f))
      : [];
    if (onlyDate) files = files.filter((f) => path.basename(f).startsWith(onlyDate));
    if (!files.length) {
      log(`${dir} 下无 jsonl 文件`);
      return;
    }
    await this.ensureTable(cfg, log);
    const sqlTemplate = this.buildSql();
    const conn = await this.connect(cfg);
    let total = 0;
    let cnt = 0;
    try {
      log(`入库 ${files.length} 个日期文件 -> \`${cfg.database}\`.\`${TABLE}\``);
      for (const p of files) total += await this.loadFile(conn, p, sqlTemplate, log);
      const r = await conn.query(`SELECT COUNT(*)::int AS c FROM "${TABLE}"`);
      cnt = r.rows[0]?.c ?? 0;
    } finally {
      await conn.end();
    }
    log(`完成：本次读取 ${total} 行，表内现有 ${cnt} 行`);
  }

  async doVerify(cfg: DbCfg, log: LogFn): Promise<void> {
    await this.ensureTable(cfg, log);
    const conn = await this.connect(cfg);
    let dbRows: Record<string, number> = {};
    let cnt = 0;
    let dmin: string | null = null;
    let dmax: string | null = null;
    try {
      const r1 = await conn.query(
        `SELECT "stat_date", COUNT(*)::int AS c FROM "${TABLE}" GROUP BY "stat_date" ORDER BY "stat_date"`,
      );
      for (const row of r1.rows) {
        const k = row.stat_date instanceof Date ? row.stat_date.toISOString().slice(0, 10) : String(row.stat_date);
        dbRows[k] = row.c;
      }
      const r2 = await conn.query(
        `SELECT COUNT(*)::int AS c, MIN("stat_date") AS dmin, MAX("stat_date") AS dmax FROM "${TABLE}"`,
      );
      cnt = r2.rows[0]?.c ?? 0;
      dmin = r2.rows[0]?.dmin ?? null;
      dmax = r2.rows[0]?.dmax ?? null;
    } finally {
      await conn.end();
    }
    if (!cnt) {
      log('表内暂无数据，无从对账。请先跑 load 节点把 delivery_raw 下的 jsonl 入库。');
      return;
    }
    const fmt = (v: unknown) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : '';
    log(`表内共 ${cnt} 行，日期范围 ${fmt(dmin)} ~ ${fmt(dmax)}\n`);
    log('日期'.padEnd(12) + '接口total'.padStart(10) + '库内行数'.padStart(10) + '差异'.padStart(8));
    let bad = 0;
    const metas = fs
      .readdirSync(this.raw.rawDir)
      .filter((f) => f.endsWith('.meta.json'))
      .sort();
    for (const mf of metas) {
      const m = JSON.parse(fs.readFileSync(path.join(this.raw.rawDir, mf), 'utf-8'));
      const d = String(m.date);
      const api = Number(m.total ?? 0);
      const got = dbRows[d] ?? 0;
      const diff = got - api;
      const flag = Math.abs(diff) <= Math.max(3, api * 0.005) ? '' : '  <-- 偏差偏大';
      if (flag) bad += 1;
      log(
        d.padEnd(12) +
          String(api).padStart(10) +
          String(got).padStart(10) +
          String(diff).padStart(8) +
          flag,
      );
    }
    log(bad ? `\n${bad} 个日期偏差偏大，建议 --force 重抓` : '\n全部日期行数正常');
  }
}
