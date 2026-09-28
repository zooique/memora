/**
 * AgentLoop 运行时指标纯状态容器
 *
 * 零 AgentLoop 依赖的自包含值对象：9 个计数字段 + 3 个派生 getter。
 * 置入 `managers/` 而非 loop.ts 的理由：度量「定义」与度量「消费」应分离——
 * loop 只负责 `this.metrics.xxx++`，指标结构本身不属于编排逻辑。
 *
 * 注：不设召回计数指标——记忆检索唯一入口 = search_memories 工具，耗时可看 TOOL_EXEC span。
 */
export class LoopMetrics {
  llmCallCount = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  actualInputTokens = 0;
  actualOutputTokens = 0;
  toolCallCount = 0;
  toolFailureCount = 0;

  /** 空响应兜底次数（LLM 200 但 0 token）。为真说明用户看到英文兜底文案、
   *  任务零产出却被 success 盖章——宿主据此识别「瞬态抽风」vs「模型拒绝」，不再被静默掩盖 */
  emptyResponseCount = 0;

  // ─── 未解析工具意图 ──────────────────────
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

  // ─── 任务表触发观测量（先实证触发率，再决定修复是否起效）──
  /** 累计调用 task_table_write 次数（= 任务表建表/重建次数） */
  planTaskTableWriteCount = 0;
  /** 累计产出 plan_item_boundary 次数（= 思考折叠分块的边界数） */
  planItemBoundaryCount = 0;

  // ─── 发送边界守卫 ───────────────────
  /** 发送边界守卫命中次数（tool_call 批次成形违规被拒发）。健康态应恒 0——
   *  命中 = 构造期散点回归（内核 bug 信号），见 toolCallHelpers.auditToolCallPairing */
  llmPairingGuardFires = 0;

  // ─── 读取防重的台账替身回显观测（观测防重是否过度拦截合法重读）──
  /** read_file 覆盖度台账回显（分支② formatLedgerStub 命中）累计次数。
   *  仅作观测基线：与「规避行为红旗」交叉判定防重是否过度顶替合法重读（见 AgentMetrics 该字段 JSDoc）。 */
  ledgerStubEchoCount = 0;

  // ─── 读取防重的 L2 硬拦观测 ──
  /** read_dedup 护栏硬拦命中（同主体重复获取且结果仍在上下文）累计次数。
   *  与 ledgerStubEchoCount 互补：本计数 = L2 精确判重（模型乒乓信号，撞墙升级文案的量化基线），
   *  后者 = L3 变体顶替；健康态应接近 0，持续增长 = 模型在同主体上反复重读。 */
  readDedupBlockCount = 0;
}
