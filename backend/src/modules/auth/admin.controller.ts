import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { DataPermService, DEFAULT_SCOPE } from './data-perm.service';
import { PERM_CATALOG, ALL_PERMS } from './permissions';
import { ComputeService } from '../compute/compute.service';

/**
 * 账号 / 角色 / 密码策略 / 数据权限 管理端点（端口自 core/auth.py 与 core/dataperm.py，
 * 原 Python 实现已删除 —— 这里是唯一入口）。
 * 路由→权限由 AccessGuard 按 permissions.ts 自动裁决（admin:users / admin:roles /
 * admin:policy / admin:data-perm）。
 */
@Controller('api')
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly dataPerm: DataPermService,
    private readonly compute: ComputeService,
  ) {}

  private currentUser(req: Request): { user: string; role: string } | null {
    const t =
      (req.headers['x-token'] as string) ||
      ((req.query as Record<string, unknown>)['token'] as string | undefined);
    const s = this.auth.getSession(t);
    return s ? { user: s.user, role: s.role } : null;
  }

  // ---------------- 账号 ----------------
  @Get('admin/users')
  users() {
    return { ok: true, users: this.auth.listUsersSafe() };
  }
  @Post('admin/user')
  addUser(@Body() b: Record<string, any>) {
    try {
      this.auth.addUser(b.username, b.password, b.role);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  @Post('admin/user/update')
  updateUser(@Body() b: Record<string, any>) {
    try {
      this.auth.updateUser(b.username, b.role, b.disabled);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  @Post('admin/user/reset-pw')
  resetPw(@Body() b: Record<string, any>) {
    try {
      this.auth.resetPassword(b.username, b.password);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  @Post('admin/user/delete')
  deleteUser(@Req() req: Request, @Body() b: Record<string, any>) {
    const cur = this.currentUser(req);
    try {
      this.auth.deleteUser(b.username, cur?.user);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---------------- 角色 ----------------
  @Get('admin/roles')
  roles() {
    // all_perms：角色权限编辑页按它渲染「权限点」勾选框（admin.js 的 _allPerms）。
    // 单体返回的是排序后的权限点数组；Nest 侧 ALL_PERMS 是 Set，需转成排序数组。
    // 缺这个字段不会报错，只会让勾选框渲染成一片空白。
    return {
      ok: true,
      roles: this.auth.listRoles(),
      catalog: PERM_CATALOG,
      all_perms: [...ALL_PERMS].sort(),
    };
  }
  @Post('admin/role')
  createRole(@Body() b: Record<string, any>) {
    try {
      this.auth.createRole(b.name, b.perms || [], b.parents || []);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  @Post('admin/role/update')
  updateRole(@Body() b: Record<string, any>) {
    try {
      this.auth.updateRole(b.name, b.perms, b.parents);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  @Post('admin/role/delete')
  deleteRole(@Body() b: Record<string, any>) {
    try {
      this.auth.deleteRole(b.name);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---------------- 密码策略 ----------------
  @Get('policy')
  policy() {
    return { ok: true, policy: this.auth.getPolicy() };
  }
  @Post('policy')
  setPolicy(@Body() b: Record<string, any>) {
    try {
      return { ok: true, policy: this.auth.setPolicy(b) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---------------- 数据权限 ----------------
  /** 站点全集（含名称）+ 取数来源。
   *  名称只有 Python 侧有（风神站点接口，带缓存）；Nest 本地只有 id。
   *  经 ComputePort 复用 /api/teams 的同一份结果；计算服务不可用则降级 none，
   *  绝不让管理页因为拿不到站点名就整个打不开。 */
  private async fetchTeams(): Promise<{ list: { id: string; name: string }[]; source: string }> {
    try {
      const r = await this.compute.proxy({
        endpoint: '/api/teams',
        method: 'GET',
        headers: { 'x-scope': '*', 'x-user': '' },
      });
      const d = (r.data || {}) as Record<string, unknown>;
      const raw = Array.isArray(d['teams']) ? (d['teams'] as unknown[]) : [];
      const list = raw
        .map((t) => {
          const o = (t || {}) as Record<string, unknown>;
          return { id: String(o['id'] ?? ''), name: String(o['name'] ?? o['id'] ?? '') };
        })
        .filter((t) => t.id);
      const src = typeof d['source'] === 'string'
        ? String(d['source'])
        : (list.length ? 'cache' : 'none');
      return { list, source: src };
    } catch {
      return { list: [], source: 'none' };
    }
  }

  /**
   * 字段形状必须对齐前端 admin.js —— 它按单体的**扁平**结构读：
   * users / all_teams / business_lines / cities / ungrouped / bl_of_city /
   * default_new_site / teams_source / default_scope。
   *
   * 此前这里返回的是嵌套的 org:{cities,business_lines,default_new_site}：
   * 两侧各自都对、拼起来是坏的，数据权限页因此拿不到用户列表和站点选择器。
   * （这类「契约对不上」只有跨实现比对才能发现，单侧测试与路由扫描都测不出来。）
   */
  @Get('data-perms')
  async dataPerms() {
    const orgIds = this.dataPerm.orgCities();
    const teams = await this.fetchTeams();
    const nameOf = new Map(teams.list.map((t) => [t.id, t.name]));
    // org 的值是「站点对象」而不是裸 id：前端 openOrgEditor 按 {city:[{id,name}]} 读
    // （admin.js 注释即如此），单体的形状也一样。
    const org: Record<string, { id: string; name: string }[]> = {};
    const inOrg = new Set<string>();
    for (const [c, ts] of Object.entries(orgIds)) {
      org[c] = ts.map((id) => ({ id: String(id), name: nameOf.get(String(id)) || String(id) }));
      for (const id of ts) inOrg.add(String(id));
    }
    return {
      ok: true,
      rules: this.dataPerm.listRules(),
      org,
      users: this.auth.listUsersSafe(),
      all_teams: teams.list,
      ungrouped: teams.list.filter((t) => !inOrg.has(t.id)),
      business_lines: this.dataPerm.businessLines(),
      cities: this.dataPerm.cities(),
      bl_of_city: this.dataPerm.blOfCity(),
      teams_source: teams.source,
      default_scope: DEFAULT_SCOPE,
      default_new_site: this.dataPerm.getDefaultNewSite(),
    };
  }
  @Get('data-perms/org')
  org() {
    return {
      ok: true,
      cities: this.dataPerm.cities(),
      business_lines: this.dataPerm.businessLines(),
      default_new_site: this.dataPerm.getDefaultNewSite(),
    };
  }
  @Post('data-perms')
  setDataPerm(@Body() b: Record<string, any>) {
    try {
      this.dataPerm.setRule(b.username, b.scope, {
        teams: b.teams,
        cities: b.cities,
        business_lines: b.business_lines,
        inherit_new: b.inherit_new,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  @Post('data-perms/delete')
  deleteDataPerm(@Body() b: Record<string, any>) {
    try {
      this.dataPerm.deleteRule(b.username);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
