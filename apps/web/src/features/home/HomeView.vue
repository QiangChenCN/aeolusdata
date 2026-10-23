<template>
  <div class="home">
    <section class="hero">
      <div class="hero-main">
        <div class="hero-logo">🐂</div>
        <div>
          <h1>风神工作台</h1>
          <p class="hero-sub">风神数据自动化中枢 —— 任务编排、运行监控与产物预览，一站直达。</p>
        </div>
      </div>
      <div class="hero-stats">
        <div class="stat">
          <span class="stat-num">{{ tasks.tasks.length }}</span>
          <span class="stat-label">任务总数</span>
        </div>
        <div class="stat">
          <span class="stat-num stat--run">{{ runningCount }}</span>
          <span class="stat-label">执行中</span>
        </div>
        <div class="stat">
          <span class="stat-num">{{ tasks.groups.length }}</span>
          <span class="stat-label">业务分组</span>
        </div>
      </div>
    </section>

    <section class="cards">
      <el-card class="quick" shadow="hover" @click="go('/tasks')">
        <el-icon class="quick-ic"><Grid /></el-icon>
        <div><b>任务中心</b><p>查看与运行全部任务</p></div>
      </el-card>
      <el-card class="quick" shadow="hover" @click="go('/history')">
        <el-icon class="quick-ic"><Clock /></el-icon>
        <div><b>运行记录</b><p>回看历史运行与日志</p></div>
      </el-card>
      <el-card class="quick" shadow="hover" @click="go('/standard')">
        <el-icon class="quick-ic"><DataLine /></el-icon>
        <div><b>数据看板</b><p>标准达成 / 时段出勤</p></div>
      </el-card>
    </section>

    <section class="two">
      <el-card class="panel" shadow="never">
        <template #header><span class="panel-h">最近运行</span></template>
        <div v-if="!recentRuns.length" class="empty">暂无运行记录</div>
        <ul v-else class="runs">
          <li v-for="h in recentRuns" :key="h.run_id" class="run-row" @click="openRun(h)">
            <el-tag size="small" :type="statusTag(h.status)">{{ STATUS_TXT[h.status] || h.status }}</el-tag>
            <span class="run-name">{{ h.name }}</span>
            <span class="run-meta">{{ h.start }} · {{ h.duration }}s</span>
            <el-icon class="run-go"><ArrowRight /></el-icon>
          </li>
        </ul>
      </el-card>

      <el-card class="panel" shadow="never">
        <template #header><span class="panel-h">服务状态</span></template>
        <div class="svc">
          <div class="svc-row"><span>后端连接</span><StatusCapsule :dot="connDot" :text="connText" :title="connTitle" /></div>
          <div class="svc-row"><span>风神 Cookie</span><StatusCapsule :dot="cookieDot" :text="cookieText" /></div>
          <div class="svc-row"><span>Quark DA</span><StatusCapsule :dot="quarkDot" :text="quarkText" /></div>
        </div>
      </el-card>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import StatusCapsule from '../../components/common/StatusCapsule.vue';
import { useTasksStore } from '../../stores/tasks.js';
import { useRunsStore } from '../../stores/runs.js';
import { useAppStore } from '../../stores/app.js';
import { STATUS_TXT } from '../../utils/tokens.js';

const router = useRouter();
const tasks = useTasksStore();
const runs = useRunsStore();
const app = useAppStore();

const runningCount = computed(
  () => (tasks.tasks || []).filter((t) => t.status === 'running').length,
);
const recentRuns = computed(() => (runs.history || []).slice(0, 8));

function go(p) { router.push(p); }
function openRun(h) { runs.openLog(h.run_id); }

function statusTag(s) {
  return s === 'success' ? 'success' : s === 'failed' ? 'danger'
    : s === 'running' ? 'warning' : s === 'stopped' ? 'info' : s === 'queued' ? 'warning' : 'info';
}

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
const quark = computed(() => app.quark);
const quarkDot = computed(() => {
  const q = quark.value; if (!q) return 'muted';
  return q.status === 'valid' ? 'ok' : 'muted';
});
const quarkText = computed(() => {
  const q = quark.value; if (!q) return '待校验';
  if (q.status === 'valid') return '有效';
  if (q.status === 'invalid') return '已失效';
  if (q.status === 'nocache') return '未兑换';
  return '未知';
});
</script>

<style scoped>
/* 整页 flex 列布局，占满 app-main 内容区：水平铺满、垂直撑满、无多余留白/滚动条 */
.home {
  height: 100%; box-sizing: border-box;
  padding: var(--sp-20);
  display: flex; flex-direction: column; gap: var(--sp-16);
  overflow: hidden;
}
.hero {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-20);
  background: linear-gradient(120deg, var(--el-color-primary-light-9), var(--el-bg-color));
  border: 1px solid var(--el-border-color-lighter); border-radius: var(--r-modal);
  padding: var(--sp-24); flex-wrap: wrap; flex: none;
}
.hero-main { display: flex; align-items: center; gap: var(--sp-16); }
.hero-logo { font-size: 44px; }
.hero h1 { margin: 0; font-size: clamp(28px, 2vw + 20px, 36px); line-height: var(--lh-tight); }
.hero-sub { margin: var(--sp-6) 0 0; color: var(--el-text-color-secondary); font-size: var(--el-font-size-base); }
.hero-stats { display: flex; gap: var(--sp-12); }
.stat {
  display: flex; flex-direction: column; align-items: center;
  min-width: 84px; padding: var(--sp-12) var(--sp-16);
  background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base);
}
.stat-num { font-size: 26px; font-weight: var(--fw-bold); color: var(--el-text-color-primary); }
.stat-num.stat--run { color: var(--el-color-primary); }
.stat-label { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); margin-top: 2px; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--sp-12); flex: none; }
.quick { cursor: pointer; display: flex; align-items: center; gap: var(--sp-12); }
.quick-ic { font-size: 26px; color: var(--el-color-primary); }
.quick b { font-size: var(--el-font-size-medium); }
.quick p { margin: 2px 0 0; color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); }

/* 两块面板占满剩余垂直空间；面板内部滚动，避免撑出整页滚动条 */
.two { display: grid; grid-template-columns: 1.4fr 1fr; gap: var(--sp-12); flex: 1; min-height: 0; }
.panel { display: flex; flex-direction: column; min-height: 0; }
.panel :deep(.el-card__body) { flex: 1; min-height: 0; overflow: auto; }
.panel-h { font-weight: var(--fw-semibold); }
.empty { padding: var(--sp-40); text-align: center; color: var(--el-text-color-secondary); }
.runs { list-style: none; margin: 0; padding: 0; }
.run-row {
  display: flex; align-items: center; gap: var(--sp-10);
  padding: var(--sp-10) var(--sp-6); border-radius: var(--el-border-radius-base); cursor: pointer;
}
.run-row:hover { background: var(--el-fill-color-light); }
.run-name { flex: 1; font-weight: var(--fw-semibold); }
.run-meta { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); }
.run-go { color: var(--el-text-color-secondary); }
.svc { display: flex; flex-direction: column; gap: var(--sp-12); }
.svc-row { display: flex; align-items: center; justify-content: space-between; }

/* 响应式：窄屏堆叠两栏、收紧内边距，保持铺满不溢出 */
@media (max-width: 768px) {
  .home { padding: var(--sp-12); gap: var(--sp-12); }
  .hero { padding: var(--sp-16); }
  .two { grid-template-columns: 1fr; }
}
@media (max-width: 480px) {
  .home { padding: var(--sp-8); }
  .hero-stats { width: 100%; justify-content: space-between; }
  .stat { flex: 1; min-width: 0; }
}
</style>
