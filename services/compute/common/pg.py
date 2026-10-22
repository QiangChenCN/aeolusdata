"""PostgreSQL 直连接入（与 Nest PgService 同源；Python 计算侧读取端口）。

DATABASE_URL 读取顺序：环境变量 → 仓库根 .env（与 Nest 共用单一配置源）。
未配置时 connect() 返回 None，调用方应优雅降级（如考核三项退回 +15 假设），
不抛异常、不回退 SQLite。
"""
from __future__ import annotations

import os


def _repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json（目录名无关）
    while here and here != os.path.dirname(here) and not (
        os.path.exists(os.path.join(here, ".git"))
        or os.path.exists(os.path.join(here, "package.json"))
    ):
        here = os.path.dirname(here)
    return here


def get_database_url() -> "str | None":
    url = os.environ.get("DATABASE_URL")
    if url:
        return url.strip()
    env_path = os.path.join(_repo_root(), ".env")
    if os.path.isfile(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("DATABASE_URL="):
                        return line[len("DATABASE_URL=") :].strip().strip('"').strip("'")
        except OSError:
            return None
    return None


def pg_configured() -> bool:
    """是否配置了 DATABASE_URL（等价于旧 SQLite 库文件存在）。"""
    return bool(get_database_url())


def connect():
    """开一条同步连接；未配置 DATABASE_URL 或连接失败返回 None。"""
    url = get_database_url()
    if not url:
        return None
    try:
        import psycopg

        return psycopg.connect(url, connect_timeout=5)
    except Exception:
        return None
