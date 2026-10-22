import { Module } from '@nestjs/common';
import { MinioService } from './minio.service';

/** 媒体/对象存储模块（MinIO 图床）。 */
@Module({
  providers: [MinioService],
  exports: [MinioService],
})
export class MediaModule {}
