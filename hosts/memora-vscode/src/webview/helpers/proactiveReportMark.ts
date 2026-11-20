/**
 * 「助手主动开口」的身份标注（PROACTIVE-REPORT-1，2026-11-20 用户拍板）
 *
 * 问题：助手形态把所有身份标签藏了（chatStyles 的 `body[data-form='assistant']` 段），
 * 普通回答靠「上一条是用户」自证归属；落定汇报前面没有用户气泡，于是成了没有身份的第四种东西。
 *
 * 为什么外置：chatView.ts 卡在 max-lines 上限（2600），呈现工具放 helper 里自然生长，
 * 不删注释、不压平既有代码。
 *
 * 判据不在这里：调用方按 `isInternalSeedSender` 单点算好再调（实时与重放同一判据）。
 */
import { HOSTED_SENDER_NAME } from '../../shared/constants.js';

/**
 * 给一条已创建的 assistant 消息加身份标注
 *
 * 只做两件事：加类（CSS 仅对该类解除标签隐藏，普通回答的隐藏按 2026-11-16 定案不动）、
 * 把已有身份标签的角色名换成统一身份名（`HOSTED_SENDER_NAME`，全仓唯一取值点）。
 *
 * @param el 该轮已创建的 assistant 消息元素（label 已由 buildAssistantShell 建好）
 */
export function markProactiveReport(el: HTMLElement): void {
  el.classList.add('msg-ai--proactive');
  const roleEl = el.querySelector<HTMLElement>(':scope > .msg-ai-label .msg-ai-label__role');
  if (roleEl) roleEl.textContent = HOSTED_SENDER_NAME;
}
