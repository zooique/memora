/**
 * 消息体内的有序插入工具（CHATVIEW-SLIM-2 第 5 刀·零状态批，自 chatView.ts 外置）
 *
 * 跨域使用（过程流行构造 + 记忆命中块），故独立成件而非并入某个视图模块。
 *
 * @module insertBeforeBody
 */

/**
 * 「过程在上 · 报告在下」挂载锚点（SSOT）：把过程类元素插到 assistant 块报告正文之前。
 *
 * 两处挂载点共用同一实现，杜绝措辞/语义漂移：
 *   ① ensureProcessFlow（运行时平铺容器 .process-flow）
 *   ② ensureRoundBlock（finalize 折叠区 .round-block）
 *
 * 三段式降级：`.msg-body` 存在 → 插到它之前；否则紧随 `.msg-ai-label`；再否则 prepend。
 *
 * 运行时**无 round-block**，锚点不得依赖它——以它为锚时 querySelector 恒返回 null，
 * 而 insertBefore(el, null) 按 DOM 规范退化为 appendChild，元素落到 assistant 块最末
 * （正文 .msg-body 与 .msg-footer 之后）= 会话内容底部（坑）。
 *
 * @param host assistant 容器（.msg.assistant）
 * @param el 待挂载的过程类元素
 */
export function insertBeforeBody(host: HTMLElement, el: HTMLElement): void {
  const msgBody = host.querySelector(':scope > .msg-body');
  if (msgBody) {
    host.insertBefore(el, msgBody);
    return;
  }
  const label = host.querySelector(':scope > .msg-ai-label');
  if (label) {
    label.after(el);
    return;
  }
  host.prepend(el);
}
