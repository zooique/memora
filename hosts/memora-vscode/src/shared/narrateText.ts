/**
 * 过程叙述（narrate）文本派生 —— 单点实现（webview 复制源 / 宿主打捞落盘共用）
 *
 * 为什么必须只有一份：同一轮的「过程叙述拼起来是什么」被两处消费，而两处的产物用户都会看到——
 *   ① webview：中断轮的「复制」把该文本写进 `dataset.rawText`（`processFlowModel` 曾自持实现）；
 *   ② 宿主：崩溃残留轮打捞时派生为恢复后的 `assistantMessage.content`（`interruptedSalvage`）。
 * 两处一旦各写一遍，同一轮的「复制出来的文本」与「重启后恢复出来的文本」就会不一致——
 * 这类分叉不会有任何报错，只会让用户觉得「复制跟看到的不一样」。
 *
 * 拼接口径 = **换行**，不是空串：每个 narrate 事件是**一次工具迭代的完整叙述段**
 * （内核 `loop` 在工具分支 emit 的 `(streamedText + pendingNarrate).trim()`），段间原有的
 * 空白已被 trim 掉，空串拼接会把两段粘成一句（"先读文档然后改配置"）。
 *
 * 排序：按 `seq` 升序。消费方传进来的数组通常已有序，排序只是让「乱序输入」也不出错——
 * 成本是一次短数组排序，收益是不依赖上游的数组顺序契约。
 *
 * 纯函数、只有 `import type`：webview 与 extension 两个 bundle 都能安全共用
 * （webview 侧不得有内核运行时依赖）。
 */

import type { ProcessEvent } from '@zooique/memora';

/**
 * 把过程事件里的叙述段拼成一段可读文本。
 *
 * @param events 该轮的 `processEvents`（缺省 = 未落盘/空轮 ⇒ 空串）
 * @returns 无 narrate 事件时返回空串（调用方据此不写 assistantMessage / 不设 rawText）
 */
export function deriveNarrateText(events: readonly ProcessEvent[] | undefined): string {
  return (events ?? [])
    .filter((e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.payload.content)
    .join('\n');
}
