import { Logger } from '@nestjs/common';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GlobalFonts } from '@napi-rs/canvas';

/**
 * 中文渲染字体解析（移植自 common/ding_common.py 的 resolve_font_path）。
 *
 * 优先级：DING_FONT_PATH → 各平台常见 CJK 字体 → Linux `fc-match` 兜底。
 * 解析结果注册进 @napi-rs/canvas 的全局字体表，之后按 FONT_FAMILY 引用即可。
 */
const logger = new Logger('RenderFont');

/** 注册到 canvas 的字体族名（内部固定，外部无需关心）。 */
export const FONT_FAMILY = 'SimHei';

let registered: string | null = null;

/**
 * 从当前文件位置向上回溯，定位仓库内置的中文字体。
 *
 * 兼容两种运行布局：
 * - 开发（`nest start`）：__dirname = src/modules/render → 上溯到 apps/api/assets/…
 * - 生产（`node dist/src/main.js`）：__dirname = dist/src/modules/render → 上溯到 apps/api/assets/…
 * 这样不依赖 `nest build` 是否把 assets 拷进 dist，也不依赖系统装字体。
 */
export function findBundledFont(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'assets', 'fonts', 'SourceHanSans.ttc');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveFontPath(): string {
  const env = process.env.DING_FONT_PATH;
  if (env && fs.existsSync(env)) return env;

  // 项目内置字体：跟随仓库走，开发/生产都不依赖系统装字体。仅用 Source Han Sans 完整版
  // （Adobe 发行，= NotoSansCJK 合集，含 SC/TC/JP/KR，TTC index 0 即简体中文）。
  const bundled = findBundledFont();

  const candidates = [
    ...(bundled ? [bundled] : []),
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/msyh.ttf',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const out = execFileSync('fc-match', ['-f', '%{file}', ':lang=zh'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    /* 无 fontconfig 环境：忽略 */
  }
  logger.warn(
    `未找到可用中文字体，回退默认路径（渲染中文将变方块，请安装 fonts-wqy-zenhei 或设 DING_FONT_PATH）: ${candidates[0]}`,
  );
  return candidates[0];
}

/** 确保中文字体已注册（幂等）；返回字体族名。 */
export function ensureFont(): string {
  if (registered) return registered;
  const p = resolveFontPath();
  try {
    if (GlobalFonts.registerFromPath(p, FONT_FAMILY)) {
      registered = FONT_FAMILY;
    } else {
      logger.warn(`中文字体注册失败（${p}），回退 sans-serif —— 中文可能显示为方块`);
      registered = 'sans-serif';
    }
  } catch (e) {
    logger.warn(`中文字体注册异常（${p}）：${(e as Error).message}`);
    registered = 'sans-serif';
  }
  return registered;
}
