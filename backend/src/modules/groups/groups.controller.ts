import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { GroupsService } from './groups.service';

/**
 * 群选择器（目标群 Combobox）HTTP 端点。完全在 NestJS 实现，不再 spawn Python。
 *
 *   GET  /api/groups?q=    搜索（q 缺省/空 → 最近使用）
 *   GET  /api/groups?id=   按 openConversationId 反查群名
 *   POST /api/groups/used  登记最近使用 {id,title}
 *   POST /api/groups/forget 移除 {id}
 *
 * 返回顶层 {groups, source, query}（与前端 api() 不解包 {ok,data} 的约定一致）。
 * 权限：GET 走 view（持机器令牌/会话即放行），POST used/forget 走 groups:write，
 * 由全局 AccessGuard 按 permissions.ts 裁决。
 */
@Controller('api')
export class GroupsController {
  constructor(private readonly svc: GroupsService) {}

  @Get('groups')
  async groups(@Query('q') q?: string, @Query('id') id?: string) {
    if (id) {
      return { groups: await this.svc.byId(String(id)), source: 'cache' };
    }
    if (q !== undefined) {
      return {
        groups: await this.svc.search(String(q || '')),
        source: q ? 'remote' : 'recent',
        query: q || '',
      };
    }
    return { groups: await this.svc.recent(), source: 'recent', query: '' };
  }

  @Post('groups/used')
  async used(@Body() b: { id?: string; title?: string }) {
    this.svc.noteUsed(String(b?.id || ''), b?.title);
    return { ok: true };
  }

  @Post('groups/forget')
  async forget(@Body() b: { id?: string }) {
    this.svc.forget(String(b?.id || ''));
    return { ok: true };
  }
}
