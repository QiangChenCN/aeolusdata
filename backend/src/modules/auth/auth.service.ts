import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
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
 * 职责：用户库 .users.json / 会话（内存表，TTL 12h）/ 角色（.roles.json，支持继承+环检测）
 * / 密码策略（.pwpolicy.json，NIST 800-63B）/ 路由→权限 / 审计 .audit.jsonl。
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
  exp: number;
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

const SESSION_TTL = 12 * 3600;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;

const ROLES_SEED: Record<string, RoleRecord> = {
  admin: { perms: [], parents: [], builtin: true, locked: true, all: true },
  operator: {
    perms: ['view', 'file:read', 'task:run', 'data:refresh', 'todo:write', 'groups:write', 'config:write'],
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
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly sessions = new Map<string, Session>();
  private usersFile = '';
  private rolesFile = '';
  private policyFile = '';
  private auditFile = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const dataDir = path.join(process.cwd(), 'data');
    this.usersFile = path.join(dataDir, '.users.json');
    this.rolesFile = path.join(dataDir, '.roles.json');
    this.policyFile = path.join(dataDir, '.pwpolicy.json');
    this.auditFile = path.join(dataDir, '.audit.jsonl');
    this.ensureBootstrap();
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
  login(username: string, password: string, ip: string): { token: string; role: string; expiresIn: number } | null {
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
    const token = randomBytes(24).toString('hex');
    const fp = createHash('sha256').update(token).digest('hex').slice(0, 12);
    this.sessions.set(token, {
      user: username,
      role: u.role,
      ip,
      exp: Date.now() / 1000 + SESSION_TTL,
      fp,
    });
    this.audit('login', true, username, ip, u.role);
    return { token, role: u.role, expiresIn: SESSION_TTL };
  }

  logout(token?: string): void {
    const s = token ? this.sessions.get(token) : null;
    if (s) {
      this.sessions.delete(token as string);
      this.audit('logout', true, s.user, s.ip, s.role);
    }
  }

  getSession(token?: string): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.exp < Date.now() / 1000) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  // ---------------- 账号管理 ----------------
  addUser(username: string, password: string, role: string): void {
    username = (username || '').trim();
    if (!username) throw new Error('用户名不能为空');
    if (/[\s/\\]/.test(username)) throw new Error('用户名不能含空格或 / \\');
    const roles = this.loadRoles();
    if (!roles[role]) throw new Error('无效角色：' + role);
    const [ok, reason] = this.validatePassword(password);
    if (!ok) throw new Error(reason);
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
    });
    this.saveUsers(users);
    this.audit('user:add', true, username, '-', role);
  }

  updateUser(username: string, role?: string, disabled?: boolean): void {
    const users = this.loadUsers();
    const u = users.find((x) => x.username === username);
    if (!u) throw new Error('用户不存在：' + username);
    if (role !== undefined) {
      if (!this.loadRoles()[role]) throw new Error('无效角色：' + role);
      u.role = role;
    }
    if (disabled !== undefined) u.disabled = !!disabled;
    this.saveUsers(users);
    this.audit('user:update', true, username, '-', u.role);
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
