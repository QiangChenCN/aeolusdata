import time, os, sys, json

from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<

# 移除写死的 WorkBuddy 外机路径；ROOT 沿用上方 bootstrap 推导的仓库根
os.chdir(ROOT)
from analytics.domains.attend_period import attend_period_teams as APT
from analytics.domains.standard import rider_period_detail as RPD
from analytics.domains.attend_period import attend_period_all as APA
import urllib.request, urllib.error

date = "2026-09-13"
teams = APT.get_teams()
out = []
out.append("teams: %s" % teams)

# 单站 compute（import 层，不经 HTTP）
tid = teams[0]
t0 = time.time()
res = RPD.compute(tid, date)
dt = time.time() - t0
out.append("single(%s) compute=%.2fs riders=%d periods=%d" % (tid, dt, len(res["rows"]), len(res["periods"])))

# __all__ compute（import 层）
t0 = time.time()
res_all = APA.rider_detail_all(teams, date)
dt = time.time() - t0
out.append("__all__(%d sites) rider_detail_all=%.2fs riders=%d" % (len(teams), dt, len(res_all["rows"])))

# 校验：cells 完整性 + 抽样
bad = [r for r in res_all["rows"] if not isinstance(r.get("cells"), dict)]
out.append("validate cells-missing rows: %d" % len(bad))
sample = res_all["rows"][0] if res_all["rows"] else {}
out.append("sample tcells=%d scheduled=%s" % (len(sample.get("cells", {})), sample.get("scheduled_periods")))

# HTTP 端到端 __all__
try:
    token = open(".api_token").read().strip()
except Exception:
    token = ""
url = "http://127.0.0.1:8909/api/attend-period/rider-detail?team=__all__&start=%s&refresh=1&token=%s" % (date, token)
t0 = time.time()
try:
    with urllib.request.urlopen(url, timeout=120) as r:
        j = json.loads(r.read())
    dt = time.time() - t0
    out.append("HTTP __all__ e2e=%.2fs ok=%s riders=%d note=%s" % (dt, j.get("ok"), len(j.get("rows", [])), j.get("data_note")))
except urllib.error.HTTPError as e:
    out.append("HTTP __all__ ERROR code=%s body=%s" % (e.code, e.read().decode("utf-8", "ignore")[:200]))

with open("_bench_out.txt", "w", encoding="utf-8-sig") as f:
    f.write("\n".join(out) + "\n")
print("\n".join(out))
