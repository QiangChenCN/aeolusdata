import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/** 手动刷新冷却时长（秒）。前端 / 后端共用同一常量口径。 */
export const REFRESH_COOLDOWN_SEC = 60;
const COOLDOWN_FILE = 'assessment-refresh-cooldown.json';

/**
 * 考核看板「手动刷新」冷却状态（持久化）。
 *
 * 为什么需要它：手动刷新按钮触发后端重新计算取数，需限制频率（1 分钟）。
 * 冷却时间戳落盘到 `apps/api/runtime/assessment-refresh-cooldown.json`，因此：
 *   · 后端是权威（点击时校验，无法被前端绕过）；
 *   · 页面刷新（reload）后前端重新拉取剩余时间，冷却不失效；
 *   · 前端读秒只是本地倒数，初始值来自后端，前后端口径一致。
 *
 * 注意：仅「手动刷新」走冷却（manual=true）。自动轮询（manual 缺省 false）跳过冷却，
 * 避免自动取数被自己写入的时间戳反噬。
 */
@Injectable()
export class AssessmentCooldownService {
  private readonly logger = new Logger(AssessmentCooldownService.name);
  private readonly file: string;

  constructor(private readonly config: ConfigService) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.file = path.join(root, 'apps', 'api', 'runtime', COOLDOWN_FILE);
  }

  /** 当前剩余冷却秒数（向上取整，≥0）。 */
  remainingSec(): number {
    const last = this.readLast();
    if (!last) return 0;
    const elapsed = (Date.now() - last) / 1000;
    return Math.max(0, Math.ceil(REFRESH_COOLDOWN_SEC - elapsed));
  }

  inCooldown(): boolean {
    return this.remainingSec() > 0;
  }

  /** 记录一次「手动刷新成功」时刻（覆盖写）。取数失败不调用，避免失败也被冷却。 */
  mark(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ last_manual_refresh_ms: Date.now() }),
        'utf-8',
      );
    } catch (e) {
      this.logger.warn('刷新冷却状态写失败：' + (e as Error).message);
    }
  }

  /** 供 GET 端点返回，用于前端页面加载时恢复读秒。 */
  status() {
    return {
      cooldown_sec: REFRESH_COOLDOWN_SEC,
      remaining_sec: this.remainingSec(),
      last_refresh_ms: this.readLast(),
    };
  }

  private readLast(): number | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const j = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      return typeof j.last_manual_refresh_ms === 'number'
        ? j.last_manual_refresh_ms
        : null;
    } catch {
      return null;
    }
  }
}
