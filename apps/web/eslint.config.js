import globals from "globals";
import importPlugin from "eslint-plugin-import";

/* 前端源码静态检查。
   重点防「模块化拆分后漏 import / 路径写错」这类**构建期捕获不到**的运行时
   ReferenceError —— 2026-09-16 冒烟曾一次暴露 5 个此类隐患（_taskFilter、
   _sessionDangerOK、cfDateMode、_std、__API_TOKEN__），no-undef 可全部拦住。 */
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        // ElMessage / ElNotification 在 main.js 挂到 window 全局暴露，
        // 各文件以裸标识符调用（历史约定），这里声明为只读全局以通过 no-undef
        ElMessage: "readonly",
        ElNotification: "readonly",
      },
    },
    plugins: { import: importPlugin },
    settings: {
      // 解析 ./xxx.js 相对路径与 node_modules 裸包名（echarts / tabulator-tables）；
      // .mjs：element-plus 语言包（es/locale/lang/zh-cn）为 .mjs 文件，缺它会报 no-unresolved
      "import/resolver": { node: { extensions: [".js", ".mjs"] } },
    },
    rules: {
      "no-undef": "error",
      "import/no-unresolved": "error",
      "import/no-duplicates": "warn",
    },
  },
];
