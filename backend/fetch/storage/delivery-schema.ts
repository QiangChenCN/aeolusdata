import * as fs from 'fs';
import * as path from 'path';
import { FIELD_CN, FIELD_ORDER } from './delivery-columns';

/** 运单详情入库表结构 —— DDL 单一来源（移植 jobs/delivery/db_schema.py）。 */
export const TABLE = 'ods_delivery_tracking';
export const TABLE_CN = '运单详情(aeolus 运单数据页 queryTracking/2.0 原始明细)';

/** 明确按长文本处理的字段：样本为空或较短，但业务上可能很长。 */
export const TEXT_COLS = new Set([
  'userComplaintContent',
  'merchantComplaintContent',
  'claimReasons',
  'claimReasonIds',
  'abnormalReportReasons',
  'abnormalReportReasonIds',
  'isBogusReportReasons',
  'isBogusReportReasonIds',
  'isBogusMarkReasons',
  'isBogusMarkReasonIds',
  'cancelReason',
  'abnormalMarkEventNames',
  'abnormalMarkEvents',
]);

export interface ColumnProfile {
  col: string;
  cn?: string;
  json_type?: string;
  maxlen?: number;
  distinct?: number;
  nonnull_pct?: number;
}
export type Profile = Record<string, ColumnProfile>;

export function profilePath(deliveryDir: string): string {
  return path.join(deliveryDir, 'column_profile.json');
}

export function loadProfile(deliveryDir: string): Profile {
  const p = profilePath(deliveryDir);
  if (!fs.existsSync(p)) return {};
  const arr = JSON.parse(fs.readFileSync(p, 'utf-8')) as ColumnProfile[];
  const out: Profile = {};
  for (const item of arr) out[item.col] = item;
  return out;
}

/** 按实测最大长度分档，留足余量。 */
export function colType(col: string, profile: Profile): string {
  if (TEXT_COLS.has(col)) return 'TEXT';
  const mx = profile[col]?.maxlen ?? 0;
  if (mx <= 13) return 'VARCHAR(32)';
  if (mx <= 32) return 'VARCHAR(64)';
  if (mx <= 64) return 'VARCHAR(128)';
  if (mx <= 200) return 'VARCHAR(512)';
  return 'TEXT';
}

function colNote(c: string, profile: Profile): string {
  if (c === 'stat_date') return '业务日期(由 trackingFinishAt 按北京时间取日期，派生列)';
  if (c === 'extra_json') return '接口新增/未映射字段原样 JSON(保真兜底，正常为空)';
  if (c === 'etl_created_at') return '首次入库时间(派生列)';
  if (c === 'etl_updated_at') return '最近更新时间(派生列)';
  const cn = FIELD_CN[c] ?? c;
  const p = profile[c];
  let note = cn;
  if (p) {
    const jt = p.json_type || '';
    if (jt === 'list' || jt === 'dict' || jt === 'list/dict') {
      note += `[接口原始为${jt}，入库存 JSON 字符串]`;
    }
    note += ` | 样本最长${p.maxlen} 非空${p.nonnull_pct}%`;
  }
  return note;
}

/**
 * PostgreSQL DDL：原始 99 列 + 4 派生列，全部双引号包裹。
 * drop=true → DROP + CREATE（init 节点专用，会清空数据）；
 * drop=false → CREATE TABLE IF NOT EXISTS（load 前兜底建表，安全可重入）。
 */
export function genPgDdl(profile: Profile, drop = true, table = TABLE): string {
  const body: string[] = [];
  for (const c of FIELD_ORDER) {
    const t = colType(c, profile);
    const nullClause = c === 'trackingId' ? 'NOT NULL' : 'DEFAULT NULL';
    body.push(`  "${c}" ${t} ${nullClause}`);
  }
  body.push('  "stat_date" DATE DEFAULT NULL');
  body.push('  "extra_json" TEXT DEFAULT NULL');
  body.push('  "etl_created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  body.push('  "etl_updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  body.push('  PRIMARY KEY ("trackingId")');
  const colsDef = body.join(',\n');

  const idxStmts = [
    `CREATE INDEX IF NOT EXISTS "idx_stat_date" ON "${table}" ("stat_date");`,
    `CREATE INDEX IF NOT EXISTS "idx_team_date" ON "${table}" ("teamId", "stat_date");`,
    `CREATE INDEX IF NOT EXISTS "idx_knight_date" ON "${table}" ("knightId", "stat_date");`,
    `CREATE INDEX IF NOT EXISTS "idx_finish_at" ON "${table}" ("trackingFinishAt");`,
    `CREATE INDEX IF NOT EXISTS "idx_platform_tracking" ON "${table}" ("platformTrackingId");`,
    `CREATE INDEX IF NOT EXISTS "idx_merchant" ON "${table}" ("platformMerchantId");`,
  ];

  const commentStmts = [`COMMENT ON TABLE "${table}" IS '${TABLE_CN}';`];
  for (const c of [...FIELD_ORDER, 'stat_date', 'extra_json', 'etl_created_at', 'etl_updated_at']) {
    const noteSafe = colNote(c, profile).replace(/'/g, "''");
    commentStmts.push(`COMMENT ON COLUMN "${table}"."${c}" IS '${noteSafe}';`);
  }

  const parts: string[] = [];
  if (drop) {
    parts.push(`DROP TABLE IF EXISTS "${table}" CASCADE;`);
    parts.push(`CREATE TABLE "${table}" (\n${colsDef}\n);`);
  } else {
    parts.push(`CREATE TABLE IF NOT EXISTS "${table}" (\n${colsDef}\n);`);
  }
  parts.push(...idxStmts);
  parts.push(...commentStmts);
  return parts.join('\n\n');
}
