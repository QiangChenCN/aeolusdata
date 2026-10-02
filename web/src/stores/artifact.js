import { defineStore } from 'pinia';
import { fetchArtifacts } from '../api/runs.js';

// 任务产物浏览器：拉清单 + 内联预览
export const useArtifactStore = defineStore('artifact', {
  state: () => ({ visible: false, taskId: null, files: [], loading: false }),
  actions: {
    async open(taskId) {
      if (!taskId) return;
      this.taskId = taskId;
      this.visible = true;
      this.loading = true;
      this.files = [];
      try {
        const r = await fetchArtifacts(taskId);
        this.files = (r && r.files) || [];
      } catch (e) {
        this.files = [];
      } finally {
        this.loading = false;
      }
    },
    close() { this.visible = false; this.taskId = null; },
  },
});
