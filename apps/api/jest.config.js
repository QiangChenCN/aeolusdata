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
  // ts-jest 默认做全量类型检查；项目未挂 @types/jest 全局类型，会导致所有
  // *.spec.ts 在编译期就报 describe/it/expect 未定义而跑不起来。单测只转译不
  // 检查类型（生产代码仍由 tsc 把关），故开启 isolatedModules。
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
