import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { DingtalkService } from './dingtalk.service';

/**
 * 钉钉能力端点（基于官方 dws CLI）。
 *
 * 权限语义为 'machine'：仅持有效机器令牌的内部服务可调用 —— 发消息、写在线表都是
 * 强操作，不应任何登录用户都能触发。
 *
 * 接口一律类型化：不接受裸 dws 参数数组（那是被替换掉的 Python 做法）。
 */
@Controller('api')
export class DingtalkController {
  constructor(private readonly ding: DingtalkService) {}

  /** 发群消息。正文需自带 <@openDingTalkId> 占位符才会真的 @ 到人。 */
  @Post('ding/send-message')
  async sendMessage(
    @Body()
    b: { group?: string; text?: string; atOpenDingTalkIds?: string[]; dryRun?: boolean },
  ) {
    return this.guard(() =>
      this.ding.sendMessage({
        group: String(b?.group || ''),
        text: String(b?.text || ''),
        atOpenDingTalkIds: b?.atOpenDingTalkIds || [],
        dryRun: !!b?.dryRun,
      }),
    );
  }

  /** 发文件消息（图片以附件形式发送）。 */
  @Post('ding/send-file')
  async sendFile(@Body() b: { group?: string; file?: string; dryRun?: boolean }) {
    return this.guard(() =>
      this.ding.sendFile({
        group: String(b?.group || ''),
        file: String(b?.file || ''),
        dryRun: !!b?.dryRun,
      }),
    );
  }

  /** 列出我加入的全部群。 */
  @Get('ding/groups')
  async groups() {
    return this.guard(() => this.ding.listGroups());
  }

  /** 按关键词搜索群（分页拉全）。 */
  @Get('ding/search-groups')
  async searchGroups(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.guard(() =>
      this.ding.searchGroups(String(q || ''), Number(limit) || 20),
    );
  }

  /** 按群号取群信息（chat-list-all 会漏的隐藏群走这里）。 */
  @Get('ding/group')
  async groupByNumber(@Query('number') number?: string) {
    return this.guard(() => this.ding.getGroupByNumber(String(number || '')));
  }

  /** 按群名解析 openConversationId（不写死 ID，匹配不明确时拒绝）。 */
  @Get('ding/resolve-group')
  async resolveGroup(@Query('name') name?: string) {
    return this.guard(() => this.ding.resolveGroup(String(name || '')));
  }

  /** 读在线表格区域。 */
  @Post('ding/sheet/read')
  async sheetRead(
    @Body() b: { node?: string; sheetId?: string; range?: string },
  ) {
    return this.guard(() =>
      this.ding.sheetReadRange({
        node: String(b?.node || ''),
        sheetId: String(b?.sheetId || ''),
        range: String(b?.range || ''),
      }),
    );
  }

  /** 写在线表格区域（values 为二维数组）。 */
  @Post('ding/sheet/update')
  async sheetUpdate(
    @Body()
    b: { node?: string; sheetId?: string; range?: string; values?: string[][]; dryRun?: boolean },
  ) {
    return this.guard(() =>
      this.ding.sheetUpdateRange({
        node: String(b?.node || ''),
        sheetId: String(b?.sheetId || ''),
        range: String(b?.range || ''),
        values: b?.values || [],
        dryRun: !!b?.dryRun,
      }),
    );
  }

  /** 发起钉钉设备流登录：返回 userCode + verificationUri，供前端展示让用户授权。 */
  @Post('ding/auth/device-login')
  async deviceLogin() {
    return this.guard(() => this.ding.deviceLogin());
  }

  /** 查询钉钉登录状态（是否已授权）。 */
  @Get('ding/auth/status')
  async authStatus() {
    return this.guard(() => this.ding.authStatus());
  }

  /** 退出钉钉登录（清除登录态，用于重新授权）。 */
  @Post('ding/auth/logout')
  async authLogout() {
    return this.guard(() => this.ding.authLogout());
  }

  /** 读取 dws CLI 全部配置项（元数据 + 当前生效值）。 */
  @Get('ding/config')
  async dingConfig() {
    return this.guard(() => this.ding.getDingConfig());
  }

  /** 保存 dws CLI 配置覆盖（空字符串表示删除该覆盖，恢复内置默认）。 */
  @Post('ding/config')
  async saveDingConfig(@Body() b: { patch?: Record<string, string> }) {
    return this.guard(() => this.ding.saveDingConfig(b?.patch || {}));
  }

  private async guard(fn: () => Promise<unknown>) {
    try {
      return { ok: true, data: await fn() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
