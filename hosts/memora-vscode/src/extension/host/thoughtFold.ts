/**
 * thought 落盘折叠 — 展示侧全量、落盘侧按 step 聚合
 *
 * 为什么独立成文件（自 chatPanel.ts 拆出）：chatPanel 是贴 eslint max-lines 上限的
 * TARGET 文件（只降不升），本域是「一份长不变量说明 + 一个纯函数」的完整闭环，
 * 留在面板类旁只是被连带挤占行数。纯逻辑零宿主依赖，测试直接驱动。
 */
import type { ProcessEvent } from '@zooique/memora';

/**
 * thought 落盘截断上限（字符；Turn 意图理解与模型思考展示设计）：
 * 模型思考内容可能很长（deepseek 深度思考数千 token），落盘前截断防 Round 文件膨胀
 * （SSOT 常量：仅宿主落盘侧消费；展示侧流式全量，不受影响）。命名与既有 thinking 相位事件无关。
 */
export const MAX_THOUGHT_PAYLOAD_LENGTH = 4000;

/**
 * thought 增量按 step 聚合（落盘前折叠）：同 stepIndex 的**相邻** thought 碎片合并为
 * ≤MAX_THOUGHT_PAYLOAD_LENGTH 的批次事件。真机 1.37MB 级 round 文件的主因是 7000+
 * 碎片信封开销（seq/ts/type/payload 键）而非思考正文——折叠后信封数 ≈ 正文字符/上限。
 *
 * 三条不变量：
 * - **内容零损失**：批次满则开新批（单碎片超限已在 emit 侧截断，本函数不二次截断）；
 * - **seq 幂等兼容**：批次 seq/ts 取首碎片，同输入恒同结果——step 边界检查点与流尾终局
 *   两次折叠对 mergeProcessEvents 的 seq 去重天然幂等；
 * - **UI 流式不变**：仅落盘侧折叠（emitEvent 即时投影仍逐碎片）；重放渲染无差
 *   （webview 本就按 stepIndex 把连续碎片聚成一个折叠块，批次边界恰是其归桶边界）。
 *
 * ⚠️ **前提不变量（破坏即静默丢内容，见 tasks/待完成任务.md T4-FOLD-1）**：seq 幂等成立依赖
 * 「检查点只在 step 边界触发 + 同 step 碎片在其 step_boundary 前已完整」——此时两次折叠的
 * 批次构成恒相同。若未来检查点提前到 step 中途（心跳检查点 / 中途 flush），同一 run 的碎片
 * 会跨两次折叠变形（首批 seq 不变但内容更长），mergeProcessEvents 按 seq 去重会**静默丢弃**
 * 长版 = 内容丢失。届时须先改为流式有状态折叠（emit 时折、检查点只 flush）。
 */
export function foldThoughtEvents(events: ProcessEvent[]): ProcessEvent[] {
  const out: ProcessEvent[] = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (
      ev.type === 'thought' &&
      prev?.type === 'thought' &&
      prev.payload.stepIndex === ev.payload.stepIndex &&
      prev.payload.content.length + ev.payload.content.length <= MAX_THOUGHT_PAYLOAD_LENGTH
    ) {
      // 拷贝后替换，不原地改 prev（prev 与 eventsByRound 缓冲可能共享引用）
      out[out.length - 1] = {
        ...prev,
        payload: { ...prev.payload, content: prev.payload.content + ev.payload.content },
      };
      continue;
    }
    out.push(ev);
  }
  return out;
}
