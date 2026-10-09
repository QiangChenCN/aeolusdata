import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 配置位于 web/（与 package.json 同目录，Vite 才能自动加载并就近解析 web/node_modules）。
// root 指向 web/：源码 web/src/、入口 web/index.html 都在其下，构建产物落到 web/dist/。
const HERE = dirname(fileURLToPath(import.meta.url)); // web/

export default defineConfig({
  plugins: [vue()],
  root: HERE,
  base: '/',
  build: {
    rollupOptions: {
      input: resolve(HERE, 'index.html'),
    },
    outDir: resolve(HERE, 'dist'), // web/dist
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2019',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 开发联调：把 /api 代理到 NestJS 后端（默认 8787），由它做鉴权/会话 + 注入 x-scope 后
      // 再委托 FastAPI 计算服务（8900）。注意 /api 必须走 Nest，不能直连单体 8917
      // （否则绕过 Nest 会话与 x-scope 数据权限链路）。
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // SSE（/api/events）默认会被 http-proxy 缓冲，导致实时日志/状态事件延迟或丢失。
        // 对 text/event-stream 关闭缓冲、禁用缓存与转换，确保逐块实时转发。
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            const ct = proxyRes.headers['content-type'] || '';
            if (ct.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
              proxyRes.headers['connection'] = 'keep-alive';
            }
          });
        },
      },
    },
  },
});
