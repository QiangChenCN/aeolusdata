# -*- coding: utf-8 -*-
"""MinIO 图床公共模块：统一 load_minio_cfg / ensure_bucket_public / upload_to_minio。

被 attendance.py（考勤图）与 appeal_reminder.py（违规明细图）共用，消除两处重复实现。

对象名统一为「业务前缀 + 图片内容 SHA256 前 16 位」，天然幂等：
- 同一张图（内容相同）永远同一对象名，重复上传只覆盖、不堆积；
- 不同内容的图必得不同对象名，历史消息里的旧链接不会串图（相比「按查询时间 HMAC」更安全）。
"""
import os
import json
import hashlib
import logging

from ding_common import with_retry

log = logging.getLogger("minio_common")

BASE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(BASE, "minio_config.json")


def load_minio_cfg():
    """读取 MinIO 凭据配置（minio_config.json），缺失字段报错带提示。"""
    if not os.path.exists(CFG_PATH):
        raise RuntimeError(
            "未找到 minio_config.json，请先配置 MinIO 凭据"
            "（endpoint/access_key/secret_key/bucket/public_base）"
        )
    return json.load(open(CFG_PATH, encoding="utf-8"))


def ensure_bucket_public(client, bucket):
    """确保 bucket 存在且为 public-read（内联图须匿名 GET，否则群里图裂 403）。

    bucket 首次创建时下发 public-read 策略；已存在则跳过（不覆盖既有策略）。
    """
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)
        policy = {
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow", "Principal": {"AWS": ["*"]},
                "Action": ["s3:GetObject"],
                "Resource": ["arn:aws:s3:::%s/*" % bucket]
            }]
        }
        client.set_bucket_policy(bucket, json.dumps(policy))
        log.info("已创建 bucket 并设为 public-read: %s", bucket)
    else:
        log.info("bucket 已存在: %s", bucket)


def _content_sha256(img_path):
    """计算图片文件内容的 SHA256（分块读取，支持大文件）。"""
    h = hashlib.sha256()
    with open(img_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


@with_retry(times=3, delay=4, backoff=2, label="MinIO上传图片")
def upload_to_minio(img_path, prefix):
    """上传本地图片到 MinIO 公开桶，返回公网直链。

    prefix: 业务前缀（如 "attendance" / "vp"），用于桶内区分图类；
            对象名 = "{prefix}/{sha256(图片内容)[:16]}.png"，幂等不堆积。
    """
    from minio import Minio
    cfg = load_minio_cfg()
    client = Minio(cfg["endpoint"], access_key=cfg["access_key"],
                   secret_key=cfg["secret_key"], secure=bool(cfg.get("secure", True)))
    bucket = cfg["bucket"]
    ensure_bucket_public(client, bucket)   # 保证内联图可匿名访问, 避免 403 图裂
    token = _content_sha256(img_path)[:16]
    obj = "%s/%s.png" % (prefix, token)
    client.fput_object(bucket, obj, img_path, content_type="image/png")
    base = cfg["public_base"].rstrip("/")
    url = "%s/%s" % (base, obj)
    log.info("图片已上传 MinIO: %s", url)
    return url
