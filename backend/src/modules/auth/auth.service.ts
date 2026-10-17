import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto';
import { ALL_PERMS } from './permissions';

/**
 * RBAC 核心服务（端口自 core/auth.py，纯标准库实现，零第三方依赖）；
 * 原 Python 实现已删除，本服务是唯一入口（用户库仍为同一份 .users.json）。
 * 状态文件统一落在 backend/data/（.users.json / .roles.json / .pwpolicy.json / .audit.jsonl），
 * 与 backend/data/quark/ 同属后端私有本地状态，全部 gitignore、不在仓库。
 * 职责：用户库 .users.json / 会话（内存表 + 落盘 .sessions.json，滑动 TTL）/ 角色（.roles.json，
 * 支持继承+环检测）/ 密码策略（.pwpolicy.json，NIST 800-63B）/ 路由→权限 / 审计 .audit.jsonl。
 *
 * 关键兼容：口令哈希沿用 Python scrypt(n=16384,r=8,p=1,dklen=64) 同一套参数，
 * 存储格式 `saltHex$keyHex`，与既有 .users.json 互通（切换后端零迁移）。
 */

export interface UserRecord {
  username: string;
  pw_hash: string;
  role: string;
  disabled?: boolean;
  created_at?: string;
  failed_attempts?: number;
  locked_until?: number;
  pw_history?: string[];
  must_change?: boolean;
  /** 钉钉 unionid：绑定后可用于钉钉免登 / OAuth2 自动登录。 */
  dingtalk_unionid?: string;
  /** 头像地址（URL 或 data URI）；为空时前端回退到首字母占位头像。 */
  avatar?: string;
  /** 姓名（真实姓名 / 昵称），选填，用于个人资料展示。 */
  name?: string;
  /** 手机号，选填；前端展示与校验，后端仅做格式校验与存储。 */
  phone?: string;
  /** 邮箱，选填；用于通知与找回，后端仅做格式校验与存储。 */
  email?: string;
}

export interface RoleRecord {
  perms: string[];
  parents: string[];
  builtin?: boolean;
  locked?: boolean;
  all?: boolean;
}

export interface Session {
  user: string;
  role: string;
  ip: string;
  /** 滑动过期时刻：每次成功校验都会向后刷新，但不越过 max_exp。 */
  exp: number;
  /** 绝对上限：自登录时刻起不可逾越，避免「持续活跃 = 永不过期」。 */
  max_exp: number;
  /** 本次会话的滑动窗口长度（秒），由登录时是否勾选「记住我」决定。 */
  ttl: number;
  fp: string;
}

export interface Policy {
  min_length: number;
  max_length: number;
  require_upper: boolean;
  require_lower: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  max_age_days: number;
  prevent_reuse: number;
  breach_check: boolean;
  lockout_attempts: number;
  lockout_minutes: number;
  allow_paste: boolean;
}

// 会话时长：区分「记住我」与否。
//  - ttl（滑动空闲窗口）：该时长内无任何访问即失效；每次访问都会刷新。
//  - cap（绝对上限）：自登录时刻起的最长寿命，滑动续期不得越过它。
//    双重限制的目的是：用户持续使用时不会被中途踢下线，同时会话不会因一直活跃而永不终结。
const SESSION_TTL = 12 * 3600; // 未勾选「记住我」：空闲 12h
const SESSION_CAP = 24 * 3600; // 未勾选「记住我」：最长 24h
const SESSION_TTL_REMEMBER = 7 * 24 * 3600; // 记住我：空闲 7d
const SESSION_CAP_REMEMBER = 30 * 24 * 3600; // 记住我：最长 30d
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 过期会话定期清理周期
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;

const ROLES_SEED: Record<string, RoleRecord> = {
  admin: { perms: [], parents: [], builtin: true, locked: true, all: true },
  operator: {
    perms: ['view', 'file:read', 'task:run', 'data:refresh', 'cron:write', 'groups:write', 'config:write'],
    parents: ['viewer'],
    builtin: true,
    locked: false,
    all: false,
  },
  viewer: { perms: ['view'], parents: [], builtin: true, locked: false, all: false },
};

const PW_POLICY_DEFAULT: Policy = {
  min_length: 8,
  max_length: 64,
  require_upper: false,
  require_lower: false,
  require_digit: false,
  require_symbol: false,
  max_age_days: 0,
  prevent_reuse: 0,
  breach_check: false,
  lockout_attempts: 5,
  lockout_minutes: 15,
  allow_paste: true,
};

const COMMON_PASSWORDS = new Set(
  `
  password 123456 12345678 123456789 12345 1234567 qwerty abc123
  password1 111111 123123 admin 1234567890 letmein welcome monkey
  dragon sunshine princess football baseball master jordan harley
  ranger iamgod trustno1 shadow superman batman 654321 pokemon
  iloveyou 1234 aaaaaa passw0rd qwerty123 1q2w3e4r azerty
  admin123 root 123qwe qwertyuiop 666666 888888 000000 photoshop
  starwars whatever hello facebook sunshine 1qaz2wsx 1q2w3e
  changeme password123 abcd1234 a123456 123abc q1w2e3r4t5
  `.split(/\s+/),
);

function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly sessions = new Map<string, Session>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private usersFile = '';
  private rolesFile = '';
  private policyFile = '';
  private auditFile = '';
  private sessionsFile = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const dataDir = path.join(process.cwd(), 'data');
    this.usersFile = path.join(dataDir, '.users.json');
    this.rolesFile = path.join(dataDir, '.roles.json');
    this.policyFile = path.join(dataDir, '.pwpolicy.json');
    this.auditFile = path.join(dataDir, '.audit.jsonl');
    this.sessionsFile = path.join(dataDir, '.sessions.json');
    this.ensureBootstrap();
    // 恢复上次运行遗留的会话：否则每次发版重启都会让所有已登录用户（含「记住我」）重新登录
    this.loadSessions();

    // 过期会话定期清理：会话只在被访问时惰性删除（getSession），长期不再访问的会话
    // 会永久滞留在 Map 里。「记住我」把生命周期拉长到 7~30 天后，这个累积更明显。
    this.sweepTimer = setInterval(() => this.sweepSessions(), SESSION_SWEEP_INTERVAL_MS);
    // 不阻止进程退出（Nest 关闭时不因该定时器挂住）
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // 优雅停机落盘：让会话跨重启存活（systemd stop/restart 会走到这里）
    this.persistSessions();
  }

  private sweepSessions(): void {
    const now = Date.now() / 1000;
    let removed = 0;
    for (const [token, s] of this.sessions) {
      if (s.exp < now || s.max_exp <= now) {
        this.sessions.delete(token);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`清理过期会话 ${removed} 个，剩余 ${this.sessions.size} 个`);
    }
    // 周期性快照：滑动续期只改内存里的 exp，靠这里把最新值写回磁盘。
    // 不做每次请求都写盘 —— 那样 QPS 一高就是持续 IO。
    this.persistSessions();
  }

  // ---------------- 会话持久化 ----------------
  /**
   * 会话是「活跃凭证」，落盘让后端重启不清空登录态。取舍说明：
   *  - 文件权限 0600 + 落在 gitignore 的 backend/data/，与 .users.json 同口径；
   *  - 滑动续期只更新内存 exp，由 sweep 周期写回，最差丢失一个周期的续期时长；
   *  - 停机期间已超时的会话在加载时直接丢弃，不会「复活」。
   */
  private loadSessions(): void {
    if (!this.sessionsFile || !fs.existsSync(this.sessionsFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf-8')) as Record<string, unknown>;
      const now = Date.now() / 1000;
      let loaded = 0;
      for (const [token, val] of Object.entries(raw || {})) {
        const rec = val as Partial<Session>;
        // 缺关键字段的记录不认（旧结构 / 半坏数据），避免加载出不可用的会话
        if (!rec || typeof rec.exp !== 'number' || typeof rec.max_exp !== 'number') continue;
        if (rec.exp < now || rec.max_exp <= now) continue; // 停机期间已过期
        this.sessions.set(token, rec as Session);
        loaded++;
      }
      if (loaded > 0) this.logger.log(`已从磁盘恢复 ${loaded} 个会话（避免重启后全员重新登录）`);
    } catch (e) {
      this.logger.warn(`会话文件读取失败，按空会话启动：${(e as Error).message}`);
    }
  }

  private persistSessions(): void {
    if (!this.sessionsFile) return;
    try {
      const obj: Record<string, Session> = {};
      for (const [token, s] of this.sessions) obj[token] = s;
      const body = JSON.stringify(obj);
      const tmp = this.sessionsFile + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      try {
        // 原子替换：避免写到一半崩溃留下损坏的会话文件
        fs.renameSync(tmp, this.sessionsFile);
      } catch (e) {
        fs.writeFileSync(this.sessionsFile, body, { mode: 0o600 });
      }
    } catch (e) {
      this.logger.warn(`会话落盘失败：${(e as Error).message}`);
    }
  }

  // ---------------- 口令哈希（scrypt，与 Python 互通） ----------------
  private hashPw(pw: string, salt?: Buffer): string {
    const s = salt || randomBytes(16);
    const key = scryptSync(pw, s, SCRYPT_DKLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return s.toString('hex') + '$' + key.toString('hex');
  }

  private verifyPw(pw: string, stored: string): boolean {
    const [saltHex, keyHex] = stored.split('$');
    if (!saltHex || !keyHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const key = Buffer.from(keyHex, 'hex');
    const cand = scryptSync(pw, salt, SCRYPT_DKLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return cand.length === key.length && timingSafeEqual(cand, key);
  }

  // ---------------- 用户库 ----------------
  private loadUsers(): UserRecord[] {
    try {
      return JSON.parse(fs.readFileSync(this.usersFile, 'utf-8')).users || [];
    } catch {
      return [];
    }
  }
  /** 按用户名取单条用户记录（查不到返回 null）。 */
  getUser(username: string): UserRecord | null {
    const u = this.loadUsers().find((x) => x.username === username);
    return u || null;
  }
  private saveUsers(users: UserRecord[]): void {
    fs.writeFileSync(this.usersFile, JSON.stringify({ users }, null, 2), 'utf-8');
    try {
      fs.chmodSync(this.usersFile, 0o600);
    } catch {
      /* ignore */
    }
  }

  private ensureBootstrap(): void {
    let users = this.loadUsers();
    if (users.length === 0) {
      const pw = this.config.get<string>('WB_ADMIN_PASSWORD') || 'admin123';
      users = [
        {
          username: 'admin',
          pw_hash: this.hashPw(pw),
          role: 'admin',
          disabled: false,
          created_at: nowStr(),
          failed_attempts: 0,
          locked_until: 0,
          pw_history: [],
          must_change: !this.config.get<string>('WB_ADMIN_PASSWORD'),
        },
      ];
      this.saveUsers(users);
      if (!this.config.get<string>('WB_ADMIN_PASSWORD')) {
        this.logger.warn('默认管理员 admin/admin123 已创建，请尽快改密（切勿公网暴露默认口令）');
      }
    }
    if (!fs.existsSync(this.rolesFile)) this.saveRoles({ ...ROLES_SEED });
    if (!fs.existsSync(this.policyFile)) this.savePolicy({ ...PW_POLICY_DEFAULT });
  }

  // ---------------- 角色（可配置 + 继承） ----------------
  private saveRoles(roles: Record<string, RoleRecord>): void {
    const out: Record<string, RoleRecord> = {};
    for (const [name, r] of Object.entries(roles)) {
      out[name] = {
        perms: [...(r.perms || [])].sort(),
        parents: [...(r.parents || [])],
        builtin: !!r.builtin,
        locked: !!r.locked,
        all: !!r.all,
      };
    }
    fs.writeFileSync(this.rolesFile, JSON.stringify({ roles: out }, null, 2), 'utf-8');
    try {
      fs.chmodSync(this.rolesFile, 0o600);
    } catch {
      /* ignore */
    }
  }

  loadRoles(): Record<string, RoleRecord> {
    let data: Record<string, RoleRecord>;
    try {
      data = JSON.parse(fs.readFileSync(this.rolesFile, 'utf-8')).roles || {};
    } catch {
      data = { ...ROLES_SEED };
      this.saveRoles(data);
    }
    for (const [name, seed] of Object.entries(ROLES_SEED)) {
      if (!data[name]) data[name] = { ...seed };
    }
    return data;
  }

  /** 有效权限 = 自身权限 ∪ 全部（传递）父角色权限，含环检测。 */
  effectivePerms(role: string): Set<string> {
    const roles = this.loadRoles();
    const r = roles[role];
    if (!r) return new Set();
    if (r.all) return new Set(ALL_PERMS);
    const out = new Set<string>();
    const expanded = new Set<string>();
    const stack = [role];
    while (stack.length) {
      const nm = stack.pop() as string;
      if (expanded.has(nm)) continue;
      expanded.add(nm);
      const rr = roles[nm];
      if (!rr) continue;
      for (const p of rr.perms || []) out.add(p);
      for (const par of rr.parents || []) if (!expanded.has(par)) stack.push(par);
    }
    return out;
  }

  hasPerm(role: string, perm: string): boolean {
    if (perm === 'self') return true;
    if (role === 'admin') return true;
    const r = this.loadRoles()[role];
    if (r && r.all) return true;
    return this.effectivePerms(role).has(perm);
  }

  listRoles(): Array<Record<string, unknown>> {
    const roles = this.loadRoles();
    return Object.entries(roles).map(([name, r]) => ({
      name,
      perms: [...this.effectivePerms(name)].sort(),
      explicit_perms: [...(r.perms || [])].sort(),
      parents: [...(r.parents || [])],
      builtin: !!r.builtin,
      locked: !!r.locked,
      all: !!r.all,
    }));
  }

  private roleChildren(name: string, roles = this.loadRoles()): string[] {
    return Object.entries(roles)
      .filter(([, r]) => (r.parents || []).includes(name))
      .map(([n]) => n);
  }

  private wouldCycle(name: string, parents: string[], roles = this.loadRoles()): boolean {
    const stack = [...parents];
    const seen = new Set<string>();
    while (stack.length) {
      const p = stack.pop() as string;
      if (p === name) return true;
      if (seen.has(p)) continue;
      seen.add(p);
      const pr = roles[p];
      if (pr) stack.push(...(pr.parents || []));
    }
    return false;
  }

  createRole(name: string, perms: string[], parents: string[]): void {
    name = (name || '').trim();
    if (!name) throw new Error('角色名不能为空');
    if (/[\s/\\]/.test(name)) throw new Error('角色名不能含空格或 / \\');
    const roles = this.loadRoles();
    if (roles[name]) throw new Error('角色已存在：' + name);
    const cleanPerms = (perms || []).filter((p) => ALL_PERMS.has(p));
    const cleanParents = (parents || []).filter((p) => roles[p] && p !== name);
    if (this.wouldCycle(name, cleanParents, roles)) throw new Error('角色继承会形成环，已拒绝');
    roles[name] = { perms: cleanPerms, parents: cleanParents, builtin: false, locked: false, all: false };
    this.saveRoles(roles);
  }

  updateRole(name: string, perms?: string[], parents?: string[]): void {
    const roles = this.loadRoles();
    const r = roles[name];
    if (!r) throw new Error('角色不存在：' + name);
    if (r.locked) throw new Error('内置角色「' + name + '」已锁定，不可修改');
    if (perms !== undefined) {
      const clean = perms.filter((p) => ALL_PERMS.has(p));
      if (r.all && clean.length) throw new Error('全权限角色不可缩减权限点');
      r.perms = clean;
    }
    if (parents !== undefined) {
      const clean = parents.filter((p) => roles[p] && p !== name);
      if (this.wouldCycle(name, clean, roles)) throw new Error('角色继承会形成环，已拒绝');
      r.parents = clean;
    }
    roles[name] = r;
    this.saveRoles(roles);
  }

  deleteRole(name: string): void {
    const roles = this.loadRoles();
    const r = roles[name];
    if (!r) throw new Error('角色不存在：' + name);
    if (r.builtin || r.locked) throw new Error('内置/锁定角色「' + name + '」不可删除');
    if (this.roleChildren(name, roles).length) {
      throw new Error('角色「' + name + '」仍被其它角色继承，请先解除继承');
    }
    const users = this.loadUsers();
    if (users.some((u) => u.role === name)) {
      throw new Error('仍有账号使用角色「' + name + '」，请先迁移这些账号');
    }
    delete roles[name];
    this.saveRoles(roles);
  }

  // ---------------- 密码策略 ----------------
  private savePolicy(pol: Policy): void {
    fs.writeFileSync(this.policyFile, JSON.stringify(pol, null, 2), 'utf-8');
    try {
      fs.chmodSync(this.policyFile, 0o600);
    } catch {
      /* ignore */
    }
  }
  getPolicy(): Policy {
    let pol: Partial<Policy>;
    try {
      pol = JSON.parse(fs.readFileSync(this.policyFile, 'utf-8'));
    } catch {
      pol = { ...PW_POLICY_DEFAULT };
      this.savePolicy(pol as Policy);
    }
    return { ...PW_POLICY_DEFAULT, ...pol };
  }
  setPolicy(patch: Partial<Policy>): Policy {
    const pol = this.getPolicy();
    const allowed = new Set(Object.keys(PW_POLICY_DEFAULT));
    for (const [k, v] of Object.entries(patch || {})) {
      if (!allowed.has(k)) throw new Error('未知策略字段：' + k);
      (pol as unknown as Record<string, unknown>)[k] = v;
    }
    for (const k of ['min_length', 'max_length', 'lockout_attempts', 'lockout_minutes', 'prevent_reuse']) {
      if (k in (patch as object)) pol[k as keyof Policy] = Math.max(0, Number(patch[k as keyof Policy])) as never;
    }
    if (pol.min_length > pol.max_length) throw new Error('最小长度不能大于最大长度');
    this.savePolicy(pol);
    return pol;
  }
  validatePassword(pw: string, policy = this.getPolicy()): [boolean, string] {
    pw = pw || '';
    const n = pw.length;
    if (n < policy.min_length) return [false, `密码长度至少 ${policy.min_length} 位`];
    if (n > policy.max_length) return [false, `密码长度不能超过 ${policy.max_length} 位`];
    if (policy.require_upper && !/[A-Z]/.test(pw)) return [false, '需包含大写字母'];
    if (policy.require_lower && !/[a-z]/.test(pw)) return [false, '需包含小写字母'];
    if (policy.require_digit && !/\d/.test(pw)) return [false, '需包含数字'];
    if (policy.require_symbol && !/[^A-Za-z0-9]/.test(pw)) return [false, '需包含符号（非字母数字）'];
    if (policy.breach_check && COMMON_PASSWORDS.has(pw.toLowerCase())) {
      return [false, '该密码过于常见，已被泄露库收录，请更换'];
    }
    return [true, ''];
  }

  // ---------------- 会话 ----------------
  login(
    username: string,
    password: string,
    ip: string,
    remember = false,
  ): { token: string; role: string; expiresIn: number } | null {
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) {
      this.audit('login', false, username, ip, 'no such user');
      return null;
    }
    const now = Date.now() / 1000;
    if ((u.locked_until || 0) > now) {
      this.audit('login', false, username, ip, 'locked');
      return null;
    }
    if (u.disabled) {
      this.audit('login', false, username, ip, 'disabled');
      return null;
    }
    if (!this.verifyPw(password, u.pw_hash)) {
      u.failed_attempts = (u.failed_attempts || 0) + 1;
      const pol = this.getPolicy();
      if (pol.lockout_attempts > 0 && u.failed_attempts >= pol.lockout_attempts) {
        u.locked_until = now + pol.lockout_minutes * 60;
        this.audit('login', false, username, ip, `locked after ${u.failed_attempts} attempts`);
      }
      this.saveUsers(users);
      this.audit('login', false, username, ip, 'bad password');
      return null;
    }
    u.failed_attempts = 0;
    u.locked_until = 0;
    this.saveUsers(users);
    const r = this.issueSession(username, u.role, ip, remember);
    this.audit('login', true, username, ip, u.role);
    return r;
  }

  /** 签发会话（账密登录与钉钉登录共用）。 */
  private issueSession(
    username: string,
    role: string,
    ip: string,
    remember: boolean,
  ): { token: string; role: string; expiresIn: number } {
    const token = randomBytes(24).toString('hex');
    const fp = createHash('sha256').update(token).digest('hex').slice(0, 12);
    const ttl = remember ? SESSION_TTL_REMEMBER : SESSION_TTL;
    const cap = remember ? SESSION_CAP_REMEMBER : SESSION_CAP;
    const nowSec = Date.now() / 1000;
    this.sessions.set(token, {
      user: username,
      role,
      ip,
      exp: nowSec + ttl,
      max_exp: nowSec + cap,
      ttl,
      fp,
    });
    this.persistSessions(); // 登录立即落盘：立刻重启也要还活着
    return { token, role, expiresIn: ttl };
  }

  logout(token?: string): void {
    const s = token ? this.sessions.get(token) : null;
    if (s) {
      this.sessions.delete(token as string);
      this.persistSessions(); // 登出立即落盘：否则重启后会话会「复活」
      this.audit('logout', true, s.user, s.ip, s.role);
    }
  }

  /**
   * 钉钉身份 → 本地账号 → 会话。两种结果：
   *   - { token, role, expiresIn, user }  已绑定且启用 → 直接签发会话（免登成功）
   *   - { needBind:true, unionid, name }  未绑定 → 交由前端引导「先登录再绑定」
   *
   * 已移除「未绑定自动开户」：它会凭空造出 dt_<unionid> 这类无法记忆、无法管理的账号。
   * 现在账号一律由管理员预先创建，用户首次在钉钉内用工号登录时自动完成绑定。
   */
  resolveDingtalkUser(
    unionid: string,
    name: string,
    ip: string,
    remember = false,
  ):
    | { token: string; role: string; expiresIn: number; user: string }
    | { needBind: true; unionid: string; name: string } {
    const users = this.loadUsers();
    const u = users.find((x) => x.dingtalk_unionid && x.dingtalk_unionid === unionid);
    if (u && !u.disabled) {
      const r = this.issueSession(u.username, u.role, ip, remember);
      this.audit('login-dingtalk', true, u.username, ip, u.role);
      return { ...r, user: u.username };
    }
    if (u && u.disabled) this.audit('login-dingtalk', false, u.username, ip, 'disabled');
    return { needBind: true, unionid, name };
  }

  /** 将钉钉 unionid 绑定到指定本地账号（防重复绑定）。unionid 为空表示解绑。 */
  bindDingtalk(username: string, unionid: string): void {
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) throw new Error('用户不存在：' + username);
    if (unionid) {
      const clash = users.find(
        (x) => x.dingtalk_unionid && x.dingtalk_unionid === unionid && x.username !== username,
      );
      if (clash) throw new Error('该钉钉账号已绑定到另一个用户：' + clash.username);
      u.dingtalk_unionid = unionid;
    } else {
      delete u.dingtalk_unionid;
    }
    this.saveUsers(users);
    this.audit('user:bind-dingtalk', true, username, '-', unionid || 'unbind');
  }

  getSession(token?: string): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const now = Date.now() / 1000;
    // 1) 越过绝对上限：不可续期，直接失效
    if (s.max_exp <= now) {
      this.sessions.delete(token);
      return null;
    }
    // 2) 空闲超过滑动窗口：失效
    if (s.exp < now) {
      this.sessions.delete(token);
      return null;
    }
    // 3) 滑动续期：每次访问刷新空闲窗口，但不得越过绝对上限
    const next = Math.min(now + s.ttl, s.max_exp);
    if (next > s.exp) s.exp = next;
    return s;
  }

  // ---------------- 账号管理 ----------------
  addUser(username: string, password: string, role: string, name?: string, phone?: string, email?: string): void {
    username = (username || '').trim();
    if (!username) throw new Error('用户名不能为空');
    if (/[\s/\\]/.test(username)) throw new Error('用户名不能含空格或 / \\');
    const roles = this.loadRoles();
    if (!roles[role]) throw new Error('无效角色：' + role);
    const [ok, reason] = this.validatePassword(password);
    if (!ok) throw new Error(reason);
    if (phone) this.assertPhone(phone);
    if (email) this.assertEmail(email);
    const users = this.loadUsers();
    if (users.some((u) => u.username === username)) throw new Error('用户已存在：' + username);
    users.push({
      username,
      pw_hash: this.hashPw(password),
      role,
      disabled: false,
      created_at: nowStr(),
      failed_attempts: 0,
      locked_until: 0,
      pw_history: [],
      must_change: false,
      name: name ? name.trim() : undefined,
      phone: phone ? phone.trim() : undefined,
      email: email ? email.trim() : undefined,
    });
    this.saveUsers(users);
    this.audit('user:add', true, username, '-', role);
  }

  updateUser(username: string, role?: string, disabled?: boolean, name?: string, phone?: string, email?: string): void {
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) throw new Error('用户不存在：' + username);
    if (role !== undefined) {
      if (!this.loadRoles()[role]) throw new Error('无效角色：' + role);
      u.role = role;
    }
    if (disabled !== undefined) u.disabled = !!disabled;
    if (name !== undefined) u.name = name.trim() || undefined;
    if (phone !== undefined) {
      const p = phone.trim();
      if (p) this.assertPhone(p);
      u.phone = p || undefined;
    }
    if (email !== undefined) {
      const e = email.trim();
      if (e) this.assertEmail(e);
      u.email = e || undefined;
    }
    this.saveUsers(users);
    this.audit('user:update', true, username, '-', u.role);
  }

  /** 个人中心更新自己的姓名 / 手机号 / 邮箱（不含角色、禁用等管理字段）。 */
  updateProfile(username: string, name?: string, phone?: string, email?: string): void {
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) throw new Error('用户不存在：' + username);
    if (name !== undefined) u.name = name.trim() || undefined;
    if (phone !== undefined) {
      const p = phone.trim();
      if (p) this.assertPhone(p);
      u.phone = p || undefined;
    }
    if (email !== undefined) {
      const e = email.trim();
      if (e) this.assertEmail(e);
      u.email = e || undefined;
    }
    this.saveUsers(users);
    this.audit('user:update-profile', true, username, '-', u.role);
  }

  /** 中国大陆手机号校验（11 位，1 开头第二位 3-9）。 */
  private assertPhone(phone: string): void {
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('手机号格式不正确');
  }

  /** 邮箱格式校验（宽松：local@domain.tld）。 */
  private assertEmail(email: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式不正确');
  }

  deleteUser(username: string, currentUser?: string): void {
    const users = this.loadUsers();
    if (!users.some((u) => u.username === username)) throw new Error('用户不存在：' + username);
    if (currentUser && username === currentUser) throw new Error('不能删除当前登录的账号');
    const admins = users.filter((u) => u.role === 'admin' && !u.disabled);
    if (admins.some((a) => a.username === username) && admins.length <= 1) {
      throw new Error('至少需保留一个启用的管理员账号');
    }
    this.saveUsers(users.filter((u) => u.username !== username));
    this.audit('user:delete', true, username, '-', '-');
  }

  resetPassword(username: string, password: string): void {
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) throw new Error('用户不存在：' + username);
    const [ok, reason] = this.validatePassword(password);
    if (!ok) throw new Error(reason);
    const pol = this.getPolicy();
    const newHash = this.hashPw(password);
    if (this.reuseBlocked(u, newHash, pol)) {
      throw new Error(`新密码不能与最近 ${pol.prevent_reuse} 次使用过的密码相同`);
    }
    u.pw_hash = newHash;
    this.recordPw(u, newHash, pol);
    this.saveUsers(users);
    this.audit('user:reset-pw', true, username, '-', u.role);
  }

  changePassword(username: string, oldPassword: string, newPassword: string): void {
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) throw new Error('用户不存在：' + username);
    if (!this.verifyPw(oldPassword, u.pw_hash)) {
      u.failed_attempts = (u.failed_attempts || 0) + 1;
      this.saveUsers(users);
      throw new Error('原密码错误');
    }
    const [ok, reason] = this.validatePassword(newPassword);
    if (!ok) throw new Error(reason);
    const newHash = this.hashPw(newPassword);
    if (this.verifyPw(newPassword, u.pw_hash)) throw new Error('新密码不能与原密码相同');
    const pol = this.getPolicy();
    if (this.reuseBlocked(u, newHash, pol)) {
      throw new Error(`新密码不能与最近 ${pol.prevent_reuse} 次使用过的密码相同`);
    }
    u.pw_hash = newHash;
    this.recordPw(u, newHash, pol);
    this.saveUsers(users);
    this.audit('user:change-pw', true, username, '-', u.role);
  }

  /**
   * 更新个人头像：以 data URI（base64）形式存入用户记录，避免引入文件存储基础设施。
   * 仅接受图片 data URI，并限制体积，防止 .users.json 被撑爆或为任意外链留口子。
   * 调用方（控制器）负责「只能改自己」的权限约束。
   */
  updateAvatar(username: string, avatar: string): string {
    if (!avatar) throw new Error('头像数据为空');
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,/i.exec(avatar);
    if (!m) throw new Error('头像格式不支持，仅支持 PNG/JPG/WEBP/GIF');
    // base64 体积约为原图 1.33 倍，限制 data URI 长度 ≈ 1.5MB 原图上限
    if (avatar.length > 2_500_000) throw new Error('头像文件过大（请压缩后重试）');
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) throw new Error('用户不存在：' + username);
    u.avatar = avatar;
    this.saveUsers(users);
    this.audit('user:update-avatar', true, username, '-', u.role);
    return avatar;
  }

  listUsersSafe(): Array<Record<string, unknown>> {
    const users = this.loadUsers();
    const now = Date.now() / 1000;
    return users.map((u) => ({
      username: u.username,
      role: u.role,
      disabled: !!u.disabled,
      locked: (u.locked_until || 0) > now,
      created_at: u.created_at,
      must_change: !!u.must_change,
      dingtalk_unionid: u.dingtalk_unionid || '',
      avatar: u.avatar || '',
      name: u.name || '',
      phone: u.phone || '',
      email: u.email || '',
    }));
  }

  private reuseBlocked(u: UserRecord, newHash: string, pol: Policy): boolean {
    const k = pol.prevent_reuse;
    if (!k) return false;
    const hist = u.pw_history || [];
    return hist.slice(-k).includes(newHash);
  }
  private recordPw(u: UserRecord, newHash: string, pol: Policy): void {
    const k = pol.prevent_reuse;
    const hist = [...(u.pw_history || []), newHash];
    u.pw_history = k ? hist.slice(-(k + 1)) : hist.slice(-1);
    u.failed_attempts = 0;
    u.locked_until = 0;
    u.must_change = false;
  }

  // ---------------- 审计 ----------------
  audit(
    action: string,
    ok: boolean,
    user: string,
    ip: string,
    roleOrNote: string,
    method = '',
    pth = '',
  ): void {
    const rec = {
      ts: nowStr(),
      action,
      ok: !!ok,
      user: user || '-',
      ip: ip || '-',
      role: roleOrNote || '-',
      method,
      path: pth,
    };
    try {
      fs.appendFileSync(this.auditFile, JSON.stringify(rec) + '\n', 'utf-8');
    } catch {
      /* ignore */
    }
  }
}
