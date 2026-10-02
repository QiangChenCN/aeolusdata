<template>
  <div class="adm">
    <h2 class="v-title">系统设置</h2>

    <el-tabs v-model="tab" class="adm-tabs">
      <!-- 用户管理 -->
      <el-tab-pane label="账号管理" name="users">
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
      </el-tab-pane>

      <!-- 角色权限 -->
      <el-tab-pane label="角色权限" name="roles">
        <div class="adm-bar">
          <span class="sp" />
          <el-button type="primary" size="small" @click="openRole()"><el-icon><Plus /></el-icon> 新增角色</el-button>
        </div>
        <el-table :data="roles" stripe border>
          <el-table-column prop="name" label="角色" width="160" />
          <el-table-column label="继承" width="160">
            <template #default="{ row }">{{ (row.parents || []).join('、') || '—' }}</template>
          </el-table-column>
          <el-table-column label="权限点" min-width="280">
            <template #default="{ row }">
              <el-tag v-for="p in (row.perms || []).slice(0, 12)" :key="p" size="small" class="perm-tag">{{ p }}</el-tag>
              <span v-if="(row.perms || []).length > 12" class="muted">…</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openRole(row)">编辑</el-button>
              <el-button size="small" type="danger" :disabled="row.builtin || row.locked" @click="delRole(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 密码策略 -->
      <el-tab-pane label="密码策略" name="policy">
        <el-form label-width="160px" class="adm-form">
          <el-form-item label="最小长度"><el-input-number v-model="policy.min_length" :min="6" :max="64" /></el-form-item>
          <el-form-item label="最大长度"><el-input-number v-model="policy.max_length" :min="6" :max="128" /></el-form-item>
          <el-form-item label="要求大写"><el-switch v-model="policy.require_upper" /></el-form-item>
          <el-form-item label="要求小写"><el-switch v-model="policy.require_lower" /></el-form-item>
          <el-form-item label="要求数字"><el-switch v-model="policy.require_digit" /></el-form-item>
          <el-form-item label="要求符号"><el-switch v-model="policy.require_symbol" /></el-form-item>
          <el-form-item label="最大有效期(天)"><el-input-number v-model="policy.max_age_days" :min="0" :max="365" /></el-form-item>
          <el-form-item label="防复用"><el-switch v-model="policy.prevent_reuse" /></el-form-item>
          <el-form-item label="泄露筛查"><el-switch v-model="policy.breach_check" /></el-form-item>
          <el-form-item label="锁定尝试次数"><el-input-number v-model="policy.lockout_attempts" :min="1" :max="20" /></el-form-item>
          <el-form-item label="锁定分钟"><el-input-number v-model="policy.lockout_minutes" :min="1" :max="1440" /></el-form-item>
          <el-form-item label="允许粘贴"><el-switch v-model="policy.allow_paste" /></el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="savingPolicy" @click="savePolicy">保存策略</el-button>
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <!-- 个人改密 -->
      <el-tab-pane label="个人改密" name="pw">
        <el-form label-width="120px" class="adm-form">
          <el-form-item label="旧密码"><el-input v-model="pw.old" type="password" show-password /></el-form-item>
          <el-form-item label="新密码"><el-input v-model="pw.next" type="password" show-password /></el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="pw.confirm" type="password" show-password />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="savingPw" @click="doChangePw">提交</el-button>
          </el-form-item>
        </el-form>
      </el-tab-pane>
    </el-tabs>

    <!-- 用户对话框 -->
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

    <!-- 角色对话框 -->
    <el-dialog v-model="roleDlg" :title="roleForm.name ? '编辑角色' : '新增角色'" width="520px">
      <el-form label-width="80px">
        <el-form-item label="角色名"><el-input v-model="roleForm.name" :disabled="!!roleForm._edit" /></el-form-item>
        <el-form-item label="继承">
          <el-select v-model="roleForm.parents" multiple clearable>
            <el-option v-for="r in roles" :key="r.name" :label="r.name" :value="r.name" :disabled="r.name === roleForm.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="权限点">
          <el-select v-model="roleForm.perms" multiple filterable class="role-perms">
            <el-option v-for="p in allPerms" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDlg = false">取消</el-button>
        <el-button type="primary" @click="saveRole">保存</el-button>
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
  fetchRoles, saveRole as apiSaveRole, fetchPolicy, savePolicy as postPolicy, changePw,
} from '../api/dashboards.js';

const app = useAppStore();
const tab = ref('users');
const users = ref([]);
const roles = ref([]);
const allPerms = ref([]);
const policy = reactive({});
const savingPolicy = ref(false);
const savingPw = ref(false);
const pw = reactive({ old: '', next: '', confirm: '' });

const userDlg = ref(false);
const userForm = reactive({ username: '', password: '', role: '', disabled: false, _edit: false });
const roleDlg = ref(false);
const roleForm = reactive({ name: '', perms: [], parents: [], _edit: false });

async function loadUsers() {
  try { const r = await fetchUsers(); users.value = (r && r.users) || []; } catch (e) { app.toast(e.message || '加载用户失败', 'error'); }
}
async function loadRoles() {
  try {
    const r = await fetchRoles();
    roles.value = (r && r.roles) || [];
    allPerms.value = (r && r.all_perms) || [];
  } catch (e) { app.toast(e.message || '加载角色失败', 'error'); }
}
async function loadPolicy() {
  try { const r = await fetchPolicy(); Object.assign(policy, r.policy || {}); } catch (e) { app.toast(e.message || '加载策略失败', 'error'); }
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

function openRole(r) {
  Object.assign(roleForm, r
    ? { name: r.name, perms: (r.perms || []).slice(), parents: (r.parents || []).slice(), _edit: true }
    : { name: '', perms: [], parents: [], _edit: false });
  roleDlg.value = true;
}
async function saveRole() {
  try {
    const op = roleForm._edit ? 'update' : 'create';
    await apiSaveRole(op, { name: roleForm.name, perms: roleForm.perms, parents: roleForm.parents });
    roleDlg.value = false;
    app.toast('已保存', 'success');
    await loadRoles();
  } catch (e) { app.toast(e.message || '保存失败', 'error'); }
}
async function delRole(r) {
  if (r.builtin || r.locked) { app.toast('内置/锁定角色不可删除', 'warning'); return; }
  if (!(await app.confirmDialog({ message: `删除角色「${r.name}」？` }))) return;
  try { await apiSaveRole('delete', { name: r.name }); app.toast('已删除', 'success'); await loadRoles(); }
  catch (e) { app.toast(e.message || '删除失败', 'error'); }
}

async function savePolicy() {
  savingPolicy.value = true;
  try { await postPolicy(policy); app.toast('策略已保存', 'success'); }
  catch (e) { app.toast(e.message || '保存失败', 'error'); }
  finally { savingPolicy.value = false; }
}
async function doChangePw() {
  if (pw.next !== pw.confirm) { app.toast('两次输入的新密码不一致', 'warning'); return; }
  savingPw.value = true;
  try { await changePw({ old_password: pw.old, new_password: pw.next }); app.toast('密码已修改', 'success'); pw.old = pw.next = pw.confirm = ''; }
  catch (e) { app.toast(e.message || '修改失败', 'error'); }
  finally { savingPw.value = false; }
}

onMounted(() => { loadUsers(); loadRoles(); loadPolicy(); });
</script>

<style scoped>
.adm { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--fs-title); }
.adm-bar { display: flex; align-items: center; margin-bottom: var(--sp-12); }
.adm-bar .sp { flex: 1; }
.adm-form { max-width: 520px; }
.perm-tag { margin: 0 4px 4px 0; }
.muted { color: var(--muted); }
.role-perms { width: 100%; }
</style>
