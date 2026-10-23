// 一次性迁移脚本：把现有 5 个 SQLite 库灌入 PostgreSQL（DATABASE_URL 必填）。
//
// 用法（在 apps/api/ 目录下）：
//   DATABASE_URL=postgresql://aeolus:密码@localhost:5432/aeolusdata \
//     node scripts/migrate-sqlite-to-pg.mjs
//
// 幂等：所有写入均 ON CONFLICT DO NOTHING / DO UPDATE，可重复运行。
// 仅读取 apps/api/runtime/db/*.db；不会删除任何 .db 文件（迁移验证无误后由你手动删除）。
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, '..', 'data', 'db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[migrate] 缺少 DATABASE_URL 环境变量，退出。');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// 每个迁移项：sqlite 文件名、sqlite 表名、目标 PG 表、列、冲突处理（upsert 表达式）。
// col 顺序对应 SELECT 的列；占位符用 $1..
const JOBS = [
  {
    file: 'assessment_history.db', table: 'delivery_history', pg: 'delivery',
    cols: ['order_id', 'team_id', 'date', 'payload'],
    conflict: 'ON CONFLICT(order_id, date) DO UPDATE SET team_id=excluded.team_id, payload=excluded.payload',
  },
  {
    file: 'assessment_history.db', table: 'visit_history', pg: 'visit_history',
    cols: ['main_task_id', 'team_id', 'date', 'visited', 'total', 'payload'],
    conflict: 'ON CONFLICT(main_task_id, team_id, date) DO UPDATE SET visited=excluded.visited, total=excluded.total, payload=excluded.payload',
  },
  {
    file: 'violation.db', table: 'violation_records', pg: 'violation',
    cols: ['stat_date', 'violation_no', 'raw_json', 'created_at'],
    conflict: 'ON CONFLICT(stat_date, violation_no) DO NOTHING',
  },
  {
    file: 'realtime.db', table: 'realtime_records', pg: 'violation_realtime',
    cols: ['stat_date', 'violation_no', 'raw_json', 'created_at'],
    conflict: 'ON CONFLICT(stat_date, violation_no) DO NOTHING',
  },
  {
    file: 'im_contact.db', table: 'im_contact_records', pg: 'im_contact_records',
    cols: ['stat_date', 'rider_id', 'raw_json', 'fetched_at'],
    conflict: 'ON CONFLICT(stat_date, rider_id) DO NOTHING',
  },
  {
    file: 'im_contact.db', table: 'im_contact_meta', pg: 'im_contact_meta',
    cols: ['k', 'v'], conflict: 'ON CONFLICT(k) DO NOTHING',
  },
  {
    file: '../cron.db', table: 'cron_list', pg: 'cron_list',
    cols: ['id', 'name', 'icon', 'color', 'sort_order', 'created_at', 'updated_at'],
    conflict: 'ON CONFLICT(id) DO NOTHING',
  },
  {
    file: '../cron.db', table: 'cron_item', pg: 'cron_item',
    cols: ['id', 'list_id', 'title', 'note', 'status', 'done_at', 'done_count', 'flag',
      'remind_at', 'repeat_type', 'repeat_interval', 'repeat_by', 'repeat_end',
      'task_id', 'task_args', 'auto_run', 'last_run_at', 'last_run_status',
      'created_at', 'updated_at', 'remind_times', 'timeout', 'queue_run'],
    conflict: 'ON CONFLICT(id) DO NOTHING',
  },
  {
    file: '../cron.db', table: 'cron_run', pg: 'cron_run',
    cols: ['id', 'item_id', 'fire_key', 'due_at', 'started_at', 'finished_at',
      'status', 'attempt', 'retry_at', 'run_id', 'message'],
    conflict: 'ON CONFLICT(fire_key) DO NOTHING', setvalSeq: true,
  },
  {
    file: '../cron.db', table: 'cron_kv', pg: 'cron_kv',
    cols: ['key', 'value'], conflict: 'ON CONFLICT(key) DO NOTHING',
  },
];

function sqliteRows(file, table) {
  const path = join(DB_DIR, file);
  if (!existsSync(path)) {
    console.log(`[migrate] 跳过（文件不存在）：${file}`);
    return [];
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA query_only=1');
  const cols = JOBS.find((j) => j.file === file && j.table === table).cols;
  const rows = db
    .prepare(`SELECT ${cols.map((c) => `\`${c}\``).join(', ')} FROM \`${table}\``)
    .all();
  db.close();
  return rows;
}

async function migrateJob(job) {
  // skipIfNonEmpty：目标表已有数据则跳过（用于无业务唯一键、无法 ON CONFLICT 的表）。
  if (job.skipIfNonEmpty) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${job.pg}`);
    if (rows[0].c > 0) {
      console.log(`[migrate] ${job.table}: 目标 ${job.pg} 已有 ${rows[0].c} 行，跳过`);
      return 0;
    }
  }
  const rows = sqliteRows(job.file, job.table);
  if (!rows.length) {
    console.log(`[migrate] ${job.table}: 无数据`);
    return 0;
  }
  const cols = job.cols;
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql =
    `INSERT INTO ${job.pg} (${cols.join(', ')}) VALUES (${placeholders}) ${job.conflict}`;
  let n = 0;
  for (const r of rows) {
    const params = cols.map((c) => (r[c] === undefined ? null : r[c]));
    await pool.query(sql, params);
    n += 1;
  }
  if (job.setvalSeq) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${job.pg}), 1))`,
      [job.pg],
    );
  }
  console.log(`[migrate] ${job.table}: 灌入 ${n} 行`);
  return n;
}

async function main() {
  console.log(`[migrate] 开始，DB_DIR=${DB_DIR}`);
  let total = 0;
  for (const job of JOBS) total += await migrateJob(job);
  console.log(`[migrate] 完成，共 ${total} 行。`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('[migrate] 失败：', e.message);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
