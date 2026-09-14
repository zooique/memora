/**
 * AgentLoop 运行时指标纯状态容器（ARCH-3 P3-6 从 loop.ts:162-211 下沉）
 *
 * 零 AgentLoop 依赖的自包含值对象：9 个计数字段 + 3 个派生 getter。
 * 置入 `managers/` 而非 loop.ts 的理由：度量「定义」与度量「消费」应分离——
 * loop 只负责 `this.metrics.xxx++`，指标结构本身不属于编排逻辑。
 *
 * 引用点（`this.metrics.xxx`）与类定义位置无关，故搬迁改动面 = 1 处 import。
 *
 * 注：原 recallTotalCount / recallHitCount / hitRate 已于 2026-09-11 物理删除——
 * 自动记忆召回退役后三者零写点、hitRate 恒 0（假指标），字段的存在本身即
 * 在宣称一件已不存在的事（记忆检索唯一入口 = search_memories 工具，耗时可看 TOOL_EXEC span）。
 */
export class LoopMetrics {
  llmCallCount = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  actualInputTokens = 0;
  actualOutputTokens = 0;
  toolCallCount = 0;
  toolFailureCount = 0;

  // ─── 未解析工具意图（2026-09-14 静默失败修复）──────────────────────
  /**
   * 疑似工具调用但无原生 toolCalls 的文本意图数。
   * 文本出口不再宣告可调用通道后，模型仍可能吐出 <tool_call>/<function=> 骨架——
   * 本计数让「想干活却一步没干成」不再被静默盖章「完成」（宿主据此不显示 success）。
   */
  unparsedToolIntentCount = 0;

  // ─── 任务级 SLO 度量 ──────────────────────
  /** 任务总执行次数（每次 processUserInput 算一次） */
  taskTotalCount = 0;
  /** 任务成功次数 */
  taskSuccessCount = 0;
  /** 任务失败次数（abort/超时/迭代耗尽） */
  taskFailureCount = 0;
  /** 任务累计耗时（毫秒，用于计算平均耗时） */
  taskTotalDurationMs = 0;

  /** 任务成功率（0-1） */
  get taskSuccessRate(): number {
    return this.taskTotalCount > 0 ? this.taskSuccessCount / this.taskTotalCount : 0;
  }

  /** 平均任务耗时（毫秒） */
  get taskAvgDurationMs(): number {
    return this.taskTotalCount > 0 ? Math.round(this.taskTotalDurationMs / this.taskTotalCount) : 0;
  }

  // ─── 任务表触发观测量（2026-09-14 层0：先实证"任务表从未被 LLM 触发"，再决定触发修复是否起效）──
  /** 累计调用 task_table_write 次数（= 任务表建表/重建次数） */
  planTaskTableWriteCount = 0;
  /** 累计产出 step_boundary 次数（= 思考折叠分块的边界数） */
  stepBoundaryCount = 0;
}
