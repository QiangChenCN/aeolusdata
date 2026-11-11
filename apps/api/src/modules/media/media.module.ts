import { Module } from '@nestjs/common';
import { MinioService } from './minio.service';
import { MinioConfigService } from './minio-config.service';
import { MediaController } from './media.controller';

/** 媒体/对象存储模块（MinIO 图床 + 图床配置 UI）。 */
@Module({
  controllers: [MediaController],
  providers: [MinioService, MinioConfigService],
  exports: [MinioService, MinioConfigService],
})
export class MediaModule {}
