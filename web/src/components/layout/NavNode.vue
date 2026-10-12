<template>
  <template v-if="node.type === 'leaf'">
    <RouterLink :to="navTo(node)" class="nv" :class="{ on: navIsActive(node) }" :style="indent" @click.stop>
      <el-icon class="ic"><component :is="node.icon" /></el-icon>
      <span class="nm">{{ node.name }}</span>
      <span v-if="node.count != null" class="ct">{{ node.count }}</span>
      <span v-if="navBusy(node)" class="nv-dot nv-dot--busy"></span>
    </RouterLink>
  </template>

  <template v-else>
    <div class="nv nv-parent" :class="{ open: isOpen, 'parent-on': navParentOn(node) }" :style="indent" @click="toggle">
      <el-icon class="ic"><component :is="node.icon" /></el-icon>
      <span class="nm">{{ node.name }}</span>
      <span v-if="node.count != null" class="ct">{{ node.count }}</span>
      <el-icon class="nv-arw"><ArrowRight /></el-icon>
    </div>
    <div class="nv-subs-wrap" :class="{ open: isOpen }">
      <div class="nv-subs">
        <NavNode
          v-for="c in node.children"
          :key="childKey(c)"
          :node="c"
          :depth="depth + 1"
          :siblings="childKeys"
        />
      </div>
    </div>
  </template>
</template>

<script setup>
import { computed } from 'vue';
import { useAppStore } from '../../stores/app.js';
import NavNode from './NavNode.vue';
import { navTo, navIsActive, navBusy, navParentOn } from '../../utils/nav.js';

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  siblings: { type: Array, default: () => [] },
});

const app = useAppStore();
const isOpen = computed(() => app.navOpen[props.node.key] === true);
// 顶层不缩进；每深一层右移 16px（第 1 层 32px，与旧 .nv-sub 对齐）
const indent = computed(() =>
  props.depth === 0 ? null : { paddingLeft: 32 + (props.depth - 1) * 16 + 'px' },
);
const childKeys = computed(() => (props.node.children || []).map((c) => c.key));
function childKey(c) {
  return c.key || c.kind + (c.id || '');
}

// 手风琴：展开本节点时，收起同级其它父节点（互斥）；只做展开/收起，不跳转
function toggle() {
  const willOpen = !isOpen.value;
  props.siblings.forEach((k) => {
    if (k !== props.node.key) app.setNavOpen(k, false);
  });
  app.setNavOpen(props.node.key, willOpen);
}
</script>

<style scoped>
.nv {
  display: flex; align-items: center; gap: var(--sp-10);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--r-xl);
  color: var(--text-body); cursor: pointer;
  text-decoration: none; font-size: var(--el-font-size-base);
  position: relative;
  transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
}
/* 悬停/选中时滑入的左侧品牌色竖条 */
.nv::before {
  content: '';
  position: absolute; left: 3px; top: 50%;
  width: 3px; height: 18px;
  background: var(--brand); border-radius: var(--r-pill);
  transform: translateY(-50%) scaleY(0); opacity: 0;
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.nv:hover {
  background: color-mix(in srgb, var(--brand) 8%, transparent);
  color: var(--text);
  transform: translateX(2px);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.08);
}
.nv:hover::before, .nv.on::before {
  transform: translateY(-50%) scaleY(1); opacity: 1;
}
.nv.on { background: var(--brand-soft); color: var(--brand); font-weight: var(--fw-semibibold); }
.nv .ic { font-size: 17px; }
.nv .nm { flex: 1; }
.nv .ct {
  font-size: 11px; color: var(--muted); background: var(--surface-sunken);
  padding: 1px var(--sp-8); border-radius: var(--r-pill); min-width: 20px; text-align: center;
}
.nv-parent .nv-arw { transition: transform 0.18s ease; color: var(--muted); }
.nv-parent.open .nv-arw { transform: rotate(90deg); }
/* 仅「含当前选中子项」的父菜单加粗 */
.nv-parent.parent-on { color: var(--brand); font-weight: var(--fw-semibold); }
/* 手风琴折叠动画：grid-template-rows 0fr→1fr，无需知道子项数量 */
.nv-subs-wrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.22s ease; }
.nv-subs-wrap.open { grid-template-rows: 1fr; }
.nv-subs { overflow: hidden; min-height: 0; display: flex; flex-direction: column; gap: 2px; margin: 0; }
.nv-subs-wrap.open .nv-subs { margin: 2px 0 var(--sp-4); }
.nv-dot--busy {
  position: absolute; right: var(--sp-10); top: 50%; transform: translateY(-50%);
  width: 7px; height: 7px; border-radius: 50%; background: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-soft);
}
</style>
