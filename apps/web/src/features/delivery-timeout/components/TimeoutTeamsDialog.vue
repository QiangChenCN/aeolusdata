<template>
  <el-dialog :model-value="modelValue" title="站点设置（选择需要在看板展示的站点）" width="440px"
             @update:model-value="(v) => emit('update:modelValue', v)">
    <el-checkbox-group v-model="cfgSel" class="dv-cfg-group">
      <el-checkbox v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</el-checkbox>
    </el-checkbox-group>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="cfgSaving" @click="saveCfg">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { saveDeliveryTimeoutTeams } from '../../../api/delivery-timeout.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  teams: { type: Array, default: () => [] },
  teamsCfg: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue', 'saved']);

const cfgSel = ref([]);
const cfgSaving = ref(false);

// 每次打开都以「已配置站点」为初值，避免取消后残留上次勾选。
watch(
  () => props.modelValue,
  (v) => { if (v) cfgSel.value = [...props.teamsCfg]; },
);

async function saveCfg() {
  cfgSaving.value = true;
  try {
    const res = await saveDeliveryTimeoutTeams(cfgSel.value);
    if (res && res.ok) {
      ElMessage.success('站点配置已保存');
      emit('saved', res.teams || [...cfgSel.value]);
      emit('update:modelValue', false);
    } else {
      ElMessage.error((res && res.error) || '保存失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    cfgSaving.value = false;
  }
}
</script>

<!-- 无私有样式：沿用 el-checkbox-group 默认布局（与原单文件版本一致），避免改动外观 -->
