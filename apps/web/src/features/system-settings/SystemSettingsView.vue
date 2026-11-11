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
      <RouterLink to="/settings/aeolus" class="card">
        <div>
          <div class="card-t">风神设置</div>
          <div class="card-d">风神（Aeolus）登录账号与密码，由「风神设置」页写入后端 credentials.json（无需在 .env 中存储）</div>
        </div>
        <el-icon class="card-arw"><ArrowRight /></el-icon>
      </RouterLink>
      <RouterLink to="/settings/minio" class="card">
        <div>
          <div class="card-t">MinIO 设置</div>
          <div class="card-d">MinIO 图床连接配置（endpoint / bucket / 密钥），保存后热生效，支持连通性验证</div>
        </div>
        <el-icon class="card-arw"><ArrowRight /></el-icon>
      </RouterLink>
      <RouterLink to="/settings/rbac" class="card">
        <div>
          <div class="card-t">权限管理</div>
          <div class="card-d">账号、角色、密码策略与个人改密（账号管理 / 角色管理 / 密码策略 / 个人改密）</div>
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
.muted { color: var(--el-text-color-secondary); }
.cards { display: flex; flex-direction: column; gap: var(--sp-12); margin-top: var(--sp-12); }
.card {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-12);
  max-width: 420px;
  padding: var(--sp-16); border: 1px solid #ebeef5; border-radius: 8px;
  text-decoration: none; color: var(--el-text-color-primary);
  transition: border-color .15s, box-shadow .15s;
}
.card:hover { border-color: var(--el-color-primary); box-shadow: 0 2px 12px rgba(0,0,0,.06); }
.card-t { font-weight: var(--fw-semibold); font-size: var(--el-font-size-medium); }
.card-d { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); margin-top: 4px; }
.card-arw { font-size: 18px; color: var(--el-text-color-secondary); }
</style>
