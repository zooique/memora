/**
 * 中断 / 失败原因投影（宿主共享纯函数）
 *
 * 为什么单独成文件：`webview/helpers/processFlowModel.ts` 的 `decideTerminus` 用 webview 的
 * `@vscode/l10n`，宿主面板不能反向依赖它；而「谁停的」这一事实的来源（`Round.processEvents`
 * 的 `aborted` / `error` 事件）是宿主与 webview 共用的。故把**判定**收在这里、把**文案**留给
 * 各自消费方（webview 走 l10n，宿主通知走中文事实句），避免两处各判一遍。
 *
 * 边界：纯函数、零 I/O、不新增状态。输入就是已落盘 / 正在落盘的 `ProcessEvent[]`，
 * **不**给 Round 加字段，也不另建终态源。
 *
 * ⚠️ 与 `decideTerminus` 的分野：后者回答「UI 该显示哪一档」，无事件时**有意**兜底为
 * 「用户中断」（TERMINUS-SSOT-1 的展示定案）；本函数回答「事实上的停手是谁」，无事件且
 * 宿主未 abort 时必须是 `unavailable`——把展示兜底抄进事实层就是伪造「用户停」。
 */
import type { ProcessEvent } from '@zooique/memora';

/** 进程事件里的终止来源事件（互斥：同一条失败路径不会两个都写） */
type ErrorEvent = Extract<ProcessEvent, { type: 'error' }>;
type AbortedEvent = Extract<ProcessEvent, { type: 'aborted' }>;

/**
 * 停手者（**只列真实可测的档**）
 *
 * - `user`：宿主 abort（生产唯一调用点 = 用户点停止）或 `stopReason==='user'`
 * - `timeout`：`stopReason==='timeout'`（LLM 请求 / chat 锁超时）
 * - `error`：`error` 事件（异常终止，带回原始错误文本）
 * - `recovered`：`aborted` 事件的 `stopReason === 'interrupted'`——宿主重启时发现该轮未收场，
 *   由**打捞进程**补写的「异常退出后恢复」标记（`interruptedSalvage`）。与 user 严格分开：
 *   用户没按停止，是进程先死了
 * - `unavailable`：本轮确实以中断收场，但**没有任何可判定的原因**。如实标「取不到」，
 *   不并入 user、也不叫 unknown（名字即结论，不能被当成垃圾桶）
 */
export type InterruptStopper = 'user' | 'timeout' | 'error' | 'recovered' | 'unavailable';

/** 原因投影结果 */
export interface InterruptReason {
  /** 停手者分档 */
  stopper: InterruptStopper;
  /**
   * 做出判定的原始事件（`unavailable` 且无事件时缺省）。
   *
   * 保留原始事件而不是提前翻成文案：宿主通知要原始 error 文本（`friendlyErrorMessage`
   * 会吞细节），webview 要 l10n 文案——两边各取所需，判据只有这一份。
   */
  source?: ErrorEvent | AbortedEvent;
}

/**
 * 从一轮的过程事件推导「谁停的」
 *
 * 判定顺序与 `decideTerminus` 一致（error 优先，其次 aborted）；差异只在兜底：
 * 无事件时，`hostAborted === true` 才是用户（宿主 abort 的唯一生产点是用户停止），
 * 否则如实 `unavailable`。
 *
 * @param events 该轮的 `processEvents`（运行时累积或盘上读回，同一形状）
 * @param opts.hostAborted 宿主这一轮是否真的 abort 过（`controller.signal.aborted`）
 * @returns 停手者分档 + 原始事件
 */
export function deriveInterruptReason(
  events: readonly ProcessEvent[],
  opts: { hostAborted?: boolean } = {},
): InterruptReason {
  // ① error 优先：与 decideTerminus 的保守排序同源（二者本应互斥，此序只防异常组合）
  const errorEvent = events.find((e): e is ErrorEvent => e.type === 'error');
  if (errorEvent) return { stopper: 'error', source: errorEvent };

  // ② aborted：stopReason 是结构化的「谁让它停」，reason 只是自由文本描述
  const aborted = events.find((e): e is AbortedEvent => e.type === 'aborted');
  if (aborted) {
    const stopReason = aborted.payload.stopReason;
    if (stopReason === 'user') return { stopper: 'user', source: aborted };
    if (stopReason === 'timeout') return { stopper: 'timeout', source: aborted };
    // 'interrupted' 的唯一生产者 = 崩溃打捞（宿主重启时补写）⇒ 归「异常退出后恢复」
    if (stopReason === 'interrupted') return { stopper: 'recovered', source: aborted };
    // 'connection' 目前无生产者；未登记值同样不冒充任何人
    return { stopper: 'unavailable', source: aborted };
  }

  // ③ 无事件：只有宿主确实 abort 过才归用户（可测事实），否则取不到原因
  return opts.hostAborted ? { stopper: 'user' } : { stopper: 'unavailable' };
}
