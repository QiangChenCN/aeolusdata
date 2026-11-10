/**
 * 跨语言路径契约（monorepo 标准落地）。
 * 取代散落在各 service 的 `path.join(root, 'apps','api','runtime', X)` 硬编码拼接。
 *
 * - 仓库根：env `AEOLUS_REPO_ROOT` 优先；兜底只认 `.git`
 *   （apps/api 自身带 package.json，若用 package.json 兜底会误停在 apps/api，算错仓库根）。
 *   与 services/compute/analytics/core/paths.py 同算法、同 env 名。
 * - 子目录位置统一从仓库根 `config/paths.json` 读取，杜绝散落硬编码。
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT_ENV = 'AEOLUS_REPO_ROOT';

function findRepoRoot(): string {
  let d = path.resolve(process.cwd());
  while (d && d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      return d;
    }
    d = path.dirname(d);
  }
  return path.resolve(process.cwd(), '..');
}

function resolveRoot(): string {
  return process.env[REPO_ROOT_ENV]
    ? path.resolve(process.env[REPO_ROOT_ENV])
    : process.env.PROJECT_ROOT
      ? path.resolve(process.env.PROJECT_ROOT)
      : findRepoRoot();
}

// 进程启动时的根（兼容直接 import ROOT 的模块）。
// dirs.* 内部走 resolveRoot() 动态解析，以支持运行时通过 env 覆盖（如单测注入临时 PROJECT_ROOT）。
export const ROOT = resolveRoot();

const contract = JSON.parse(
  fs.readFileSync(path.join(resolveRoot(), 'config', 'paths.json'), 'utf-8'),
);
const DIRS = contract.dirs as Record<string, string>;

function abs(rel: string): string {
  return path.join(resolveRoot(), rel);
}

export const dirs = {
  runtime(sub?: string): string {
    const base = abs(DIRS.appsApiRuntime);
    return sub ? path.join(base, sub) : base;
  },
  config(sub?: string): string {
    const base = abs(DIRS.appsApiConfig);
    return sub ? path.join(base, sub) : base;
  },
  appsWebDist(sub?: string): string {
    const base = abs(DIRS.appsWebDist);
    return sub ? path.join(base, sub) : base;
  },
  computeStandard(sub?: string): string {
    const base = abs(DIRS.computeStandard);
    return sub ? path.join(base, sub) : base;
  },
  /** Python 计算侧 analytics/core 目录：时段配置 period_config_YYYY-MM.json 的唯一落盘位置。 */
  computeAnalyticsCore(sub?: string): string {
    const base = abs(DIRS.computeAnalyticsCore);
    return sub ? path.join(base, sub) : base;
  },
  sharedCache(sub?: string): string {
    const base = abs(DIRS.sharedCache);
    return sub ? path.join(base, sub) : base;
  },
};
