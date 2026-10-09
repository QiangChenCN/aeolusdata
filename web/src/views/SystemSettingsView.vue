<template>
  <div class="sys">
    <h2 class="v-title">系统设置</h2>
    <p class="muted">系统级集成与外部服务配置。以下为当前已接入的设置模块：</p>
    <div class="cards">
      <RouterLink to="/settings/dingtalk" class="card">
        <div>
          <div class="card-t">钉钉设置</div>
          <div class="card-d">钉钉授权与 dws CLI 配置项（共 32 项，分 8 类）</div>
        </div>
        <el-icon class="card-arw"><ArrowRight /></el-icon>
      </RouterLink>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.sys { padding: var(--sp-20); max-width: 980px; }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.muted { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--sp-12); margin-top: var(--sp-12); }
.card {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-12);
  padding: var(--sp-16); border: 1px solid #ebeef5; border-radius: 8px;
  text-decoration: none; color: var(--text);
  transition: border-color .15s, box-shadow .15s;
}
.card:hover { border-color: var(--brand); box-shadow: 0 2px 12px rgba(0,0,0,.06); }
.card-t { font-weight: var(--fw-semibold); font-size: var(--el-font-size-medium); }
.card-d { font-size: var(--el-font-size-extra-small); color: var(--muted); margin-top: 4px; }
.card-arw { font-size: 18px; color: var(--muted); }
</style>
