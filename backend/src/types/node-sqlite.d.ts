// 最小化 node:sqlite 类型声明（Node 24 内置模块；@types/node 未含）。
// 仅覆盖本仓库实际用到的 API 面。
declare module 'node:sqlite' {
  export interface SqliteRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: unknown[]): SqliteRunResult;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; [k: string]: unknown });
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }

  export class SqliteError extends Error {
    code: string;
  }
}
