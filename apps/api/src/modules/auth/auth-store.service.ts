import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../pg/pg.service';
import type { Policy, RoleRecord, Session, UserRecord } from './auth.service';

/**
 * RBAC 持久层（账号 / 角色 / 密码策略 / 会话 / 审计）。
 *
 * 背景：这五份状态原先全部落在 apps/api/runtime/ 下的隐藏文件里（.users.json /
 * .roles.json / .pwpolicy.json / .sessions.json / .audit.jsonl）。它们被 gitignore、
 * git 里没有副本，机器一丢账号与钉钉绑定关系就没了，也无法随 PG 一起备份。
 * 本服务把它们迁到 PostgreSQL，与 realtime/violation/cron 等既有 store 同一套范式
 * （PgService 直连 + 手写 SQL，不引入 ORM）。
 *
 * 两条存储路径按 DATABASE_URL 是否配置自动选择：
 *   · PG 可用（正常情况）→ 全部走 rbac_* 五张表；
 *   · PG 不可用（未配置 DATABASE_URL 的旧部署）→ 回落到原来的文件读写，行为与迁移前
 *     完全一致，保证「没接 PG 的环境不会因为这次改造而登不上系统」。
 *
 * 一次性迁移内置在 loadXxx 里：PG 表为空但历史文件存在时，读文件灌入 PG 再返回。
 * 因此**不需要单独的迁移脚本**，也不需要人工在服务器上执行命令 —— 后端重启即完成迁移，
 * 且天然幂等（PG 一旦有数据就不再读文件）。
 *
 * 注意：AuthService 的对外 API 全是同步的（getSession / hasPerm 是每请求热路径，
 * 被全局 AccessGuard 同步调用），所以本服务只负责「落盘」，AuthService 侧用内存缓存
 * 承接同步读，写操作改完内存后由本服务异步落盘。语义与迁移前「内存 + 文件快照」一致。
 */

// ----------------------------------------------------------------- 表结构
const PG_DDL = `
CREATE TABLE IF NOT EXISTS rbac_users (
  username   TEXT PRIMARY KEY,
  payload    JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rbac_roles (
  name       TEXT PRIMARY KEY,
  payload    JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rbac_policy (
  id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload    JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rbac_sessions (
  token      TEXT PRIMARY KEY,
  payload    JSONB        NOT NULL,
  exp        DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_exp    DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rbac_sessions_exp ON rbac_sessions(exp);
CREATE TABLE IF NOT EXISTS rbac_audit (
  id         BIGSERIAL PRIMARY KEY,
  ts         TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  ok         BOOLEAN     NOT NULL,
  username   TEXT        NOT NULL DEFAULT '-',
  ip         TEXT        NOT NULL DEFAULT '-',
  role       TEXT        NOT NULL DEFAULT '-',
  method     TEXT        NOT NULL DEFAULT '',
  path       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rbac_audit_created ON rbac_audit(created_at DESC);
`;

/** 审计落库缓冲：攒够 AUDIT_FLUSH_SIZE 条或每 AUDIT_FLUSH_MS 毫秒刷一次。 */
const AUDIT_FLUSH_SIZE = 50;
const AUDIT_FLUSH_MS = 5_000;

export interface AuditRec {
  ts: string;
  action: string;
  ok: boolean;
  user: string;
  ip: string;
  role: string;
  method: string;
  path: string;
}

@Injectable()
export class AuthStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthStoreService.name);
  private schemaPromise: Promise<void> | null = null;

  private readonly dataDir = path.join(process.cwd(), 'runtime');
  readonly files = {
    users: path.join(this.dataDir, '.users.json'),
    roles: path.join(this.dataDir, '.roles.json'),
    policy: path.join(this.dataDir, '.pwpolicy.json'),
    sessions: path.join(this.dataDir, '.sessions.json'),
    audit: path.join(this.dataDir, '.audit.jsonl'),
  };

  private auditBuf: AuditRec[] = [];
  private auditTimer: ReturnType<typeof setInterval> | null = null;
  private auditFlushing = false;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  /** 幂等建表。AuthService.onModuleInit 也会调它，保证读数据前表一定存在。 */
  ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.doEnsureSchema().catch((e) => {
        // 建表失败不能让进程起不来：置空以便后续重试，并由调用方落到文件模式
        this.schemaPromise = null;
        throw e;
      });
    }
    return this.schemaPromise;
  }

  private async doEnsureSchema(): Promise<void> {
    if (!this.pg.isEnabled) {
      this.logger.warn(
        'DATABASE_URL 未配置：RBAC 数据回落到文件存储（apps/api/runtime/.users.json 等）',
      );
      return;
    }
    await this.pg.query(PG_DDL);
    this.logger.log('RBAC 表已就绪（PG）：rbac_users / rbac_roles / rbac_policy / rbac_sessions / rbac_audit');
  }

  get pgEnabled(): boolean {
    return this.pg.isEnabled;
  }

  // ------------------------------------------------------------ 文件工具
  private readJson<T>(file: string): T | null {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  private writeJson(file: string, data: unknown): void {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ 用户
  /** 返回全部账号；PG 为空且历史文件存在时自动完成一次性迁移。 */
  async loadUsers(): Promise<UserRecord[]> {
    if (this.pg.isEnabled) {
      try {
        const rows = await this.pg.query<{ payload: UserRecord }>(
          'SELECT payload FROM rbac_users',
        );
        if (rows.length) return rows.map((r) => r.payload);
        const legacy = this.readJson<{ users?: UserRecord[] }>(this.files.users);
        if (legacy?.users?.length) {
          await this.saveUsers(legacy.users);
          this.logger.log(
            `已从 .users.json 迁移 ${legacy.users.length} 个账号到 PG（原文件保留，不再读取）`,
          );
          return legacy.users;
        }
        return [];
      } catch (e) {
        this.logger.error('读取账号失败，回落到文件：' + (e as Error).message);
      }
    }
    return this.readJson<{ users?: UserRecord[] }>(this.files.users)?.users || [];
  }

  /** 全量覆盖写：账号数量很小（几十条），全量替换可天然反映删除/改名，避免残留脏行。 */
  async saveUsers(users: UserRecord[]): Promise<void> {
    if (this.pg.isEnabled) {
      try {
        await this.pg.tx(async (c) => {
          await c.query('DELETE FROM rbac_users');
          for (const u of users) {
            await c.query(
              `INSERT INTO rbac_users(username, payload) VALUES ($1, $2)
               ON CONFLICT (username) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
              [u.username, JSON.stringify(u)],
            );
          }
        });
        return;
      } catch (e) {
        this.logger.error('账号写入 PG 失败，回落到文件：' + (e as Error).message);
      }
    }
    this.writeJson(this.files.users, { users });
  }

  // ------------------------------------------------------------ 角色
  async loadRoles(): Promise<Record<string, RoleRecord> | null> {
    if (this.pg.isEnabled) {
      try {
        const rows = await this.pg.query<{ name: string; payload: RoleRecord }>(
          'SELECT name, payload FROM rbac_roles',
        );
        if (rows.length) {
          const out: Record<string, RoleRecord> = {};
          for (const r of rows) out[r.name] = r.payload;
          return out;
        }
        const legacy = this.readJson<{ roles?: Record<string, RoleRecord> }>(this.files.roles);
        if (legacy?.roles && Object.keys(legacy.roles).length) {
          await this.saveRoles(legacy.roles);
          this.logger.log(
            `已从 .roles.json 迁移 ${Object.keys(legacy.roles).length} 个角色到 PG`,
          );
          return legacy.roles;
        }
        return null;
      } catch (e) {
        this.logger.error('读取角色失败，回落到文件：' + (e as Error).message);
      }
    }
    return this.readJson<{ roles?: Record<string, RoleRecord> }>(this.files.roles)?.roles ?? null;
  }

  async saveRoles(roles: Record<string, RoleRecord>): Promise<void> {
    if (this.pg.isEnabled) {
      try {
        await this.pg.tx(async (c) => {
          await c.query('DELETE FROM rbac_roles');
          for (const [name, r] of Object.entries(roles)) {
            await c.query(
              `INSERT INTO rbac_roles(name, payload) VALUES ($1, $2)
               ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
              [name, JSON.stringify(r)],
            );
          }
        });
        return;
      } catch (e) {
        this.logger.error('角色写入 PG 失败，回落到文件：' + (e as Error).message);
      }
    }
    this.writeJson(this.files.roles, { roles });
  }

  // ------------------------------------------------------------ 密码策略
  async loadPolicy(): Promise<Partial<Policy> | null> {
    if (this.pg.isEnabled) {
      try {
        const row = await this.pg.queryOne<{ payload: Partial<Policy> }>(
          'SELECT payload FROM rbac_policy WHERE id = 1',
        );
        if (row) return row.payload;
        const legacy = this.readJson<Partial<Policy>>(this.files.policy);
        if (legacy && Object.keys(legacy).length) {
          // 历史文件可能缺字段：这里只做原样搬迁，读取侧由 AuthService.getPolicy() 用
          // 默认值补齐（{ ...PW_POLICY_DEFAULT, ...pol }），不会因缺字段而算出错误策略。
          await this.savePolicy(legacy as Policy);
          this.logger.log('已从 .pwpolicy.json 迁移密码策略到 PG');
          return legacy;
        }
        return null;
      } catch (e) {
        this.logger.error('读取密码策略失败，回落到文件：' + (e as Error).message);
      }
    }
    return this.readJson<Partial<Policy>>(this.files.policy);
  }

  async savePolicy(pol: Policy): Promise<void> {
    if (this.pg.isEnabled) {
      try {
        await this.pg.query(
          `INSERT INTO rbac_policy(id, payload) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
          [JSON.stringify(pol)],
        );
        return;
      } catch (e) {
        this.logger.error('密码策略写入 PG 失败，回落到文件：' + (e as Error).message);
      }
    }
    this.writeJson(this.files.policy, pol);
  }

  // ------------------------------------------------------------ 会话
  /** 返回 token → 会话 的映射（已由 AuthService 侧按 exp/max_exp 过滤过期项）。 */
  async loadSessions(): Promise<Record<string, unknown>> {
    if (this.pg.isEnabled) {
      try {
        const rows = await this.pg.query<{ token: string; payload: unknown }>(
          'SELECT token, payload FROM rbac_sessions',
        );
        if (rows.length) {
          const out: Record<string, unknown> = {};
          for (const r of rows) out[r.token] = r.payload;
          return out;
        }
        // 首次上 PG：把历史会话文件搬过来，避免本次发版把所有在线用户踢下线
        const legacy = this.readJson<Record<string, Session>>(this.files.sessions);
        if (legacy && Object.keys(legacy).length) {
          await this.saveSessions(legacy);
          this.logger.log(`已从 .sessions.json 迁移 ${Object.keys(legacy).length} 个会话到 PG`);
          return legacy as Record<string, unknown>;
        }
        return {};
      } catch (e) {
        this.logger.error('读取会话失败，回落到文件：' + (e as Error).message);
      }
    }
    return this.readJson<Record<string, unknown>>(this.files.sessions) || {};
  }

  /** 全量 upsert 当前内存会话（不删库里多余行，清理交给 purgeExpiredSessions）。 */
  async saveSessions(map: Record<string, Session>): Promise<void> {
    if (this.pg.isEnabled) {
      try {
        await this.pg.tx(async (c) => {
          for (const [token, s] of Object.entries(map)) {
            await c.query(
              `INSERT INTO rbac_sessions(token, payload, exp, max_exp) VALUES ($1, $2, $3, $4)
               ON CONFLICT (token) DO UPDATE
                 SET payload = EXCLUDED.payload, exp = EXCLUDED.exp,
                     max_exp = EXCLUDED.max_exp, updated_at = now()`,
              [token, JSON.stringify(s), s.exp ?? 0, s.max_exp ?? 0],
            );
          }
        });
        return;
      } catch (e) {
        this.logger.error('会话写入 PG 失败，回落到文件：' + (e as Error).message);
      }
    }
    // 文件模式：原子替换（与迁移前实现一致）
    try {
      const tmp = this.files.sessions + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
      fs.renameSync(tmp, this.files.sessions);
    } catch (e) {
      this.logger.warn(`会话落盘失败：${(e as Error).message}`);
    }
  }

  /** 删除单个会话（登出 / 惰性过期）。文件模式下由下次全量写覆盖，无需单独处理。 */
  async deleteSession(token: string): Promise<void> {
    if (!this.pg.isEnabled) return;
    try {
      await this.pg.query('DELETE FROM rbac_sessions WHERE token = $1', [token]);
    } catch {
      /* ignore：会话删除失败不影响可用性，sweep 会再清一次 */
    }
  }

  /** 清理已过期的会话行（滑动窗口与绝对上限任一越过即失效）。 */
  async purgeExpiredSessions(nowSec: number): Promise<void> {
    if (!this.pg.isEnabled) return;
    try {
      await this.pg.query(
        'DELETE FROM rbac_sessions WHERE max_exp <= $1 OR exp < $1',
        [nowSec],
      );
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ 审计
  /**
   * 审计写入：PG 模式走缓冲批量插入（登录/鉴权是高频路径，不能每条一次 IO）；
   * 文件模式直接 append。失败只告警，绝不因审计写不进而影响登录。
   */
  appendAudit(rec: AuditRec): void {
    if (this.pg.isEnabled) {
      this.auditBuf.push(rec);
      if (this.auditBuf.length >= AUDIT_FLUSH_SIZE) void this.flushAudit();
      else this.ensureAuditTimer();
      return;
    }
    try {
      fs.appendFileSync(this.files.audit, JSON.stringify(rec) + '\n', 'utf-8');
    } catch {
      /* ignore */
    }
  }

  private ensureAuditTimer(): void {
    if (this.auditTimer) return;
    this.auditTimer = setInterval(() => void this.flushAudit(), AUDIT_FLUSH_MS);
    (this.auditTimer as { unref?: () => void }).unref?.();
  }

  async flushAudit(): Promise<void> {
    if (this.auditFlushing || !this.auditBuf.length) return;
    this.auditFlushing = true;
    const batch = this.auditBuf;
    this.auditBuf = [];
    try {
      await this.pg.tx(async (c) => {
        for (const r of batch) {
          await c.query(
            `INSERT INTO rbac_audit(ts, action, ok, username, ip, role, method, path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [r.ts, r.action, r.ok, r.user || '-', r.ip || '-', r.role || '-', r.method || '', r.path || ''],
          );
        }
      });
    } catch (e) {
      this.logger.warn(`审计写入 PG 失败（丢弃 ${batch.length} 条）：${(e as Error).message}`);
    } finally {
      this.auditFlushing = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.auditTimer) {
      clearInterval(this.auditTimer);
      this.auditTimer = null;
    }
    await this.flushAudit();
  }
}
