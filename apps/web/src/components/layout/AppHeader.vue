<template>
  <div class="hd">
    <button v-if="showMenuBtn" class="hd-menu" @click="$emit('toggle-nav')" title="折叠 / 展开侧栏">
      <el-icon><Menu /></el-icon>
    </button>
    <div class="hd-brand">
      <span class="hd-logo">A</span>
      <span class="hd-title">Aeolus WorkBench</span>
    </div>
    <span class="hd-spacer"></span>

    <StatusCapsule label="服务" :dot="connDot" :text="connText" :title="connTitle" />
    <StatusCapsule label="Cookie" :dot="cookieDot" :text="cookieText" :title="cookieTitle" />
    <StatusCapsule label="Quark" :dot="quarkDot" :text="quarkText" :title="quarkTitle" />
    <UserChip />
  </div>
</template>

<script setup>
import { computed, defineEmits } from 'vue';
import StatusCapsule from '../common/StatusCapsule.vue';
import UserChip from '../common/UserChip.vue';
import { useAppStore } from '../../stores/app.js';
import { useBreakpoint } from '../../composables/useBreakpoint.js';

defineEmits(['toggle-nav']);

const app = useAppStore();
const { isCompact } = useBreakpoint();
// 顶栏汉堡按钮仅在紧凑布局（抽屉模式）时显示；桌面端折叠后侧栏保留图标栏、
// 折叠按钮位于侧栏底部，无需顶栏按钮兜底。
const showMenuBtn = computed(() => isCompact.value);

// 配色（见 store getters）：后端 + Python 全绿=绿点，都挂=红点，任一挂=黄点（部分可用）；
// tooltip 逐项列出后端 / Python / Worker，worker 不参与配色。
const connDot = computed(() => app.connDot);
const connText = computed(() => app.connText);
const connTitle = computed(() => app.connTitle);

const cookie = computed(() => app.cookie);
const cookieDot = computed(() => {
  const c = cookie.value; if (!c) return 'muted';
  if (c.status === 'valid') return 'ok';
  if (c.status === 'invalid') return 'err';
  return 'muted';
});
const cookieText = computed(() => {
  const c = cookie.value; if (!c) return '待校验';
  if (c.status === 'valid') return '有效';
  if (c.status === 'invalid') return '已失效';
  return c._net ? '校验异常' : '未知';
});
const cookieTitle = computed(() => {
  const c = cookie.value; if (!c) return '尚未发起校验';
  return (c.reason || '') + (c.checked_at ? '（最近校验：' + c.checked_at + '）' : '');
});

const quark = computed(() => app.quark);
const quarkDot = computed(() => {
  const q = quark.value; if (!q) return 'muted';
  if (q.status === 'valid') return 'ok';
  return 'muted';
});
const quarkText = computed(() => {
  const q = quark.value; if (!q) return '待校验';
  if (q.status === 'valid') return '有效';
  if (q.status === 'invalid') return '已失效';
  if (q.status === 'nocache') return '未兑换';
  return '未知';
});
const quarkTitle = computed(() => {
  const q = quark.value; if (!q) return '尚未兑换 Quark DA cookie';
  return (q.reason || '') + (q.checked_at ? '（最近校验：' + q.checked_at + '）' : '');
});
</script>

<style scoped>
.hd {
  display: flex;
  align-items: center;
  gap: var(--sp-12);
  height: 100%;
  padding: 0 var(--sp-16);
}
.hd-menu {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px; height: 36px;
  border: none; border-radius: var(--el-border-radius-base);
  background: transparent; color: var(--el-text-color-primary);
  cursor: pointer;
}
.hd-menu:hover { background: var(--el-fill-color-light); }
.hd-brand { display: flex; align-items: center; gap: var(--sp-8); }
.hd-logo { font-size: 20px; }
.hd-title { font-weight: var(--fw-bold); font-size: var(--el-font-size-medium); }
.hd-spacer { flex: 1; }
</style>
