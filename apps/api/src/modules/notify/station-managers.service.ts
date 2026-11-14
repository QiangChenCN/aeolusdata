import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { StationManagersCfg, PRODUCTION_GROUP_NAME } from './notify-config';
import { DingtalkService } from '../../modules/dingtalk/dingtalk.service';

export interface ResolvedNames {
  /** [姓名, openDingTalkId]，已按姓名去重、剔除「不参与 @」的负责人。 */
  resolved: [string, string][];
  /** 未解析到 openid 的姓名。 */
  missing: string[];
}

/** 自动解析缓存的落盘结构（与 UI 维护的 station_managers.json 分离）。 */
interface IdCacheFile {
  /** 缓存来源群（openDingTalkId 只在群成员语义下稳定）。 */
  group: string;
  ids: Record<string, string>;
  updated_at: string;
}

/**
 * 站点负责人映射的**唯一**运行时存储：由「系统设置 → 站点负责人设置」UI 维护，
 * 落盘 `apps/api/runtime/station_managers.json`（与 credentials.json / minio_config.json
 * 同目录，gitignored 运行时产物）。保存后立即热生效，无需重启。
 *
 * 存在意义：实时在线播报 / 申诉提醒 / 装备点亮等任务需要「按站点 @ 对应负责人」，
 * 而站点负责人会随人事变动更换——不允许再改代码常量。
 *
 * openDingTalkId **不需要手动维护**：
 *  · UI 只维护「站点 → 负责人姓名」；
 *  · 发送时按姓名走通讯录搜索（dws contact +search-user 直接返回 openDingTalkId），
 *    与消息发到哪个群无关；通讯录不可用时降级从默认生产群群成员解析；
 *  · 解析成功的结果缓存到 `manager_ids_cache.json`（同目录），命中缓存不再请求；
 *  · 唯一来源：UI 文件显式填写的 managers（含保存时自动回填的 ID）→ 自动解析缓存。
 *    **没有任何内置兜底表**——未配置/解析不到就不 @（任务日志告警）。
 *
 * 站点映射同理：station_managers.json 是唯一事实来源，不存在时所有站点都视为未配置。
 */
@Injectable()
export class StationManagersService {
  private readonly logger = new Logger(StationManagersService.name);
  private readonly file: string;
  private readonly cacheFile: string;

  constructor(
    private readonly config: ConfigService,
    private readonly dingtalk: DingtalkService,
  ) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    const runtime = path.join(root, 'apps', 'api', 'runtime');
    this.file = path.join(runtime, 'station_managers.json');
    this.cacheFile = path.join(runtime, 'manager_ids_cache.json');
  }

  // ── UI 配置文件（station_managers.json）──

  private readFile(): StationManagersCfg | null {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!d || typeof d !== 'object') return null;
      if (!Array.isArray(d.stations)) return null;
      if (!Array.isArray(d.managers)) d.managers = [];
      return d as StationManagersCfg;
    } catch {
      return null;
    }
  }

  private writeFile(cfg: StationManagersCfg): void {
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

  /** UI 配置文件是否已存在（true = 已保存过；false = 走硬编码默认）。 */
  isConfigured(): boolean {
    return this.readFile() != null;
  }

  /** 生效配置（UI 展示用）：文件存在则原样返回，否则空配置（无内置默认值）。 */
  read(): StationManagersCfg {
    return this.readFile() || { managers: [], stations: [] };
  }

  // ── 自动解析缓存（manager_ids_cache.json）──

  private readCache(): IdCacheFile {
    try {
      const d = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
      if (d && typeof d === 'object' && d.ids && typeof d.ids === 'object') return d as IdCacheFile;
    } catch {
      /* 无缓存 */
    }
    return { group: '', ids: {}, updated_at: '' };
  }

  private writeCache(c: IdCacheFile): void {
    const tmp = `${this.cacheFile}.tmp`;
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.cacheFile);
    try {
      fs.chmodSync(this.cacheFile, 0o600);
    } catch {
      /* 权限微调失败不影响写入 */
    }
  }

  // ── 站点 → 负责人姓名 ──

  /**
   * 站点名/团队名 -> 负责人姓名列表。
   * 仅依据 UI 配置文件，按 站点简称 / 站点名称(全称) / 站点ID / teams 别名 精确匹配；
   * 匹配不到或文件不存在都返回空（无内置兜底，由调用方告警）。
   */
  managersForTeam(team: string): string[] {
    const t = (team || '').trim();
    if (!t) return [];
    const cfg = this.readFile();
    if (!cfg) return [];
    for (const s of cfg.stations) {
      if (
        s.name === t ||
        (s.station_name && s.station_name === t) ||
        (s.station_id && s.station_id === t) ||
        (s.teams || []).includes(t)
      ) {
        return [...(s.managers || [])];
      }
    }
    return [];
  }

  // ── 姓名 → openDingTalkId ──

  /** 姓名 -> openDingTalkId（UI 显式配置 → 自动解析缓存；无内置兜底）。 */
  openIdFor(name: string): string | undefined {
    const cfg = this.readFile();
    if (cfg) {
      for (const m of cfg.managers) if (m.name === name && m.open_id) return m.open_id;
    }
    const cache = this.readCache();
    if (cache.ids[name]) return cache.ids[name];
    return undefined;
  }

  /** 同步解析（显式配置/缓存内命中），不发网络请求；跳过「不参与 @」的负责人。 */
  resolveNames(names: Iterable<string>): ResolvedNames {
    const resolved: [string, string][] = [];
    const missing: string[] = [];
    for (const n of [...new Set(names)].filter(Boolean).sort()) {
      if (this.isNoAt(n)) continue;
      const oid = this.openIdFor(n);
      if (oid) resolved.push([n, oid]);
      else missing.push(n);
    }
    return { resolved, missing };
  }

  /** 该姓名是否被标记为「不参与 @」（仅 UI 配置，无内置名单）。 */
  private isNoAt(name: string): boolean {
    const cfg = this.readFile();
    if (!cfg) return false;
    return cfg.managers.some((m) => m.name === name && m.no_at);
  }

  /**
   * 异步自动解析 openDingTalkId，与发送目标群**无关**（发哪个群都能 @ 对）：
   *  1. 缓存/内置常量命中 → 直接用；
   *  2. 未命中 → 通讯录按姓名搜索（dws contact +search-user，直接返回 openDingTalkId），
   *     要求返回结果中**姓名精确相等且唯一**才采用；
   *     若同名多人（歧义），且该负责人在 UI 配置了手机号 → 用 `contact +by-mobile`
   *     反查 userId，与候选人 userId 比对唯一定位，消除「同名就拒绝解析」的限制；
   *  3. 通讯录搜索整体失败（网络/权限）→ 降级拉「站点日常管理通知群」群成员匹配。
   * 解析成功即落缓存，下次零成本命中。
   */
  async resolveNamesAuto(names: Iterable<string>): Promise<ResolvedNames> {
    const first = this.resolveNames(names);
    if (!first.missing.length) return first;

    const cache = this.readCache();
    let dirty = false;
    let dirFailed = false; // 通讯录搜索是否整体不可用（只降级一次，不逐名重试）
    let members: { name: string; openDingTalkId: string }[] | null = null; // 降级用的群成员，懒加载一次
    const still: string[] = [];

    // UI 配置里的姓名 → 手机号（同名歧义时反查消歧用）
    const cfgNow = this.readFile();
    const mobiles = new Map<string, string>();
    for (const m of cfgNow?.managers || []) {
      if (m.mobile && !mobiles.has(m.name)) mobiles.set(m.name, m.mobile.trim());
    }

    for (const n of first.missing) {
      let candidates: { name: string; openDingTalkId?: string; userId?: string }[] = [];
      if (!dirFailed) {
        try {
          const all = await this.dingtalk.searchUserByName(n);
          candidates = all.filter((u) => u.name === n && u.openDingTalkId); // 精确匹配，拒绝前缀/包含式误伤
        } catch (e) {
          dirFailed = true;
          this.logger.warn(`通讯录搜索不可用（${(e as Error).message.slice(0, 120)}），尝试降级群成员解析`);
        }
      }
      if (!candidates.length && dirFailed) {
        // 降级：从默认生产群群成员里找（整轮只拉一次，内存比对）
        if (members === null) {
          try {
            members = await this.dingtalk.listMembers(PRODUCTION_GROUP_NAME);
          } catch (e) {
            this.logger.warn(`群成员解析也失败：${(e as Error).message.slice(0, 120)}`);
            members = [];
          }
        }
        candidates = (members || []).filter((u) => u.name === n);
      }
      // 同名多人 → 手机号反查 userId 消歧（有 openDingTalkId 的候选才能比对）
      if (candidates.length > 1) {
        const mobile = mobiles.get(n);
        if (mobile) {
          try {
            const uid = await this.dingtalk.searchUserIdByMobile(mobile);
            if (uid) {
              const matched = candidates.filter((c) => c.userId === uid);
              if (matched.length === 1) {
                this.logger.log(`姓名「${n}」同名 ${candidates.length} 人，经手机号反查（userId=${uid}）唯一确定`);
                candidates = matched;
              }
            }
          } catch (e) {
            this.logger.warn(`手机号反查失败（${mobile.slice(0, 4)}****）：${(e as Error).message.slice(0, 100)}`);
          }
        }
      }
      if (candidates.length === 1) {
        const id = candidates[0].openDingTalkId as string;
        cache.ids[n] = id;
        dirty = true;
        first.resolved.push([n, id]);
        this.logger.log(`自动解析 openDingTalkId：${n} → ${id.slice(0, 12)}…`);
      } else if (candidates.length > 1) {
        this.logger.warn(
          `姓名「${n}」在通讯录匹配到 ${candidates.length} 人${mobiles.has(n) ? '（手机号反查仍无法唯一确定）' : '（可在负责人设置里填手机号辅助消歧）'}，跳过 @`,
        );
        still.push(n);
      } else {
        still.push(n);
      }
    }
    if (dirty) {
      cache.group = '通讯录';
      cache.updated_at = new Date().toISOString();
      this.writeCache(cache);
    }
    first.resolved.sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    first.missing = still.sort();
    return first;
  }

  /** 立即解析：把配置里引用到的全部负责人姓名都跑一遍自动解析（UI「一键解析」用）。 */
  async resolveAll(): Promise<ResolvedNames & { group: string }> {
    const cfg = this.readFile() || { managers: [], stations: [] };
    const names = new Set<string>();
    for (const s of cfg.stations) for (const m of s.managers) names.add(m);
    for (const m of cfg.managers) names.add(m.name);
    const r = await this.resolveNamesAuto([...names]);
    return { ...r, group: '通讯录' };
  }

  /** 全量 @ 名单（UI 配置的负责人去重、剔除「不参与 @」者），供「一个站点都没匹配到负责人」时兜底。 */
  allManagerIds(): string[] {
    const cfg = this.readFile();
    const ids: string[] = [];
    if (!cfg) return ids;
    for (const m of cfg.managers) {
      if (!m.open_id || m.no_at || ids.includes(m.open_id)) continue;
      ids.push(m.open_id);
    }
    return ids;
  }

  // ── UI 读写 ──

  /** UI 展示快照：站点映射 + 自动解析缓存（含来源标注）。未保存过配置时展示**空列表**，由用户手动添加。 */
  get(): {
    ok: boolean;
    configured: boolean;
    source: 'file' | 'defaults';
    cache_group: string;
    cache_updated_at: string;
    cache: { name: string; open_id: string }[];
  } & StationManagersCfg {
    const cfg = this.isConfigured() ? this.read() : { managers: [], stations: [] };
    const cache = this.readCache();
    return {
      ok: true,
      configured: this.isConfigured(),
      source: this.isConfigured() ? 'file' : 'defaults',
      cache_group: cache.group,
      cache_updated_at: cache.updated_at,
      cache: Object.entries(cache.ids).map(([name, open_id]) => ({ name, open_id })),
      managers: cfg.managers,
      stations: cfg.stations,
    };
  }

  /**
   * 保存（整体覆盖 stations；managers 可选：不传则沿用现有值）。
   * 保存成功后**自动解析**缺失的 openDingTalkId（结果落缓存），并在响应中返回未解析名单。
   */
  async save(
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; warning?: string; missing?: string[] } & ReturnType<StationManagersService['get']>> {
    const stationsRaw = Array.isArray(input?.stations) ? input.stations : null;
    if (!stationsRaw) {
      return { ...this.get(), ok: false, error: 'stations 必须是数组' };
    }

    // managers：显式传了才覆盖（一般只有旧数据迁移/手动修正才用）
    const managersRaw = Array.isArray(input?.managers) ? input.managers : null;
    const existing = this.readFile();
    const nameSet = new Set<string>();
    const oidSet = new Set<string>();
    const managers: { name: string; mobile?: string; title?: string; open_id: string }[] = [];
    for (const m of managersRaw || existing?.managers || []) {
      const name = typeof m?.name === 'string' ? m.name.trim() : '';
      const mobile = typeof m?.mobile === 'string' ? m.mobile.trim() : '';
      const title = typeof m?.title === 'string' ? m.title.trim() : '';
      const noAt = m?.no_at === true;
      const openId = typeof m?.open_id === 'string' ? m.open_id.trim() : '';
      if (!name) continue; // 只填姓名即可，openDingTalkId 留空由自动解析补齐
      if (nameSet.has(name)) return { ...this.get(), ok: false, error: `负责人姓名重复：${name}` };
      if (openId) {
        if (oidSet.has(openId)) {
          return { ...this.get(), ok: false, error: `openDingTalkId 重复（${name} 与已有人员共用同一 ID）` };
        }
        oidSet.add(openId);
      }
      nameSet.add(name);
      managers.push({
        name,
        ...(mobile ? { mobile } : {}),
        ...(title ? { title } : {}),
        ...(noAt ? { no_at: true } : {}),
        open_id: openId,
      });
    }

    const stationSeen = new Set<string>();
    const stations: { station_id?: string; station_name?: string; name: string; address?: string; teams: string[]; managers: string[] }[] = [];
    for (const s of stationsRaw) {
      const stationId = typeof s?.station_id === 'string' ? s.station_id.trim() : '';
      const stationName = typeof s?.station_name === 'string' ? s.station_name.trim() : '';
      const name = typeof s?.name === 'string' ? s.name.trim() : '';
      const address = typeof s?.address === 'string' ? s.address.trim() : '';
      const teams = Array.isArray(s?.teams)
        ? s.teams.map((t: unknown) => String(t || '').trim()).filter(Boolean)
        : [];
      const ms = Array.isArray(s?.managers)
        ? s.managers.map((x: unknown) => String(x || '').trim()).filter(Boolean)
        : [];
      if (!name && !stationName && !stationId && !teams.length && !ms.length) continue; // 空行跳过
      if (!name && !stationName) return { ...this.get(), ok: false, error: '站点简称/站点名称至少填一个' };
      if (stationSeen.has(name)) return { ...this.get(), ok: false, error: `站点重复：${name || stationName}` };
      stationSeen.add(name);
      // 站点名称并入 teams，兼容仅按全称匹配的任务数据（ teams 仍保留以兼容旧文件）
      const allTeams = Array.from(new Set([...teams, ...(stationName ? [stationName] : [])]));
      stations.push({
        ...(stationId ? { station_id: stationId } : {}),
        ...(stationName ? { station_name: stationName } : {}),
        name,
        ...(address ? { address } : {}),
        teams: allTeams,
        managers: Array.from(new Set(ms)) as string[],
      });
    }

    const next: StationManagersCfg = { managers, stations };
    this.writeFile(next);
    this.logger.log(`站点负责人配置已通过 UI 保存（站点 ${stations.length} 个，显式 ID ${managers.length} 条）`);
    const warning = stations.some((s) => !s.managers.length)
      ? '有站点未配置任何负责人：该站点有未上线骑手时将无法 @ 到人（任务日志会给出提示）'
      : undefined;

    // 保存后自动解析：只针对缓存/常量未命中的姓名，结果落缓存供任务发送使用
    let missing: string[] = [];
    try {
      const r = await this.resolveAll();
      missing = r.missing;
      // 把解析出的 ID 回填到显式配置里 open_id 为空的负责人上（无论来源是缓存、
      // 通讯录还是内置常量），保证 UI 上能直接看到解析结果
      if (r.resolved.length) {
        const byName = new Map(r.resolved);
        const cur = this.readFile();
        if (cur) {
          let changed = false;
          for (const m of cur.managers) {
            if (!m.open_id && byName.has(m.name)) {
              m.open_id = byName.get(m.name) as string;
              changed = true;
            }
          }
          if (changed) this.writeFile(cur);
        }
      }
      if (r.resolved.length) {
        this.logger.log(`保存后自动解析 openDingTalkId：成功 ${r.resolved.length} 人${missing.length ? `，未解析 ${missing.length} 人` : ''}`);
      }
    } catch (e) {
      this.logger.warn(`保存后自动解析 openDingTalkId 失败（任务发送时会重试）：${(e as Error).message.slice(0, 160)}`);
    }

    return { ...this.get(), ok: true, ...(warning ? { warning } : {}), ...(missing.length ? { missing } : {}) };
  }
}
