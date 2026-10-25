import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { dirs } from '../../../config/paths';

/**
 * 反爬节奏层（移植自 dashboard/standard/orders_fetch.py）。
 *
 * 为什么需要这一层：运单明细接口未公开 QPS 上限，实测是**配额型**滑动窗口限流
 * 且对固定节拍敏感（固定 0.5s 连打 67 页被判「请求太频繁」）。因此：
 *   · 页间隔用 AIMD 自适应（同 TCP 拥塞控制）：成功一页加性减小间隔慢慢探快，
 *     被限流乘性增大立刻退让；
 *   · 叠 ±15% 抖动，避免固定节拍被识别为机器；
 *   · 「碰撞学习」把动态下限抬到碰撞点 ×1.25，之后绝不再低于该已知安全值，
 *     杜绝「收敛后不停探快→撞墙→退避」的反复（实测原方案一次刷新撞 12 次）。
 *
 * 常量与 Python 版逐一对应，改动必须两边同步，否则限流表现会分裂。
 */
export const PACE_MIN = 0.30;
export const PACE_MAX = 4.00;
export const PACE_INIT = 0.80;
export const PACE_SUB = 0.05;
export const PACE_MUL = 1.15;
export const PACE_JITTER: [number, number] = [0.85, 1.15];
export const PACE_FLOOR_RATIO = 1.25;

// ---- 下限衰减（本次新增，对应 Python 的 PACE_FLOOR_RECOVER=0 语义变更）----
// 原设计「下限只升不降」是为了杜绝「探快→撞墙」的反复，但它有个副作用：
// 只要撞过一次（哪怕当时网络抖动），下限就被永久钉住 —— 实测已顶到 PACE_MAX=4.0s，
// 之后每次刷新都按 4s/页跑（一次全量 ~8 分钟），再也无法回到正常速度。
// 折中：只在**整轮零碰撞**后才回落（证明当前下限是安全的），且每次只 ×0.90 缓慢试探。
// 撞过就立刻停止衰减并重新抬高，保证不会退化成频繁撞墙。
export const PACE_FLOOR_DECAY = 0.90;
// 衰减门槛用「限流率」而不是「零碰撞」：实测每轮 119 次请求几乎总会撞 1 次
// （配额漂移导致的偶发），要求零碰撞会让衰减永远不触发、下限照样卡死在 PACE_MAX。
// 取 2%：偶发 1 次（0.8%）仍算健康、允许回落；真的频繁撞墙（>2%）立刻停止衰减。
export const PACE_FLOOR_DECAY_MAX_THROTTLE_RATE = 0.02;

export const SLEEP_COARSE_MIN = 0.8;
export const SLEEP_COARSE_MAX = 2.2;

export const BACKOFF_BASE = 2.0;
export const BACKOFF_FACTOR = 2.0;
export const BACKOFF_MAX_SLEEP = 30.0;
export const BACKOFF_JITTER: [number, number] = [1.0, 1.5];
export const MAX_RETRIES = 4;

export const RELOGIN_MAX = 5;
export const RELOGIN_BACKOFF_BASE = 2.0;

export interface FetchStats {
  requests: number;
  ok: number;
  throttle: number;
  failed: number;
  retries: number;
  relogin: number;
  pace_floor: number;
  pace_cur: number;
  collisions: number;
}

@Injectable()
export class FetchPaceService {
  private readonly logger = new Logger(FetchPaceService.name);
  private paceStateFile = '';
  private cur = PACE_INIT;
  private floor = PACE_MIN;
  private collisions = 0;
  private stats: FetchStats = {
    requests: 0, ok: 0, throttle: 0, failed: 0, retries: 0, relogin: 0,
    pace_floor: PACE_MIN, pace_cur: PACE_INIT, collisions: 0,
  };

  constructor(private readonly config: ConfigService) {}

  /** pace_state.json 与 Python 版共用同一份（放在 apps/api/runtime/ 目录下），
   *  两边学到的下限互通，避免各自从冷启动重新撞一轮。 */
  onModuleInitCompat() {
    this.paceStateFile = dirs.runtime('pace_state.json');
  }

  private stateFile(): string {
    if (!this.paceStateFile) this.onModuleInitCompat();
    return this.paceStateFile;
  }

  private rnd(lo: number, hi: number): number {
    return lo + Math.random() * (hi - lo);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private loadFloor(): number {
    try {
      const v = Number(JSON.parse(fs.readFileSync(this.stateFile(), 'utf-8')).floor || 0);
      if (v >= PACE_MIN && v <= PACE_MAX) return v;
    } catch {
      /* 无记录 / 损坏 → 回落 PACE_MIN */
    }
    return PACE_MIN;
  }

  private saveFloor(v: number): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile()), { recursive: true });
      fs.writeFileSync(this.stateFile(), JSON.stringify({ floor: Math.round(v * 1000) / 1000 }));
    } catch {
      /* 持久化失败不影响抓取 */
    }
  }

  /** 新一次抓取前重置：起点取「已学到的下限」与初始值的较大者。 */
  reset(): void {
    const floor = this.loadFloor();
    this.floor = floor;
    this.collisions = 0;
    this.cur = Math.max(PACE_INIT, floor);
    if (floor > PACE_MIN) {
      this.logger.log(`沿用已学到的间隔下限 ${floor.toFixed(2)}s（跨刷新记忆）`);
    }
  }

  /** 成功一页：加性减小间隔，在**动态下限**处封底（下限只升不降）。 */
  reward(): void {
    this.cur = Math.max(this.floor, this.cur - PACE_SUB);
  }

  /** 被限流 / 请求失败：乘性增大 + 抬高动态下限（碰撞学习）。 */
  penalize(): void {
    const cur = this.cur;
    this.collisions += 1;
    this.floor = Math.min(PACE_MAX, Math.max(this.floor, cur * PACE_FLOOR_RATIO));
    this.cur = Math.min(PACE_MAX, cur * PACE_MUL + 0.1);
    this.saveFloor(this.floor);
    this.logger.warn(
      `撞到限流：间隔 ${cur.toFixed(2)}s → 下限抬到 ${this.floor.toFixed(2)}s，` +
        `当前退到 ${this.cur.toFixed(2)}s（本次第 ${this.collisions} 次）`,
    );
  }

  /**
   * 非限流失败（网络异常 / 上游错误码）：只把**当前**间隔乘性退让，
   * **不抬下限、不计碰撞** —— 与 `penalize()` 的分界点是「这是不是上游配额信号」。
   *
   * 为什么必须分开：下限会写盘（pace_state.json，与 Python 共用）且只按 0.90 缓慢衰减，
   * 一次网络抖动（DNS/连接超时，与限流无关）就会把下限永久钉到 PACE_MAX=4.00s，
   * 之后每次刷新都按 4s/页跑 —— 实测曾把一次全量刷新拖到 8 分钟，且久久回不来。
   */
  penalizeNet(): void {
    this.cur = Math.min(PACE_MAX, this.cur * PACE_MUL + 0.1);
    this.logger.warn(
      `请求失败（非限流）：当前间隔退到 ${this.cur.toFixed(2)}s，下限维持 ${this.floor.toFixed(2)}s`,
    );
  }

  /** 页间隔：当前间隔叠 ±15% 抖动。 */
  async pageSleep(): Promise<void> {
    await this.sleep(this.rnd(this.cur * PACE_JITTER[0], this.cur * PACE_JITTER[1]) * 1000);
  }

  /** 段/天边界间隔：均匀随机 0.8~2.2s。段边界是服务端最可能做窗口统计的位置。 */
  async coarseSleep(): Promise<void> {
    await this.sleep(this.rnd(SLEEP_COARSE_MIN, SLEEP_COARSE_MAX) * 1000);
  }

  /** 指数退避：min(base × 2^attempt, 30s) × 均匀随机 1.0~1.5（只向上抖动，保证恢复窗口）。 */
  async backoffSleep(base = BACKOFF_BASE, attempt = 0): Promise<void> {
    const wait = Math.min(base * Math.pow(BACKOFF_FACTOR, attempt), BACKOFF_MAX_SLEEP);
    await this.sleep(wait * this.rnd(BACKOFF_JITTER[0], BACKOFF_JITTER[1]) * 1000);
  }

  /** 异常是否属于服务端限流（FREQUENT / 请求太频繁）。 */
  isThrottle(err: unknown): boolean {
    const s = String(err instanceof Error ? `${err.name}: ${err.message}` : err);
    return s.toUpperCase().includes('FREQUENT') || s.includes('频繁');
  }

  statsReset(): void {
    this.stats.requests = 0;
    this.stats.ok = 0;
    this.stats.throttle = 0;
    this.stats.failed = 0;
    this.stats.retries = 0;
    this.stats.relogin = 0;
  }

  statsSnapshot(): FetchStats {
    return {
      ...this.stats,
      pace_floor: Math.round(this.floor * 1000) / 1000,
      pace_cur: Math.round(this.cur * 1000) / 1000,
      collisions: this.collisions,
    };
  }

  bump(key: keyof Omit<FetchStats, 'pace_floor' | 'pace_cur' | 'collisions'>, n = 1): void {
    this.stats[key] = (this.stats[key] || 0) + n;
  }

  /** 抓取结束：存下限；若整轮零碰撞则缓慢回落（见 PACE_FLOOR_DECAY 注释）。 */
  persistFloor(): void {
    const before = this.floor;
    const rate = this.stats.requests > 0 ? this.collisions / this.stats.requests : 0;
    const healthy = rate < PACE_FLOOR_DECAY_MAX_THROTTLE_RATE;
    if (healthy && this.floor > PACE_MIN) {
      this.floor = Math.max(PACE_MIN, this.floor * PACE_FLOOR_DECAY);
      this.logger.log(
        `本轮限流率 ${(rate * 100).toFixed(1)}%（${this.collisions}/${this.stats.requests}）` +
          `，视为健康：下限 ${before.toFixed(2)}s → ${this.floor.toFixed(2)}s`,
      );
    } else {
      this.logger.log(
        `本轮限流率 ${(rate * 100).toFixed(1)}%（${this.collisions}/${this.stats.requests}），` +
          `下限维持 ${this.floor.toFixed(2)}s`,
      );
    }
    this.saveFloor(this.floor);
  }
}
