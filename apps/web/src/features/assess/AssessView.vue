<template>
  <div class="assess">
    <div class="assess-bar">
      <el-tabs
        v-model="activePath" type="card" class="assess-tabs"
        @tab-change="(p) => $router.push(String(p))"
      >
        <el-tab-pane label="服务质量设置" name="/assess/service" />
        <el-tab-pane label="标准达成设置" name="/assess/standard" />
        <el-tab-pane label="时段设置" name="/assess/period" />
        <el-tab-pane label="天气设置" name="/assess/weather" />
      </el-tabs>
    </div>
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const activePath = computed({
  get() {
    const p = route.path;
    if (p.startsWith('/assess/service')) return '/assess/service';
    if (p.startsWith('/assess/standard')) return '/assess/standard';
    if (p.startsWith('/assess/period')) return '/assess/period';
    if (p.startsWith('/assess/weather')) return '/assess/weather';
    return '/assess/service';
  },
  set(v) { /* 选中由 @tab-change 路由跳转驱动，v-model 仅承接回显 */ },
});
</script>

<style scoped>
.assess { display: flex; flex-direction: column; min-height: 100%; }
.assess-bar { padding: var(--sp-12) var(--sp-20) 0; background: var(--el-bg-color); }
/* card 型 tab：每个 tab 是卡片样式，头部下边框与内容区衔接 */
.assess-tabs { box-shadow: none; }
.assess-tabs :deep(.el-tabs__content) { display: none; }
.assess-tabs :deep(.el-tabs__item) { height: 40px; line-height: 40px; }
</style>
