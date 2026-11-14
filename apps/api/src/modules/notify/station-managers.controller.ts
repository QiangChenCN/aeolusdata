import { Body, Controller, Get, Post } from '@nestjs/common';
import { StationManagersService } from './station-managers.service';

/**
 * 站点负责人映射（系统设置 → 站点负责人设置）。
 * 供实时在线播报等任务「按站点 @ 负责人」使用；全部端点限 config:write 权限
 * （见 modules/auth/permissions.ts）。
 */
@Controller('api/notify')
export class StationManagersController {
  constructor(private readonly svc: StationManagersService) {}

  /** 当前映射（文件不存在时返回硬编码默认，configured=false 提示前端）。 */
  @Get('station-managers')
  get() {
    return this.svc.get();
  }

  /** 保存映射（整体覆盖 stations；openDingTalkId 无需手动填，自动解析）。 */
  @Post('station-managers')
  save(@Body() b: Record<string, unknown>) {
    return this.svc.save(b || {});
  }

  /**
   * 一键解析：把配置里引用到的全部负责人姓名拿去通讯录搜索 openDingTalkId
   * （与发送目标群无关），结果落缓存。
   */
  @Post('station-managers/resolve')
  resolve(@Body() _b: Record<string, unknown>) {
    return this.svc.resolveAll();
  }
}
