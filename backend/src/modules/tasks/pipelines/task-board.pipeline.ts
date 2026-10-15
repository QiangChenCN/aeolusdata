import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage, TaskStop } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { BoardFetchService } from '../../../../fetch/board-fetch.service';
import { ReportRenderService } from '../../render/report-render.service';
import { MinioService } from '../../media/minio.service';
import { DingtalkService } from '../../dingtalk/dingtalk.service';
import { PRODUCTION_GROUP_NAME, resolveOpenIds } from '../../notify/notify-config';

/** 测试目标群名（运行时按群名解析，不写死 cid）。 */
const TEST_GROUP_QUERY = '机器人测试';

/** 计算剩余时间（可读字符串）。 */
function calcRemaining(expireStr: string, now = new Date()): string {
  if (!expireStr) return '无截止时间';
  const m = expireStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return '时间格式异常';
  const expire = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  const deltaMs = expire.getTime() - now.getTime();
  if (deltaMs < 0) return '已过期';
  const totalSec = Math.floor(deltaMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  return parts.length ? parts.join('') : '不足1分钟';
}

/** 站长任务看板（原 jobs/board/task_board.py）。 */
@Injectable()
export class TaskBoardPipeline implements TaskHandler {
  readonly id = 'task_board';
  readonly stages: TaskStage[] = [
    { id: 'fetch', name: '拉取任务列表' },
    { id: 'filter', name: '筛选已开始' },
    { id: 'render', name: '渲染看板图' },
    { id: 'resolve', name: '解析站长 openid' },
    { id: 'send', name: '发送任务看板' },
  ];
  private readonly outDir: string;

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly board: BoardFetchService,
    private readonly render: ReportRenderService,
    private readonly minio: MinioService,
    private readonly dingtalk: DingtalkService,
    config: ConfigService,
  ) {
    this.handlers.register(this);
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.outDir = path.join(root, 'backend', 'data', 'jobs', 'board', 'out');
  }

  private get rawPath(): string {
    return path.join(this.outDir, 'task_list_raw.json');
  }
  private get imgPath(): string {
    return path.join(this.outDir, 'task_started.png');
  }

  /** 只留 status=已开始，按剩余时间升序（已过期/异常排最后）。 */
  private filterStarted(tasks: Record<string, any>[], ctx: TaskRunContext): Record<string, any>[] {
    const now = new Date();
    const started = tasks
      .filter((t) => t.status === '已开始')
      .map((t) => {
        const expireStr = String(t.taskExpireTime ?? '');
        return {
          taskName: t.taskName ?? '',
          taskObject: t.taskObject ?? '',
          status: t.status ?? '',
          taskExpireTime: expireStr,
          remaining: calcRemaining(expireStr, now),
          executorName: t.executorName ?? '',
          priority: t.priority ?? '',
        };
      });
    const sortKey = (x: Record<string, any>): number => {
      if (x.remaining === '已过期') return 999999;
      const m = String(x.taskExpireTime).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
      if (!m) return 999998;
      const dt = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
      );
      return (dt.getTime() - now.getTime()) / 1000;
    };
    void ctx;
    started.sort((a, b) => sortKey(a) - sortKey(b));
    return started;
  }

  /** 从 raw 里抽已开始任务的去重执行人（保留顺序）。 */
  private extractExecutorNames(tasks: Record<string, any>[]): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const t of tasks) {
      if (t.status !== '已开始') continue;
      for (const raw of String(t.executorName ?? '').split(',')) {
        const n = raw.trim();
        if (n && !seen.has(n)) {
          seen.add(n);
          names.push(n);
        }
      }
    }
    return names;
  }

  private buildMarkdown(
    resolved: [string, string][],
    total: number,
    imgUrl: string,
  ): string {
    const mentions = resolved.map(([, oid]) => `<@${oid}>`).join(' ');
    return (
      '## 站长任务看板 · 进行中任务\n' +
      `**当前共 ${total} 条「已开始」任务未完成**，请相关执行人及时跟进处理（明细见下图）：\n\n` +
      `![站长任务看板-进行中任务](${imgUrl})\n` +
      '\n\n' +
      mentions
    );
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const a = ctx.args;
    const testMode = Boolean(a['--test']);
    const noAt = testMode || Boolean(a['--no-at']);
    const dryRun = Boolean(a['--dry-run']);
    const groupId = String(a['--group'] ?? '') || (testMode ? TEST_GROUP_QUERY : '');

    const state: {
      allTasks?: Record<string, any>[];
      started?: Record<string, any>[];
      resolved?: [string, string][];
      missing?: string[];
      executorNames?: string[];
      totalStarted?: number;
      imgPath?: string;
    } = {};
    const p = new Pipeline(ctx, state);

    const loadRaw = () => {
      if (!fs.existsSync(this.rawPath)) {
        throw new Error('未找到 task_list_raw.json，请先跑 fetch 节点（或全量跑）拉取。');
      }
      return JSON.parse(fs.readFileSync(this.rawPath, 'utf-8')) as Record<string, any>[];
    };

    p.stage('fetch', '拉取任务列表', async () => {
      fs.mkdirSync(this.outDir, { recursive: true });
      const all = await this.board.fetch();
      fs.writeFileSync(this.rawPath, JSON.stringify(all, null, 2), 'utf-8');
      ctx.log(`[save] raw data -> ${this.rawPath}`);
      state.allTasks = all;
    });

    p.stage('filter', '筛选已开始', () => {
      if (!state.allTasks) state.allTasks = loadRaw();
      const started = this.filterStarted(state.allTasks, ctx);
      ctx.log(`[filter] ${started.length} tasks with status=已开始`);
      if (!started.length) throw new TaskStop('没有进行中的任务，跳过渲染。');
      for (const t of started) {
        ctx.log(`  - ${t.taskName} | ${t.taskObject} | ${t.remaining} | ${t.executorName}`);
      }
      state.started = started;
    });

    p.stage('render', '渲染看板图', () => {
      if (!state.started) {
        if (!state.allTasks) state.allTasks = loadRaw();
        state.started = this.filterStarted(state.allTasks, ctx);
        if (!state.started.length) {
          throw new TaskStop('task_list_raw.json 没有进行中任务，跳过渲染。');
        }
      }
      this.render.renderTasks(state.started, this.imgPath);
      state.imgPath = this.imgPath;
      ctx.log(`[render] -> ${this.imgPath}`);
    });

    p.stage('resolve', '解析站长 openid', () => {
      if (!state.allTasks) state.allTasks = loadRaw();
      const names = this.extractExecutorNames(state.allTasks);
      state.executorNames = names;
      state.totalStarted = state.allTasks.filter((t) => t.status === '已开始').length;
      ctx.log(`已开始任务 ${state.totalStarted} 条，涉及执行人 ${names.length} 人`);
      if (testMode) {
        state.resolved = [];
        state.missing = [];
        return;
      }
      const { resolved, missing } = resolveOpenIds(names);
      state.resolved = resolved;
      state.missing = missing;
    });

    p.stage('send', '发送任务看板', async () => {
      const imgPath = state.imgPath || this.imgPath;
      if (!fs.existsSync(imgPath)) {
        throw new Error(`未找到 ${imgPath}，请先跑 render 节点（或全量跑）生成图片。`);
      }
      const resolved = state.resolved || [];
      const missing = state.missing || [];
      ctx.log(
        `已开始任务 ${state.totalStarted ?? 0} 条，涉及执行人 ${state.executorNames?.length ?? 0} 人（已解析 ${resolved.length}，缺失 ${missing.length}）`,
      );
      const imgUrl = await this.minio.upload(imgPath, 'taskboard');
      ctx.log(
        `图片已上传 MinIO: ${imgUrl} (${Math.round(fs.statSync(imgPath).size / 1024)} KB)`,
      );
      const gid = groupId || PRODUCTION_GROUP_NAME;
      if (dryRun) {
        const caption = this.buildMarkdown(
          resolved,
          state.totalStarted ?? 0,
          '(内联图片：发送时上传 MinIO 并填入公网直链)',
        );
        ctx.log(`[dry-run] markdown:\n${caption}`);
        return;
      }
      const atIds = resolved.length && !noAt ? resolved.map(([, oid]) => oid) : [];
      ctx.log(`目标群: ${gid}`);
      ctx.log(`将 @ ${resolved.length} 人: ${resolved.map(([n]) => n).join('、')}`);
      if (missing.length) {
        ctx.log(`[warn] 跳过 @（未解析到 openDingTalkId）: ${[...missing].sort().join('、')}`);
      }
      const out = await this.dingtalk.sendMessage({
        group: gid,
        text: this.buildMarkdown(resolved, state.totalStarted ?? 0, imgUrl),
        atOpenDingTalkIds: atIds,
      });
      ctx.log(`任务看板发送: ${JSON.stringify(out).slice(0, 200)}`);
      ctx.log('任务看板发送完成。');
    });

    await p.run();
  }
}
