#!/usr/bin/env node
/**
 * 前端架构边界检查器（零依赖，Node 内置模块）。作用域：apps/web/src。
 *
 * 本脚本只校验前端范围内的边界（后端/Python 各有独立检查脚本）：
 *   R2 features/<A> 不得引用 features/<B>（含平铺的 *.vue）。
 *   R3 共享层（components / composables / stores / utils / api / layouts）不得反向引用
 *       features/**（壳依赖具体页面 = 方向反转）。
 *
 * 装配点豁免（vue-router 注册 / App.vue）：src/router/、src/App.vue。
 *
 * 基线（棘轮 ratchet）见同目录 arch-baseline.json：存量不阻断，新增必报错。
 *
 * 用法：
 *   node apps/web/scripts/check-arch.mjs
 *   node apps/web/scripts/check-arch.mjs --strict
 *   node apps/web/scripts/check-arch.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const BASELINE_PATH = path.join(ROOT, 'apps', 'web', 'scripts', 'arch-baseline.json');
const STRICT = process.argv.includes('--strict');
const AS_JSON = process.argv.includes('--json');

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
    else if (/\.(ts|js|mjs|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = [
  /(?:^|[\s;{}()])(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bfrom\s*['"]([^'"]+)['"]/g,
];

function extractImports(src) {
  const res = [];
  for (const re of IMPORT_RE) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (m[1]) res.push(m[1]);
    }
  }
  return [...new Set(res)];
}

const EXT = ['.ts', '.tsx', '.js', '.mjs', '.vue'];

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => path.join(base, 'index' + e))];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return null;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function boardOf(file) {
  const m = rel(file).match(/^apps\/web\/src\/features\/([^/]+)\//);
  return m ? m[1] : null;
}

function isAssemblyPoint(file) {
  const r = rel(file);
  return /^apps\/web\/src\/router\//.test(r) || /^apps\/web\/src\/App\.vue$/.test(r);
}

const target = path.join(ROOT, 'apps', 'web', 'src');
const files = walk(target).filter((f) => !/\.test\./.test(f));

const violations = [];
for (const file of files) {
  const r = rel(file);
  const src = fs.readFileSync(file, 'utf-8');
  const selfBoard = boardOf(file);

  // R3：共享层不得反向引用 features/
  if (/^apps\/web\/src\/(components|composables|stores|utils|api|layouts)\//.test(r)) {
    for (const spec of extractImports(src)) {
      const abs = resolveSpec(file, spec);
      if (!abs) continue;
      const tr = rel(abs);
      if (/^apps\/web\/src\/features\//.test(tr)) {
        violations.push({ rule: 'R3', from: r, import: tr, spec });
      }
    }
  }

  // R2：features/<A> 不得引用 features/<B>
  for (const spec of extractImports(src)) {
    const abs = resolveSpec(file, spec);
    if (!abs) continue;
    const tr = rel(abs);
    const m = tr.match(/^apps\/web\/src\/features\/([^/]+)\//);
    if (!m) continue;
    const targetBoard = m[1];
    if (selfBoard && targetBoard && selfBoard !== targetBoard && !isAssemblyPoint(file)) {
      violations.push({ rule: 'R2', from: r, import: tr, spec });
    }
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
  scope: 'apps/web',
  scanned: files.length,
  totalViolations: violations.length,
  suppressedByBaseline: violations.length - remaining.length,
  newViolations: remaining.length,
  staleBaselineEntries: staleBaseline.length,
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, violations: remaining, staleBaseline }, null, 2));
} else {
  console.log('=== 前端架构边界检查 (apps/web) ===');
  console.log(`${summary.mode} 模式 · 扫描 ${summary.scanned} 个文件 · 违规 ${summary.totalViolations} 处`);
  console.log(`基线豁免 ${summary.suppressedByBaseline} 处 · 新增待处理 ${summary.newViolations} 处\n`);
  if (remaining.length) {
    for (const v of remaining) console.log(`  [${v.rule}] ${v.from}\n      → ${v.import}`);
  } else {
    console.log('✅ 无新增违规（基线内存量见 apps/web/scripts/arch-baseline.json）\n');
  }
  if (staleBaseline.length) {
    console.log('⚠️  基线中已失效（对应违规已消失，可清理）：');
    for (const e of staleBaseline) console.log(`  ${e.rule} ${e.from} → ${e.import}`);
  }
}

process.exit(STRICT ? (violations.length ? 1 : 0) : remaining.length ? 1 : 0);
