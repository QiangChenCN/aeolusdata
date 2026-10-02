import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 钉钉能力服务 —— 基于官方 dws CLI（Apache-2.0，Go 实现）。
 *
 * 集成方式说明（重要）：dws **只提供 CLI，没有 SDK**。官方用法就是命令行 +
 * `--format json`（结构化输出）+ `--yes`（跳过确认）+ `--dry-run`（预览不执行）。
 * npm 包 dingtalk-workspace-cli 只是二进制安装器。因此"从 Node 起 CLI"是官方路径，
 * 不是绕路 —— 但**不复制 Python 那套**（Python 自己拼 `node dws.js` 路径、手工解 JSON、
 * 把原始 args 当接口传）。这里一律收敛成类型化方法。
 *
 * 凭证由 dws 自己持有并按需自动刷新（OAuth 设备流 / 自建应用），本服务不接触 token；
 * dws 自带进程内 + 跨进程双层锁，并发调用安全。
 */
export interface DwsOpts {
  profile?: string;
  timeout?: number;
  dryRun?: boolean;
  yes?: boolean;
}

export interface DingGroup {
  openConversationId: string;
  title: string;
  score?: number;
}

@Injectable()
export class DingtalkService {
  private readonly logger = new Logger(DingtalkService.name);

  constructor(private readonly config: ConfigService) {}

  // ---------------------------------------------------------- 命令解析
  /**
   * dws 可执行命令候选（按优先级）。官方推荐 `npm i -g dingtalk-workspace-cli`
   * 让 dws 进 PATH，故 PATH 优先；未安装时回退显式配置。
   */
  private candidates(): string[][] {
    const list: string[][] = [['dws']];
    const bin = (this.config.get<string>('DING_DWS_BIN') || '').trim();
    if (bin && fs.existsSync(bin)) list.push([bin]);
    const js = (this.config.get<string>('DING_DWS_JS') || '').trim();
    if (js && fs.existsSync(js)) list.push([process.execPath, js]);
    return list;
  }

  private spawnOnce(
    cmd: string[],
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string; enoent: boolean }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let enoent = false;
      let child;
      try {
        child = spawn(cmd[0], cmd.slice(1).concat(args), { windowsHide: true });
      } catch (e) {
        resolve({ code: -1, stdout, stderr: String(e), enoent: true });
        return;
      }
      child.stdout?.on('data', (d) => (stdout += String(d)));
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('error', (e: NodeJS.ErrnoException) => {
        enoent = e?.code === 'ENOENT';
        resolve({ code: -1, stdout, stderr: String(e?.message || e), enoent });
      });
      child.on('close', (code) =>
        resolve({ code: code ?? -1, stdout, stderr, enoent }),
      );
    });
  }

  /** 执行 dws 并解析 JSON 输出。 */
  private async run(args: string[], opts: DwsOpts = {}): Promise<Record<string, any>> {
    const full = args.slice();
    const profile = opts.profile ?? this.config.get<string>('DING_PROFILE');
    if (profile) full.push('--profile', String(profile));
    const timeout = opts.timeout ?? Number(this.config.get<string>('DING_TIMEOUT') || 0);
    if (timeout > 0) full.push('--timeout', String(timeout));
    if (opts.yes) full.push('--yes');
    if (opts.dryRun) full.push('--dry-run');
    full.push('--format', 'json');

    const cands = this.candidates();
    let lastErr = '';
    for (const cmd of cands) {
      const r = await this.spawnOnce(cmd, full);
      if (r.enoent) {
        lastErr = r.stderr;
        continue;
      }
      if (r.code !== 0) {
        throw new Error(this.humanize(r.stdout, r.stderr, r.code));
      }
      const out = (r.stdout || '').trim();
      try {
        return JSON.parse(out);
      } catch {
        throw new Error('dws 返回非 JSON: ' + out.slice(0, 600));
      }
    }
    throw new Error(
      `未找到可执行的 dws（已尝试 ${cands.length} 个候选）。` +
        `官方安装：npm install -g dingtalk-workspace-cli；或配置 DING_DWS_BIN。${lastErr}`,
    );
  }

  /** 把 dws 的晦涩报错翻成人话（沿用既有排障经验）。 */
  private humanize(stdout: string, stderr: string, code: number): string {
    const all = `${stdout || ''}${stderr || ''}`;
    if (all.includes('can not find file by url')) {
      return (
        '在线表打不开：地址填错，或该表已被删除 / 当前账号无访问权限。' +
        '修法：打开钉钉在线表，复制浏览器地址栏整条链接填到任务配置的「文档地址」'
      );
    }
    return `dws 退出码 ${code}: ${(stdout || '').slice(0, 300)} | ${(stderr || '').slice(0, 300)}`;
  }

  // ---------------------------------------------------------- 群
  /** 兼容 +chat-search（result.groups）与 +chat-list-all（顶层 groups）。 */
  private resultBlock(payload: Record<string, any>): Record<string, any> {
    if (payload?.result && typeof payload.result === 'object') return payload.result;
    if (payload && typeof payload === 'object') return payload;
    return {};
  }

  /**
   * 分页拉全：chat-list-all / chat-search 都是游标分页，只取首页会漏群
   * （实测首页 25 个、全量 46 个），漏群会导致按群名解析失败或发错群。
   */
  private async pageAllGroups(args: string[]): Promise<Record<string, any>[]> {
    const out: Record<string, any>[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const a = args.slice();
      if (cursor) a.push('--cursor', cursor);
      const blk = this.resultBlock(await this.run(a));
      for (const g of (blk.groups as Record<string, any>[]) || []) {
        if (!g.title) g.title = g.name || '';
        out.push(g);
      }
      // nextCursor 可能是数字（如 1764770547970），只认字符串会漏掉后续页
      const next = blk.nextCursor ?? blk.cursor;
      cursor = next ? String(next) : null;
      if (!blk.hasMore || !cursor) break;
    }
    return out;
  }

  private toGroups(rows: Record<string, any>[]): DingGroup[] {
    return rows
      .filter((g) => g.openConversationId)
      .map((g) => ({
        openConversationId: String(g.openConversationId),
        title: String(g.title || ''),
      }));
  }

  async listGroups(): Promise<DingGroup[]> {
    return this.toGroups(await this.pageAllGroups(['chat', '+chat-list-all']));
  }

  async searchGroups(query: string, limit = 20): Promise<DingGroup[]> {
    return this.toGroups(
      await this.pageAllGroups(['chat', '+chat-search', '--query', query, '--limit', String(limit)]),
    );
  }

  async getGroupByNumber(num: number | string): Promise<DingGroup | null> {
    const p = await this.run(['chat', '+chat-get-by-id', '--group-id', String(num)]);
    const info = (p?.result || {}).groupInfo || {};
    if (!info || !info.openConversationId) return null;
    return {
      openConversationId: String(info.openConversationId),
      title: String(info.title || ''),
    };
  }

  /** 隐藏群号（chat-list-all 会漏的群），数据放在 common/groups.json。 */
  private knownGroupNumbers(): number[] {
    const root = this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..');
    const f = path.join(root, 'common', 'groups.json');
    try {
      if (!fs.existsSync(f)) return [];
      const cfg = JSON.parse(fs.readFileSync(f, 'utf-8'));
      return (cfg?.known_group_numbers || []).map((n: any) => Number(n));
    } catch {
      return [];
    }
  }

  /** 纯字符匹配度 0~100（与既有 find_group 口径一致：不归一化、不去 emoji/空白）。 */
  private scoreMatch(q: string, t: string): number {
    if (!q || !t) return 0;
    if (q === t) return 100;
    // 查询词是群名的子串 → 满分（如「站点」⊆「站点日常管理通知群」）
    if (t.includes(q)) return 100;
    // 群名是查询词的子串 → 按长度比例给分，明显低于精确相等（如「测试」⊆「机器人测试」）
    if (q.includes(t)) return Math.floor((100 * t.length) / q.length);
    const qs = new Set(q);
    const ts = new Set(t);
    let inter = 0;
    qs.forEach((c) => ts.has(c) && inter++);
    if (!inter) return 0;
    const union = new Set([...qs, ...ts]).size;
    return Math.floor((100 * inter) / union);
  }

  /**
   * 按群名解析 openConversationId（不写死任何 ID）。
   * 候选池 = 全量群列表 ∪ 搜索结果 ∪ 已知群号；按匹配度打分，避免发错群。
   */
  async resolveGroup(name: string, opts: { exact?: boolean } = {}): Promise<DingGroup> {
    const q = (name || '').trim();
    if (!q) throw new Error('群名不能为空');

    const pool = new Map<string, DingGroup>();
    for (const g of await this.listGroups()) pool.set(g.openConversationId, g);
    try {
      for (const g of await this.searchGroups(q)) {
        if (!pool.has(g.openConversationId)) pool.set(g.openConversationId, g);
      }
    } catch {
      /* 搜索失败不致命：已有全量列表 */
    }
    for (const n of this.knownGroupNumbers()) {
      try {
        const g = await this.getGroupByNumber(n);
        if (g && !pool.has(g.openConversationId)) pool.set(g.openConversationId, g);
      } catch {
        /* 单个群号解析失败不影响整体 */
      }
    }

    const scored: { s: number; g: DingGroup }[] = [];
    for (const g of pool.values()) {
      if (!g.title) continue;
      const s = this.scoreMatch(q, g.title);
      if (s >= 60) scored.push({ s, g });
    }
    if (!scored.length) {
      throw new Error(`未找到与「${q}」匹配的群（共 ${pool.size} 个候选）`);
    }
    scored.sort((a, b) => b.s - a.s);
    const best = scored[0];
    const second = scored[1]?.s ?? 0;
    // 唯一满分，或明显领先第二名才自动返回；否则拒绝，避免发错群
    if (best.s === 100 && (scored.filter((x) => x.s === 100).length === 1 || second < 100)) {
      return { ...best.g, score: best.s };
    }
    if (best.s >= 70 && best.s - second >= 20) return { ...best.g, score: best.s };
    const cand = scored.slice(0, 5).map((x) => `${x.g.title}(${x.s})`).join('、');
    throw new Error(`群名「${q}」匹配不明确，请指定更准确的群名。候选：${cand}`);
  }

  // ---------------------------------------------------------- 消息
  /**
   * 发群消息（以当前授权用户身份）。
   * dws 的 @ 规则：正文必须带 <@openDingTalkId> 占位符，只传 ids 不生效。
   */
  /**
   * 把 group 参数归一为 openConversationId：以 'cid' 开头视为已是 id 直接复用，
   * 否则按群名解析（resolveGroup 自带歧义校验，避免发错群）。这样调用方（含 Python job）
   * 只需传群名，钉钉协议细节全收敛在 Nest。
   */
  async resolveTarget(group: string): Promise<string> {
    const g = (group || '').trim();
    if (!g) throw new Error('缺少 group（openConversationId 或群名）');
    if (g.startsWith('cid')) return g;
    return (await this.resolveGroup(g)).openConversationId;
  }

  /** 公开给 groups 模块复用的纯字符匹配度（与旧 Python find_group 口径一致）。 */
  score(q: string, t: string): number {
    return this.scoreMatch(q, t);
  }

  /** 公开给 groups 模块：chat-list-all 漏掉的隐藏群号。 */
  knownNumbers(): number[] {
    return this.knownGroupNumbers();
  }

  /** 按关键词搜群并打分（候选池 = 全量 ∪ 搜索结果 ∪ 已知群号）。 */
  async searchScored(
    query: string,
    limit = 20,
  ): Promise<{ openConversationId: string; title: string; score: number }[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const pool = new Map<string, DingGroup>();
    for (const g of await this.listGroups()) pool.set(g.openConversationId, g);
    try {
      for (const g of await this.searchGroups(q)) {
        if (!pool.has(g.openConversationId)) pool.set(g.openConversationId, g);
      }
    } catch {
      /* 搜索失败不致命 */
    }
    for (const n of this.knownNumbers()) {
      try {
        const g = await this.getGroupByNumber(n);
        if (g && !pool.has(g.openConversationId)) pool.set(g.openConversationId, g);
      } catch {
        /* 单个群号解析失败不影响整体 */
      }
    }
    const scored: { openConversationId: string; title: string; score: number }[] = [];
    for (const g of pool.values()) {
      if (!g.title) continue;
      const s = this.score(q, g.title);
      if (s >= 30) scored.push({ openConversationId: g.openConversationId, title: g.title, score: s });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title),
    );
    return scored.slice(0, limit);
  }

  async sendMessage(p: {
    group: string;
    text: string;
    atOpenDingTalkIds?: string[];
    dryRun?: boolean;
  }): Promise<Record<string, any>> {
    if (!p.text) throw new Error('缺少 text');
    const group = await this.resolveTarget(p.group);
    const args = ['chat', 'message', 'send', '--group', group, '--text', p.text];
    const ids = (p.atOpenDingTalkIds || []).filter(Boolean);
    if (ids.length) args.push('--at-open-dingtalk-ids', ids.join(','));
    return this.run(args, { yes: true, dryRun: p.dryRun });
  }

  /** 发文件消息（图片会以附件形式发送，不渲染成内联图）。 */
  async sendFile(p: { group: string; file: string; dryRun?: boolean }): Promise<Record<string, any>> {
    if (!p.file) throw new Error('缺少 file 路径');
    if (!fs.existsSync(p.file)) throw new Error('文件不存在: ' + p.file);
    const group = await this.resolveTarget(p.group);
    return this.run(
      ['chat', 'message', 'send', '--group', group, '--msg-type', 'file', '--file', p.file],
      { yes: true, dryRun: p.dryRun },
    );
  }

  // ---------------------------------------------------------- 在线表格
  /** 读取区域，返回二维行（与既有 read_range 口径一致）。 */
  async sheetReadRange(p: {
    node: string;
    sheetId: string;
    range: string;
  }): Promise<string[][]> {
    const j = await this.run([
      'sheet', 'csv-get', '--node', p.node, '--sheet-id', p.sheetId, '--range', p.range,
    ]);
    if (!j.success) throw new Error('读取在线表失败: ' + (j.message || ''));
    const rows: string[][] = [];
    for (const raw of String(j.csv || '').split('\n')) {
      let line = raw.trim();
      if (!line) continue;
      if (line.startsWith('[row=')) line = line.slice(line.indexOf(']') + 1);
      if (line.startsWith(',')) line = line.slice(1);
      rows.push(this.splitCsvLine(line));
    }
    return rows;
  }

  async sheetUpdateRange(p: {
    node: string;
    sheetId: string;
    range: string;
    values: string[][];
    dryRun?: boolean;
  }): Promise<Record<string, any>> {
    if (!Array.isArray(p.values)) throw new Error('values 必须是二维数组');
    // range update 不接受原始字符串：每格必须是 {"type":"text","text":"..."}。
    // 统一按 text 写入，长数字（运单号/骑手ID）才不会被自动转成数值丢精度或变科学计数法。
    const cells = p.values.map((row) =>
      (row || []).map((v) => ({ type: 'text', text: v == null ? '' : String(v) })),
    );
    return this.run(
      [
        'sheet', 'range', 'update', '--node', p.node, '--sheet-id', p.sheetId,
        '--range', p.range, '--values', JSON.stringify(cells),
      ],
      { yes: true, dryRun: p.dryRun },
    );
  }

  /** 极简 CSV 行切分（处理引号包裹）。 */
  private splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === ',' && !inQ) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
}
