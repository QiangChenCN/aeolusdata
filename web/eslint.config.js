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
      globals: { ...globals.browser },
    },
    plugins: { import: importPlugin },
    settings: {
      // 解析 ./xxx.js 相对路径与 node_modules 裸包名（echarts / tabulator-tables）
      "import/resolver": { node: { extensions: [".js"] } },
    },
    rules: {
      "no-undef": "error",
      "import/no-unresolved": "error",
      "import/no-duplicates": "warn",
    },
  },
];
