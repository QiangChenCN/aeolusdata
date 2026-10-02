/**
 * 统一配色（移植自 common/theme_colors.py，单一事实来源）。
 *
 * 品牌色：淘宝闪购橙 #FF5000。
 * 前端 HTML/CSS 直接用十六进制常量；Node 侧 PNG 渲染用 rgb() 取 [r,g,b]。
 */
export const BRAND = '#FF5000';
export const BRAND_HOVER = '#E64600';
export const BRAND_TINT = '#FFF3EE';
export const BRAND_TINT_SOFT = '#FFF7F4';
export const BRAND_BORDER = '#FFE0D0';

export const TEXT_PRIMARY = '#1D2129';
export const TEXT_REGULAR = '#303133';
export const TEXT_SECONDARY = '#4E5969';
export const TEXT_TERTIARY = '#86909C';
export const BORDER = '#E5E6EB';
export const DIVIDER = '#F2F3F5';
export const SURFACE = '#F7F8FA';
export const CANVAS = '#F5F6F8';
export const WHITE = '#FFFFFF';

export const SUCCESS = '#00B42A';
export const SUCCESS_TINT = '#E8FFEA';
export const DANGER = '#F53F3F';
export const DANGER_TINT = '#FFECE8';
export const WARNING = '#FFB400';
export const WARNING_TINT = '#FFF7E8';
export const INFO = '#165DFF';
export const INFO_TINT = '#E8F3FF';

/** 十六进制 -> [r,g,b]（供 canvas fill/stroke 使用）。 */
export function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
