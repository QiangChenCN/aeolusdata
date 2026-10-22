/**
 * dual emit 收尾脚本。
 *
 * 背景：dist/cjs 与 dist/esm 下都是 .js 后缀，但内部语法一个是 CommonJS、一个是 ESM。
 * 若不显式标记，Node 会按「最近的 package.json 的 type 字段」来判定格式；
 * 由于本包根 package.json 没有 type（默认 commonjs），dist/esm 里的 .js
 * 可能被误当成 CommonJS 解析。
 *
 * 做法：在两个产物目录各写一份只含 type 的 package.json，把格式「钉死」，
 * 这是 Node 官方推荐的 dual package hazard 规避方式。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const markers = [
  ['dist/cjs', 'commonjs'],
  ['dist/esm', 'module'],
];

for (const [dir, type] of markers) {
  const target = resolve(root, dir);
  if (!existsSync(target)) {
    console.warn(`[shared] 跳过 ${dir}（目录不存在，构建可能已失败）`);
    continue;
  }
  writeFileSync(resolve(target, 'package.json'), JSON.stringify({ type }, null, 2) + '\n');
  console.log(`[shared] 已写入 ${dir}/package.json → {"type":"${type}"}`);
}
