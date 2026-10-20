import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../pg/pg.service';

type Row = Record<string, unknown>;

// ----------------------------------------------------------------- 常量（对齐 todo_store.py）
export const STATUS_OPEN = 'open';
export const STATUS_DONE = 'done';

// 执行记录状态
export const RUN_RUNNING = 'running';
export const RUN_RETRYING = 'retrying';
export const RUN_SUCCESS = 'success';
export const RUN_FAILED = 'failed';
export const RUN_SKIPPED = 'skipped';
export const RUN_MISSED = 'missed';

export const MAX_ATTEMPTS = 3; // 1 次正式 + 2 次重试
export const RETRY_DELAYS = [60, 300]; // 第 1、2 次重试退避秒数
export const CATCHUP_GRACE_SEC = 15 * 60; // 重启补跑宽限

const WEEKDAY_CN: Record<number, string> = {
  1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日',
};

// ----------------------------------------------------------------- 表结构（PG，最终态）
const PG_DDL = `
CREATE TABLE IF NOT EXISTS cron_list (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  icon        TEXT    NOT NULL DEFAULT 'list-checks',
  color       TEXT    NOT NULL DEFAULT '#FF5000',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS cron_item (
  id              TEXT PRIMARY KEY,
  list_id         TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  note            TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'open',
  done_at         TEXT,
  done_count      INTEGER NOT NULL DEFAULT 0,
  flag            INTEGER NOT NULL DEFAULT 0,
  remind_at       TEXT,
  repeat_type     TEXT    NOT NULL DEFAULT 'none',
  repeat_interval INTEGER NOT NULL DEFAULT 1,
  repeat_by       TEXT    NOT NULL DEFAULT '',
  repeat_end      TEXT    NOT NULL DEFAULT '',
  task_id         TEXT,
  task_args       TEXT    NOT NULL DEFAULT '{}',
  auto_run        INTEGER NOT NULL DEFAULT 0,
  last_run_at     TEXT,
  last_run_status TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  remind_times    TEXT    NOT NULL DEFAULT '[]',
  timeout         INTEGER NOT NULL DEFAULT 0,
  queue_run       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cron_run (
  id          SERIAL PRIMARY KEY,
  item_id     TEXT    NOT NULL,
  fire_key    TEXT    NOT NULL UNIQUE,
  due_at      TEXT,
  started_at  TEXT,
  finished_at TEXT,
  status      TEXT    NOT NULL,
  attempt     INTEGER NOT NULL DEFAULT 1,
  retry_at    TEXT,
  run_id      TEXT,
  message     TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cron_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_list_status ON cron_item(list_id, status);
CREATE INDEX IF NOT EXISTS idx_item_due ON cron_item(remind_at)
  WHERE auto_run=1 AND status='open';
CREATE INDEX IF NOT EXISTS idx_item_remind ON cron_item(remind_at);
CREATE INDEX IF NOT EXISTS idx_run_item ON cron_run(item_id, due_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_open ON cron_run(status)
  WHERE status IN ('running','retrying');
`;

/** 工作内容 PostgreSQL 持久层（移植自 workbench/todo_store.py，去掉 SQLite 迁移脚手架）。 */
@Injectable()
export class CronStoreService implements OnModuleInit {
  private readonly logger = new Logger(CronStoreService.name);
  // 单例 Promise：保证 PG_DDL（含 CREATE TABLE 自动建的复合类型）在并发初始化下只执行一次，
  // 避免 onModuleInit 与 scheduler.onModuleInit 同时调用 initDb 导致的类型竞态。
  private static initPromise: Promise<void> | null = null;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    await this.initDb();
  }

  // ------------------------------------------------------------ 连接
  private async all(sql: string, ...params: any[]): Promise<Row[]> {
    return this.pg.query<Row>(sql, params);
  }

  private async one(sql: string, ...params: any[]): Promise<Row | undefined> {
    const rows = await this.pg.query<Row>(sql, params);
    return rows[0];
  }

  private async run(sql: string, ...params: any[]): Promise<void> {
    await this.pg.query(sql, params);
  }

  // ------------------------------------------------------------ 键值设置（全局开关等）
  async getMeta(key: string, def = ''): Promise<string> {
    const row = await this.one('SELECT value FROM cron_kv WHERE key=$1', key);
    return row ? String(row['value']) : def;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.run(
      'INSERT INTO cron_kv(key,value) VALUES($1,$2) ' +
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, value,
    );
  }

  /** 全局「自动执行」主开关是否被暂停（关掉后调度器不再自动点火）。 */
  async isAutoPaused(): Promise<boolean> {
    return (await this.getMeta('auto_paused', '0')) === '1';
  }

  // ------------------------------------------------------------ 迁移 / 初始化
  /** PG 为最终态建表，无需逐版本迁移；返回 [0,5] 兼容旧调用方语义。 */
  async initDb(): Promise<[number, number]> {
    if (!CronStoreService.initPromise) {
      CronStoreService.initPromise = (async () => {
        await this.pg.query(PG_DDL);
        await this.seedDefaultLists();
      })();
    }
    await CronStoreService.initPromise;
    return [0, 5];
  }

  private async seedDefaultLists(): Promise<void> {
    const now = this.nowStr();
    const defaults: [string, string, string, string][] = [
      ['l_work', '工作', 'list-checks', '#FF5000'],
      ['l_station', '站点', 'store', '#1A73E8'],
      ['l_temp', '临时', 'lightbulb', '#F5A623'],
    ];
    for (const [lid, name, icon, color] of defaults) {
      await this.run(
        'INSERT INTO cron_list(id,name,icon,color,sort_order,created_at,updated_at) ' +
          'VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
        lid, name, icon, color, 0, now, now,
      );
    }
  }

  // ------------------------------------------------------------ 基础工具
  private nowStr(): string {
    return this.fmtLocal(new Date()) || '';
  }

  private nowFull(): string {
    return new Date().toISOString().slice(0, 19).replace('T', ' ').replace('Z', '');
  }

  fmtLocal(d: Date | null): string | null {
    if (!d) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  parseDt(s: string | null | undefined): Date | null {
    const str = (s || '').toString().trim();
    if (!str) return null;
    // 纯日期 → 当天 00:00
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(`${str}T00:00:00`);
    // 日期+时间（可选含秒），统一规范为「YYYY-MM-DDTHH:mm:ss」以本地时区解析
    const m = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/);
    if (m) return new Date(`${m[1]}:${m[2] ? m[2].slice(1) : '00'}`);
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  /** 在指定日期 day 上叠加时间 t（"HH:mm" 或 "HH:mm:ss"）返回 Date。 */
  private mkDayTime(day: Date, t: string): Date {
    const parts = t.split(':').map((x) => parseInt(x, 10));
    const d = new Date(day);
    d.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
    return d;
  }

  fireKey(itemId: string, dueAt: string | null | undefined): string {
    return `${itemId}#${dueAt || ''}`;
  }

  private uid(prefix: string): string {
    return prefix + randomUUID().replace(/-/g, '').slice(0, 12);
  }

  // ------------------------------------------------------------ 重复规则
  ruleOf(row: Row | null | undefined): {
    type: string; interval: number; by: string; end: string;
  } {
    if (!row) return { type: 'none', interval: 1, by: '', end: '' };
    return {
      type: (row['repeat_type'] as string) || 'none',
      interval: Number(row['repeat_interval'] || 1),
      by: (row['repeat_by'] as string) || '',
      end: (row['repeat_end'] as string) || '',
    };
  }

  normalizeRule(d: unknown): { type: string; interval: number; by: string; end: string } {
    if (!d || typeof d !== 'object') return { type: 'none', interval: 1, by: '', end: '' };
    const obj = d as Record<string, unknown>;
    let t = String(obj['type'] || 'none').toLowerCase();
    if (!['none', 'daily', 'weekly', 'monthly', 'custom'].includes(t)) t = 'none';
    let n = parseInt(String(obj['interval'] || '1'), 10);
    if (isNaN(n)) n = 1;
    n = Math.max(1, Math.min(999, n));

    let by = '';
    if (t === 'weekly') {
      const days = Array.from(
        new Set(
          String(obj['by'] || '')
            .match(/\d+/g)
            ?.map((x) => parseInt(x, 10))
            .filter((x) => x >= 1 && x <= 7) || [],
        ),
      ).sort((a, b) => a - b);
      by = days.join(',');
    } else if (t === 'monthly') {
      const raw = String(obj['by'] || '').trim();
      if (raw.toUpperCase() === 'L') by = 'L';
      else {
        const m = raw.match(/\d+/);
        by = m ? String(Math.max(1, Math.min(31, parseInt(m[0], 10)))) : '';
      }
    }

    let end = String(obj['end'] || '').trim();
    if (end) {
      const dt = this.parseDt(end);
      end = dt ? dt.toISOString().slice(0, 10) : '';
    }
    if (t === 'none') return { type: 'none', interval: 1, by: '', end: '' };
    return { type: t, interval: n, by, end };
  }

  /** 解析时间列表（"HH:mm" 或 "HH:mm:ss" 数组），过滤非法值并按时间排序。支持直接传数组或 JSON 字符串。 */
  parseTimes(raw: unknown): string[] {
    let arr: unknown[];
    if (Array.isArray(raw)) arr = raw;
    else if (typeof raw === 'string' && raw.trim()) {
      try { arr = JSON.parse(raw); } catch { return []; }
    } else return [];
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => String(x || '').trim())
      .filter((x) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(x))
      .sort();
  }

  describeRule(rule: { type: string; interval: number; by: string; end?: string }): string {
    const t = rule.type || 'none';
    const n = Math.max(1, rule.interval || 1);
    const by = rule.by || '';
    let s = '不重复';
    if (t === 'daily') s = n === 1 ? '每天' : `每 ${n} 天`;
    else if (t === 'weekly') {
      const days = by.split(',').filter(Boolean).map((x) => parseInt(x, 10));
      const names = days.map((d) => WEEKDAY_CN[d] || String(d)).join('、') || '当天';
      s = n === 1 ? `每${names}` : `每 ${n} 周的 ${names}`;
    } else if (t === 'monthly') {
      if (by.toUpperCase() === 'L') s = n === 1 ? '每月最后一天' : `每 ${n} 个月的最后一天`;
      else {
        const day = by || '1';
        s = n === 1 ? `每月 ${day} 日` : `每 ${n} 个月的 ${day} 日`;
      }
    } else if (t === 'custom') s = `每 ${n} 小时`;
    if (rule.end) s += `（至 ${rule.end}）`;
    return s;
  }

  private lastDay(y: number, m: number): number {
    if (m === 12) return 31;
    return new Date(y, m, 0).getDate();
  }

  /** 严格晚于 now 的下一次到期（对齐 compute_next_due）。 */
  computeNextDue(rule: { type: string; interval: number; by: string; end: string },
                 anchorStr: string, nowDt?: Date): Date | null {
    const t = rule.type || 'none';
    if (t === 'none') return null;
    const anchor = this.parseDt(anchorStr);
    if (!anchor) return null;
    const now = nowDt || new Date();
    const n = Math.max(1, rule.interval || 1);
    const end = this.parseDt(rule.end);
    const endDay = end ? end.toISOString().slice(0, 10) : null;
    const tm = { h: anchor.getHours(), m: anchor.getMinutes(), s: anchor.getSeconds() };

    const ok = (cand: Date | null): Date | null => {
      if (!cand) return null;
      if (endDay && cand.toISOString().slice(0, 10) > endDay) return null;
      return cand;
    };
    const mk = (day: Date): Date => {
      const d = new Date(day);
      d.setHours(tm.h, tm.m, tm.s, 0);
      return d;
    };

    if (t === 'daily') {
      let d = new Date(anchor); d.setHours(0, 0, 0, 0);
      const step = n;
      for (let i = 0; i < 4000; i++) {
        const cand = mk(d);
        if (cand > now) return ok(cand);
        d.setDate(d.getDate() + step);
      }
      return null;
    }
    if (t === 'custom') {
      const stepMs = n * 3600 * 1000;
      let cand: Date;
      if (anchor > now) cand = anchor;
      else {
        const k = Math.floor((now.getTime() - anchor.getTime()) / stepMs) + 1;
        cand = new Date(anchor.getTime() + stepMs * k);
      }
      while (cand <= now) cand = new Date(cand.getTime() + stepMs);
      return ok(cand);
    }
    if (t === 'weekly') {
      let days = (rule.by || '').split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 7);
      if (!days.length) days = [anchor.getDay() === 0 ? 7 : anchor.getDay()];
      const anchorWeek = new Date(anchor); anchorWeek.setHours(0, 0, 0, 0);
      anchorWeek.setDate(anchorWeek.getDate() - ((anchorWeek.getDay() + 6) % 7)); // 周一为一周起点
      let d = new Date(Math.max(anchor.getTime(), now.getTime())); d.setHours(0, 0, 0, 0);
      for (let i = 0; i < 1200; i++) {
        const thisWeek = new Date(d); thisWeek.setDate(thisWeek.getDate() - ((thisWeek.getDay() + 6) % 7));
        const diff = Math.round((thisWeek.getTime() - anchorWeek.getTime()) / 86400000 / 7);
        const iso = ((d.getDay() + 6) % 7) + 1;
        if (diff >= 0 && diff % n === 0 && days.includes(iso)) {
          const cand = mk(d);
          if (cand > now) return ok(cand);
        }
        d.setDate(d.getDate() + 1);
      }
      return null;
    }
    if (t === 'monthly') {
      const raw = rule.by || '';
      const useLast = raw.toUpperCase() === 'L';
      const m = raw.match(/\d+/);
      const dom = m ? Math.max(1, Math.min(31, parseInt(m[0], 10))) : anchor.getDate();
      const base = new Date(anchor);
      for (let off = 0; off < 600; off++) {
        if (off % n) continue;
        let yy = base.getFullYear();
        let mm = base.getMonth() + 1 + off;
        yy += Math.floor((mm - 1) / 12);
        mm = ((mm - 1) % 12) + 1;
        const day = useLast ? this.lastDay(yy, mm) : Math.min(dom, this.lastDay(yy, mm));
        const cand = mk(new Date(yy, mm - 1, day));
        if (cand > now) return ok(cand);
      }
      return null;
    }
    return null;
  }

  // ------------------------------------------------------------ 列表 CRUD
  async listLists(): Promise<Row[]> {
    return this.all('SELECT * FROM cron_list ORDER BY sort_order, created_at');
  }

  apiList(row: Row): object {
    return { id: row['id'], name: row['name'], icon: row['icon'], color: row['color'] };
  }

  async createList(name: string, icon = 'list-checks', color = '#FF5000'): Promise<Row | null> {
    const now = this.nowStr();
    const lid = this.uid('l_');
    const n = Number((await this.one('SELECT COUNT(*) c FROM cron_list'))?.['c'] || 0);
    await this.run(
      'INSERT INTO cron_list(id,name,icon,color,sort_order,created_at,updated_at)' +
        ' VALUES($1,$2,$3,$4,$5,$6,$7)',
      lid, name || '未命名', icon, color, n, now, now,
    );
    return this.getList(lid);
  }

  async getList(lid: string): Promise<Row | null> {
    return (await this.one('SELECT * FROM cron_list WHERE id=$1', lid)) || null;
  }

  async updateList(lid: string, kw: Record<string, unknown>): Promise<Row | null> {
    const fields = ['name', 'icon', 'color', 'sort_order']
      .filter((k) => k in kw && kw[k] != null)
      .reduce((o, k) => ((o[k] = kw[k]), o), {} as Record<string, unknown>);
    if (!Object.keys(fields).length) return this.getList(lid);
    fields['updated_at'] = this.nowStr();
    const cols = Object.keys(fields);
    await this.run(
      `UPDATE cron_list SET ${cols.map((c) => `${c}=$${cols.indexOf(c) + 1}`).join(',')} WHERE id=$${cols.length + 1}`,
      ...cols.map((c) => fields[c]),
      lid,
    );
    return this.getList(lid);
  }

  async deleteList(lid: string): Promise<[boolean, string]> {
    const n = Number((await this.one('SELECT COUNT(*) c FROM cron_item WHERE list_id=$1', lid))?.['c'] || 0);
    if (n) return [false, `列表下还有 ${n} 条事项，先删掉或移走`];
    await this.run('DELETE FROM cron_list WHERE id=$1', lid);
    return [true, '已删除列表'];
  }

  // ------------------------------------------------------------ 事项 CRUD
  async listItems(): Promise<Row[]> {
    return this.all('SELECT * FROM cron_item ORDER BY created_at');
  }

  async getItem(iid: string): Promise<Row | null> {
    return (await this.one('SELECT * FROM cron_item WHERE id=$1', iid)) || null;
  }

  apiItem(row: Row, linkState = '', hasOpenRun = false): object {
    return {
      id: row['id'],
      listId: row['list_id'],
      title: row['title'],
      note: row['note'] || '',
      status: row['status'],
      done: row['status'] === STATUS_DONE,
      doneAt: row['done_at'] || '',
      doneCount: parseInt(String(row['done_count'] || '0'), 10),
      flag: !!row['flag'],
      remindAt: row['remind_at'] || '',
      remindTimes: this.parseTimes(row['remind_times']),
      timeout: parseInt(String(row['timeout'] || '0'), 10),
      repeatType: row['repeat_type'] || 'none',
      repeatInterval: parseInt(String(row['repeat_interval'] || '1'), 10),
      repeatBy: row['repeat_by'] || '',
      repeatEnd: row['repeat_end'] || '',
      repeatLabel: this.describeRule(this.ruleOf(row)),
      taskId: row['task_id'] || '',
      autoRun: !!row['auto_run'],
      queueRun: !!row['queue_run'],
      lastRunAt: row['last_run_at'] || '',
      lastRunStatus: row['last_run_status'] || '',
      linkState,
      hasOpenRun: !!hasOpenRun,
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    };
  }

  async createItem(
    title: string, listId: string, note = '', remindAt = '', flag = 0,
    repeat: unknown = {}, taskId = '', autoRun = 0, taskArgs: unknown = {},
    remindTimes: string[] = [], timeout = 0, queueRun = 0,
  ): Promise<Row | null> {
    const now = this.nowStr();
    const { type, interval, by, end } = this.normalizeRule(repeat);
    const iid = this.uid('i_');
    await this.run(
      'INSERT INTO cron_item(id,list_id,title,note,status,flag,remind_at,' +
        ' repeat_type,repeat_interval,repeat_by,repeat_end,' +
        ' task_id,task_args,auto_run,remind_times,timeout,queue_run,created_at,updated_at)' +
        ' VALUES($1,$2,$3,$4,\'open\',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      iid, listId, title || '未命名', note || '', flag ? 1 : 0, remindAt || '',
      type, interval, by, end, taskId || '',
      JSON.stringify(taskArgs || {}), autoRun ? 1 : 0, JSON.stringify(remindTimes || []), Number(timeout) || 0, queueRun ? 1 : 0, now, now,
    );
    return this.getItem(iid);
  }

  async updateItem(iid: string, kw: Record<string, unknown>): Promise<Row | null> {
    const row = await this.getItem(iid);
    if (!row) return null;
    const fields: Record<string, unknown> = {};
    for (const k of ['title', 'note', 'remind_at', 'list_id', 'done_at', 'last_run_at',
      'last_run_status', 'task_id', 'task_args', 'remind_times', 'timeout', 'queue_run']) {
      if (k in kw && kw[k] != null) fields[k] = kw[k];
    }
    if ('flag' in kw && kw['flag'] != null) fields['flag'] = kw['flag'] ? 1 : 0;
    if ('auto_run' in kw && kw['auto_run'] != null) fields['auto_run'] = kw['auto_run'] ? 1 : 0;
    if ('queue_run' in kw && kw['queue_run'] != null) fields['queue_run'] = kw['queue_run'] ? 1 : 0;
    if ('status' in kw && (kw['status'] === STATUS_OPEN || kw['status'] === STATUS_DONE)) {
      fields['status'] = kw['status'];
    }
    if ('repeat' in kw && kw['repeat'] && typeof kw['repeat'] === 'object') {
      const { type, interval, by, end } = this.normalizeRule(kw['repeat']);
      fields['repeat_type'] = type;
      fields['repeat_interval'] = interval;
      fields['repeat_by'] = by;
      fields['repeat_end'] = end;
    }
    if (!Object.keys(fields).length) return row;
    fields['updated_at'] = this.nowStr();
    const cols = Object.keys(fields);
    await this.run(
      `UPDATE cron_item SET ${cols.map((c) => `${c}=$${cols.indexOf(c) + 1}`).join(',')} WHERE id=$${cols.length + 1}`,
      ...cols.map((c) => fields[c]),
      iid,
    );
    return this.getItem(iid);
  }

  async deleteItem(iid: string): Promise<boolean> {
    await this.run('DELETE FROM cron_item WHERE id=$1', iid);
    await this.run('DELETE FROM cron_run WHERE item_id=$1', iid);
    return true;
  }

  async setDone(iid: string, done: boolean): Promise<Row | null> {
    const row = await this.getItem(iid);
    if (!row) return null;
    const nowDt = new Date();
    const fields: Record<string, unknown> = {};
    if (done) {
      fields['status'] = STATUS_OPEN;
      fields['done_at'] = this.nowStr();
      fields['done_count'] = (parseInt(String(row['done_count'] || '0'), 10)) + 1;
      fields['updated_at'] = this.nowStr();
      const rule = this.ruleOf(row);
      if (rule.type !== 'none') {
        const nxt = this.computeNextDue(rule, String(row['remind_at'] || this.nowStr()), nowDt);
        if (nxt) fields['remind_at'] = this.fmtLocal(nxt);
      } else {
        fields['status'] = STATUS_DONE;
      }
    } else {
      fields['status'] = STATUS_OPEN;
      fields['done_at'] = null;
      fields['updated_at'] = this.nowStr();
      if (row['done_count']) {
        fields['done_count'] = Math.max(0, parseInt(String(row['done_count'] || '0'), 10) - 1);
      }
      const times = this.parseTimes(row['remind_times']);
      if (!row['remind_at'] && times.length) {
        fields['remind_at'] = this.fmtLocal(this.mkDayTime(new Date(), times[0]));
      }
    }
    const cols = Object.keys(fields);
    await this.run(
      `UPDATE cron_item SET ${cols.map((c) => `${c}=$${cols.indexOf(c) + 1}`).join(',')} WHERE id=$${cols.length + 1}`,
      ...cols.map((c) => fields[c]),
      iid,
    );
    return this.getItem(iid);
  }

  // ------------------------------------------------------------ 任务关联
  async linkTask(iid: string, taskId: string, autoRun?: boolean): Promise<Row | null> {
    if (taskId) {
      const kw: Record<string, unknown> = { task_id: taskId };
      if (autoRun != null) kw['auto_run'] = autoRun;
      return this.updateItem(iid, kw);
    }
    return this.updateItem(iid, { task_id: '', auto_run: 0, task_args: '{}', last_run_status: null });
  }

  async unlinkTask(iid: string): Promise<Row | null> {
    return this.linkTask(iid, '');
  }

  async itemsLinkedTo(taskId: string): Promise<Row[]> {
    return this.all('SELECT id,title FROM cron_item WHERE task_id=$1', taskId);
  }

  // ------------------------------------------------------------ 调度查询
  async dueItems(nowStr: string): Promise<Row[]> {
    return this.all(
      "SELECT * FROM cron_item WHERE auto_run=1 AND status=$1 AND remind_at IS NOT NULL" +
        " AND remind_at<>'' AND remind_at<=$2 ORDER BY remind_at",
      STATUS_OPEN, nowStr,
    );
  }

  async findRun(itemId: string, dueAt: string | null | undefined): Promise<Row | null> {
    return (await this.one('SELECT * FROM cron_run WHERE fire_key=$1', this.fireKey(itemId, dueAt))) || null;
  }

  /** 占位式领取一次触发；fire_key UNIQUE 约束保证并发去重（违反时由 ON CONFLICT DO NOTHING 兜底）。 */
  async claimRun(itemId: string, dueAt: string | null | undefined, runId: string, attempt = 1): Promise<Row | null> {
    await this.run(
      'INSERT INTO cron_run(item_id,fire_key,due_at,started_at,status,attempt,run_id)' +
        ' VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(fire_key) DO NOTHING',
      itemId, this.fireKey(itemId, dueAt), dueAt, this.nowFull(),
      RUN_RUNNING, attempt, runId,
    );
    return this.findRun(itemId, dueAt);
  }

  async markMissed(itemId: string, dueAt: string | null | undefined, message: string): Promise<Row | null> {
    await this.run(
      'INSERT INTO cron_run(item_id,fire_key,due_at,started_at,finished_at,' +
        ' status,attempt,message) VALUES($1,$2,$3,$4,$5,$6,0,$7) ON CONFLICT(fire_key) DO NOTHING',
      itemId, this.fireKey(itemId, dueAt), dueAt, this.nowFull(), this.nowFull(),
      RUN_MISSED, message,
    );
    return this.findRun(itemId, dueAt);
  }

  async markSkipped(itemId: string, dueAt: string | null | undefined, message: string): Promise<Row | null> {
    await this.run(
      'INSERT INTO cron_run(item_id,fire_key,due_at,started_at,finished_at,' +
        ' status,attempt,message) VALUES($1,$2,$3,$4,$5,$6,0,$7) ON CONFLICT(fire_key) DO NOTHING',
      itemId, this.fireKey(itemId, dueAt), dueAt, this.nowFull(), this.nowFull(),
      RUN_SKIPPED, message,
    );
    return this.findRun(itemId, dueAt);
  }

  async finishRun(itemId: string, dueAt: string | null | undefined, status: string, message = ''): Promise<void> {
    await this.run(
      'UPDATE cron_run SET status=$1, finished_at=$2, message=$3, retry_at=NULL WHERE fire_key=$4',
      status, this.nowFull(), message || '', this.fireKey(itemId, dueAt),
    );
    await this.run(
      'UPDATE cron_item SET last_run_at=$1, last_run_status=$2, updated_at=$3 WHERE id=$4',
      this.nowFull(), status, this.nowFull(), itemId,
    );
  }

  retryDelayFor(attempt: number): number {
    const idx = Math.max(0, Math.min(RETRY_DELAYS.length - 1, attempt - 1));
    return RETRY_DELAYS[idx];
  }

  async scheduleRetry(itemId: string, dueAt: string | null | undefined, attempt: number, message = ''): Promise<boolean> {
    const delay = this.retryDelayFor(attempt);
    const retryAt = new Date(Date.now() + delay * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await this.run(
      'UPDATE cron_run SET status=$1, attempt=$2, message=$3, retry_at=$4 WHERE fire_key=$5',
      RUN_RETRYING, attempt, message || '', retryAt, this.fireKey(itemId, dueAt),
    );
    return true;
  }

  async retryDue(nowStr?: string): Promise<Row[]> {
    const now = nowStr || new Date().toISOString().slice(0, 19).replace('T', ' ');
    return this.all(
      'SELECT * FROM cron_run WHERE status=$1 AND retry_at IS NOT NULL AND retry_at<=$2 ORDER BY retry_at',
      RUN_RETRYING, now,
    );
  }

  async openRuns(): Promise<Row[]> {
    return this.all(
      'SELECT * FROM cron_run WHERE status IN ($1,$2) ORDER BY id',
      RUN_RUNNING, RUN_RETRYING,
    );
  }

  async openRunOf(itemId: string): Promise<Row | null> {
    return (await this.one(
      'SELECT * FROM cron_run WHERE item_id=$1 AND status IN ($2,$3) ORDER BY id DESC LIMIT 1',
      itemId, RUN_RUNNING, RUN_RETRYING,
    )) || null;
  }

  async markDispatched(itemId: string, dueAt: string | null | undefined, runId: string, attempt: number): Promise<Row | null> {
    await this.run(
      'UPDATE cron_run SET status=$1, run_id=$2, attempt=$3, started_at=$4, finished_at=NULL,' +
        ' retry_at=NULL WHERE fire_key=$5',
      RUN_RUNNING, runId, attempt, this.nowFull(), this.fireKey(itemId, dueAt),
    );
    return this.findRun(itemId, dueAt);
  }

  async itemRuns(itemId: string, limit = 10): Promise<Row[]> {
    return this.all('SELECT * FROM cron_run WHERE item_id=$1 ORDER BY id DESC LIMIT $2', itemId, limit);
  }

  async advanceAfterRun(iid: string): Promise<Row | null> {
    const row = await this.getItem(iid);
    if (!row) return null;
    const rule = this.ruleOf(row);
    const times = this.parseTimes(row['remind_times']);
    if (rule.type !== 'custom' && times.length) {
      const fromDue = this.parseDt(String(row['remind_at'] || ''));
      const now = new Date();
      if (fromDue) {
        const sorted = times.slice().sort();
        let next: Date | null = null;
        for (const t of sorted) {
          const cand = this.mkDayTime(fromDue, t);
          if (cand > now) { next = cand; break; }
        }
        if (!next) {
          const baseDay = new Date(fromDue);
          baseDay.setDate(baseDay.getDate() + 1);
          baseDay.setHours(0, 0, 0, 0);
          next = this.computeNextDue(rule, this.fmtLocal(this.mkDayTime(baseDay, sorted[0])) || this.nowStr(), now);
        }
        if (!next) {
          if (rule.type === 'none') {
            return this.updateItem(iid, { status: STATUS_DONE, done_at: this.nowStr(), remind_at: null });
          }
          return row;
        }
        return this.updateItem(iid, { remind_at: this.fmtLocal(next) });
      }
    }
    if (rule.type !== 'none') {
      const nxt = this.computeNextDue(rule, String(row['remind_at'] || this.nowStr()), new Date());
      return this.updateItem(iid, { remind_at: nxt ? this.fmtLocal(nxt) : row['remind_at'] });
    }
    return row;
  }

  async settleSuccess(iid: string): Promise<Row | null> {
    const row = await this.getItem(iid);
    if (!row) return null;
    if (this.ruleOf(row).type === 'none') {
      return this.updateItem(iid, { status: STATUS_DONE, done_at: this.nowStr() });
    }
    return this.advanceAfterRun(iid);
  }

  async pruneRuns(keepDays = 30): Promise<void> {
    const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    await this.run('DELETE FROM cron_run WHERE finished_at IS NOT NULL AND finished_at < $1', cutoff);
  }

  // ------------------------------------------------------------ 导入导出
  async importPayload(payload: unknown): Promise<[number, number]> {
    const data = (payload || {}) as Record<string, unknown>;
    const lists = (data['lists'] as Record<string, unknown>[]) || [];
    const items = (data['items'] as Record<string, unknown>[]) || [];
    const now = this.nowStr();
    let nList = 0;
    let nItem = 0;
    for (const l of lists) {
      try {
        await this.run(
          'INSERT INTO cron_list(id,name,icon,color,sort_order,created_at,updated_at)' +
            ' VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
          l['id'] || this.uid('l_'), l['name'] || '未命名', l['icon'] || 'list-checks',
          l['color'] || '#FF5000', nList, now, now,
        );
        nList++;
      } catch {
        /* ignore */
      }
    }
    for (const it of items) {
      try {
        await this.run(
          'INSERT INTO cron_item(id,list_id,title,note,status,done_at,' +
            ' flag,remind_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)' +
            ' ON CONFLICT(id) DO NOTHING',
          it['id'] || this.uid('i_'), it['listId'] || 'l_work', it['title'] || '未命名',
          it['note'] || '', it['done'] ? STATUS_DONE : STATUS_OPEN,
          it['doneAt'] || null, it['flag'] ? 1 : 0, it['remindAt'] || '',
          it['createdAt'] || now, now,
        );
        nItem++;
      } catch {
        /* ignore */
      }
    }
    return [nList, nItem];
  }
}
