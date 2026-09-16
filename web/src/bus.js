// bus.js —— 极简事件总线（去环：功能模块 emit('refresh')，main 订阅刷新）
const map = new Map();

export const bus = {
  on(type, fn){
    if(!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
    return function(){ const s = map.get(type); if(s) s.delete(fn); };
  },
  off(type, fn){
    const s = map.get(type);
    if(s) s.delete(fn);
  },
  emit(type, payload){
    const s = map.get(type);
    if(s) s.forEach(function(f){
      try { f(payload); } catch(e){ console.error("[bus] handler error for '" + type + "'", e); }
    });
  }
};

/* 自动导出：供其他模块导入的内部顶层符号 */
export { map };
