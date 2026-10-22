/**
 * 考核看板的**公开面**（barrel）。
 *
 * 约定（由 `apps/api/scripts/check-arch.mjs` 的 R1 / R6 强制）：其它模块要用本看板的能力时，
 * 只能从这里（或装配体 `assessment.module.ts`）导入，不得深引内部实现文件。
 *
 * 目前**没有外部消费者** —— 这是刻意保持的状态：考核看板的取数 / 计算 / 配置全部自管。
 * 下面只导出「其它看板确有理由复用」的一项（历史结果库）；其余编排类服务
 * （auto-refresh / cooldown / delivery-fetch / violation-fetch / visit-fetch / events）
 * 属于本看板内部实现，**不导出**，改它们无需顾虑外部。
 */
export { AssessmentHistoryStoreService } from './assessment-history-store.service';
export { AssessmentModule } from './assessment.module';
