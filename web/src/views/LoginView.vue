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

        <el-alert
          v-if="dtStatus === 'logging'"
          class="lf-alert"
          title="正在通过钉钉自动登录…"
          type="info"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="dtStatus === 'unbound'"
          class="lf-alert"
          :title="dtMessage"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="dtStatus === 'failed'"
          class="lf-alert"
          :title="dtMessage"
          type="warning"
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

          <!-- 钉钉内置浏览器（聊天链接进入）也必须保留这个入口：
               那里没有工作台微应用上下文，JSAPI 免登会报「没有该域名微应用」，
               唯一可用的是走 login.dingtalk.com 的 OAuth2 授权。 -->
          <el-button
            v-if="dtEnabled"
            size="large"
            class="lf-btn"
            :icon="ChatDotRound"
            @click="openDingtalkOauth"
          >{{ inDingtalk ? '使用钉钉登录' : '使用钉钉扫码登录' }}</el-button>
        </el-form>

        <p class="lf-hint">
          登录即代表您同意相关使用规范；如忘记密码或无法登录，请联系系统管理员。
        </p>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { User, Lock, ArrowLeft, List, DataLine, ChatDotRound } from '@element-plus/icons-vue';
import { useAuthStore } from '../stores/auth.js';
import { dingtalkConfig, dingtalkJsapi, dingtalkBind } from '../api/auth.js';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const remember = ref(false);
const loading = ref(false);
const error = ref('');

// 钉钉登录相关状态
const dtEnabled = ref(false);
const dtCorpId = ref('');
const dtAuthorizeUrl = ref('');
const inDingtalk = ref(false);
const dtLoading = ref(false);
const dtStatus = ref(''); // idle | logging | unbound | failed
const dtMessage = ref('');

const canGoBack = computed(() => window.history.length > 1);
function goBack() { if (window.history.length > 1) router.back(); }

function redirectTarget() {
  return typeof route.query.redirect === 'string' && route.query.redirect
    ? route.query.redirect
    : '/';
}

async function submit() {
  error.value = '';
  if (!username.value || !password.value) { error.value = '请输入用户名和密码'; return; }
  loading.value = true;
  try {
    await auth.signin(username.value, password.value, remember.value);
    // 从钉钉内首次进入且未绑定：账密登录成功后自动把本账号绑定到该钉钉 ID，
    // 之后再次进入即可 JSAPI 免登（无需管理员介入）。
    if (route.query.dingtalk === 'needbind' && typeof route.query.unionid === 'string') {
      try { await dingtalkBind(undefined, route.query.unionid); } catch (e) { /* 绑定失败不影响登录 */ }
    }
    router.replace(redirectTarget());
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}

// ---------------- 钉钉登录 ----------------
function isInDingtalk() {
  if (typeof navigator !== 'undefined' && /DingTalk/i.test(navigator.userAgent)) return true;
  return typeof window !== 'undefined' && !!window.dd;
}

function ensureDingtalkJsApi() {
  return new Promise((resolve, reject) => {
    if (window.dd) return resolve();
    const s = document.createElement('script');
    s.src = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('钉钉 JSAPI 脚本加载失败'));
    document.head.appendChild(s);
  });
}

/** 从钉钉返回结果里取出免登码（兼容 {code} / {authCode} / 直接返回字符串三种形态）。 */
function pickAuthCode(r) {
  const v = typeof r === 'string' ? r : (r?.code ?? r?.authCode ?? '');
  return v ? String(v) : '';
}

// 取免登授权码：优先新版 promise 风格 dd.getAuthCode，回退到经典回调风格
function getAuthCode(corpId) {
  return new Promise((resolve, reject) => {
    const dd = window.dd;
    if (!dd) return reject(new Error('钉钉 JSAPI 未就绪'));
    // 把任意拒绝值（钉钉 SDK 常拒绝为 {errCode,errMsg} 对象而非 Error）统一转成可读字符串
    const fail = (e) =>
      reject(
        new Error(
          e?.errMsg || e?.errorMessage || e?.message ||
            (typeof e === 'string' ? e : JSON.stringify(e)) || '获取免登码失败',
        ),
      );
    if (typeof dd.getAuthCode === 'function') {
      const p = dd.getAuthCode({ corpId });
      if (p && typeof p.then === 'function') {
        // 不同版本 SDK 返回的字段名可能是 code / authCode，这里都兼容，避免取到空串
        p.then(pickAuthCode).catch(fail);
        return;
      }
    }
    dd.runtime?.permission?.requestAuthCode({
      corpId,
      onSuccess: pickAuthCode,
      onFail: fail,
    });
  });
}

async function autoDingtalkLogin() {
  if (!dtCorpId.value) return;
  dtLoading.value = true;
  dtStatus.value = 'logging';
  dtMessage.value = '正在通过钉钉自动登录…';
  try {
    await ensureDingtalkJsApi();
    const authCode = await getAuthCode(dtCorpId.value);
    const data = await dingtalkJsapi(authCode);
    if (data && data.ok && data.token) {
      const ok = await auth.applyDingtalkSession(data.token);
      if (ok) {
        router.replace(redirectTarget());
        return;
      }
    } else if (data && data.needBind) {
      dtStatus.value = 'unbound';
      dtMessage.value =
        `您的钉钉账号（ID: ${data.unionid}）尚未绑定本系统账号。` +
        `请用工号密码登录后，由管理员在「账号管理」中绑定该钉钉 ID，之后即可免登。`;
      dtLoading.value = false;
      return;
    }
    dtStatus.value = 'failed';
    dtMessage.value = '钉钉自动登录未成功：' + errText(data && data.error) + '（可用账号密码登录）';
    dtLoading.value = false;
  } catch (e) {
    dtStatus.value = 'failed';
    // eslint-disable-next-line no-console
    console.error('[钉钉免登失败]', e);
    dtMessage.value =
      '钉钉自动登录失败：' + errText(e) + '（可用账号密码登录' +
      (dtAuthorizeUrl.value ? '，或点击下方「使用钉钉登录」走授权登录' : '') + '）';
    dtLoading.value = false;
  }
}

/** 把错误信息统一转成可读字符串（兼容 Error / 普通对象 / 字符串）。 */
function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

onMounted(async () => {
  // OAuth 回跳后未绑定 → 后端会重定向到 /login?dingtalk=needbind&unionid=…。
  // 此前这里既不提示也不引导，用户看到的只是「点完登录没反应」，因此补一条明确说明：
  // 账密登录成功会自动把当前钉钉身份绑定到本账号，下次即可免登。
  if (route.query.dingtalk === 'needbind' && typeof route.query.unionid === 'string') {
    dtStatus.value = 'unbound';
    dtMessage.value =
      '钉钉已认证成功，但该钉钉身份尚未绑定本系统账号。请用工号密码登录 —— 登录成功后会自动完成绑定，之后即可直接免登。';
  }
  try {
    const cfg = await dingtalkConfig();
    if (cfg && cfg.enabled) {
      dtEnabled.value = true;
      dtCorpId.value = cfg.corpId || '';
      dtAuthorizeUrl.value = cfg.authorizeUrl || '';
      inDingtalk.value = isInDingtalk();
      if (inDingtalk.value) autoDingtalkLogin();
    }
  } catch (e) {
    /* 钉钉配置探测失败不影响账密登录 */
  }
});

function openDingtalkOauth() {
  if (dtAuthorizeUrl.value) window.location.href = dtAuthorizeUrl.value;
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
  font-size: var(--el-font-size-extra-small);
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
.lb-tag { margin: 0 0 var(--sp-32); font-size: var(--el-font-size-base); opacity: 0.92; }
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
  font-size: var(--el-font-size-base);
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
