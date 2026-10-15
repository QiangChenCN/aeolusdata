import * as Joi from 'joi';
import * as path from 'path';

// 在 ConfigModule.forRoot 读取前，给 WORKBENCH_DIR 一个可靠默认值（Nest backend 目录：
// tasks.json 与 todo.db 现已落于 backend/ 下，故默认指向 backend 而非旧 python/workbench）。
// 否则 ConfigService.get('WORKBENCH_DIR') 在无 env/.env 时为 undefined，
// 各模块会把路径解析成 cwd-relative（如 backend/tasks.json），导致注册表/待办库错位。
if (!process.env.WORKBENCH_DIR) {
  // 后端可能从仓库根或 backend/ 自身启动（ConfigModule 默认只在 cwd 找 .env，
  // 从仓库根启动时 .env 不会被加载，只能靠这里兜底）。
  // 统一收敛到 backend/ 目录，避免 cwd 不同导致 tasks.json / todo.db 解析错位。
  const cwd = process.cwd();
  process.env.WORKBENCH_DIR =
    path.basename(cwd) === 'backend' ? cwd : path.join(cwd, 'backend');
}

/**
 * 环境变量校验 Schema（启动时强校验，缺失/非法直接失败）。
 * 新增配置必须同步更新 .env.example 与本 Schema。
 */
export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(8787),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  AUTH_TOKEN: Joi.string().required(),
  // 默认取 python：代理端点（standard / attend-period / overview / assessment / groups …）
  // 依赖 Python 生态，node 模式下它们恒定返回 NEED_PYTHON，默认值取 node 会误导。
  COMPUTE_PROVIDER: Joi.string().valid('node', 'python').default('python'),
  PYTHON_COMPUTE_URL: Joi.string().uri().optional(),
  // 项目根（jobs/、common/ 所在）：后端默认在上层目录
  PROJECT_ROOT: Joi.string().optional(),
  // 任务注册表目录（tasks.json / runs / data）
  WORKBENCH_DIR: Joi.string().optional(),
}).unknown(true);

export interface AppConfig {
  port: number;
  nodeEnv: string;
  authToken: string;
  computeProvider: 'node' | 'python';
  pythonComputeUrl?: string;
  projectRoot: string;
  workbenchDir: string;
}

export function loadAppConfig(): AppConfig {
  const projectRoot =
    process.env.PROJECT_ROOT || path.resolve(process.cwd(), '..');
  return {
    port: Number(process.env.PORT) || 8787,
    nodeEnv: process.env.NODE_ENV || 'development',
    authToken: process.env.AUTH_TOKEN || '',
    computeProvider: (process.env.COMPUTE_PROVIDER as 'node' | 'python') || 'python',
    pythonComputeUrl: process.env.PYTHON_COMPUTE_URL,
    projectRoot,
    workbenchDir: process.env.WORKBENCH_DIR || path.join(projectRoot, 'backend'),
  };
}
