import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DingtalkService } from '../dingtalk/dingtalk.service';

interface RecentItem {
  id: string;
  title: string;
  used_at: number;
}

/**
 * 群选择器后端：最近使用 + 按匹配度搜索 + 按 openConversationId 反查。
 * 与旧 Python workbench/group_picker.py 等价，但**完全在 NestJS 内实现**——
 * 群列表/搜索/解析统一走 DingtalkService（由它调官方 dws CLI），不再 spawn Python。
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);
  private readonly ding: DingtalkService;
  private readonly recentPath = path.join(process.cwd(), 'runtime', 'recent_groups.json');
  private readonly ttl = 600_000;
  private readonly recentMax = 20;
  private cache: { ts: number; groups: { id: string; title: string }[] } = { ts: 0, groups: [] };

  constructor(ding: DingtalkService) {
    this.ding = ding;
  }

  private async allGroups(force = false): Promise<{ id: string; title: string }[]> {
    const now = Date.now();
    if (!force && this.cache.groups.length && now - this.cache.ts < this.ttl) {
      return this.cache.groups;
    }
    const groups = await this.ding.listGroups();
    const result = groups
      .filter((g) => g.title)
      .map((g) => ({ id: g.openConversationId, title: g.title }));
    if (result.length || force) this.cache = { ts: now, groups: result };
    return this.cache.groups;
  }

  private readRecent(): RecentItem[] {
    try {
      if (!fs.existsSync(this.recentPath)) return [];
      const raw = fs.readFileSync(this.recentPath, 'utf-8') || '{}';
      const data = JSON.parse(raw);
      const items: RecentItem[] = Array.isArray(data) ? data : data.items || [];
      return items.filter((x) => x && x.id);
    } catch {
      return [];
    }
  }

  private writeRecent(items: RecentItem[]): void {
    try {
      fs.mkdirSync(path.dirname(this.recentPath), { recursive: true });
      const tmp = this.recentPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf-8');
      fs.renameSync(tmp, this.recentPath);
    } catch (e) {
      this.logger.warn('写入最近群失败: %s', (e as Error).message);
    }
  }

  async recent(): Promise<{ id: string; title: string }[]> {
    const items = this.readRecent().sort((a, b) => (b.used_at || 0) - (a.used_at || 0));
    const pool = new Map((await this.allGroups()).map((g) => [g.id, g.title]));
    const out: { id: string; title: string }[] = [];
    for (const it of items) {
      const id = it.id;
      let title = (it.title || '').trim();
      if (!title || title === id) title = (pool.get(id) || '').trim();
      if (!title) continue;
      out.push({ id, title });
      if (out.length >= 10) break;
    }
    return out;
  }

  async search(
    q: string,
  ): Promise<{ id: string; title: string; score: number; recent: boolean }[]> {
    const query = (q || '').trim();
    if (!query) {
      return (await this.recent()).map((g) => ({ ...g, score: 100, recent: true }));
    }
    const scored = await this.ding.searchScored(query, 20);
    const recentIds = new Set(this.readRecent().map((x) => x.id));
    return scored.map((s) => ({
      id: s.openConversationId,
      title: s.title,
      score: s.score,
      recent: recentIds.has(s.openConversationId),
    }));
  }

  async byId(gid: string): Promise<{ id: string; title: string }[]> {
    const id = (gid || '').trim();
    if (!id) return [];
    const pool = new Map((await this.allGroups()).map((g) => [g.id, g.title]));
    const title = pool.get(id);
    if (title) return [{ id, title }];
    for (const x of this.readRecent()) {
      if (x.id === id) {
        const t = (x.title || '').trim();
        if (t && t !== id) return [{ id, title: t }];
      }
    }
    return [];
  }

  noteUsed(id: string, title?: string): void {
    const gid = (id || '').trim();
    if (!gid) return;
    const t = (title || '').trim();
    const items = this.readRecent().filter((x) => x.id !== gid);
    items.unshift({ id: gid, title: t === gid ? '' : t, used_at: Math.floor(Date.now() / 1000) });
    this.writeRecent(items.slice(0, this.recentMax));
  }

  forget(id: string): void {
    const gid = (id || '').trim();
    if (!gid) return;
    this.writeRecent(this.readRecent().filter((x) => x.id !== gid));
  }
}
