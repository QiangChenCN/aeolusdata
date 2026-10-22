#!/usr/bin/env node
/**
 * Python 计算层架构边界检查器（零依赖，Node 内置模块）。作用域：services/compute。
 *
 * 注意：本脚本以 .mjs 形式留在 Python 工程目录内，由 Node 运行（与 pytest 的
 * test_arch_boundaries.py 调用方式一致，后者已依赖 node 可用）。
 *
 * 本脚本只校验 Python 范围内的边界（前端/后端各有独立检查脚本）：
 *   R4 看板私有域包（analytics/domains/<name>/）之间不得互引。
 *   R5 未在 SHARED_MODULES 登记的 analytics 顶层模块，若被 ≥2 个不同看板引用，
 *       视为「事实共享契约」，必须先登记（写明 owner 与适用看板）才能继续用。
 *
 * 装配点豁免：同一域包内部的相对导入（from .xxx）直接放行。
 *
 * 基线（棘轮 ratchet）见同目录 arch-baseline.json：存量不阻断，新增必报错。
 *
 * 用法：
 *   node services/compute/scripts/check-arch.mjs            # 人工查看（默认含基线）
 *   node services/compute/scripts/check-arch.mjs --strict    # 忽略基线，只看真实违规
 *   node services/compute/scripts/check-arch.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const BASELINE_PATH = path.join(ROOT, 'services', 'compute', 'scripts', 'arch-baseline.json');
const STRICT = process.argv.includes('--strict');
const AS_JSON = process.argv.includes('--json');

/* 顶层包根（sys.path 根是 services/compute/） */
const PY_ROOTS = ['analytics', 'common', 'compute_api', 'tools', 'dashboard', 'sources'];
/* 看板私有域包（互引即违规） */
const PY_BOARD_PKGS = new Set([
  'assessment', 'delivery_timeout', 'im_contact', 'standard', 'attend_period',
]);
/* 已登记的共享契约模块（改动前请先看这里写的 owner 清单） */
const SHARED_MODULES = new Set([
  'analytics',
  'common.pg',
  'analytics.core',
  'analytics.core.cache',
  'analytics.core.order_rules',
  'analytics.core.teams_config',
  'analytics.core.period_config',
  'analytics.core.grade_standards',
  'sources',
  'analytics.domains.standard.achievement',
  'analytics.domains.standard.rider_dimension',
  'analytics.domains.standard.station_report',
  'analytics.domains.standard.site_orders',
  'analytics.domains.assessment.service_quality',
]);

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '__pycache__', '.venv', 'venv',
  'coverage', '.pytest_cache', '.vite', 'logs',
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.py$/.test(e.name)) out.push(p);
  }
  return out;
}

const PY_IMPORT_RE = [
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/gm,
];

function extractImports(src) {
  const res = [];
  for (const re of PY_IMPORT_RE) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (m[1]) res.push(m[1]);
    }
  }
  return [...new Set(res)];
}

function resolvePyModule(spec) {
  const parts = spec.split('.');
  if (!PY_ROOTS.includes(parts[0])) return null;
  const abs = path.join(ROOT, 'services', 'compute', parts.join('/'));
  const candidates = [abs, abs + '.py', path.join(abs, '__init__.py')];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return null;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function pyModuleName(file) {
  const m = rel(file).match(/^services\/compute\/([^/].*?)(?:\.py|\/__init__\.py)$/);
  return m ? m[1].replace(/\//g, '.') : null;
}

function boardOf(file) {
  const m = rel(file).match(/^services\/compute\/analytics\/domains\/([^/]+)\//);
  return m && PY_BOARD_PKGS.has(m[1]) ? m[1] : null;
}

const target = path.join(ROOT, 'services', 'compute');
const files = walk(target).filter(
  (f) => !/\/tests?\//.test(rel(f)) && !/test_.*\.py$/.test(f),
);

const violations = [];
const pyUsage = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf-8');
  const selfBoard = boardOf(file);
  for (const spec of extractImports(src)) {
    if (spec.startsWith('.')) continue; // 同域包内部相对导入，放行
    const targetAbs = resolvePyModule(spec);
    if (!targetAbs) continue;
    const targetBoard = boardOf(targetAbs);
    if (!targetBoard) {
      // 记录共享面使用（用于 R5）
      if (selfBoard) {
        const nm = pyModuleName(targetAbs) || spec;
        if (!pyUsage.has(nm)) pyUsage.set(nm, new Set());
        pyUsage.get(nm).add(selfBoard);
      }
      continue;
    }
    if (selfBoard === targetBoard) continue; // 同域内部
    // R4 语义：只有「两侧都位于看板包内」才算跨看板耦合。
    // 装配层（compute_api/）与工具脚本（tools/）不属于任何看板，
    // 它们本就负责把请求派发到各看板，直接引用看板入口属正常分层。
    // 去掉这行会让规则不可满足：装配层永远不能引用任何看板文件。
    if (selfBoard === null) continue;
    violations.push({ rule: 'R4', from: rel(file), import: pyModuleName(targetAbs) || spec, spec });
  }
}

// R5：事实共享契约必须登记
for (const [mod, boards] of pyUsage) {
  if (boards.size >= 2 && !SHARED_MODULES.has(mod)) {
    violations.push({ rule: 'R5', import: mod, from: `被 ${[...boards].sort().join(' / ')} 引用`, spec: mod });
  }
}

let baseline = { allow: [] };
if (!STRICT && fs.existsSync(BASELINE_PATH)) {
  baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
}
const keyOf = (v) => `${v.rule}|${v.from}|${v.import}`;
const allowed = new Set((baseline.allow || []).map(keyOf));
const remaining = violations.filter((v) => !allowed.has(keyOf(v)));
const staleBaseline = (baseline.allow || []).filter((e) => !violations.some((v) => keyOf(v) === keyOf(e)));

const summary = {
  mode: STRICT ? 'strict' : 'baseline',
  scope: 'services/compute',
  scanned: files.length,
  totalViolations: violations.length,
  suppressedByBaseline: violations.length - remaining.length,
  newViolations: remaining.length,
  staleBaselineEntries: staleBaseline.length,
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, violations: remaining, staleBaseline }, null, 2));
} else {
  console.log('=== Python 架构边界检查 (services/compute) ===');
  console.log(`${summary.mode} 模式 · 扫描 ${summary.scanned} 个文件 · 违规 ${summary.totalViolations} 处`);
  console.log(`基线豁免 ${summary.suppressedByBaseline} 处 · 新增待处理 ${summary.newViolations} 处\n`);
  if (remaining.length) {
    for (const v of remaining) console.log(`  [${v.rule}] ${v.from}\n      → ${v.import}`);
  } else {
    console.log('✅ 无新增违规（基线内存量见 services/compute/scripts/arch-baseline.json）\n');
  }
  if (staleBaseline.length) {
    console.log('⚠️  基线中已失效（对应违规已消失，可清理）：');
    for (const e of staleBaseline) console.log(`  ${e.rule} ${e.from} → ${e.import}`);
  }
}

process.exit(STRICT ? (violations.length ? 1 : 0) : remaining.length ? 1 : 0);
