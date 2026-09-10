/**
 * AgentLoop 运行时指标纯状态容器（ARCH-3 P3-6 从 loop.ts:162-211 下沉）
 *
 * 零 AgentLoop 依赖的自包含值对象：11 个计数字段 + 3 个派生 getter。
 * 置入 `managers/` 而非 loop.ts 的理由：度量「定义」与度量「消费」应分离——
 * loop 只负责 `this.metrics.xxx++`，指标结构本身不属于编排逻辑。
 *
 * 引用点（`this.metrics.xxx`，30 处 / 15+ 成员）与类定义位置无关，故搬迁改动面 = 1 处 import。
 */
export class LoopMetrics {
  llmCallCount = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  actualInputTokens = 0;
  actualOutputTokens = 0;
  recallTotalCount = 0;
  recallHitCount = 0;
  toolCallCount = 0;
  toolFailureCount = 0;

  // ─── 任务级 SLO 度量 ──────────────────────
  /** 任务总执行次数（每次 processUserInput 算一次） */
  taskTotalCount = 0;
  /** 任务成功次数 */
  taskSuccessCount = 0;
  /** 任务失败次数（abort/超时/迭代耗尽） */
  taskFailureCount = 0;
  /** 任务累计耗时（毫秒，用于计算平均耗时） */
  taskTotalDurationMs = 0;

  get hitRate(): number {
    return this.recallTotalCount > 0 ? this.recallHitCount / this.recallTotalCount : 0;
  }

  /** 任务成功率（0-1） */
  get taskSuccessRate(): number {
    return this.taskTotalCount > 0 ? this.taskSuccessCount / this.taskTotalCount : 0;
  }

  /** 平均任务耗时（毫秒） */
  get taskAvgDurationMs(): number {
    return this.taskTotalCount > 0 ? Math.round(this.taskTotalDurationMs / this.taskTotalCount) : 0;
  }
}
