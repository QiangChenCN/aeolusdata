/**
 * 任务流水线骨架（对应 Python 侧 common/nodeflow.py 的 NODES / pick / execute）。
 *
 * 每个任务声明若干节点，节点函数共享一份 state（对应旧代码的 ctx 字典），
 * 通过 `--begin/--end` 可只跑区间内的节点（保持旧 CLI 语义）。
 */
import { TaskRunContext, TaskStop } from './task-handler';

export interface PipelineStage<S> {
  id: string;
  name: string;
  fn: (state: S) => Promise<void> | void;
}

/** 从任务参数里取 --begin/--end（未给返回 undefined）。 */
export function parseRange(args: Record<string, unknown>): [string | undefined, string | undefined] {
  const b = args['--begin'];
  const e = args['--end'];
  return [b == null || b === '' ? undefined : String(b), e == null || e === '' ? undefined : String(e)];
}

/**
 * 按声明顺序截取 [begin, end] 区间（含两端）。
 * 非法节点名 / end 早于 begin 一律抛错 —— 与 Python nodeflow.pick 同语义（宁可非零退出）。
 */
export function pickRange(ids: string[], begin?: string, end?: string): string[] {
  if (!begin && !end) return ids.slice();
  const bi = begin ? ids.indexOf(begin) : 0;
  const ei = end ? ids.indexOf(end) : ids.length - 1;
  if (bi < 0 || ei < 0) {
    throw new Error(`未知节点：${begin || ''} / ${end || ''}（可用 ${ids.join(' / ')}）`);
  }
  if (ei < bi) {
    throw new Error(`节点区间非法：end(${ids[ei]}) 早于 begin(${ids[bi]})`);
  }
  return ids.slice(bi, ei + 1);
}

export class Pipeline<S extends Record<string, any>> {
  private readonly stages: PipelineStage<S>[] = [];

  constructor(
    private readonly ctx: TaskRunContext,
    private readonly state: S,
  ) {}

  stage(id: string, name: string, fn: (state: S) => Promise<void> | void): this {
    this.stages.push({ id, name, fn });
    return this;
  }

  get stageIds(): string[] {
    return this.stages.map((s) => s.id);
  }

  /** 按 --begin/--end 顺序执行节点；任一节点抛错即中断（后续不再跑）。 */
  async run(): Promise<void> {
    const [begin, end] = parseRange(this.ctx.args);
    const todo = new Set(pickRange(this.stageIds, begin, end));
    for (const st of this.stages) {
      if (!todo.has(st.id)) continue;
      if (this.ctx.isStopped()) throw new TaskStop('已请求终止');
      this.ctx.log(`[节点] ${st.name}（${st.id}）`);
      await st.fn(this.state);
    }
  }
}
