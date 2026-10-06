<template>
  <div class="login-page">
    <!-- 返回入口 -->
    <button v-if="canGoBack" class="login-back" type="button" @click="goBack">
      <el-icon><ArrowLeft /></el-icon> 返回
    </button>

    <div class="login-card">
      <!-- 左侧品牌区 -->
      <aside class="login-brand">
        <div class="lb-logo">🐂</div>
        <h1 class="lb-title">摸🐟岛 · 工作台</h1>
        <p class="lb-tag">一站式任务编排与数据看板</p>
        <ul class="lb-feats">
          <li><el-icon><List /></el-icon> 任务编排与运行记录</li>
          <li><el-icon><DataLine /></el-icon> 实时数据看板</li>
          <li><el-icon><ChatDotRound /></el-icon> 机器人接入与配置</li>
        </ul>
        <p class="lb-foot">登录即进入受保护的工作区</p>
      </aside>

      <!-- 右侧表单区 -->
      <section class="login-form">
        <h2 class="lf-title">登录工作台</h2>
        <p class="lf-sub">使用工作台账号登录以继续</p>

        <el-alert
          v-if="error"
          class="lf-alert"
          :title="error"
          type="error"
          :closable="false"
          show-icon
        />

        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="用户名">
            <el-input
              v-model="username"
              size="large"
              placeholder="请输入用户名"
              :prefix-icon="User"
              autofocus
              :disabled="loading"
            />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="password"
              size="large"
              type="password"
              show-password
              placeholder="请输入密码"
              :prefix-icon="Lock"
              :disabled="loading"
              @keyup.enter="submit"
            />
          </el-form-item>
          <div class="lf-remember">
            <el-checkbox v-model="remember">记住我（7 天内免登录）</el-checkbox>
          </div>
          <el-button
            type="primary"
            size="large"
            class="lf-btn"
            :loading="loading"
            @click="submit"
          >登录</el-button>
        </el-form>

        <p class="lf-hint">
          登录即代表您同意相关使用规范；如忘记密码或无法登录，请联系系统管理员。
        </p>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { User, Lock, ArrowLeft, List, DataLine, ChatDotRound } from '@element-plus/icons-vue';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const remember = ref(false);
const loading = ref(false);
const error = ref('');

const canGoBack = computed(() => window.history.length > 1);
function goBack() { if (window.history.length > 1) router.back(); }

async function submit() {
  error.value = '';
  if (!username.value || !password.value) { error.value = '请输入用户名和密码'; return; }
  loading.value = true;
  try {
    await auth.signin(username.value, password.value, remember.value);
    const redirect =
      typeof route.query.redirect === 'string' && route.query.redirect
        ? route.query.redirect
        : '/';
    router.replace(redirect);
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-24);
  background: linear-gradient(135deg, #eef2ff 0%, #f7f9fc 100%);
}
.login-back {
  position: absolute;
  top: var(--sp-20);
  left: var(--sp-20);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  padding: var(--sp-8) var(--sp-14);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--white);
  color: var(--text);
  font-size: var(--fs-caption);
  cursor: pointer;
}
.login-back:hover { background: var(--surface-sunken); }

.login-card {
  width: min(880px, 100%);
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: var(--white);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  overflow: hidden;
  box-shadow: 0 18px 50px rgba(20, 30, 60, 0.12);
}
.login-brand {
  padding: var(--sp-40);
  color: var(--white);
  background: linear-gradient(150deg, var(--brand) 0%, #4f6bff 100%);
  display: flex;
  flex-direction: column;
}
.lb-logo { font-size: 44px; line-height: 1; }
.lb-title { margin: var(--sp-16) 0 var(--sp-8); font-size: 22px; font-weight: var(--fw-bold); }
.lb-tag { margin: 0 0 var(--sp-32); font-size: var(--fs-body); opacity: 0.92; }
.lb-feats {
  list-style: none;
  margin: auto 0 var(--sp-24);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-14);
}
.lb-feats li {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  font-size: var(--fs-body);
}
.lb-foot { margin: 0; font-size: 12px; opacity: 0.8; }

.login-form {
  padding: var(--sp-40);
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.lf-title { margin: 0; font-size: 22px; font-weight: var(--fw-bold); }
.lf-sub { margin: var(--sp-8) 0 var(--sp-24); color: var(--muted); }
.lf-alert { margin-bottom: var(--sp-16); }
.lf-btn { width: 100%; margin-top: var(--sp-8); }
.lf-remember { margin: 0 0 var(--sp-4); }
.lf-hint { margin: var(--sp-20) 0 0; font-size: 12px; line-height: 1.6; color: var(--muted); }

@media (max-width: 720px) {
  .login-card { grid-template-columns: 1fr; }
  .login-brand { display: none; }
}
</style>
