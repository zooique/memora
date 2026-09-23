/**
 * AgentLoop 运行时指标纯状态容器（ARCH-3 P3-6 从 AgentLoop 下沉）
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

  /** 空响应兜底次数（2026-09-15 边界补缝观察：LLM 200 但 0 token）。为真说明用户看到英文兜底文案、
   *  任务零产出却被 success 盖章——宿主据此识别「瞬态抽风」vs「模型拒绝」，不再被静默掩盖 */
  emptyResponseCount = 0;

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
  /** 累计产出 plan_item_boundary 次数（= 思考折叠分块的边界数） */
  planItemBoundaryCount = 0;

  // ─── TOOLPAIR-2 发送边界守卫（2026-09-15 Step 2）──────────────────
  /** 发送边界守卫命中次数（tool_call 批次成形违规被拒发）。健康态应恒 0——
   *  命中 = 构造期散点回归（内核 bug 信号），见 toolCallHelpers.auditToolCallPairing */
  llmPairingGuardFires = 0;

  // ─── 读取防重的台账替身回显观测（2026-09-15，观测 ADR-031 过度拦截候选）──
  /** read_file 覆盖度台账回显（分支② formatLedgerStub 命中）累计次数。
   *  仅作观测基线：与「规避行为红旗」交叉判定防重是否过度顶替合法重读（见 AgentMetrics 该字段 JSDoc）。 */
  ledgerStubEchoCount = 0;
}
