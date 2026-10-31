/**
 * 过程事件 / 指标段级合并（纯函数）
 *
 * 外置出处：HOST-SPLIT-1 切片（2026-10-31，自 chatPanel 纯合并域抽出）。
 * 抽出的判据只有一条：**无 this 依赖**——两个函数只做纯变换、不读存储、不持状态，
 * 因此可以离开面板类单独单测；落盘仍由调用方决定（本模块不碰 store）。
 *
 * 三条调用面共用同一合并语义：
 * ① step 边界原子检查点（checkpointRound）
 * ② 流尾最终落盘（consumeFlow）
 * ③ 运行时 live 重放（buildLiveTurnFromBuffer）
 *
 * @module processEventMerge
 */
import type { ProcessEvent, ProcessMetricsPayload } from '@zooique/memora';

/**
 * metrics 同轮段级合并（多流续跑防丢失）
 *
 * 一次 turn 可能分多段流完成（软暂停续跑 / ask 回答后续跑等）——每段流尾各自 emit 一条
 * metrics（段级增量：本段耗时 / token diff / 本段工具失败数）。旧实现把 prior 的 metrics
 * 恒剔除 → 前段全部指标丢失，回合终态只剩末段（如前段 7 次工具失败被静默清零）。
 * 本助手把前段与末段求和成一条（零 schema 变更）；`success` 取末段值——其语义是
 * 「这段流程跑完了没有」，终局收尾状态以最后一段为准（中间段 false = 曾中断，非终局）。
 *
 * 可选字段（unparsedToolIntentCount / emptyResponseCount / truncationRecoveryCount）：
 * 任一段携带即求和（缺段按 0），两段都缺则保持缺省——不伪造旧数据没有的信号面。
 */
export function mergeMetricsPayload(
  prior: ProcessMetricsPayload,
  fresh: ProcessMetricsPayload,
): ProcessMetricsPayload {
  return {
    durationMs: prior.durationMs + fresh.durationMs,
    tokenIn: prior.tokenIn + fresh.tokenIn,
    tokenOut: prior.tokenOut + fresh.tokenOut,
    toolFailureCount: prior.toolFailureCount + fresh.toolFailureCount,
    success: fresh.success,
    ...(prior.unparsedToolIntentCount !== undefined || fresh.unparsedToolIntentCount !== undefined
      ? {
          unparsedToolIntentCount:
            (prior.unparsedToolIntentCount ?? 0) + (fresh.unparsedToolIntentCount ?? 0),
        }
      : {}),
    ...(prior.emptyResponseCount !== undefined || fresh.emptyResponseCount !== undefined
      ? {
          emptyResponseCount: (prior.emptyResponseCount ?? 0) + (fresh.emptyResponseCount ?? 0),
        }
      : {}),
    ...(prior.truncationRecoveryCount !== undefined || fresh.truncationRecoveryCount !== undefined
      ? {
          truncationRecoveryCount:
            (prior.truncationRecoveryCount ?? 0) + (fresh.truncationRecoveryCount ?? 0),
        }
      : {}),
  };
}

/**
 * 按 seq 幂等合并过程事件（SSOT 单一合并语义）
 *
 * step 检查点与流尾完成共用本函数，避免两份合并逻辑漂移；靠 seq 全局唯一
 * （_processSeq 单调）天然幂等——step 检查点已写入的增量，流尾重合并不会重复追加，保序。
 *
 * 合并规则：
 * - 终态净化：prior 中旧流 aborted 恒剔除——终局终态恒为末流。
 * - metrics 同轮合并：prior 与 incoming 同轮各有 metrics（多流续跑）时求和成单条
 *   （mergeMetricsPayload：计数求和、success 取末段），前段指标不再被静默丢弃；
 *   incoming 无 metrics（step 检查点常态）时 prior metrics 原样保留，待流尾合并。
 * - 身份去重：多流续跑（prior 非空）时剔除 incoming 的 meta——身份保留首流，
 *   续跑不重复身份；单流轮（prior 空）保留 meta（else 分支）。
 * - 幂等去重：incoming 中 seq 已写入的丢弃（跨流不重叠，seq 全局唯一）。
 *
 * @param prior Round 既有 processEvents（前流/上次检查点产物，可为空）
 * @param incoming 本流当前已累积事件（含刚 emit 的 plan_item_boundary / 末轮 metrics）
 * @returns 合并后数组（不改写存储，落盘由调用方决定）
 */
export function mergeProcessEvents(
  prior: ProcessEvent[],
  incoming: ProcessEvent[],
): ProcessEvent[] {
  // metrics 同轮合并：incoming 带末段 metrics 且 prior 也有前段 metrics → 并入 incoming 单条
  const incomingMetrics = incoming.find(
    (e): e is Extract<ProcessEvent, { type: 'metrics' }> => e.type === 'metrics',
  );
  const priorMetrics = prior.find(
    (e): e is Extract<ProcessEvent, { type: 'metrics' }> => e.type === 'metrics',
  );
  const effectiveIncoming =
    incomingMetrics && priorMetrics
      ? incoming.map((e) =>
          e === incomingMetrics
            ? { ...e, payload: mergeMetricsPayload(priorMetrics.payload, e.payload) }
            : e,
        )
      : incoming;
  // 终态净化：旧流 aborted 剔除（终态恒为末流）；前段 metrics 已并入 incoming 时同样剔除
  // （防双计）；incoming 无 metrics 的检查点路径保留 prior metrics（不丢前段指标）
  const base = prior.filter(
    (e) => e.type !== 'aborted' && !(e.type === 'metrics' && incomingMetrics !== undefined),
  );
  // 身份去重：仅多流续跑（prior 非空）剔 incoming 的 meta，避免重复身份
  const freshIncoming =
    prior.length > 0 ? effectiveIncoming.filter((e) => e.type !== 'meta') : effectiveIncoming;
  // 幂等去重：seq 全局唯一，incoming 中已写入的丢弃；fresh 恒在 base 之后（seq 单调保序）
  const have = new Set(base.map((e) => e.seq));
  const fresh = freshIncoming.filter((e) => !have.has(e.seq));
  return [...base, ...fresh];
}
