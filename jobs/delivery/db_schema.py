#!/usr/bin/env python3
"""运单详情入库表结构 —— DDL 单一来源。

设计依据（2026-08-24 基于 3,396 行真实样本 column_profile.json 实测）：
- 列名保留接口原始英文名（camelCase，反引号包裹），中文名写进 MySQL 原生 COMMENT
- 原值保真：99 个原始字段全部按字符串存（VARCHAR/TEXT），不做类型转换、不丢信息
- 仅追加 3 个派生列：stat_date（业务日期，查询/统计主入口）、etl_created_at、etl_updated_at
- 主键 trackingId：实测重复行均为整行完全相同（接口分页抖动），故可作主键 + upsert 幂等
- 不分表：日均 ~7.7k 单、年约 280 万行，单表 InnoDB 毫无压力；靠 stat_date 索引即可

DDL 单一来源见本文件：
  - gen_mysql_ddl()  —— MySQL 参考导出（人工查阅用，非运行必需）
  - gen_pg_ddl()     —— 运行期 PG 建表，load_delivery_db.py 直接调用，无需外部 .sql 文件
（历史上曾手动导出到 sql/ods_delivery_tracking.sql，现已去除：文件不被代码读取、
 且运行期改用 PG DDL，导出件即冗余可重生。）
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from delivery_columns import FIELD_ORDER, FIELD_CN

TABLE = "ods_delivery_tracking"
TABLE_CN = "运单详情(aeolus 运单数据页 queryTracking/2.0 原始明细)"

# 明确按长文本处理的字段：当前样本为空或较短，但业务上可能很长，给 TEXT 避免截断
TEXT_COLS = {
    "userComplaintContent", "merchantComplaintContent",
    "claimReasons", "claimReasonIds",
    "abnormalReportReasons", "abnormalReportReasonIds",
    "isBogusReportReasons", "isBogusReportReasonIds",
    "isBogusMarkReasons", "isBogusMarkReasonIds",
    "cancelReason", "abnormalMarkEventNames", "abnormalMarkEvents",
}

PROFILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "column_profile.json")


def load_profile():
    if not os.path.exists(PROFILE_PATH):
        return {}
    return {p["col"]: p for p in json.load(open(PROFILE_PATH, encoding="utf-8"))}


def col_type(col, profile):
    """按实测最大长度分档，留足余量。"""
    if col in TEXT_COLS:
        return "TEXT"
    mx = (profile.get(col) or {}).get("maxlen", 0)
    if mx <= 13:
        return "VARCHAR(32)"
    if mx <= 32:
        return "VARCHAR(64)"
    if mx <= 64:
        return "VARCHAR(128)"
    if mx <= 200:
        return "VARCHAR(512)"
    return "TEXT"


def gen_mysql_ddl(table=None, database=None):
    # table 留空再在函数体内取 TABLE：默认参数在「函数定义时」就绑定死了，
    # 写成 def f(table=TABLE) 的话，之后再改 db_schema.TABLE 也不会生效，
    # 建表/建索引就会静默打到旧表名上（2026-09-03 踩到）。
    table = table or TABLE
    prof = load_profile()
    lines = []
    if database:
        lines.append(f"CREATE DATABASE IF NOT EXISTS `{database}` "
                     "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;")
        lines.append(f"USE `{database}`;")
        lines.append("")
    lines.append(f"DROP TABLE IF EXISTS `{table}`;")
    lines.append(f"CREATE TABLE `{table}` (")
    body = []
    for c in FIELD_ORDER:
        t = col_type(c, prof)
        cn = FIELD_CN.get(c, c)
        p = prof.get(c) or {}
        note = f"{cn}"
        if p:
            jt = p.get("json_type", "")
            if jt in ("list", "dict", "list/dict"):
                note += f"[接口原始为{jt}，入库存 JSON 字符串]"
            note += f" | 样本最长{p.get('maxlen')} 非空{p.get('nonnull_pct')}%"
        null = "NOT NULL" if c == "trackingId" else "DEFAULT NULL"
        body.append(f"  `{c}` {t} {null} COMMENT '{note}'")
    # 派生列
    body.append("  `stat_date` DATE DEFAULT NULL "
                "COMMENT '业务日期(由 trackingFinishAt 按北京时间取日期，派生列)'")
    body.append("  `extra_json` TEXT DEFAULT NULL "
                "COMMENT '接口新增/未映射字段原样 JSON(保真兜底，正常为空)'")
    body.append("  `etl_created_at` DATETIME DEFAULT CURRENT_TIMESTAMP "
                "COMMENT '首次入库时间(派生列)'")
    body.append("  `etl_updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP "
                "ON UPDATE CURRENT_TIMESTAMP COMMENT '最近更新时间(派生列)'")
    # 键与索引
    body.append("  PRIMARY KEY (`trackingId`)")
    body.append("  KEY `idx_stat_date` (`stat_date`)")
    body.append("  KEY `idx_team_date` (`teamId`, `stat_date`)")
    body.append("  KEY `idx_knight_date` (`knightId`, `stat_date`)")
    body.append("  KEY `idx_finish_at` (`trackingFinishAt`)")
    body.append("  KEY `idx_platform_tracking` (`platformTrackingId`)")
    body.append("  KEY `idx_merchant` (`platformMerchantId`)")
    lines.append(",\n".join(body))
    lines.append(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 "
                 "COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC")
    lines.append(f"  COMMENT='{TABLE_CN}';")
    return "\n".join(lines)


def estimate_row_bytes():
    """校验 InnoDB 单行长度上限（65535 字节，TEXT 只占行内指针）。"""
    prof = load_profile()
    total = 0
    for c in FIELD_ORDER:
        t = col_type(c, prof)
        if t == "TEXT":
            total += 12
        else:
            n = int(t[t.index("(") + 1:-1])
            total += n * 4 + 2
    return total


def gen_pg_ddl(table=None, drop=True):
    """PostgreSQL DDL：保留原始 99 列 + 4 派生列；列名/字段大小写敏感，全部双引号包裹。

    备注/索引/约束差异：
    - COMMENT 用 PG 的 `COMMENT ON COLUMN/TABLE IS '...'`（CREATE 时无法内联）
    - 索引：`CREATE INDEX` 独立语句（MySQL 是 KEY 内联）
    - etl_updated_at 走 `DEFAULT CURRENT_TIMESTAMP`，upsert 时在 DO UPDATE 里刷新
      （PG 没有 MySQL 的 `ON UPDATE CURRENT_TIMESTAMP` 自动列）
    - CASCADE 让旧表如有外键引用也能 DROP 干净

    `drop` 开关（2026-09-03 加）：
      drop=True  —— 首句 `DROP TABLE IF EXISTS ... CASCADE` + `CREATE TABLE`。
                    init 节点「DROP 重建表」专用，**会清空全部已入库数据**。
      drop=False —— 只发 `CREATE TABLE IF NOT EXISTS`，索引也带 IF NOT EXISTS。
                    给 load 前的「表不在就自动建」兜底用：安全可重入，
                    表已存在时一条数据都不会动。别拿 drop=True 去做兜底建表。
    """
    # 同 gen_mysql_ddl：table 留空到函数体内再取，避免默认参数在定义期绑定死。
    table = table or TABLE
    prof = load_profile()
    body = []
    for c in FIELD_ORDER:
        t = col_type(c, prof)
        null = "NOT NULL" if c == "trackingId" else "DEFAULT NULL"
        body.append(f'  "{c}" {t} {null}')
    # 派生列
    body.append('  "stat_date" DATE DEFAULT NULL')
    body.append('  "extra_json" TEXT DEFAULT NULL')
    body.append('  "etl_created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    body.append('  "etl_updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    body.append('  PRIMARY KEY ("trackingId")')

    cols_def = ",\n".join(body)

    idx_stmts = [
        f'CREATE INDEX IF NOT EXISTS "idx_stat_date" ON "{table}" ("stat_date");',
        f'CREATE INDEX IF NOT EXISTS "idx_team_date" ON "{table}" ("teamId", "stat_date");',
        f'CREATE INDEX IF NOT EXISTS "idx_knight_date" ON "{table}" ("knightId", "stat_date");',
        f'CREATE INDEX IF NOT EXISTS "idx_finish_at" ON "{table}" ("trackingFinishAt");',
        f'CREATE INDEX IF NOT EXISTS "idx_platform_tracking" ON "{table}" ("platformTrackingId");',
        f'CREATE INDEX IF NOT EXISTS "idx_merchant" ON "{table}" ("platformMerchantId");',
    ]

    def _col_note(c):
        if c == "stat_date":
            return "业务日期(由 trackingFinishAt 按北京时间取日期，派生列)"
        if c == "extra_json":
            return "接口新增/未映射字段原样 JSON(保真兜底，正常为空)"
        if c == "etl_created_at":
            return "首次入库时间(派生列)"
        if c == "etl_updated_at":
            return "最近更新时间(派生列)"
        cn = FIELD_CN.get(c, c)
        p = prof.get(c) or {}
        note = cn
        if p:
            jt = p.get("json_type", "")
            if jt in ("list", "dict", "list/dict"):
                note += f"[接口原始为{jt}，入库存 JSON 字符串]"
            note += f" | 样本最长{p.get('maxlen')} 非空{p.get('nonnull_pct')}%"
        return note

    comment_stmts = [f"COMMENT ON TABLE \"{table}\" IS '{TABLE_CN}';"]
    for c in FIELD_ORDER + ["stat_date", "extra_json", "etl_created_at", "etl_updated_at"]:
        note_safe = _col_note(c).replace("'", "''")
        comment_stmts.append(f"COMMENT ON COLUMN \"{table}\".\"{c}\" IS '{note_safe}';")

    parts = []
    if drop:
        parts.append(f'DROP TABLE IF EXISTS "{table}" CASCADE;')
        create_kw = "CREATE TABLE"
    else:
        create_kw = "CREATE TABLE IF NOT EXISTS"
    parts.append(f'{create_kw} "{table}" (\n{cols_def}\n);')
    parts.extend(idx_stmts)
    parts.extend(comment_stmts)
    return "\n\n".join(parts)


if __name__ == "__main__":
    if "--check" in sys.argv:
        b = estimate_row_bytes()
        print(f"预估行内字节: {b} / 65535 上限 -> {'OK' if b < 60000 else '超限!'}")
    elif "--pg" in sys.argv:
        print(gen_pg_ddl())
    else:
        print(gen_mysql_ddl(database=os.environ.get("DB_NAME")))
