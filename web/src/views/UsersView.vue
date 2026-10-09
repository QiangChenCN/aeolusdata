<template>
  <div class="adm">
    <h2 class="v-title">账号管理</h2>

    <div class="adm-bar">
      <span class="sp" />
      <el-button type="primary" size="small" @click="openUser()"><el-icon><Plus /></el-icon> 新增用户</el-button>
    </div>
    <el-table :data="users" stripe border>
      <el-table-column prop="username" label="用户名" width="160" />
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
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openUser(row)">编辑</el-button>
          <el-button size="small" @click="resetPw(row)">改密</el-button>
          <el-button size="small" type="danger" @click="delUser(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="userDlg" :title="userForm.username ? '编辑用户' : '新增用户'" width="420px">
      <el-form label-width="80px">
        <el-form-item label="用户名"><el-input v-model="userForm.username" :disabled="!!userForm._edit" /></el-form-item>
        <el-form-item v-if="!userForm._edit" label="密码"><el-input v-model="userForm.password" type="password" show-password /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="userForm.role">
            <el-option v-for="r in roles" :key="r.name" :label="r.name" :value="r.name" />
          </el-select>
        </el-form-item>
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
import { useAppStore } from '../stores/app.js';
import {
  fetchUsers, createUser, updateUser, resetUserPw, deleteUser,
  fetchRoles,
} from '../api/dashboards.js';

const app = useAppStore();
const users = ref([]);
const roles = ref([]);
const userDlg = ref(false);
const userForm = reactive({ username: '', password: '', role: '', disabled: false, _edit: false });

async function loadUsers() {
  try { const r = await fetchUsers(); users.value = (r && r.users) || []; } catch (e) { app.toast(e.message || '加载用户失败', 'error'); }
}
async function loadRoles() {
  try {
    const r = await fetchRoles();
    roles.value = (r && r.roles) || [];
  } catch (e) { app.toast(e.message || '加载角色失败', 'error'); }
}
function openUser(u) {
  Object.assign(userForm, u
    ? { username: u.username, password: '', role: u.role, disabled: !!u.disabled, _edit: true }
    : { username: '', password: '', role: roles.value[0] ? roles.value[0].name : '', disabled: false, _edit: false });
  userDlg.value = true;
}
async function saveUser() {
  try {
    if (userForm._edit) {
      await updateUser({ username: userForm.username, role: userForm.role, disabled: userForm.disabled });
    } else {
      await createUser({ username: userForm.username, password: userForm.password, role: userForm.role });
    }
    userDlg.value = false;
    app.toast('已保存', 'success');
    await loadUsers();
  } catch (e) { app.toast(e.message || '保存失败', 'error'); }
}
async function resetPw(u) {
  const np = prompt('为 ' + u.username + ' 设置新密码');
  if (!np) return;
  try { await resetUserPw({ username: u.username, password: np }); app.toast('已重置密码', 'success'); }
  catch (e) { app.toast(e.message || '重置失败', 'error'); }
}
async function delUser(u) {
  if (!(await app.confirmDialog({ message: `删除用户「${u.username}」？` }))) return;
  try { await deleteUser(u.username); app.toast('已删除', 'success'); await loadUsers(); }
  catch (e) { app.toast(e.message || '删除失败', 'error'); }
}
onMounted(() => { loadUsers(); loadRoles(); });
</script>

<style scoped>
.adm { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.adm-bar { display: flex; align-items: center; margin-bottom: var(--sp-12); }
.adm-bar .sp { flex: 1; }
.muted { color: var(--muted); }
</style>
