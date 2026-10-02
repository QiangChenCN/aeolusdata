/**
 * 原生任务处理器契约（任务中心从 spawn(python) 迁到 Nest 内流水线的核心抽象）。
 *
 * 背景见 docs/migration-jobs-to-nest.md：Python 只保留「大数据计算 / Excel」，
 * 取数 / 加工 / 编排 / 出图 / 上传 / 发送全部在 Nest 内完成。
 *
 * 增量迁移：TaskRunnerService 优先查本注册表；查不到才回退旧的 spawn(cmd) 路径。
 */

/** 任务节点（对应 Python 侧 nodeflow 的 NODES 项）。 */
export interface TaskStage {
  id: string;
  name: string;
}

/** 一次运行的上下文：只暴露处理器需要的能力（日志 / 停止 / 参数）。 */
export interface TaskRunContext {
  runId: string;
  taskId: string;
  name: string;
  group: string;
  /** 任务参数（key 为 --flag 形式，与 tasks.json 的 params.flag 对齐）。 */
  args: Record<string, unknown>;
  /** 追加一行运行日志（走 SSE，与旧 Python print 同通道）。 */
  log(line: string): void;
  /** 是否已收到「终止」请求（长循环/多站点轮询请定期检查）。 */
  isStopped(): boolean;
}

/** 原生任务处理器。实现类需在构造时把自己注册进 TaskHandlersService。 */
export interface TaskHandler {
  /** 必须与 backend/tasks.json 的任务 id 一致。 */
  readonly id: string;
  /** 节点声明（供区间校验与前端步进条）；缺省表示「不可分段」。 */
  readonly stages?: TaskStage[];
  /** 执行：正常返回即成功；抛 TaskStop 表示业务性正常结束；抛其它即失败。 */
  run(ctx: TaskRunContext): Promise<void>;
}

/**
 * 业务性「正常结束」——对应 Python nodeflow.Stop 的语义。
 * 典型场景：筛选后 0 条（无数据可发），此时应记成功而非失败。
 */
export class TaskStop extends Error {
  constructor(message = '无数据可处理，正常结束') {
    super(message);
    this.name = 'TaskStop';
  }
}
