import { Body, Controller, Get, Post } from '@nestjs/common';
import { MinioConfigService } from './minio-config.service';

/**
 * MinIO 图床配置（系统设置 → MinIO 设置）。
 * 全部端点限 admin:minio 权限（见 modules/auth/permissions.ts）。
 */
@Controller('api/media')
export class MediaController {
  constructor(private readonly minioCfg: MinioConfigService) {}

  /** 当前 MinIO 配置（脱敏快照：secret_key 明文永不外泄，access_key 只给首尾提示）。 */
  @Get('minio')
  minioGet() {
    return this.minioCfg.masked();
  }

  /** 保存 MinIO 配置（secret_key 留空 = 沿用原值；保存后立即热生效，无需重启）。 */
  @Post('minio')
  minioSave(@Body() b: Record<string, unknown>) {
    return this.minioCfg.save(b || {});
  }

  /**
   * 连通性验证：用当前已保存配置真实连一次 MinIO，
   * 确认 bucket 可访问并应用 public-read 策略（不存在则创建）。
   */
  @Post('minio/test')
  minioTest() {
    return this.minioCfg.verify();
  }
}
