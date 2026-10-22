import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { TaskRegistryService, TaskDef } from './task-registry.service';
import { JobQueueService } from '../jobs/job-queue.service';

/**
 * 任务产物服务（从旧 TaskRunnerService 精简而来）。
 *
 * 2026-10-22 任务执行已剥离到独立 worker 进程（见 modules/jobs）：执行、队列、运行内存态、
 * SSE 广播全部迁走。本类只保留「纯磁盘」的产物列举 / 读取能力，不持有任何运行态。
 * 占位符 <name> 展开所需的「最近一次运行参数」改由 JobQueueService 从 PG 读取。
 */
@Injectable()
export class TaskRunnerService {
  private projectRoot = '';

  constructor(
    private readonly config: ConfigService,
    private readonly registry: TaskRegistryService,
    private readonly jobQueue: JobQueueService,
  ) {
    this.projectRoot = path.resolve(
      this.config.get<string>('PROJECT_ROOT') ||
        path.resolve(process.cwd(), '..'),
    );
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

  /** 该任务最近一次成功运行的参数（history 是 unshift 的，第一条最新）。 */
  private async lastRunArgs(taskId: string): Promise<Record<string, unknown>> {
    try {
      return await this.jobQueue.getLastArgs(taskId);
    } catch {
      return {};
    }
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

  async listArtifacts(
    taskId?: string,
  ): Promise<{ name: string; rel: string; size: number; mtime: string; type: string }[]> {
    if (!taskId) return [];
    const task = this.registry.get(taskId);
    if (!task) return [];
    const args = await this.lastRunArgs(taskId);
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
    'node_modules', '.git', 'credentials', 'secrets', 'runs', 'logs',
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
    // apps/api/runtime 整体为敏感（内部数据），但 apps/api/runtime/jobs 下是公开任务产物，
    // 需经 /api/file 读取，故对该子目录放行（其余 apps/api/runtime/* 仍拦截）。
    if (parts[0] === 'apps' && parts[1] === 'api' && parts[2] === 'runtime' && parts[3] !== 'jobs') return true;
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
      ctype: (ARTIFACT_CONTENT_TYPES as Record<string, string>)[ext] || 'application/octet-stream',
    };
  }
}

const ARTIFACT_INLINE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.html', '.htm', '.csv', '.tsv', '.json', '.jsonl', '.txt', '.md', '.log',
]);
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
