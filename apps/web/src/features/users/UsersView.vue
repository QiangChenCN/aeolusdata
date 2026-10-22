<template>
  <div class="adm">
    <h2 class="v-title">账号管理</h2>

    <div class="adm-bar">
      <span class="sp" />
      <el-button type="primary" size="small" @click="openUser()"><el-icon><Plus /></el-icon> 新增用户</el-button>
    </div>
    <el-table :data="users" stripe border>
      <el-table-column prop="username" label="用户名" width="160" />
      <el-table-column prop="name" label="姓名" width="120" />
      <el-table-column prop="phone" label="手机号" width="140" />
      <el-table-column prop="email" label="邮箱" min-width="180" show-overflow-tooltip />
      <el-table-column prop="role" label="角色" width="140" />
      <el-table-column label="状态" width="160">
        <template #default="{ row }">
          <el-tag v-if="row.disabled" size="small" type="info">已禁用</el-tag>
          <el-tag v-if="row.locked" size="small" type="warning">已锁定</el-tag>
          <el-tag v-if="row.must_change" size="small" type="danger">需改密</el-tag>
          <span v-if="!row.disabled && !row.locked && !row.must_change" class="muted">正常</span>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="创建时间" min-width="160" />
      <el-table-column label="钉钉绑定" min-width="180">
        <template #default="{ row }">
          <span v-if="row.dingtalk_unionid" class="dt-id" :title="row.dingtalk_unionid">{{ row.dingtalk_unionid.slice(0, 14) }}…</span>
          <span v-else class="muted">未绑定</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="330" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openUser(row)">编辑</el-button>
          <el-button size="small" @click="resetPw(row)">改密</el-button>
          <el-button size="small" @click="openBind(row)">绑定钉钉</el-button>
          <el-button size="small" type="danger" @click="delUser(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="bindDlg" title="绑定钉钉账号" width="460px">
      <p class="bind-tip">
        将钉钉身份（unionid）绑定到用户 <b>{{ bindForm.username }}</b>，绑定后该用户在钉钉工作台内打开本系统即可一键免登。
      </p>
      <el-form label-width="92px">
        <el-form-item label="当前绑定">
          <span v-if="bindForm.current" class="dt-id">{{ bindForm.current }}</span>
          <span v-else class="muted">未绑定</span>
        </el-form-item>
        <el-form-item label="钉钉 unionid">
          <el-input
            v-model="bindForm.unionid"
            placeholder="粘贴用户的钉钉 unionid（可在钉钉内登录失败提示中获取）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="!bindForm.current" @click="unbind">解除绑定</el-button>
        <el-button @click="bindDlg = false">取消</el-button>
        <el-button type="primary" @click="saveBind">保存绑定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="userDlg" :title="userForm.username ? '编辑用户' : '新增用户'" width="420px">
      <el-form label-width="80px">
        <el-form-item label="用户名"><el-input v-model="userForm.username" :disabled="!!userForm._edit" /></el-form-item>
        <el-form-item v-if="!userForm._edit" label="密码"><el-input v-model="userForm.password" type="password" show-password /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="userForm.role">
            <el-option v-for="r in roles" :key="r.name" :label="r.name" :value="r.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="姓名"><el-input v-model="userForm.name" placeholder="选填" maxlength="20" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="userForm.phone" placeholder="选填，11 位手机号" maxlength="11" /></el-form-item>
        <el-form-item label="邮箱"><el-input v-model="userForm.email" placeholder="选填" maxlength="64" /></el-form-item>
        <el-form-item v-if="userForm._edit" label="禁用"><el-switch v-model="userForm.disabled" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userDlg = false">取消</el-button>
        <el-button type="primary" @click="saveUser">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import { useAppStore } from '../../stores/app.js';
import {
  fetchUsers, createUser, updateUser, resetUserPw, deleteUser,
  fetchRoles,
} from '../../api/dashboards.js';
import { dingtalkBind } from '../../api/auth.js';

const app = useAppStore();
const users = ref([]);
const roles = ref([]);
const userDlg = ref(false);
const userForm = reactive({ username: '', password: '', role: '', name: '', phone: '', email: '', disabled: false, _edit: false });

// 钉钉绑定
const bindDlg = ref(false);
const bindForm = reactive({ username: '', current: '', unionid: '' });
function openBind(row) {
  bindForm.username = row.username;
  bindForm.current = row.dingtalk_unionid || '';
  bindForm.unionid = row.dingtalk_unionid || '';
  bindDlg.value = true;
}
async function saveBind() {
  try {
    await dingtalkBind(bindForm.username, bindForm.unionid);
    ElMessage.success(bindForm.unionid ? '已绑定钉钉' : '已解除绑定');
    bindDlg.value = false;
    await loadUsers();
  } catch (e) { ElMessage.error(e.message || '绑定失败'); }
}
async function unbind() {
  try {
    await dingtalkBind(bindForm.username, '');
    ElMessage.success('已解除绑定');
    bindDlg.value = false;
    await loadUsers();
  } catch (e) { ElMessage.error(e.message || '解绑失败'); }
}

async function loadUsers() {
  try { const r = await fetchUsers(); users.value = (r && r.users) || []; } catch (e) { ElMessage.error(e.message || '加载用户失败'); }
}
async function loadRoles() {
  try {
    const r = await fetchRoles();
    roles.value = (r && r.roles) || [];
  } catch (e) { ElMessage.error(e.message || '加载角色失败'); }
}
function openUser(u) {
  Object.assign(userForm, u
    ? { username: u.username, password: '', role: u.role, name: u.name || '', phone: u.phone || '', email: u.email || '', disabled: !!u.disabled, _edit: true }
    : { username: '', password: '', role: roles.value[0] ? roles.value[0].name : '', name: '', phone: '', email: '', disabled: false, _edit: false });
  userDlg.value = true;
}
async function saveUser() {
  try {
    if (userForm._edit) {
      await updateUser({ username: userForm.username, role: userForm.role, disabled: userForm.disabled, name: userForm.name, phone: userForm.phone, email: userForm.email });
    } else {
      await createUser({ username: userForm.username, password: userForm.password, role: userForm.role, name: userForm.name, phone: userForm.phone, email: userForm.email });
    }
    userDlg.value = false;
    ElMessage.success('已保存');
    await loadUsers();
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
}
async function resetPw(u) {
  const np = prompt('为 ' + u.username + ' 设置新密码');
  if (!np) return;
  try { await resetUserPw({ username: u.username, password: np }); ElMessage.success('已重置密码'); }
  catch (e) { ElMessage.error(e.message || '重置失败'); }
}
async function delUser(u) {
  if (!(await app.confirmDialog({ message: `删除用户「${u.username}」？` }))) return;
  try { await deleteUser(u.username); ElMessage.success('已删除'); await loadUsers(); }
  catch (e) { ElMessage.error(e.message || '删除失败'); }
}
onMounted(() => { loadUsers(); loadRoles(); });
</script>

<style scoped>
.adm { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.adm-bar { display: flex; align-items: center; margin-bottom: var(--sp-12); }
.adm-bar .sp { flex: 1; }
.muted { color: var(--el-text-color-secondary); }
.dt-id { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--el-text-color-primary); word-break: break-all; }
.bind-tip { margin: 0 0 var(--sp-16); color: var(--el-text-color-secondary); line-height: 1.6; }
</style>
