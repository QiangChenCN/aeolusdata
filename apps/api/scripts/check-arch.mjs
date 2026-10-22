#!/usr/bin/env node
/**
 * 后端架构边界检查器（零依赖，Node 内置模块）。作用域：apps/api/src。
 *
 * 背景：本项目是「多看板」架构 —— 标准达成 / 考核 / 配送超时 / IM 电联 各自为独立看板，
 * 且同一指标允许多套算法。真实风险是**跨看板直接引用内部实现**（共享后改一处波及多板）。
 *
 * 本脚本只校验后端范围内的边界（前端/Python 各有独立检查脚本）：
 *   R1 看板业务模块（assessment / delivery-timeout / im-contact / standard）之间
 *       不得深引对方内部实现（service/controller/util…），只允许 *.module.ts 与 index.ts 公开面。
 *   R6 看板外模块引用看板内部实现时，若该看板已提供 index.ts 公开面，必须走公开面。
 *   （平台设施层 pg / compute / auth / config / tasks / notify / render … 不算耦合，放行。）
 *
 * 装配点豁免（Nest module 注册所必需）：app.module.ts、<board>.module.ts。
 *
 * 基线（棘轮 ratchet）见同目录 arch-baseline.json：存量不阻断，新增必报错。
 *
 * 用法：
 *   node apps/api/scripts/check-arch.mjs            # 人工查看（默认含基线）
 *   node apps/api/scripts/check-arch.mjs --strict    # 忽略基线，只看真实违规
 *   node apps/api/scripts/check-arch.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const BASELINE_PATH = path.join(ROOT, 'apps', 'api', 'scripts', 'arch-baseline.json');
const STRICT = process.argv.includes('--strict');
const AS_JSON = process.argv.includes('--json');

const BACKEND_BOARD_MODULES = new Set(['assessment', 'delivery-timeout', 'im-contact', 'standard']);

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
  const m = rel(file).match(/^apps\/api\/src\/modules\/([^/]+)\//);
  return m ? m[1] : null;
}

function isAssemblyPoint(file) {
  const r = rel(file);
  return /(^|\/)app\.module\.ts$/.test(r) || /^apps\/api\/src\/modules\/[^/]+\/[^/]*\.module\.ts$/.test(r);
}

const target = path.join(ROOT, 'apps', 'api', 'src');
const files = walk(target).filter((f) => !/\.test\./.test(f) && !/[^/]*\.spec\.ts$/.test(f));

const violations = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf-8');
  const selfBoard = boardOf(file);
  for (const spec of extractImports(src)) {
    const targetAbs = resolveSpec(file, spec);
    if (!targetAbs || !fs.existsSync(targetAbs)) continue;
    const targetBoard = boardOf(targetAbs);
    if (!targetBoard) continue;                       // 平台设施层，不算看板耦合
    if (selfBoard === targetBoard) continue;          // 同看板内部
    if (isAssemblyPoint(file)) continue;              // 装配点豁免
    const tr = rel(targetAbs);
    if (/\.module\.ts$/.test(path.basename(tr)) || path.basename(tr) === 'index.ts') continue; // 公开面允许
    if (!BACKEND_BOARD_MODULES.has(targetBoard)) continue;
    if (BACKEND_BOARD_MODULES.has(selfBoard)) {
      violations.push({ rule: 'R1', from: rel(file), import: tr, spec });
    } else {
      const publicFace = path.join(ROOT, 'apps', 'api', 'src', 'modules', targetBoard, 'index.ts');
      if (fs.existsSync(publicFace)) {
        violations.push({ rule: 'R6', from: rel(file), import: tr, spec });
      }
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
  scope: 'apps/api',
  scanned: files.length,
  totalViolations: violations.length,
  suppressedByBaseline: violations.length - remaining.length,
  newViolations: remaining.length,
  staleBaselineEntries: staleBaseline.length,
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, violations: remaining, staleBaseline }, null, 2));
} else {
  console.log('=== 后端架构边界检查 (apps/api) ===');
  console.log(`${summary.mode} 模式 · 扫描 ${summary.scanned} 个文件 · 违规 ${summary.totalViolations} 处`);
  console.log(`基线豁免 ${summary.suppressedByBaseline} 处 · 新增待处理 ${summary.newViolations} 处\n`);
  if (remaining.length) {
    for (const v of remaining) console.log(`  [${v.rule}] ${v.from}\n      → ${v.import}`);
  } else {
    console.log('✅ 无新增违规（基线内存量见 apps/api/scripts/arch-baseline.json）\n');
  }
  if (staleBaseline.length) {
    console.log('⚠️  基线中已失效（对应违规已消失，可清理）：');
    for (const e of staleBaseline) console.log(`  ${e.rule} ${e.from} → ${e.import}`);
  }
}

process.exit(STRICT ? (violations.length ? 1 : 0) : remaining.length ? 1 : 0);
