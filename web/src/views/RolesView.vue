<template>
  <div class="adm">
    <h2 class="v-title">角色管理</h2>

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
import { fetchRoles, saveRole as apiSaveRole } from '../api/dashboards.js';

const app = useAppStore();
const roles = ref([]);
const allPerms = ref([]);
const roleDlg = ref(false);
const roleForm = reactive({ name: '', perms: [], parents: [], _edit: false });

async function loadRoles() {
  try {
    const r = await fetchRoles();
    roles.value = (r && r.roles) || [];
    allPerms.value = (r && r.all_perms) || [];
  } catch (e) { ElMessage.error(e.message || '加载角色失败'); }
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
    ElMessage.success('已保存');
    await loadRoles();
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
}
async function delRole(r) {
  if (r.builtin || r.locked) { ElMessage.warning('内置/锁定角色不可删除'); return; }
  if (!(await app.confirmDialog({ message: `删除角色「${r.name}」？` }))) return;
  try { await apiSaveRole('delete', { name: r.name }); ElMessage.success('已删除'); await loadRoles(); }
  catch (e) { ElMessage.error(e.message || '删除失败'); }
}
onMounted(loadRoles);
</script>

<style scoped>
.adm { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.adm-bar { display: flex; align-items: center; margin-bottom: var(--sp-12); }
.adm-bar .sp { flex: 1; }
.perm-tag { margin: 0 4px 4px 0; }
.muted { color: var(--el-text-color-secondary); }
.role-perms { width: 100%; }
</style>
