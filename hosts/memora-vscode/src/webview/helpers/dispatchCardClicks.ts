/**
 * 盖章会话卡点击委托（DISPATCH-CARD-TURN-1）——chatView 域外置
 *
 * 两个 document 级委托必须成对：① 点卡不算「用户接管折叠」（summary/details 闩）；
 * ② 点卡 preventDefault 阻止 details 原生开合并上报 switch_session（带本卡 turn 锚点）。
 * 曾写在 chatView 内，撑破 max-lines 基线；本模块无 DOM 全局，document 由调用方注入。
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import { DISPATCH_ROUND_ATTR, DISPATCH_SESSION_ATTR } from './dispatchSessionCard.js';

/** webview → 宿主的单点投递口（由 chatView 注入 vscode.postMessage） */
type Post = (msg: WebviewToExtensionMessage) => void;

export function initDispatchCardClicks(doc: Document, post: Post): void {
  // 用户折叠意图闩：点卡只切会话，不算接管 details 开合。
  doc.addEventListener('click', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.(`[${DISPATCH_SESSION_ATTR}]`)) return;
    const summary = (e.target as HTMLElement | null)?.closest?.('summary');
    const details = summary?.closest('details');
    if (details) details.dataset.userToggled = 'true';
  });

  // 卡片出口：复用 switch_session，带本卡 turn 锚点（工作台/历史浮层发的无锚点版本不变）。
  doc.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement | null)?.closest?.(`[${DISPATCH_SESSION_ATTR}]`);
    if (!card) return;
    e.preventDefault();
    const sid = card.getAttribute(DISPATCH_SESSION_ATTR);
    if (!sid) return;
    const roundId = card.getAttribute(DISPATCH_ROUND_ATTR);
    post({
      type: 'switch_session',
      sessionId: sid,
      ...(roundId ? { roundId } : {}),
    });
  });
}
