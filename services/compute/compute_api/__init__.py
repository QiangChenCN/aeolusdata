from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


"""AeolusData 独立计算服务包。

- `main.py`     FastAPI 应用（只算、不鉴权；鉴权与数据权限裁决在 NestJS）。
- `handlers.py` 计算 handler 库：命名空间端点（standard / attend-period / overview /
  assessment）的派发表与实现，原根目录 `server.py` 的计算子集。
"""
