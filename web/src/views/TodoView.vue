<template>
  <div class="todo">
    <div class="todo-bar">
      <h2 class="v-title">工作内容</h2>
      <span class="v-sub">按清单组织待办，可绑定任务自动执行</span>
      <span class="sp" />
      <el-button size="small" @click="openListDialog()"><el-icon><Plus /></el-icon> 新建清单</el-button>
    </div>

    <div class="todo-body">
      <aside class="todo-lists">
        <div
          v-for="l in lists" :key="l.id"
          class="todo-list" :class="{ on: l.id === activeListId }"
          @click="activeListId = l.id"
        >
          <span class="todo-list-ic">{{ l.icon || '📋' }}</span>
          <span class="todo-list-name">{{ l.name }}</span>
          <span class="todo-list-count">{{ countOf(l.id) }}</span>
          <el-dropdown trigger="click" @command="(c) => onListCmd(c, l)">
            <el-icon class="todo-list-more"><MoreFilled /></el-icon>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="edit">重命名</el-dropdown-item>
                <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </aside>

      <section class="todo-items">
        <div class="todo-items-bar">
          <b>{{ activeList ? activeList.name : '' }}</b>
          <span class="sp" />
          <el-button size="small" type="primary" @click="openItemDialog()">
            <el-icon><Plus /></el-icon> 添加条目
          </el-button>
        </div>

        <div v-if="loading" class="todo-state"><el-icon class="is-loading"><Loading /></el-icon> 加载中…</div>
        <ul v-else-if="filtered.length" class="todo-item-list">
          <li v-for="it in filtered" :key="it.id" class="todo-item" :class="{ done: it.status === 'done' }">
            <el-checkbox :model-value="it.status === 'done'" @change="() => toggle(it)" />
            <div class="todo-item-main">
              <div class="todo-item-top">
                <span class="todo-item-title">{{ it.title }}</span>
                <el-tag v-if="it.flag" size="small" type="warning" effect="plain">⚑ 重点</el-tag>
                <el-tag v-if="it.linkState && it.linkState !== 'ok'" size="small" type="info">
                  {{ it.linkState === 'missing' ? '任务缺失' : '已禁用' }}
                </el-tag>
                <el-tag v-if="it.lastRunStatus" size="small" :type="it.lastRunStatus === 'success' ? 'success' : 'danger'">
                  {{ it.lastRunStatus }}
                </el-tag>
              </div>
              <div v-if="it.note" class="todo-item-note">{{ it.note }}</div>
            </div>
            <div class="todo-item-acts">
              <el-button v-if="it.taskId" size="small" type="primary" plain :loading="it._running" @click="trigger(it)">
                运行
              </el-button>
              <el-button size="small" text @click="openItemDialog(it)">编辑</el-button>
              <el-button size="small" text type="danger" @click="removeItem(it)">删除</el-button>
            </div>
          </li>
        </ul>
        <div v-else class="todo-state todo-empty">该清单暂无条目</div>
      </section>
    </div>

    <!-- 清单对话框 -->
    <el-dialog v-model="listDlg" :title="listForm.id ? '重命名清单' : '新建清单'" width="420px">
      <el-form label-width="64px">
        <el-form-item label="名称"><el-input v-model="listForm.name" placeholder="清单名称" /></el-form-item>
        <el-form-item label="图标"><el-input v-model="listForm.icon" placeholder="emoji，如 📋" maxlength="4" /></el-form-item>
        <el-form-item label="颜色"><el-color-picker v-model="listForm.color" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="listDlg = false">取消</el-button>
        <el-button type="primary" @click="saveList">保存</el-button>
      </template>
    </el-dialog>

    <!-- 条目对话框 -->
    <el-dialog v-model="itemDlg" :title="itemForm.id ? '编辑条目' : '添加条目'" width="480px">
      <el-form label-width="72px">
        <el-form-item label="标题"><el-input v-model="itemForm.title" placeholder="要做的事" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="itemForm.note" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="清单">
          <el-select v-model="itemForm.listId" placeholder="选择清单">
            <el-option v-for="l in lists" :key="l.id" :label="l.name" :value="l.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关联任务">
          <el-select v-model="itemForm.taskId" clearable filterable placeholder="可选，绑定后可直接运行">
            <el-option v-for="t in tasksList" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="重点"><el-switch v-model="itemForm.flag" /></el-form-item>
        <el-form-item label="自动运行"><el-switch v-model="itemForm.autoRun" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="itemDlg = false">取消</el-button>
        <el-button type="primary" @click="saveItem">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Plus, MoreFilled } from '@element-plus/icons-vue';
import { useAppStore } from '../stores/app.js';
import { useTasksStore } from '../stores/tasks.js';
import {
  fetchTodo, postTodoList, postTodoItem, triggerTodoItem,
} from '../api/dashboards.js';

const app = useAppStore();
const tasks = useTasksStore();

const lists = ref([]);
const items = ref([]);
const activeListId = ref(null);
const loading = ref(false);

const tasksList = computed(() => tasks.tasks || []);
const activeList = computed(() => lists.value.find((l) => l.id === activeListId.value) || null);
const filtered = computed(() => items.value.filter((i) => i.listId === activeListId.value));
function countOf(id) { return items.value.filter((i) => i.listId === id).length; }

const listDlg = ref(false);
const listForm = ref({ id: null, name: '', icon: '📋', color: '#FF5000' });
const itemDlg = ref(false);
const itemForm = ref({ id: null, title: '', note: '', listId: null, taskId: null, flag: false, autoRun: false });

async function load() {
  loading.value = true;
  try {
    const res = await fetchTodo();
    const todo = (res && res.todo) || {};
    lists.value = todo.lists || [];
    items.value = todo.items || [];
    if (!activeListId.value && lists.value.length) activeListId.value = lists.value[0].id;
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function openListDialog(l) {
  listForm.value = l ? { id: l.id, name: l.name, icon: l.icon || '📋', color: l.color || '#FF5000' }
    : { id: null, name: '', icon: '📋', color: '#FF5000' };
  listDlg.value = true;
}
function onListCmd(c, l) {
  if (c === 'edit') openListDialog(l);
  else if (c === 'delete') removeList(l);
}
async function saveList() {
  if (!listForm.value.name) { ElMessage.warning('请填写名称'); return; }
  try {
    const op = listForm.value.id ? 'update' : 'create';
    const payload = listForm.value.id ? { id: listForm.value.id } : {};
    await postTodoList(op, Object.assign(payload, {
      name: listForm.value.name, icon: listForm.value.icon, color: listForm.value.color,
    }));
    listDlg.value = false;
    ElMessage.success('已保存');
    await load();
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
}
async function removeList(l) {
  if (!(await app.confirmDialog({ message: `删除清单「${l.name}」？其下条目将一并删除。` }))) return;
  try {
    await postTodoList('delete', { id: l.id });
    ElMessage.success('已删除');
    await load();
  } catch (e) { ElMessage.error(e.message || '删除失败'); }
}

function openItemDialog(it) {
  itemForm.value = it
    ? { id: it.id, title: it.title, note: it.note || '', listId: it.listId, taskId: it.taskId || null, flag: !!it.flag, autoRun: !!it.autoRun }
    : { id: null, title: '', note: '', listId: activeListId.value, taskId: null, flag: false, autoRun: false };
  itemDlg.value = true;
}
async function saveItem() {
  if (!itemForm.value.title) { ElMessage.warning('请填写标题'); return; }
  try {
    const op = itemForm.value.id ? 'update' : 'create';
    const payload = { title: itemForm.value.title, note: itemForm.value.note, listId: itemForm.value.listId };
    if (itemForm.value.taskId) { payload.taskId = itemForm.value.taskId; payload.autoRun = itemForm.value.autoRun; payload.flag = itemForm.value.flag; }
    if (itemForm.value.id) payload.id = itemForm.value.id;
    await postTodoItem(op, payload);
    itemDlg.value = false;
    ElMessage.success('已保存');
    await load();
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
}
async function toggle(it) {
  try { await postTodoItem('toggle', { id: it.id }); await load(); }
  catch (e) { ElMessage.error(e.message || '操作失败'); }
}
async function removeItem(it) {
  if (!(await app.confirmDialog({ message: `删除条目「${it.title}」？` }))) return;
  try { await postTodoItem('delete', { id: it.id }); ElMessage.success('已删除'); await load(); }
  catch (e) { ElMessage.error(e.message || '删除失败'); }
}
async function trigger(it) {
  it._running = true;
  try { await triggerTodoItem(it.id); ElMessage.success('已触发：' + it.title); }
  catch (e) { ElMessage.error(e.message || '触发失败'); }
  finally { it._running = false; }
}

onMounted(load);
</script>

<style scoped>
.todo { padding: var(--sp-20); }
.todo-bar { display: flex; align-items: baseline; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.v-sub { color: var(--muted); font-size: var(--el-font-size-base); }
.todo-bar .sp { flex: 1; }
.todo-body { display: grid; grid-template-columns: 240px 1fr; gap: var(--sp-16); align-items: start; }
.todo-lists { border: 1px solid var(--border-soft); border-radius: var(--r-md); overflow: hidden; background: var(--white); }
.todo-list {
  display: flex; align-items: center; gap: var(--sp-8); padding: var(--sp-12) var(--sp-14);
  cursor: pointer; border-bottom: 1px solid var(--border-soft);
}
.todo-list:last-child { border-bottom: none; }
.todo-list.on { background: var(--brand-soft); }
.todo-list-ic { font-size: 16px; }
.todo-list-name { flex: 1; font-weight: var(--fw-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-list-count { font-size: var(--el-font-size-extra-small); color: var(--muted); }
.todo-list-more { color: var(--muted); }
.todo-items { border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--white); min-height: 360px; }
.todo-items-bar { display: flex; align-items: center; gap: var(--sp-8); padding: var(--sp-12) var(--sp-16); border-bottom: 1px solid var(--border-soft); }
.todo-items-bar .sp { flex: 1; }
.todo-item-list { list-style: none; margin: 0; padding: var(--sp-8) var(--sp-16); }
.todo-item { display: flex; align-items: flex-start; gap: var(--sp-10); padding: var(--sp-12) 0; border-bottom: 1px solid var(--border-soft); }
.todo-item:last-child { border-bottom: none; }
.todo-item.done .todo-item-title { text-decoration: line-through; color: var(--muted); }
.todo-item-main { flex: 1; min-width: 0; }
.todo-item-top { display: flex; align-items: center; gap: var(--sp-6); flex-wrap: wrap; }
.todo-item-title { font-weight: var(--fw-semibold); }
.todo-item-note { color: var(--muted); font-size: var(--el-font-size-extra-small); margin-top: 2px; }
.todo-item-acts { display: flex; gap: var(--sp-4); flex: none; }
.todo-state { padding: var(--sp-40); text-align: center; color: var(--muted); display: flex; gap: var(--sp-8); justify-content: center; align-items: center; }
</style>
