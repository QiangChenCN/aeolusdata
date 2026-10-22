<template>
  <div class="pi">
    <!-- 通栏资料头 -->
    <section class="pi-hero">
      <div class="pi-hero-main">
        <div class="pi-avatar-wrap" title="点击修改头像" @click="openAvatarDlg">
          <el-avatar class="pi-avatar" :size="120" :src="auth.avatar || undefined">
            <template v-if="!auth.avatar">{{ initial }}</template>
          </el-avatar>
          <div class="pi-avatar-mask"><el-icon><Camera /></el-icon></div>
        </div>
        <div class="pi-hero-id">
          <div class="pi-name">
            {{ auth.name || auth.user || '未登录' }}
            <el-tag :type="auth.role === 'admin' ? 'danger' : 'info'" size="small" effect="dark" round>
              {{ roleLabel }}
            </el-tag>
          </div>
        </div>
      </div>
    </section>

    <!-- 双列内容 -->
    <div class="pi-grid">
      <section class="pi-sec">
        <div class="pi-sec-head">
          <span><el-icon class="pi-sec-ic"><Postcard /></el-icon>基本资料</span>
          <el-button v-if="!editing" size="small" text type="primary" @click="startEdit">编辑</el-button>
        </div>

        <template v-if="!editing">
          <el-descriptions :column="1" border class="pi-desc">
            <el-descriptions-item label="用户名">{{ auth.user || '-' }}</el-descriptions-item>
            <el-descriptions-item label="姓名">{{ auth.name || '未填写' }}</el-descriptions-item>
            <el-descriptions-item label="手机号">{{ auth.phone || '未填写' }}</el-descriptions-item>
            <el-descriptions-item label="邮箱">{{ auth.email || '未填写' }}</el-descriptions-item>
            <el-descriptions-item label="角色">{{ roleLabel }}</el-descriptions-item>
            <el-descriptions-item label="权限说明">{{ permText }}</el-descriptions-item>
          </el-descriptions>
        </template>
        <el-form v-else label-width="72px" class="pi-desc-form">
          <el-form-item label="用户名"><span class="pi-ro">{{ auth.user || '-' }}</span></el-form-item>
          <el-form-item label="姓名">
            <el-input v-model="profileForm.name" placeholder="请输入姓名" maxlength="20" />
          </el-form-item>
          <el-form-item label="手机号">
            <el-input v-model="profileForm.phone" placeholder="请输入手机号" maxlength="11" />
          </el-form-item>
          <el-form-item label="邮箱">
            <el-input v-model="profileForm.email" placeholder="请输入邮箱" maxlength="64" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="savingProfile" @click="saveProfile">保存</el-button>
            <el-button @click="editing = false">取消</el-button>
          </el-form-item>
        </el-form>
      </section>

      <section class="pi-sec">
        <div class="pi-sec-head"><span><el-icon class="pi-sec-ic"><Lock /></el-icon>账号安全</span></div>
        <div class="pi-sec-row">
          <div class="pi-sec-info">
            <div class="pi-sec-h">登录密码</div>
            <div class="pi-sec-d">定期修改密码，有助于保护账号安全</div>
          </div>
          <el-button type="primary" plain @click="goPw">修改密码</el-button>
        </div>
      </section>
    </div>

    <!-- 我的权限 -->
    <section class="pi-sec">
      <div class="pi-sec-head"><span><el-icon class="pi-sec-ic"><Stamp /></el-icon>我的权限</span></div>
      <ul class="pi-perm">
        <li v-for="c in caps" :key="c">
          <el-icon class="pi-perm-ok"><CircleCheck /></el-icon><span>{{ c }}</span>
        </li>
      </ul>
    </section>

    <!-- 修改头像弹窗 -->
    <el-dialog v-model="avatarDlg" title="修改头像" width="420px" align-center destroy-on-close>
      <div class="pi-av-box">
        <el-upload
          class="pi-uploader"
          accept="image/*"
          :auto-upload="false"
          :show-file-list="false"
          :on-change="onAvatarChange"
        >
          <el-avatar v-if="avatarPreview" :size="120" :src="avatarPreview" />
          <el-avatar v-else :size="120">{{ initial }}</el-avatar>
          <div class="pi-upload-tip">点击选择图片（建议正方形，≤5MB）</div>
        </el-upload>
      </div>
      <template #footer>
        <el-button @click="avatarDlg = false">取消</el-button>
        <el-button type="primary" :loading="savingAvatar" :disabled="!avatarPreview" @click="saveAvatar">保存</el-button>
      </template>
    </el-dialog>

    <!-- 修改密码弹窗 -->
    <el-dialog v-model="pwDlg" title="修改登录密码" width="420px" align-center>
      <el-form label-width="96px">
        <el-form-item label="旧密码"><el-input v-model="pwForm.old" type="password" show-password placeholder="请输入当前密码" /></el-form-item>
        <el-form-item label="新密码"><el-input v-model="pwForm.next" type="password" show-password placeholder="请输入新密码" /></el-form-item>
        <el-form-item label="确认新密码"><el-input v-model="pwForm.confirm" type="password" show-password placeholder="请再次输入新密码" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwDlg = false">取消</el-button>
        <el-button type="primary" :loading="savingPw" @click="savePw">提交修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, reactive } from 'vue';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../../stores/auth.js';
import { changePw } from '../../api/dashboards.js';

const auth = useAuthStore();
const roleLabel = computed(() => (auth.role === 'admin' ? '管理员' : '普通用户'));
const initial = computed(() => {
  const src = auth.name || auth.user || '';
  return src ? src.charAt(0).toUpperCase() : '?';
});
const permText = computed(() =>
  auth.role === 'admin' ? '拥有系统全部管理权限' : '可查看业务数据并管理个人账号',
);
const caps = computed(() =>
  auth.role === 'admin'
    ? [
        '查看全部业务数据看板（考核/超时/标准达成等）',
        '管理账号与角色（账号管理 / 角色管理 / 密码策略）',
        '配置系统设置（钉钉 / 风神 / 调度）',
        '制定与下发考核规则',
        '修改个人密码',
      ]
    : [
        '查看业务数据看板',
        '管理个人账号资料',
        '修改个人密码',
      ],
);
function goPw() { openPwDlg(); }

// ---------------- 编辑基本资料 ----------------
const editing = ref(false);
const savingProfile = ref(false);
const profileForm = reactive({ name: '', phone: '', email: '' });

function startEdit() {
  profileForm.name = auth.name || '';
  profileForm.phone = auth.phone || '';
  profileForm.email = auth.email || '';
  editing.value = true;
}

async function saveProfile() {
  const email = (profileForm.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ElMessage.warning('邮箱格式不正确');
    return;
  }
  const phone = (profileForm.phone || '').trim();
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
    ElMessage.warning('手机号格式不正确');
    return;
  }
  savingProfile.value = true;
  try {
    await auth.updateProfile({ name: profileForm.name, phone, email });
    ElMessage.success('资料已保存');
    editing.value = false;
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    savingProfile.value = false;
  }
}

// ---------------- 修改密码（弹窗） ----------------
const pwDlg = ref(false);
const savingPw = ref(false);
const pwForm = reactive({ old: '', next: '', confirm: '' });

function openPwDlg() {
  pwForm.old = ''; pwForm.next = ''; pwForm.confirm = '';
  pwDlg.value = true;
}

async function savePw() {
  if (pwForm.next !== pwForm.confirm) { ElMessage.warning('两次输入的新密码不一致'); return; }
  savingPw.value = true;
  try {
    await changePw({ old_password: pwForm.old, new_password: pwForm.next });
    ElMessage.success('密码已修改');
    pwDlg.value = false;
  } catch (e) {
    ElMessage.error(e.message || '修改失败');
  } finally {
    savingPw.value = false;
  }
}

// ---------------- 修改头像 ----------------
const avatarDlg = ref(false);
const avatarPreview = ref('');
const savingAvatar = ref(false);

function openAvatarDlg() {
  avatarPreview.value = auth.avatar || '';
  avatarDlg.value = true;
}

// 选图后客户端压缩到 256×256（cover 裁剪）再转 data URI，控制体积。
function onAvatarChange(file) {
  const raw = file && file.raw;
  if (!raw) return;
  if (!raw.type.startsWith('image/')) { ElMessage.error('请选择图片文件'); return; }
  if (raw.size > 5 * 1024 * 1024) { ElMessage.error('图片不能超过 5MB'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      avatarPreview.value = canvas.toDataURL('image/jpeg', 0.85);
    };
    img.onerror = () => ElMessage.error('图片解析失败');
    img.src = reader.result;
  };
  reader.onerror = () => ElMessage.error('读取文件失败');
  reader.readAsDataURL(raw);
}

async function saveAvatar() {
  if (!avatarPreview.value) return;
  savingAvatar.value = true;
  try {
    await auth.updateAvatar(avatarPreview.value);
    ElMessage.success('头像已更新');
    avatarDlg.value = false;
  } catch (e) {
    ElMessage.error(e.message || '更新失败');
  } finally {
    savingAvatar.value = false;
  }
}
</script>

<style scoped>
/* 与项目其它视图（.todo/.adm/.dv/.hist…）一致：根节点自带 20px 内边距，
   使卡片与视口边缘留出间隙，而不是贴边。box-sizing 由 base.css 的 * 规则统一为 border-box。 */
.pi { width: 100%; padding: var(--sp-20); }
.pi-hero {
  position: relative; border-radius: var(--el-border-radius-base);
  overflow: hidden; background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light);
}
.pi-hero-main { display: flex; align-items: center; gap: var(--sp-16); padding: var(--sp-24); }
.pi-avatar-wrap { position: relative; flex: 0 0 auto; width: 120px; height: 120px; border-radius: 50%; cursor: pointer; }
.pi-avatar-wrap .pi-avatar { display: inline-flex; }
.pi-avatar-mask {
  position: absolute; inset: 0; border-radius: 50%;
  background: rgba(0, 0, 0, 0.45); color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 28px;
  opacity: 0; transition: opacity 0.2s; pointer-events: none;
}
.pi-avatar-wrap:hover .pi-avatar-mask { opacity: 1; }
.pi-av-box { display: flex; justify-content: center; }
.pi-uploader { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.pi-uploader :deep(.el-upload) { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.pi-upload-tip { font-size: 12px; color: var(--el-text-color-secondary); }
.pi-avatar {
  flex: 0 0 auto;
  background: linear-gradient(135deg, var(--el-color-primary), #7c5cff);
  border: 3px solid var(--el-bg-color); box-shadow: var(--el-box-shadow-light);
  color: #fff;
  font-size: 60px;
  font-weight: var(--fw-bold);
  line-height: 1;
}
.pi-hero-id { flex: 1 1 auto; min-width: 0; padding-top: var(--sp-12); }
.pi-name { display: flex; align-items: center; gap: var(--sp-8); font-size: 22px; font-weight: var(--fw-semibold); color: var(--el-text-color-primary); }
.pi-act { flex: 0 0 auto; margin-top: var(--sp-12); }

.pi-grid { margin-top: var(--sp-16); display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-16); }
/* 网格之后的「我的权限」卡片：与上方卡片保持一致的间距 */
.pi-grid + .pi-sec { margin-top: var(--sp-16); }
.pi-sec { padding: var(--sp-20); border-radius: var(--el-border-radius-base); background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light); }
.pi-grid > .pi-sec:last-child:nth-child(odd) { grid-column: 1 / -1; }
.pi-sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-8); font-size: var(--el-font-size-medium); font-weight: var(--fw-semibold); color: var(--el-text-color-primary); margin-bottom: var(--sp-16); }
.pi-sec-head > span { display: inline-flex; align-items: center; gap: var(--sp-8); }
.pi-desc-form { max-width: 420px; }
.pi-ro { color: var(--el-text-color-regular); }
.pi-sec-ic { color: var(--el-color-primary); }
.pi-desc { max-width: 100%; }
.pi-sec-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-16); }
.pi-sec-h { font-size: var(--el-font-size-base); color: var(--el-text-color-primary); }
.pi-sec-d { margin-top: 4px; font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }

.pi-perm { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-12) var(--sp-24); }
.pi-perm li { display: flex; align-items: center; gap: var(--sp-8); font-size: var(--el-font-size-base); color: var(--el-text-color-regular); }
.pi-perm-ok { color: var(--el-color-success); font-size: 18px; }

@media (max-width: 860px) {
  .pi { padding: var(--sp-12); }
  .pi-grid { grid-template-columns: 1fr; }
  .pi-grid > .pi-sec:last-child:nth-child(odd) { grid-column: auto; }
  .pi-perm { grid-template-columns: 1fr; }
}
</style>
