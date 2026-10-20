/* 考核看板 —— 历史数据回填（本月 1 号 ~ 昨天）。
 *
 * 把区间内每一天的「运单 + 违规」明细按日落进 assessment_history.db（historyOnly：只写历史库，
 * 不覆盖实时 JSON，避免破坏今日看板）。幂等 UPSERT，可重复跑。
 *
 * 用法：
 *   cd backend
 *   node backfill-history.cjs            # 跳过历史库已有数据的日期（可续跑）
 *   node backfill-history.cjs --force    # 强制重取所有日期（仍幂等）
 *
 * 独立引导 Nest 容器（不走 HTTP 鉴权），与正在运行的后端进程通过 WAL 并发写同一历史库，互不阻塞。
 * 建议后台跑并观察日志：node backfill-history.cjs > ../logs/backfill.log 2>&1 &
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/src/app.module');
const {
  AssessmentViolationFetchService,
} = require('./dist/src/modules/assessment/assessment-violation-fetch.service');
const {
  AssessmentDeliveryFetchService,
} = require('./dist/src/modules/assessment/assessment-delivery-fetch.service');

const FORCE = process.argv.includes('--force');
const DB_PATH = path.join(__dirname, 'data', 'db', 'assessment_history.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 昨天所在月份的 1 号 ~ 昨天（含）。 */
function monthDatesUpToYesterday() {
  const yestIso = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const [y, m, dy] = yestIso.split('-').map(Number);
  const out = [];
  for (let dd = 1; dd <= dy; dd++) {
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
  }
  return out;
}

/** 该日期历史库是否已有运单明细（>0 视为已落）。 */
function hasDelivery(date) {
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    const row = db.prepare('SELECT COUNT(*) AS n FROM delivery_history WHERE date = ?').get(date);
    return row ? Number(row.n) > 0 : false;
  } catch (e) {
    return false; // 库不存在/无表 → 视为未落
  } finally {
    if (db) db.close();
  }
}

/** 该日期历史库是否已有违规明细（>0 视为已落）。 */
function hasViolation(date) {
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    const row = db.prepare('SELECT COUNT(*) AS n FROM violation_history WHERE date = ?').get(date);
    return row ? Number(row.n) > 0 : false;
  } catch (e) {
    return false;
  } finally {
    if (db) db.close();
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const violation = app.get(AssessmentViolationFetchService);
  const delivery = app.get(AssessmentDeliveryFetchService);

  const dates = monthDatesUpToYesterday();
  // 运单导出易触发「请求太频繁」，日间稍长间隔避让；运单失败不阻塞后续（可续跑补）。
  const GAP = Number(process.env.BACKFILL_GAP_MS || 5000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let okD = 0, okV = 0, fail = 0, skip = 0;
  console.log(`[backfill] 区间 ${dates[0]} ~ ${dates[dates.length - 1]}，共 ${dates.length} 天；间隔 ${GAP}ms${FORCE ? '（--force 全重取）' : ''}`);
  for (const date of dates) {
    const needD = FORCE || !hasDelivery(date);
    const needV = FORCE || !hasViolation(date);
    if (!needD && !needV) { skip++; continue; }

    if (needD) {
      process.stdout.write(`[backfill] ${date} 运单... `);
      try {
        const r = await delivery.fetchAndLand(date, { historyOnly: true });
        console.log(`ok=${r.ok} ${r.msg}`);
        r.ok ? okD++ : fail++;
      } catch (e) {
        console.log(`ERR ${e.message}`);
        fail++;
      }
      await sleep(GAP);
    }
    if (needV) {
      process.stdout.write(`[backfill] ${date} 违规... `);
      try {
        const r = await violation.fetchAndLand([], date, { historyOnly: true });
        console.log(`ok=${r.ok} ${r.msg}`);
        r.ok ? okV++ : fail++;
      } catch (e) {
        console.log(`ERR ${e.message}`);
        fail++;
      }
      await sleep(GAP);
    }
  }
  console.log(`[backfill] 完成：运单成功 ${okD} 天、违规成功 ${okV} 天、跳过 ${skip} 天、失败 ${fail} 次。可重跑补失败/缺失的日期。`);
  await app.close();
}

main().catch((e) => {
  console.error('[backfill] 致命错误：', e);
  process.exit(1);
});
