import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';

export interface TaskParam {
  flag: string;
  default?: string;
  type?: string;
  raw?: boolean;
}
export interface TaskDef {
  /** 可执行命令（`{py}` 占位符会被替换成 python）。9 个任务已全部迁为 Nest 原生流水线，
   *  tasks.json 不再声明它；仅当任务尚未原生实现时才需要（回退 spawn 路径）。 */
  cmd?: string[];
  name: string;
  group?: string;
  params?: TaskParam[];
  timeout?: number;
  hidden?: boolean;
  disabled?: boolean;
  /** 任务 id（tasks.json 数组项自带），注册表以它为键。 */
  id?: string;
  /** 前置产物（相对项目根）：以 / 结尾按目录算，其余按文件算。 */
  needs?: string[];
  /** 本任务产出的路径（相对项目根），前端据此反查「该先跑谁」。 */
  outputs?: string[];
  /** 其余原始字段（desc / nodes / color …）原样透传给前端。 */
  [key: string]: unknown;
}
export type TaskMap = Record<string, TaskDef>;

/** 任务分组（tasks.json 的 groups）。 */
export interface GroupDef {
  id: string;
  name: string;
  color?: string;
  [key: string]: unknown;
}

/** 任务注册表（移植自 server.py 对 workbench/tasks.json 的加载）。 */
@Injectable()
export class TaskRegistryService implements OnModuleInit {
  private readonly logger = new Logger(TaskRegistryService.name);
  private taskMap: TaskMap = {};
  /** 分组与任务数组原样保留：/api/state 的 registry 必须完整下发它们
   *  （前端任务中心依赖 groups[].{id,name,color} 与 tasks[].{id,group,outputs,...}）。 */
  private groups: GroupDef[] = [];
  private tasks: TaskDef[] = [];
  private raw: Record<string, unknown> = {};
  private mtime = 0;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.syncRegistry();
  }

  get map(): TaskMap {
    return this.taskMap;
  }
  get(tid: string): TaskDef | undefined {
    return this.taskMap[tid];
  }

  /** 文件变更时重新读取（供 /api/reload）。 */
  syncRegistryIfChanged(): void {
    const file = this.filePath();
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === this.mtime) return;
      this.load();
    } catch {
      /* 文件缺失：保留旧注册表 */
    }
  }

  syncRegistry(): void {
    this.load();
  }

  /** 任务是否可运行：ok / missing / disabled。 */
  linkState(taskId: string): 'ok' | 'missing' | 'disabled' {
    const t = this.taskMap[taskId];
    if (!t) return 'missing';
    if (t.hidden || t.disabled) return 'disabled';
    return 'ok';
  }

  /** registry 只读视图（对应 server.py 的 MGR.registry_view()）：
   *  原样下发 groups / tasks，并给每个任务按磁盘现状补上 missing（缺失的前置产物）。
   *  每次请求现算；取视图前先探测文件变更，保证改完 tasks.json 刷新页面即生效。 */
  view(): Record<string, unknown> {
    this.syncRegistryIfChanged();
    const tasks = this.tasks.map((t) => ({ ...t, missing: this.missingPrereqs(t) }));
    return { ...this.raw, groups: this.groups, tasks };
  }

  /** 注册表内的任务 id 列表。
   *  供 /api/state 计算 last（每个任务最近一次运行）时使用 —— view() 返回的是
   *  Record<string, unknown>，直接取 .tasks 在 TS 侧是 unknown，这里给个强类型出口。 */
  taskIds(): string[] {
    this.syncRegistryIfChanged();
    return this.tasks.map((t) => String(t.id));
  }

  /** 任务声明的 needs（前置产物）是否齐备，返回缺失项列表（相对项目根）。
   *  · 以 / 结尾按目录算 —— 必须存在且非空
   *  · 其余按文件算     —— 必须存在
   *  只在展示与执行前提示用，不阻断执行（产物也可能由别的途径生成）。 */
  private missingPrereqs(task: TaskDef): string[] {
    const root =
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..');
    const missing: string[] = [];
    for (const need of task.needs || []) {
      const rel = String(need).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel) continue;
      const p = path.join(root, rel);
      let ok = false;
      try {
        if (rel.endsWith('/')) {
          ok = fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
        } else {
          ok = fs.statSync(p).isFile();
        }
      } catch {
        ok = false;
      }
      if (!ok) missing.push(rel);
    }
    return missing;
  }

  private filePath(): string {
    return path.join(this.config.get<string>('WORKBENCH_DIR') || '', 'tasks.json');
  }

  private load(): void {
    const file = this.filePath();
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const data = JSON.parse(raw);
      const arr: TaskDef[] = data.tasks || (Array.isArray(data) ? data : []);
      // 注册表以任务 id 为键（tasks.json 中是数组，需转成 Record<id, def>）
      const map: TaskMap = {};
      for (const t of arr) {
        if (t.id) map[t.id] = t;
      }
      this.taskMap = map;
      this.groups = (data.groups as GroupDef[]) || [];
      this.tasks = arr;
      this.raw = data;
      this.mtime = fs.statSync(file).mtimeMs;
      this.logger.log(
        `registry loaded: ${Object.keys(this.taskMap).length} tasks, ${this.groups.length} groups`,
      );
    } catch (e) {
      this.logger.error(`registry load failed: ${(e as Error).message}`);
    }
  }
}
