import { defineStore } from 'pinia';

// 运行记录详情抽屉
export const useDrawerStore = defineStore('drawer', {
  state: () => ({ visible: false, entry: null }),
  actions: {
    open(h) { this.entry = h; this.visible = true; },
    close() { this.visible = false; this.entry = null; },
  },
});
