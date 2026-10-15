import { computed, onMounted, onUnmounted, ref } from 'vue';

// 响应式断点（沿用 Element Plus：xs<768, sm≥768, md≥992, lg≥1200, xl≥1920）。
// 提供 isMobile / isTablet / isDesktop / isCompact（≤992，侧栏收起为抽屉的阈值）。
// 仅依赖 window.innerWidth，轻量、无副作用。
export function useBreakpoint() {
  const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1280);
  const update = () => { width.value = window.innerWidth; };

  onMounted(() => window.addEventListener('resize', update, { passive: true }));
  onUnmounted(() => window.removeEventListener('resize', update));

  const isMobile = computed(() => width.value <= 767);
  const isTablet = computed(() => width.value >= 768 && width.value <= 991);
  const isDesktop = computed(() => width.value >= 992);
  // 侧栏从「内嵌可折叠」切换为「抽屉覆盖」的阈值：≤992 视为紧凑布局
  const isCompact = computed(() => width.value <= 992);

  return { width, isMobile, isTablet, isDesktop, isCompact };
}
