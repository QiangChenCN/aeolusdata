import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// 配置位于 web/（与 package.json 同目录，Vite 才能自动加载）。
// root 指向仓库根：入口 index.html 在仓库根，源码在 web/src/，构建产物落到 web/dist/。
// 由 Python server（_serve_static_get）托管 web/dist，并保持 __SERVER_API_TOKEN__ 占位替换。
const HERE = dirname(fileURLToPath(import.meta.url)); // web/
const ROOT = resolve(HERE, '..');                      // 仓库根

/* dev（vite serve）专用：读取后端持久化的 .api_token（server.py 的 _load_or_create_token），
   注入到 index.html 的 __SERVER_API_TOKEN__ 占位符。否则 dev 下前端会带着字面量占位符
   请求 /api，被后端 H2 鉴权拒绝（403）。
   apply:'serve' 保证 build 产物仍保留占位符，由生产环境的 Python server 托管
   web/dist/index.html 时再做替换 —— dev 与生产两条路径的 token 注入互不干扰。 */
function injectApiToken(){
  return {
    name: 'inject-api-token',
    apply: 'serve',
    transformIndexHtml(html){
      let token = '';
      try { token = readFileSync(resolve(ROOT, '.api_token'), 'utf-8').trim(); } catch (e) { /* 后端未启动/无 token 文件：保持占位符 */ }
      if(!token) return html;
      return html.replace(/__SERVER_API_TOKEN__/g, token);
    },
  };
}

export default defineConfig({
  root: ROOT,
  base: '/',
  plugins: [injectApiToken()],
  build: {
    rollupOptions: {
      input: resolve(ROOT, 'index.html'),
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
      // 开发联调：把 /api 代理到后端（server.py，默认 8917），否则 dev 下前端调不到后端接口
      '/api': {
        target: 'http://localhost:8917',
        changeOrigin: true,
      },
    },
  },
});
