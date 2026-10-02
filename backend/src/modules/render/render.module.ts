import { Module } from '@nestjs/common';
import { ReportRenderService } from './report-render.service';

/** 报表渲染模块（PNG 出图，移植自 common/report_render.py）。 */
@Module({
  providers: [ReportRenderService],
  exports: [ReportRenderService],
})
export class RenderModule {}
