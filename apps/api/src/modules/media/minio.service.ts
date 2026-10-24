import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client as MinioClient } from 'minio';

/**
 * MinIO 图床（移植自 common/minio_common.py）。
 *
 * 对象名统一为「业务前缀 + 图片内容 SHA256 前 16 位」，天然幂等：
 * 同一张图永远同一对象名（重复上传只覆盖、不堆积），不同内容必得不同名（不会串图）。
 */
interface MinioCfg {
  endpoint: string;
  port?: number;
  access_key: string;
  secret_key: string;
  bucket: string;
  /** 公网直链基址；URL = public_base + '/' + obj，obj 已含 prefix，故此处需带上 bucket 段（如 https://s3.xxx.com/mybucket）。 */
  public_base: string;
  secure?: boolean;
}

@Injectable()
export class MinioService {
  private readonly logger = new Logger(MinioService.name);
  private readonly cfgPath: string;
  private client: MinioClient | null = null;
  private cfg: MinioCfg | null = null;
  private bucketEnsured = false;

  constructor(private readonly config: ConfigService) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.cfgPath = path.join(root, 'apps', 'api', 'config', 'minio_config.json');
  }

  private loadCfg(): MinioCfg {
    if (this.cfg) return this.cfg;
    if (!fs.existsSync(this.cfgPath)) {
      throw new Error(
        '未找到 apps/api/config/minio_config.json，请先配置 MinIO 凭据（endpoint/access_key/secret_key/bucket/public_base）',
      );
    }
    this.cfg = JSON.parse(fs.readFileSync(this.cfgPath, 'utf-8')) as MinioCfg;
    return this.cfg;
  }

  private getClient(): { client: MinioClient; cfg: MinioCfg } {
    const cfg = this.loadCfg();
    if (!this.client) {
      this.client = new MinioClient({
        endPoint: cfg.endpoint,
        port: cfg.port ?? 9000,
        accessKey: cfg.access_key,
        secretKey: cfg.secret_key,
        useSSL: cfg.secure !== false,
      });
    }
    return { client: this.client, cfg };
  }

  /** 确保 bucket 存在且为 public-read（内联图须匿名 GET，否则群内图裂 403）。 */
  private async ensureBucketPublic(client: MinioClient, bucket: string): Promise<void> {
    if (this.bucketEnsured) return;
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket);
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucket}/*`],
          },
        ],
      };
      await client.setBucketPolicy(bucket, JSON.stringify(policy));
      this.logger.log(`已创建 bucket 并设为 public-read: ${bucket}`);
    }
    this.bucketEnsured = true;
  }

  /** 图片文件内容 SHA256（分块读取，支持大文件）。 */
  private contentSha256(imgPath: string): string {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(imgPath, 'r');
    try {
      const buf = Buffer.alloc(65536);
      let n: number;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        h.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex');
  }

  /**
   * 上传本地图片到 MinIO 公开桶，返回公网直链。
   * prefix: 业务前缀（attendance / vp / taskboard / equip）。
   * 重试策略与 Python `with_retry(times=3, delay=4, backoff=2)` 一致。
   */
  async upload(imgPath: string, prefix: string): Promise<string> {
    const times = 3;
    let delay = 4;
    let last: unknown;
    for (let i = 1; i <= times; i++) {
      try {
        return await this.doUpload(imgPath, prefix);
      } catch (e) {
        last = e;
        this.logger.warn(`MinIO上传图片 第 ${i}/${times} 次失败: ${(e as Error).message}`);
        if (i < times) {
          await new Promise((r) => setTimeout(r, delay * 1000));
          delay *= 2;
        }
      }
    }
    this.logger.error(`MinIO上传图片 重试 ${times} 次后仍失败: ${(last as Error)?.message}`);
    throw last;
  }

  private async doUpload(imgPath: string, prefix: string): Promise<string> {
    const { client, cfg } = this.getClient();
    await this.ensureBucketPublic(client, cfg.bucket);
    if (!fs.existsSync(imgPath)) throw new Error(`图片不存在：${imgPath}`);
    const token = this.contentSha256(imgPath).slice(0, 16);
    const obj = `${prefix}/${token}.png`;
    await client.fPutObject(cfg.bucket, obj, imgPath, { 'Content-Type': 'image/png' });
    const url = `${cfg.public_base.replace(/\/+$/, '')}/${obj}`;
    this.logger.log(`图片已上传 MinIO: ${url}`);
    return url;
  }
}
