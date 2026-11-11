import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { Client as MinioClient } from 'minio';

/**
 * MinIO 图床配置的**唯一**存储：由「系统设置 → MinIO 设置」UI 维护，
 * 落盘 `apps/api/runtime/minio_config.json`（与 credentials.json / cookie.txt 同目录，
 * 属运行时产物，gitignored）。手写 `apps/api/config/minio_config.json` 的旧方式已废除
 * （旧文件已删，代码不再读取）。
 *
 * MinioService 每次上传前都重新读文件并按配置指纹重建客户端，故保存后立即热生效，无需重启。

 * 安全约定：
 *  · 读取：`masked()` 脱敏快照 —— endpoint/bucket/public_base 等非敏感项原样展示，
 *    access_key 只给首尾提示，secret_key 明文永不外泄（只回 hasSecret）；
 *  · 写入：`save()` 原子写盘、权限 0o600；secret_key 留空表示「沿用原值」（首次配置必须填写）；
 *    未知名（如 filename_key 等历史扩展字段）原样保留，不做破坏性裁剪。
 */
export interface MinioCfg {
  endpoint: string;
  port?: number;
  access_key: string;
  secret_key: string;
  bucket: string;
  /** 公网直链基址；URL = public_base + '/' + obj，obj 已含 prefix，故此处需带上 bucket 段（如 https://s3.xxx.com/mybucket）。 */
  public_base: string;
  secure?: boolean;
  [key: string]: unknown;
}

export interface MinioMasked {
  ok: boolean;
  configured: boolean;
  endpoint?: string;
  port?: number;
  bucket?: string;
  public_base?: string;
  secure?: boolean;
  access_key_hint?: string;
  hasSecret: boolean;
  source: 'file' | 'none';
}

@Injectable()
export class MinioConfigService {
  private readonly logger = new Logger(MinioConfigService.name);
  private readonly file: string;

  constructor(private readonly config: ConfigService) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    // 运行时产物统一归 runtime/（与 credentials.json / cookie.txt 同目录）；
    // 旧的 apps/api/config/minio_config.json 已废除，不再读取。
    this.file = path.join(root, 'apps', 'api', 'runtime', 'minio_config.json');
  }

  private readFile(): MinioCfg | null {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      return d && typeof d === 'object' ? (d as MinioCfg) : null;
    } catch {
      return null;
    }
  }

  private writeFile(cfg: MinioCfg): void {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* 权限微调失败不影响写入 */
    }
  }

  /** 运行时真实配置（上传用）；未配置返回 null。 */
  read(): MinioCfg | null {
    const d = this.readFile();
    if (d?.endpoint && d?.access_key && d?.secret_key && d?.bucket && d?.public_base) return d;
    return null;
  }

  /** 脱敏快照（前端展示用）：secret_key 明文永不外泄。 */
  masked(): MinioMasked {
    const d = this.readFile();
    if (!d?.endpoint) {
      return { ok: true, configured: false, hasSecret: false, source: 'none' };
    }
    const ak = d.access_key ? String(d.access_key) : '';
    return {
      ok: true,
      configured: true,
      endpoint: d.endpoint,
      port: d.port,
      bucket: d.bucket || '',
      public_base: d.public_base || '',
      secure: d.secure !== false,
      access_key_hint: this.hint(ak),
      hasSecret: !!d.secret_key,
      source: 'file',
    };
  }

  private hint(key: string): string | undefined {
    if (!key) return undefined;
    if (key.length <= 5) return key[0] + '****';
    return key.slice(0, 3) + '****' + key.slice(-2);
  }

  /**
   * 保存配置（整体覆盖必填项；secret_key 留空 = 沿用原值）。
   * 首次配置（文件无 secret_key）必须填写；未知名段（如 filename_key）原样保留。
   */
  save(
    input: Record<string, unknown>,
  ): { ok: boolean; error?: string } & MinioMasked {
    const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
    const bucket = typeof input?.bucket === 'string' ? input.bucket.trim() : '';
    const publicBase = typeof input?.public_base === 'string' ? input.public_base.trim() : '';
    const accessKey = typeof input?.access_key === 'string' ? input.access_key.trim() : '';
    const secretKey = typeof input?.secret_key === 'string' ? input.secret_key : '';

    if (!endpoint) return { ...this.masked(), ok: false, error: 'endpoint 不能为空' };
    if (!bucket) return { ...this.masked(), ok: false, error: 'bucket 不能为空' };
    if (!publicBase) return { ...this.masked(), ok: false, error: '公网直链基址 public_base 不能为空' };

    const existing = this.readFile();
    const finalAccess = accessKey || (existing?.access_key ? String(existing.access_key) : '');
    const finalSecret = secretKey || (existing?.secret_key ? String(existing.secret_key) : '');
    if (!finalAccess) {
      return { ...this.masked(), ok: false, error: 'access_key 不能为空（首次配置须填写；之后修改可留空保持不变）' };
    }
    if (!finalSecret) {
      return { ...this.masked(), ok: false, error: 'secret_key 不能为空（首次配置须填写；之后修改可留空保持不变）' };
    }

    const port = input?.port == null || input?.port === '' ? undefined : Number(input.port);
    if (port != null && (!Number.isFinite(port) || port <= 0 || port > 65535)) {
      return { ...this.masked(), ok: false, error: 'port 必须是 1~65535 的数字（留空表示默认 9000）' };
    }

    // 未知名段原样保留（历史扩展字段如 filename_key 不丢）。
    const next: MinioCfg = { ...((existing || {}) as MinioCfg), endpoint, bucket, public_base: publicBase };
    next.access_key = finalAccess;
    next.secret_key = finalSecret;
    if (port != null) next.port = port;
    else delete next.port;
    next.secure = input?.secure === undefined ? existing?.secure !== false : !!input.secure;

    this.writeFile(next);
    this.logger.log(`MinIO 配置已通过 UI 保存（endpoint=${endpoint}, bucket=${bucket}）`);
    // 非阻塞警告：公网直链域名与 endpoint 不一致是合法场景（内网上传 + 公网域名回源），
    // 但也是最常见的「图片链接打不开」事故来源，故保存时主动提示确认。
    const warning = this.publicBaseMismatchWarning(endpoint, publicBase);
    return { ...this.masked(), ...(warning ? { warning } : {}) };
  }

  /** public_base 域名与 endpoint 不一致时的提示文案；一致或无法解析时返回 undefined。 */
  private publicBaseMismatchWarning(endpoint: string, publicBase: string): string | undefined {
    try {
      const host = new URL(publicBase).hostname;
      if (host && host !== endpoint) {
        return `提示：公网直链基址域名（${host}）与 endpoint（${endpoint}）不一致。若公网域名未解析/反代到该 MinIO，群里的图片链接将打不开——请确认这是有意的（如内网上传 + 公网域名），或改用 http://${endpoint}:${this.masked().port ?? 9000}/…`;
      }
    } catch {
      return '提示：公网直链基址不是合法 URL（需含协议头，如 https://host/bucket/），按此配置生成的图片链接将无法访问';
    }
    return undefined;
  }

  /**
   * 连通性验证：用当前已保存配置真实连一次 MinIO——
   *  1) bucket 探活 + 应用 public-read 策略（与 MinioService.ensureBucketPublic 同逻辑）；
   *  2) 上传探针对象后**回读公网直链**，确认「公网直链基址」真的能匿名访问
   *     （这是 endpoint 与 public_base 配错位时唯一能暴露问题的检查），随后删除探针对象。
   */
  async verify(): Promise<{
    ok: boolean;
    endpoint?: string;
    bucket?: string;
    elapsed_ms?: number;
    created?: boolean;
    direct_url?: string;
    direct_ok?: boolean;
    direct_status?: number | null;
    direct_error?: string;
    error?: string;
  }> {
    const cfg = this.read();
    if (!cfg) return { ok: false, error: 'MinIO 尚未配置或必填项缺失（endpoint/access_key/secret_key/bucket/public_base）' };
    const t0 = Date.now();
    const client = new MinioClient({
      endPoint: cfg.endpoint,
      port: cfg.port ?? 9000,
      accessKey: cfg.access_key,
      secretKey: cfg.secret_key,
      useSSL: cfg.secure !== false,
    });
    try {
      let created = false;
      const exists = await client.bucketExists(cfg.bucket);
      if (!exists) {
        await client.makeBucket(cfg.bucket);
        created = true;
      }
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${cfg.bucket}/*`],
          },
        ],
      };
      await client.setBucketPolicy(cfg.bucket, JSON.stringify(policy));

      // 直链回读：上传探针对象 → GET 公网直链 → 删除探针对象。
      const probe = `.minio-verify/probe-${Date.now()}.txt`;
      const directUrl = `${cfg.public_base.replace(/\/+$/, '')}/${probe}`;
      let directOk = false;
      let directStatus: number | null = null;
      let directError: string | undefined;
      try {
        const buf = Buffer.from(`minio verify ${new Date().toISOString()}`);
        await client.putObject(cfg.bucket, probe, buf, buf.length, { 'Content-Type': 'text/plain' });
        const res = await fetch(directUrl, { signal: AbortSignal.timeout(8000) });
        directStatus = res.status;
        directOk = res.ok;
        if (!res.ok) directError = `HTTP ${res.status}`;
      } catch (e) {
        directError = (e as Error)?.message || '直链请求失败';
      } finally {
        try {
          await client.removeObject(cfg.bucket, probe);
        } catch {
          /* 探针清理失败无碍 */
        }
      }
      return {
        ok: true,
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        created,
        elapsed_ms: Date.now() - t0,
        direct_url: directUrl,
        direct_ok: directOk,
        direct_status: directStatus,
        direct_error: directError,
      };
    } catch (e) {
      return {
        ok: false,
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        elapsed_ms: Date.now() - t0,
        error: (e as Error)?.message || '连接失败',
      };
    }
  }
}
