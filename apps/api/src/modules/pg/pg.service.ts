import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * PostgreSQL 直连接入（方案 B：PGDG 官方源安装的 PG 17）。
 *
 * 这是「模块骨架」：只提供连接池 + 基础查询/事务原语，不含任何业务表逻辑。
 * 业务模块注入 PgService 后自行写 SQL（与现有 node:sqlite 手写 SQL 的范式一致，
 * 不引入 ORM 抽象）。连接串统一从根 .env 的 DATABASE_URL 读取：
 *   DATABASE_URL=postgresql://aeolus:<密码>@localhost:5432/aeolusdata
 *
 * 设计要点：
 *   · DATABASE_URL 缺失时**不崩溃**（仅告警并跳过建池），保证未接 PG 的旧部署不受影响。
 *   · 池 idle 错误被吞掉并记录，避免单个坏连接拖垮进程。
 *   · OnModuleDestroy 时优雅 end 池。
 */
@Injectable()
export class PgService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgService.name);
  private pool: Pool | null = null;
  private readonly databaseUrl?: string;

  constructor(private readonly config: ConfigService) {
    this.databaseUrl = this.config.get<string>('DATABASE_URL');
  }

  onModuleInit(): void {
    if (!this.databaseUrl) {
      this.logger.warn(
        'DATABASE_URL 未配置，PgService 未启用（需要 PostgreSQL 时请在根 .env 配置）',
      );
      return;
    }
    this.pool = new Pool({
      connectionString: this.databaseUrl,
      max: Number(this.config.get('PG_POOL_MAX')) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.pool.on('error', (err) =>
      this.logger.error('PG 连接池 idle 错误：' + err.message),
    );
    this.logger.log('PG 连接池已建立（来自 DATABASE_URL）');
  }

  /** 执行参数化查询，返回行数组。 */
  async query<T extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<T[]> {
    this.assertEnabled();
    const res = await this.pool!.query<T>(text, params);
    return res.rows;
  }

  /** 单行查询（取第一行或 null）。 */
  async queryOne<T extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /** 取出一个专用客户端（事务/批量用），调用方务必 release()。 */
  async getClient(): Promise<PoolClient> {
    this.assertEnabled();
    return this.pool!.connect();
  }

  /**
   * 事务助手：自动 BEGIN / COMMIT / ROLLBACK，并把客户端传给 callback。
   * 用法：await pg.tx(async (client) => { await client.query(...); });
   */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private assertEnabled(): void {
    if (!this.pool) {
      throw new Error('PgService 未启用：DATABASE_URL 未配置或模块未初始化');
    }
  }

  /** 是否已启用（DATABASE_URL 已配置且连接池已建）。双模存储据此选择 PG / SQLite 兜底。 */
  get isEnabled(): boolean {
    return !!this.pool;
  }

  onModuleDestroy(): void {
    this.pool?.end().catch(() => undefined);
  }
}
