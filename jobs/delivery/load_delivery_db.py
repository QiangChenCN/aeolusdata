#!/usr/bin/env python3
"""把 delivery_raw/*.jsonl 运单原始数据入库到 PostgreSQL（幂等 upsert）。

连接配置优先级：命令行 > 环境变量(DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME) > db_config.json

用法:
  python load_delivery_db.py --init                       # 建表(会 DROP 重建)
  python load_delivery_db.py --load                       # 入库 delivery_raw 下全部日期
  python load_delivery_db.py --load --date 2026-06-25     # 只入指定日期
  python load_delivery_db.py --verify                     # 核对库内每日行数 vs 接口 total
"""
import os
import sys
import json
import glob
import argparse
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from delivery_columns import FIELD_ORDER, FIELD_CN
import db_schema

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("缺少 psycopg2，请先: .venv/Scripts/python.exe -m pip install psycopg2-binary")
    raise

BJ = datetime.timezone(datetime.timedelta(hours=8))
BASE = os.path.dirname(os.path.abspath(__file__))       # jobs/delivery
ROOT = os.path.dirname(os.path.dirname(BASE))           # 项目根
OUT_DIR = os.path.join(BASE, "out")
RAW_DIR = os.path.join(OUT_DIR, "delivery_raw")
CFG_PATH = os.path.join(BASE, "db_config.json")         # 连接配置跟任务走
BATCH = 500

INSERT_COLS = FIELD_ORDER + ["stat_date", "extra_json"]


def load_cfg(args):
    cfg = {"host": "127.0.0.1", "port": 5432, "user": "admin",
           "password": "", "database": "postgres"}
    if os.path.exists(CFG_PATH):
        cfg.update(json.load(open(CFG_PATH, encoding="utf-8")))
    for k, env in [("host", "DB_HOST"), ("port", "DB_PORT"), ("user", "DB_USER"),
                   ("password", "DB_PASSWORD"), ("database", "DB_NAME")]:
        if os.environ.get(env):
            cfg[k] = os.environ[env]
    for k in ["host", "port", "user", "password", "database"]:
        v = getattr(args, k, None)
        if v not in (None, ""):
            cfg[k] = v
    cfg["port"] = int(cfg["port"])
    return cfg


def connect(cfg, with_db=True):
    """PG 必须指定 dbname；with_db 参数保留为兼容签名（PG 模式忽略）。"""
    kw = dict(host=cfg["host"], port=cfg["port"], user=cfg["user"],
              password=cfg["password"], dbname=cfg["database"],
              client_encoding="utf8")
    return psycopg2.connect(**kw)


def to_cell(v):
    """原值保真：None->NULL，标量->字符串原样，复合->紧凑 JSON。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def stat_date_of(rec, fallback):
    ts = rec.get("trackingFinishAt") or rec.get("completeAt") or rec.get("trackingCreatedAt")
    try:
        ms = int(str(ts))
        return datetime.datetime.fromtimestamp(ms / 1000, BJ).date().isoformat()
    except (TypeError, ValueError):
        return fallback


def do_init(cfg):
    ddl = db_schema.gen_pg_ddl()
    conn = connect(cfg, with_db=True)
    try:
        with conn.cursor() as cur:
            for stmt in [s.strip() for s in ddl.split(";") if s.strip()]:
                cur.execute(stmt)
        conn.commit()
    finally:
        conn.close()
    print(f"已在 PG `{cfg['database']}` 建表 `{db_schema.TABLE}`"
          f"（{len(FIELD_ORDER)} 原始列 + 4 派生列，中文名写入 COMMENT）")


def table_exists(cfg, table=None):
    """表是否在（按当前 search_path 找）。to_regclass 找不到返回 NULL，不抛错。"""
    table = table or db_schema.TABLE
    conn = connect(cfg)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass(%s) IS NOT NULL", (table,))
            return bool(cur.fetchone()[0])
    finally:
        conn.close()


def ensure_table(cfg):
    """load 前兜底：表不在就建一条（CREATE IF NOT EXISTS，不 DROP、不动已有数据）。

    为什么需要：流水线常从 csv / raw 起步（init 节点被跳过），库里又没表时，
    load 会直接报 `relation "ods_delivery_tracking" does not exist` —— 2026-09-03
    连着三次都栽在这，得人工先跑一次 init 才解得开。这里让 load 自己补上。

    返回 True 表示本次确实新建了表（调用方可据此打日志）。
    """
    if table_exists(cfg):
        return False
    ddl = db_schema.gen_pg_ddl(drop=False)
    conn = connect(cfg)
    try:
        with conn.cursor() as cur:
            for stmt in [s.strip() for s in ddl.split(";") if s.strip()]:
                cur.execute(stmt)
        conn.commit()
    finally:
        conn.close()
    print(f"[auto-init] 表 `{db_schema.TABLE}` 不存在，已自动创建"
          f"（{len(FIELD_ORDER)} 原始列 + 4 派生列）")
    return True


def build_sql():
    """PG 版：SQL 留单 `%s` VALUES，由 psycopg2.extras.execute_values 展开为多行 VALUES。

    ON CONFLICT 配合 execute_values 时，DO UPDATE 子句引用 EXCLUDED.col，
    对应到 VALUES 里的所有行。
    """
    cols = ",".join(f'"{c}"' for c in INSERT_COLS)
    upd = ",".join(f'"{c}"=EXCLUDED."{c}"' for c in INSERT_COLS if c != "trackingId")
    return (f'INSERT INTO "{db_schema.TABLE}" ({cols}) VALUES %s '
            f'ON CONFLICT ("trackingId") DO UPDATE SET {upd}')


def load_file(conn, path, sql):
    day = os.path.basename(path).replace(".jsonl", "")
    known = set(FIELD_ORDER)
    rows, extra_keys, skipped = [], set(), 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if not rec.get("trackingId"):
                skipped += 1
                continue
            ex = {k: v for k, v in rec.items() if k not in known}
            extra_keys |= set(ex)
            vals = [to_cell(rec.get(c)) for c in FIELD_ORDER]
            vals.append(stat_date_of(rec, day))
            vals.append(json.dumps(ex, ensure_ascii=False) if ex else None)
            rows.append(vals)
    affected = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), BATCH):
            # PG 模式下用 execute_values 拼多 VALUES 一次发（pymysql 的 executemany 返回受影响行数，
            # psycopg2 的 executemany 返回 None，这里改用 execute_values 拿真实 affected）
            psycopg2.extras.execute_values(cur, sql, rows[i:i + BATCH],
                                           template=None, page_size=BATCH)
            affected += cur.rowcount
    conn.commit()
    note = f" 新增字段{sorted(extra_keys)}" if extra_keys else ""
    if skipped:
        note += f" 跳过无ID {skipped} 行"
    print(f"  {day}: 读取 {len(rows)} 行 -> upsert 影响 {affected}{note}")
    return len(rows)


def do_load(cfg, only_date=None):
    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.jsonl")))
    if only_date:
        files = [f for f in files if os.path.basename(f).startswith(only_date)]
    if not files:
        print(f"{RAW_DIR} 下无 jsonl 文件")
        return
    ensure_table(cfg)          # 表不在就先建，避免整轮入库在第一行就崩
    sql = build_sql()
    conn = connect(cfg)
    total = 0
    try:
        print(f"入库 {len(files)} 个日期文件 -> `{cfg['database']}`.`{db_schema.TABLE}`")
        for p in files:
            total += load_file(conn, p, sql)
        with conn.cursor() as cur:
            cur.execute(f'SELECT COUNT(*) FROM "{db_schema.TABLE}"')
            cnt = cur.fetchone()[0]
    finally:
        conn.close()
    print(f"完成：本次读取 {total} 行，表内现有 {cnt} 行")


def do_dry_run(only_date=None):
    """不连库，只校验数据准备环节：列数、值转换、stat_date、未映射字段。"""
    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.jsonl")))
    if only_date:
        files = [f for f in files if os.path.basename(f).startswith(only_date)]
    known = set(FIELD_ORDER)
    print(f"自检 {len(files)} 个文件，目标列数 {len(INSERT_COLS)}"
          f"（{len(FIELD_ORDER)} 原始 + stat_date + extra_json）\n")
    for p in files:
        day = os.path.basename(p).replace(".jsonl", "")
        n, extra, bad_date, maxlen, nonstr = 0, set(), 0, {}, set()
        dates = set()
        for line in open(p, encoding="utf-8"):
            if not line.strip():
                continue
            rec = json.loads(line)
            n += 1
            extra |= {k for k in rec if k not in known}
            for k, v in rec.items():
                if v is not None and not isinstance(v, str):
                    nonstr.add(f"{k}:{type(v).__name__}")
                c = to_cell(v)
                if c:
                    maxlen[k] = max(maxlen.get(k, 0), len(c))
            sd = stat_date_of(rec, day)
            dates.add(sd)
            if sd != day:
                bad_date += 1
        prof = db_schema.load_profile()
        over = []
        for k, v in maxlen.items():
            if k not in known:
                continue
            t = db_schema.col_type(k, prof)
            if not t.startswith("VARCHAR"):
                continue
            cap = int(t[t.index("(") + 1:-1])
            if v > cap:
                over.append((k, f"实际{v} > 建表{cap}"))
        print(f"{day}: {n} 行 | 未映射字段 {sorted(extra) or '无'} | "
              f"非字符串值 {sorted(nonstr) or '无'} | stat_date 落在 {sorted(dates)}"
              + (f" | 跨日 {bad_date} 行" if bad_date else ""))
        if over:
            print(f"   !! 超出建表长度的列: {over}")
    print("\n自检完成（未连接数据库）")


def do_verify(cfg):
    ensure_table(cfg)          # 同 do_load：表不在就先建，缺表时别直接抛 UndefinedTable
    conn = connect(cfg)
    try:
        with conn.cursor() as cur:
            cur.execute(f'SELECT "stat_date", COUNT(*) FROM "{db_schema.TABLE}" '
                        'GROUP BY "stat_date" ORDER BY "stat_date"')
            db_rows = dict(cur.fetchall())
            cur.execute(f'SELECT COUNT(*), MIN("stat_date"), MAX("stat_date") '
                        f'FROM "{db_schema.TABLE}"')
            cnt, dmin, dmax = cur.fetchone()
    finally:
        conn.close()
    if not cnt:
        # 空表时下面会把每个日期都判成「偏差偏大」刷满屏，直接说结论更有用
        print("表内暂无数据，无从对账。请先跑 load 节点把 delivery_raw 下的 jsonl 入库。")
        return
    print(f"表内共 {cnt} 行，日期范围 {dmin} ~ {dmax}\n")
    print(f"{'日期':<12}{'接口total':>10}{'库内行数':>10}{'差异':>8}")
    bad = 0
    for mp in sorted(glob.glob(os.path.join(RAW_DIR, "*.meta.json"))):
        m = json.load(open(mp, encoding="utf-8"))
        d = m["date"]
        api, got = m.get("total", 0), db_rows.get(datetime.date.fromisoformat(d), 0)
        diff = got - api
        flag = "" if abs(diff) <= max(3, api * 0.005) else "  <-- 偏差偏大"
        if flag:
            bad += 1
        print(f"{d:<12}{api:>10}{got:>10}{diff:>8}{flag}")
    print(f"\n{'全部日期行数正常' if not bad else f'{bad} 个日期偏差偏大，建议 --force 重抓'}")


# ==================== 执行节点（server 步进条按顺序跑）====================
# 一个脚本三种模式，各自有独立的节点列表；connect 节点只做「探活 + 打印目标库」，
# 真正干活的函数内部仍各自建连（保持原有行为不变，多一次连接可忽略）。
def _node_connect(cfg):
    conn = connect(cfg, with_db=True)
    conn.close()
    print(f"连通 OK -> `{cfg['database']}`")


def _mk_placeholder():
    pass


NODES_INIT = [
    {"id": "connect", "name": "连接 PostgreSQL", "desc": "探测目标库连通性"},
    {"id": "ddl",     "name": "DROP 重建表", "desc": "执行 DDL 重建 ods_delivery_tracking（危险：清空现有数据）"},
]
NODES_LOAD = [
    {"id": "connect", "name": "连接 PostgreSQL", "desc": "探测目标库连通性"},
    # 不再单列 count：do_load 结尾本来就会打印「表内现有 N 行」，拆出来会重复统计
    {"id": "upsert",  "name": "逐日 upsert", "desc": "扫描 delivery_raw/*.jsonl 按 trackingId upsert，结尾报告表内行数"},
]
NODES_VERIFY = [
    {"id": "connect", "name": "连接 PostgreSQL", "desc": "探测目标库连通性"},
    {"id": "count",   "name": "核对总行数", "desc": "统计表内现有行数"},
]
MODE_NODES = {"init": NODES_INIT, "load": NODES_LOAD, "verify": NODES_VERIFY}


def main():
    import nodeflow
    # 先摘掉 --begin/--end（此时还不知道用哪套节点，不能校验）
    # 注意：take_range 原地改的是传入的 list，切片是副本，必须自己写回 sys.argv
    rest = sys.argv[1:]
    begin, end, err = nodeflow.take_range(rest)
    sys.argv = [sys.argv[0]] + rest
    if err:
        print("✗ " + err)
        sys.exit(1)

    ap = argparse.ArgumentParser()
    ap.add_argument("--init", action="store_true", help="建库建表(DROP 重建)")
    ap.add_argument("--load", action="store_true", help="入库 jsonl")
    ap.add_argument("--verify", action="store_true", help="核对行数")
    ap.add_argument("--dry-run", action="store_true", help="不连库自检数据")
    ap.add_argument("--date", help="仅处理该日期")
    ap.add_argument("--host"), ap.add_argument("--port")
    ap.add_argument("--user"), ap.add_argument("--password")
    ap.add_argument("--database")
    a = ap.parse_args()
    if a.dry_run:
        do_dry_run(a.date)
        return

    mode = "init" if a.init else ("load" if a.load else ("verify" if a.verify else None))
    if mode is None:
        ap.print_help()
        return
    nodes = MODE_NODES[mode]
    todo, err = nodeflow.pick(nodes, begin, end)   # 摘完参数后再按模式校验
    if err:
        print("✗ " + err)
        sys.exit(1)

    cfg = load_cfg(a)
    print(f"PG {cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['database']}")
    ctx = {"cfg": cfg, "date": a.date, "mode": mode}

    fns = {"connect": lambda c: _node_connect(c["cfg"]),
           "ddl":     lambda c: do_init(c["cfg"]),
           "upsert":  lambda c: do_load(c["cfg"], c["date"]),
           "count":   lambda c: do_verify(c["cfg"])}
    for _n in nodes:
        _n["fn"] = fns[_n["id"]]

    sys.exit(nodeflow.execute(todo, ctx, title="[运单入库]"))


if __name__ == "__main__":
    main()
