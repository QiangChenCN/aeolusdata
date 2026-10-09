/**
 * Jest 配置（此前没有，`npm test` 实际因无法解析 TS 而跑不起来）。
 *
 * 用 ts-jest 直跑 `src/**\/*.spec.ts`：单测贴在源码旁边，与 Nest 的惯例一致；
 * node_modules 由 Jest 默认的 testPathIgnorePatterns 排除。
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
};
