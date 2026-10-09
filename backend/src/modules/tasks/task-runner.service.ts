import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { StreamingService } from '../streaming/streaming.service';
import { TaskRegistryService, TaskDef } from './task-registry.service';
import { TaskHandlersService } from './task-handlers.service';
import { TaskHandler, TaskRunContext, TaskStop } from './task-handler';
import { parseRange, pickRange } from './pipeline';
import { diagnose } from './diagnostics.util';

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'stopped';

export interface RunRecord {
  runId: string;
  taskId: string;
  name: string;
  group: string;
  args: Record<string, unknown>;
  status: RunStatus;
  start: number | null;
  end: number | null;
  exitCode: number | null;
  cmd?: string;
  lines: string[];
  errorKind?: string;
  errorAdvice?: string;
  timeout?: boolean;
}

export interface HistoryEntry {
  run_id: string;
  task_id: string;
  name: string;
  group: string;
  status: RunStatus;
  exit_code: number | null;
  start: string;
  duration: number;
  error_kind?: string;
  error_advice?: string;
  /** 当次运行的参数：产物 outputs 里的 <占位符> 要靠它展开（见 listArtifacts）。 */
  args: Record<string, unknown>;
}

const MAX_HISTORY = 60;
const MAX_LINES = 20000;

// 产物 Content-Type 表（与单体 CONTENT_TYPES 一致）：文本类一律带 charset，
// 否则中文文件名/内容在浏览器里乱码。
const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};
// 可直接内联预览的类型（与单体 INLINE_EXTS 一致）：图片走 <img>、HTML 走 <iframe>，
// 这些必须用 inline；其余用 attachment 触发下载。
const ARTIFACT_INLINE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.html', '.htm', '.csv', '.tsv', '.json', '.jsonl', '.txt', '.md', '.log',
]);

/**
 * 任务执行器（移植自 server.py TaskManager）。
 * 关键不变量：全局串行（避免 aeolus cookie 并发争抢）；调度器轮询 runStatus 不订阅 SSE。
 */
@Injectable()
export class TaskRunnerService implements OnModuleInit {
  private readonly logger = new Logger(TaskRunnerService.name);
  private readonly runs = new Map<string, RunRecord>();
  private queue: RunRecord[] = [];
  private current: RunRecord | null = null;
  private proc: ChildProcess | null = null;
  private stopFlag = false;
  private running = false;
  private history: HistoryEntry[] = [];
  private runsDir = '';
  private historyFile = '';
  private pythonBin = 'python';
  /** 项目根（jobs/ 所在）：产物 outputs 是相对它的路径。 */
  private projectRoot = '';

  constructor(
    private readonly config: ConfigService,
    private readonly streaming: StreamingService,
    private readonly registry: TaskRegistryService,
    private readonly handlers: TaskHandlersService,
  ) {}

  onModuleInit(): void {
    const wb = this.config.get<string>('WORKBENCH_DIR') || '';
    // 必须解析成绝对路径：.env 里 PROJECT_ROOT=.. 是相对值，
    // 直接用相对串做 startsWith 防穿越判断会永远为假（等于放行或全拒）。
    this.projectRoot = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.runsDir = path.join(wb, 'runs');
    this.historyFile = path.join(this.runsDir, 'history.json');
    this.pythonBin = this.config.get<string>('PYTHON_BIN') || 'python';
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.loadHistory();
  }

  // ---- 入队 ----
  enqueue(items: { task_id: string; args?: Record<string, unknown> }[]): string[] {
    const ids: string[] = [];
    for (const it of items) {
      const task = this.registry.get(it.task_id);
      if (!task) continue;
      const runId = `r${Date.now()}${this.runs.size}`;
      const run: RunRecord = {
        runId,
        taskId: it.task_id,
        name: task.name,
        group: (task.group as string) || '',
        args: it.args || {},
        status: 'queued',
        start: null,
        end: null,
        exitCode: null,
        lines: [],
      };
      this.runs.set(runId, run);
      this.queue.push(run);
      ids.push(runId);
    }
    this.emitQueue();
    setImmediate(() => this.pump());
    return ids;
  }

  /** 便捷：单次执行一个任务（供调度器调用）。 */
  run(taskId: string, args: Record<string, unknown> = {}): string[] {
    return this.enqueue([{ task_id: taskId, args }]);
  }

  private buildCommand(task: TaskDef, args: Record<string, unknown>): string[] {
    // 全部任务已迁为 Nest 原生流水线，tasks.json 不再声明 cmd；走到这里说明该任务没实现。
    if (!task.cmd || !task.cmd.length) {
      throw new Error(`任务「${task.name}」未声明 cmd，且没有对应的 Nest 原生流水线`);
    }
    const cmd = task.cmd.map((p) => (p === '{py}' ? this.pythonBin : p));
    for (const param of task.params || []) {
      const val = args[param.flag];
      if (param.raw) {
        if (val) cmd.push(String(val));
        continue;
      }
      if (param.type === 'switch') {
        if ([true, 'true', 'True', '1', 1].includes(val as never)) cmd.push(param.flag);
        continue;
      }
      if (val != null && val !== '' && val !== false) {
        if (param.flag.startsWith('--') && !param.flag.includes('=')) {
          cmd.push(`${param.flag}=${String(val)}`);
        } else {
          cmd.push(param.flag, String(val));
        }
      }
    }
    return cmd;
  }

  // ---- 串行工作循环 ----
  private pump(): void {
    if (this.running) return;
    const run = this.queue.shift();
    if (!run) return;
    this.running = true;
    this.current = run;
    this.stopFlag = false;
    this.emitQueue();
    void this.execute(run).finally(() => {
      this.current = null;
      this.proc = null;
      this.running = false;
      this.emitQueue();
      setImmediate(() => this.pump());
    });
  }

  private async execute(run: RunRecord): Promise<void> {
    const task = this.registry.get(run.taskId)!;
    // 迁移期双路径：已注册原生处理器的任务在 Nest 内跑流水线；其余仍 spawn Python。
    const handler = this.handlers.get(run.taskId);
    if (handler) return this.executeNative(handler, task, run);
    // 全部任务已迁为 Nest 原生流水线，tasks.json 不再声明 cmd。
    // 走到这里说明该任务既无原生处理器、也无命令 —— 明确报错，不要静默去起一个不存在的脚本。
    if (!task.cmd || !task.cmd.length) {
      run.status = 'failed';
      run.exitCode = -1;
      run.errorKind = '未实现';
      run.errorAdvice = `任务 ${run.taskId} 尚未实现为 Nest 原生流水线，且 tasks.json 未声明 cmd`;
      this.append(
        run,
        `[错误] 任务「${task.name}」尚未实现为 Nest 原生流水线（tasks.json 亦无可执行命令）。`,
      );
      this.finalize(run);
      return;
    }
    let cmd: string[];
    try {
      cmd = this.buildCommand(task, run.args);
    } catch (e) {
      run.status = 'failed';
      run.exitCode = -1;
      run.errorKind = '参数错误';
      run.errorAdvice = String(e);
      this.append(run, `[错误] 构建命令失败：${e}`);
      this.finalize(run);
      return;
    }

    run.status = 'running';
    run.start = Date.now();
    run.cmd = cmd.join(' ');
    this.emit({ type: 'run_start', run: this.publicRun(run) });
    this.append(run, `$ ${cmd.join(' ')}`);
    this.append(run, `[开始] ${task.name}`);

    const env: Record<string, string | undefined> = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
    };
    // Python job 会用 ding_client 回调本服务（钉钉推送 / 在线表读写等），需要机器令牌。
    // 未显式配置 NEST_AUTH_TOKEN 时用 AUTH_TOKEN 兜底，保证子进程一定拿得到 ——
    // 否则 job 里的钉钉调用会被 AccessGuard 判 401 而静默失败。
    if (!env.NEST_AUTH_TOKEN) {
      const machine = this.config.get<string>('AUTH_TOKEN');
      if (machine) env.NEST_AUTH_TOKEN = machine;
    }
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: this.config.get<string>('PROJECT_ROOT') || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: os.platform() !== 'win32',
    });
    this.proc = proc;
    proc.stdout?.on('data', (d: Buffer) => this.append(run, d.toString('utf-8')));
    proc.stderr?.on('data', (d: Buffer) => this.append(run, d.toString('utf-8')));

    const timeout = Number(task.timeout ?? 600);
    let exitCode: number;
    try {
      exitCode = await this.awaitExit(proc, timeout);
    } catch {
      this.append(run, `[系统] 超过 ${timeout} 秒未完成，强制终止。`);
      this.killTree(proc.pid);
      run.timeout = true;
      exitCode = -9;
    }
    run.end = Date.now();
    run.exitCode = exitCode;
    this.finalize(run);
  }

  /**
   * 原生处理器执行路径（迁移期新增）：不 spawn 子进程，直接在 Nest 内跑任务流水线。
   * 日志与事件形态和 spawn 路径完全一致（append → SSE），前端零改动。
   * 终止为协作式：置 stopFlag，由处理器经 ctx.isStopped() 自行退出。
   */
  private async executeNative(
    handler: TaskHandler,
    task: TaskDef,
    run: RunRecord,
  ): Promise<void> {
    run.status = 'running';
    run.start = Date.now();
    run.cmd = `native:${handler.id}`;
    this.emit({ type: 'run_start', run: this.publicRun(run) });
    this.append(run, `[开始] ${task.name}`);

    const ctx: TaskRunContext = {
      runId: run.runId,
      taskId: run.taskId,
      name: task.name,
      group: run.group,
      args: run.args,
      log: (line: string) => this.append(run, line),
      isStopped: () => this.stopFlag,
    };

    const timeout = Number(task.timeout ?? 600);
    let timer: NodeJS.Timeout | undefined;
    try {
      // --begin/--end 非法区间直接失败（与 Python nodeflow.pick 同语义：宁可非零退出）。
      if (handler.stages?.length) {
        const [b, e] = parseRange(run.args);
        pickRange(handler.stages.map((s) => s.id), b, e);
      }
      await Promise.race([
        handler.run(ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            run.timeout = true;
            this.stopFlag = true;
            reject(new Error(`超过 ${timeout} 秒未完成`));
          }, timeout * 1000);
        }),
      ]);
      run.exitCode = 0;
    } catch (err) {
      if (err instanceof TaskStop) {
        run.exitCode = 0;
        this.append(run, `[结束] ${err.message}`);
      } else {
        run.exitCode = 1;
        this.append(run, `[错误] ${(err as Error).message}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    run.end = Date.now();
    this.finalize(run);
  }

  private awaitExit(proc: ChildProcess, timeoutSec: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutSec * 1000);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private killTree(pid?: number): void {
    if (!pid) return;
    if (os.platform() === 'win32') {
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
        return;
      } catch {
        /* ignore */
      }
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        if (pid) process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }

  private append(run: RunRecord, line: string): void {
    run.lines.push(line);
    if (run.lines.length > MAX_LINES) run.lines = run.lines.slice(-MAX_LINES / 2);
    this.emit({ type: 'log', run_id: run.runId, line, ts: new Date().toISOString() });
  }

  private finalize(run: RunRecord): void {
    const full = run.lines.join('\n');
    if (run.status === 'running') {
      // 超时优先于「已终止」：超时会同时置 stopFlag（协作式中断），但诊断应显示「执行超时」。
      if (this.stopFlag && !run.timeout) run.status = 'stopped';
      else if (run.exitCode === 0) run.status = 'success';
      else run.status = 'failed';
    }
    if (run.status !== 'success') {
      let kind: string;
      let advice: string;
      if (run.status === 'stopped') {
        kind = '已手动终止';
        advice = '任务被用户终止，没有跑完。';
      } else if (run.timeout) {
        kind = '执行超时';
        advice = `任务超过 ${Number(this.registry.get(run.taskId)?.timeout ?? 600)} 秒未完成，已被强制终止。先缩小范围确认能跑通。`;
      } else {
        const d = diagnose(full, run.exitCode ?? -1);
        kind = d.kind;
        advice = d.advice;
      }
      run.errorKind = kind;
      run.errorAdvice = advice;
      this.append(run, '');
      this.append(run, `✗ 失败（退出码 ${run.exitCode}）｜诊断：${kind}`);
      this.append(run, `  建议：${advice}`);
    } else {
      this.append(run, '');
      this.append(run, `✓ 完成（退出码 0，耗时 ${((run.end! - run.start!) / 1000).toFixed(1)} 秒）`);
    }

    // 落盘完整日志
    try {
      fs.writeFileSync(path.join(this.runsDir, `${run.runId}.log`), full);
    } catch {
      /* ignore */
    }

    // 历史
    const entry: HistoryEntry = {
      run_id: run.runId,
      task_id: run.taskId,
      name: run.name,
      group: run.group,
      status: run.status,
      exit_code: run.exitCode,
      start: new Date(run.start!).toISOString().replace('T', ' ').slice(0, 19),
      duration: Math.round(((run.end || Date.now()) - (run.start || Date.now())) / 100) / 10,
      error_kind: run.errorKind,
      error_advice: run.errorAdvice,
      args: run.args,
    };
    this.history.unshift(entry);
    this.history = this.history.slice(0, MAX_HISTORY);
    this.saveHistory();
    this.emit({ type: 'history', history: this.history.slice(0, 30) });
    this.emit({ type: 'run_end', run: this.publicRun(run) });
  }

  // ---- 控制 ----
  stopCurrent(): boolean {
    const run = this.current;
    this.stopFlag = true;
    const dropped = [...this.queue];
    this.queue = [];
    if (run) {
      this.append(run, '[系统] 收到终止指令，正在结束进程…');
      if (dropped.length) {
        this.append(run, `[系统] 同时取消了队列中未开始的 ${dropped.length} 个任务`);
      }
    }
    if (this.proc && this.proc.pid && this.proc.exitCode === null) {
      this.killTree(this.proc.pid);
    }
    this.emitQueue();
    return !!run;
  }

  cancelQueued(runId?: string): boolean {
    if (!runId) return false;
    const before = this.queue.length;
    this.queue = this.queue.filter((r) => r.runId !== runId);
    const removed = this.queue.length < before;
    if (removed) this.emitQueue();
    return removed;
  }

  /** 供调度器轮询：返回 {status, exitCode}，查不到返回 null（不订阅 SSE，防背压丢状态）。 */
  runStatus(runId: string): { status: RunStatus; exitCode: number | null } | null {
    const r = this.runs.get(runId);
    return r ? { status: r.status, exitCode: r.exitCode } : null;
  }

  runLog(runId: string): string[] | null {
    const rid = String(runId || '');
    // 防路径穿越：runId 来自查询参数，只允许字母数字与 . _ -（历史 id 形如 r1790...）
    if (!/^[A-Za-z0-9._-]+$/.test(rid)) return null;

    const r = this.runs.get(rid);
    if (r) return r.lines;

    // 与单体 MGR.run_log 一致：内存里没有就**回读磁盘**。
    // 每次运行结束都会落盘 runs/<run_id>.log（见本文件的完成分支），但此前只读内存、
    // 从不回读 —— 于是 Nest 一重启，「回看历史日志」/「下载日志」对所有历史运行
    // 一律返回取不到，而单体是能看的。
    try {
      const p = path.join(this.runsDir, `${rid}.log`);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').split('\n');
    } catch {
      /* ignore */
    }
    return null;
  }

  historySlice(): HistoryEntry[] {
    return this.history.slice(0, 30);
  }

  snapshot(): {
    current: RunRecord | null;
    queue: { runId: string; taskId: string; name: string }[];
    history: HistoryEntry[];
  } {
    const cur = this.current;
    return {
      current: cur ? this.publicRun(cur) : null,
      queue: this.queue.map((r) => ({ runId: r.runId, taskId: r.taskId, name: r.name })),
      history: this.history.slice(0, 30),
    };
  }

  private publicRun(run: RunRecord): RunRecord {
    return { ...run };
  }

  private emit(event: Record<string, unknown>): void {
    this.streaming.emit(event as never);
  }

  private emitQueue(): void {
    this.streaming.emit({
      type: 'queue',
      queue: this.queue.map((r) => ({ runId: r.runId, taskId: r.taskId, name: r.name })),
    });
  }

  private loadHistory(): void {
    try {
      const raw = fs.readFileSync(this.historyFile, 'utf-8');
      this.history = JSON.parse(raw);
    } catch {
      this.history = [];
    }
  }

  private saveHistory(): void {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history));
    } catch {
      /* ignore */
    }
  }

  // ---- 产物（artifacts）列举 / 下载 ----
  // 任务在 tasks.json 的 outputs 里声明会产出什么（相对项目根），这里把它展开成
  // 「实际已生成」的清单，供前端在产品浏览器里就地预览。四种写法（与单体一致）：
  //   · 普通相对路径   jobs/x/out/a.png
  //   · 通配符         jobs/x/out/delivery_*.csv
  //   · 占位符         rule_doc_<id>.html（按 output_vars + 最近一次运行参数展开）
  //   · 目录（/ 结尾） jobs/x/out/raw/
  // 注意：绝不能退化成「扫 runs 目录」——runs 里只有运行日志，真正的产物在 jobs/*/out/。
  private artifactInfo(fp: string) {
    const rel = path.relative(this.projectRoot, fp).replace(/\\/g, '/');
    const ext = path.extname(fp).toLowerCase();
    let type = 'other';
    if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) type = 'image';
    else if (['.html', '.htm'].includes(ext)) type = 'html';
    else if (['.csv', '.tsv', '.json', '.jsonl', '.txt', '.md', '.log'].includes(ext)) {
      type = 'text';
    } else if (['.xlsx', '.xls'].includes(ext)) type = 'sheet';
    const st = fs.statSync(fp);
    const d = new Date(st.mtimeMs);
    const p = (n: number) => String(n).padStart(2, '0');
    return {
      name: path.basename(fp),
      rel,
      size: st.size,
      mtime:
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}`,
      type,
    };
  }

  /** 该任务最近一次运行的参数（history 是 unshift 的，第一条最新）。 */
  private lastRunArgs(taskId: string): Record<string, unknown> {
    for (const h of this.history) if (h.task_id === taskId) return h.args || {};
    return {};
  }

  /** 把 outputs 里的 <name> 按 output_vars 映射替换成最近一次运行的实际参数。
   *  取不到值（没跑过 / 参数为空 / 未声明映射）时退化成 `*`，保证至少能看到文件。 */
  private expandPlaceholders(
    pattern: string,
    task: TaskDef,
    args: Record<string, unknown>,
  ): string {
    const vars = (task.output_vars as Record<string, string>) || {};
    return pattern.replace(/<([A-Za-z_][A-Za-z0-9_]*)>/g, (_m, name: string) => {
      const flag = vars[name];
      const v = flag ? args[flag] : undefined;
      return v === undefined || v === null || String(v).trim() === ''
        ? '*'
        : String(v).trim();
    });
  }

  /** 相对项目根的通配匹配（只支持 `*`），返回命中的文件绝对路径。 */
  private globFiles(relPattern: string): string[] {
    const abs = path.resolve(this.projectRoot, relPattern);
    if (!relPattern.includes('*')) {
      return fs.existsSync(abs) && fs.statSync(abs).isFile() ? [abs] : [];
    }
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    const re = new RegExp(
      '^' + base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    return fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => path.join(dir, f))
      .filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }

  listArtifacts(
    taskId?: string,
  ): { name: string; rel: string; size: number; mtime: string; type: string }[] {
    if (!taskId) return [];
    const task = this.registry.get(taskId);
    if (!task) return [];
    const args = this.lastRunArgs(taskId);
    const outputs = (task.outputs as string[]) || [];
    const seen = new Set<string>();
    const out: { name: string; rel: string; size: number; mtime: string; type: string }[] = [];
    try {
      for (const raw of outputs) {
        let o = String(raw);
        if (o.includes('<')) o = this.expandPlaceholders(o, task, args);
        const hits: string[] = [];
        if (o.endsWith('/')) {
          const d = path.resolve(this.projectRoot, o.replace(/\/+$/, ''));
          if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
            const keep = typeof task.artifact_keep === 'number' ? task.artifact_keep : Infinity;
            let dirFiles = fs
              .readdirSync(d)
              .map((fn) => path.join(d, fn))
              .filter((fp) => fs.existsSync(fp) && fs.statSync(fp).isFile())
              .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            // 历史产物保留策略：超出保留数的旧文件直接删除，避免目录无限膨胀
            // （仅对声明了 artifact_keep 的任务生效；默认 Infinity = 全部保留）。
            if (isFinite(keep) && dirFiles.length > keep) {
              for (const fp of dirFiles.slice(keep)) {
                try { fs.unlinkSync(fp); } catch { /* ignore */ }
              }
              dirFiles = dirFiles.slice(0, keep);
            }
            hits.push(...dirFiles);
          }
        } else {
          hits.push(...this.globFiles(o));
        }
        for (const fp of hits) {
          if (seen.has(fp)) continue;
          seen.add(fp);
          out.push(this.artifactInfo(fp));
        }
      }
    } catch {
      return out;
    }
    return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  // ---- 敏感路径黑名单（对应单体 _SENSITIVE_* / _is_sensitive_path）----
  // /api/file 会把项目内任意文件发给浏览器，只做「防穿越」是不够的：
  // ?path=aeolus_sdk/cookie.txt 就能把风神登录凭证读走。必须连凭证 / 运行数据一起挡。
  private static readonly SENSITIVE_DIRS = new Set([
    'aeolus_sdk', 'quark_sdk', '.venv', 'venv',
    'node_modules', '.git', 'credentials', 'secrets', 'runs',
  ]);
  private static readonly SENSITIVE_FILES = new Set([
    'tasks.json', 'cookie.txt', 'cookies_meituan.json',
    'db_config.json', 'quark_da_cache.json',
  ]);
  private static readonly SENSITIVE_GLOBS = [
    '*.db', '*.sqlite', '*.sqlite3', '*.key', '*.pem', '*.pfx', '*.p12', '*.env', '.env',
  ];

  private isSensitivePath(rel: string): boolean {
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm || norm === '.') return true; // 不允许直接读项目根本身
    const parts = norm.split('/');
    if (parts.length >= 3 && parts[0] === 'backend' && parts[1] === 'data') return true;
    for (const part of parts) {
      const low = part.toLowerCase();
      if (
        TaskRunnerService.SENSITIVE_DIRS.has(part) ||
        TaskRunnerService.SENSITIVE_FILES.has(part)
      ) {
        return true;
      }
      for (const g of TaskRunnerService.SENSITIVE_GLOBS) {
        const re = new RegExp(
          '^' + g.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        );
        if (re.test(low)) return true;
      }
    }
    return false;
  }

  /** 解析产物文件（相对项目根）：防目录穿越 + 敏感路径黑名单；
   *  不存在 / 非文件 / 命中黑名单均返回 null。 */
  readArtifact(relPath: string): { abs: string; inline: boolean; ctype: string } | null {
    if (!relPath) return null;
    const abs = path.resolve(this.projectRoot, relPath);
    if (!abs.startsWith(this.projectRoot) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return null;
    }
    const rel = path.relative(this.projectRoot, abs).replace(/\\/g, '/');
    if (this.isSensitivePath(rel)) return null;
    const ext = path.extname(abs).toLowerCase();
    return {
      abs,
      inline: ARTIFACT_INLINE_EXTS.has(ext),
      ctype: ARTIFACT_CONTENT_TYPES[ext] || 'application/octet-stream',
    };
  }
}
