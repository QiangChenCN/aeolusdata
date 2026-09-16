import sys, os
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import dashboard.standard.orders_fetch as OF
import dashboard.standard.achievement as AC

s_ms = AC._ymd_to_ms("2026-09-10", False)
e_ms = AC._ymd_to_ms("2026-09-10", True)
print("[probe] range ms = %d .. %d" % (s_ms, e_ms))

sess = OF.Session()
print("[probe] Session ready (cookie cached=%s)" % bool(getattr(sess, "cookie", None)))

# 这是 server 刷新链路 refresh_all._fetch_shared_orders 调用的同一个函数：
#   fetch_orders_grouped -> _fetch_all_rows -> DE.export_orders（导出优先，分页兜底）
grouped = OF.fetch_orders_grouped(sess, s_ms, e_ms)

total = sum(len(v) for v in grouped.values())
print("[probe] TOTAL orders = %d" % total)
for k, v in sorted(grouped.items(), key=lambda kv: -len(kv[1])):
    print("  team %s -> %d 行" % (k, len(v)))
print("[probe] DONE")
