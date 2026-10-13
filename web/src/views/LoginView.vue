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

          <!-- 仅在非钉钉环境（普通浏览器）显示：钉钉容器内统一走 JSAPI 免登，
               不再额外给出 OAuth2 授权入口（扫码登录按钮对手机端无意义）。 -->
          <el-button
            v-if="dtEnabled && !inDingtalk"
            size="large"
            class="lf-btn"
            :icon="ChatDotRound"
            @click="openDingtalkOauth"
          >使用钉钉扫码登录</el-button>
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
/** 免登返回「未绑定」时记住的钉钉身份，待账密登录成功后自动绑定。 */
const pendingUnionid = ref('');

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
    // 登录成功后，若有「待绑定的钉钉身份」则自动绑定当前账号：
    //   · 钉钉内免登未绑定（pendingUnionid）
    //   · 浏览器 OAuth 回跳未绑定（URL 上带 dingtalk=needbind&unionid=…）
    // 绑定后下次打开即可直接免登；失败不影响本次登录。
    const uid =
      pendingUnionid.value ||
      (route.query.dingtalk === 'needbind' && typeof route.query.unionid === 'string'
        ? route.query.unionid
        : '');
    if (uid) {
      try {
        await dingtalkBind(undefined, uid);
      } catch (e) {
        // 绑定失败不影响本次登录（下次仍会提示绑定，也可由管理员在账号管理中处理）
        // eslint-disable-next-line no-console
        console.warn('[钉钉绑定失败]', e);
      }
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
    // 脚本既不 onload 也不 onerror 时（网络被静默拦截等）不能无限等，否则界面永远卡住
    const timer = setTimeout(() => reject(new Error('钉钉 JSAPI 脚本加载超时')), 10000);
    s.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('钉钉 JSAPI 脚本加载失败'));
    };
    document.head.appendChild(s);
  });
}

/** 从钉钉返回结果里取出免登码（兼容 {code} / {authCode} / 直接返回字符串三种形态）。 */
function pickAuthCode(r) {
  const v = typeof r === 'string' ? r : (r?.code ?? r?.authCode ?? '');
  return v ? String(v) : '';
}

// 取免登授权码：优先新版 promise 风格 dd.getAuthCode，回退到经典回调风格。
//
// 必须自带超时 + 能力检测：某些环境下 SDK 既不 resolve 也不 reject，或根本没有可用的
// 免登 API（可选链会让调用静默变成 no-op），Promise 永不落定 → 页面一直卡在
// 「正在通过钉钉自动登录……」。这两种情况都要变成明确失败，好让页面露出备用入口。
function getAuthCode(corpId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const dd = window.dd;
    if (!dd) return reject(new Error('钉钉 JSAPI 未就绪'));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('获取免登码超时（钉钉 JSAPI 无响应）'));
    }, timeoutMs);

    // 把任意拒绝值（钉钉 SDK 常拒绝为 {errCode,errMsg} 对象而非 Error）统一转成可读字符串
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          e?.errMsg || e?.errorMessage || e?.message ||
            (typeof e === 'string' ? e : JSON.stringify(e)) || '获取免登码失败',
        ),
      );
    };
    // 成功也做收敛：拿到空码视同失败，别把空串发到后端
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = pickAuthCode(r);
      if (code) resolve(code);
      else fail({ errMsg: '钉钉返回的免登码为空' });
    };

    const hasNew = typeof dd.getAuthCode === 'function';
    const hasOld = !!dd.runtime?.permission?.requestAuthCode;
    if (!hasNew && !hasOld) {
      settled = true;
      clearTimeout(timer);
      return reject(new Error('当前环境不支持钉钉免登（缺少 getAuthCode / requestAuthCode）'));
    }

    if (hasNew) {
      let p = null;
      try {
        p = dd.getAuthCode({ corpId });
      } catch (e) {
        return fail(e);
      }
      if (p && typeof p.then === 'function') {
        p.then(done).catch(fail);
        return;
      }
      // 非 promise 形态（老 SDK 可能直接返回 undefined）→ 继续尝试回调风格
    }

    if (hasOld) {
      dd.runtime.permission.requestAuthCode({ corpId, onSuccess: done, onFail: fail });
      return;
    }

    // 新版调用没产生 promise、又没有老接口 → 不能干等
    settled = true;
    clearTimeout(timer);
    reject(new Error('钉钉免登调用未返回结果'));
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
      // 记住这个钉钉身份：用户用已分配的账号登录后会自动完成绑定，之后即可免登。
      // 不再依赖管理员手工绑定，也不再自动开户（那样会造出 dt_<unionid> 这类无意义的账号）。
      pendingUnionid.value = data.unionid || '';
      dtMessage.value =
        '该钉钉身份尚未绑定本系统账号。请用你已分配的账号（工号）登录 —— ' +
        '登录成功后会自动绑定当前钉钉，下次打开即可直接免登。';
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
      (!inDingtalk.value && dtAuthorizeUrl.value ? '，或点击下方「使用钉钉扫码登录」' : '') + '）';
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
  // OAuth 回跳的三种结果都要落到界面上。此前只处理了 needbind，error / disabled 一律
  // 被忽略 —— 一旦换取身份或读通讯录失败，用户看到的就是「回到登录页、毫无反应」。
  const dt = route.query.dingtalk;
  if (dt === 'needbind' && typeof route.query.unionid === 'string') {
    dtStatus.value = 'unbound';
    dtMessage.value =
      '钉钉已认证成功，但该钉钉身份尚未绑定本系统账号。请用工号密码登录 —— 登录成功后会自动完成绑定，之后即可直接免登。';
  } else if (dt === 'error') {
    dtStatus.value = 'failed';
    const msg = typeof route.query.msg === 'string' ? route.query.msg : '';
    dtMessage.value = '钉钉登录失败：' + (msg || '未知原因') + '（可用账号密码登录）';
  } else if (dt === 'disabled') {
    dtStatus.value = 'failed';
    dtMessage.value = '钉钉登录未启用：请先在「钉钉设置」填写 AppKey / AppSecret 并开启开关。';
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
