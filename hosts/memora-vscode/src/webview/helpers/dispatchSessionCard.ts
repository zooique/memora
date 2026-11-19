/**
 * 盖章会话卡区（DISPATCH-CARD-ZONE-1）——对话区的第三种信息形态
 *
 * 心智：会话卡既非用户输入、也非助手回复，而是「被 memora 宝盖章启动的会话」独立存在。
 * 判据只有一条：`session_activity.dispatchedSessions`（被助手会话盖章启动过的会话列表），
 * 与它是被哪句话触发的无关。故卡片渲染在独立卡区（#dispatchSessionCardZone），不再嵌工具行。
 *
 * 数据真源（宿主下发，webview 只投影不推断）：
 *   - sid / via / title：来自 `session_activity.dispatchedSessions`（真名由宿主 sessionTitleFor 取）；
 *   - 运行中旋转：来自 `session_activity.runningIds`（真源 = 运行态表）。
 * 本模块是纯函数：按列表全量重建卡片 DOM，不持状态、不注册监听。
 *
 * 生命周期：跑完卡仍在（盖章是既成事实）；只有会话从盖章列表移除才撤卡。
 * 点击不在这里处理：复用 chatView 的 document click 委托（data-dispatch-session → switch_session），
 * 本模块只负责给按钮打锚点。
 */
import { getIconSvg } from '../scripts/icons.js';

/** 卡片锚点属性（点击委托与去重遍历共用） */
export const DISPATCH_SESSION_ATTR = 'data-dispatch-session';

/** 一条盖章会话（形状与 protocol.ts dispatchedSessions 元素同构） */
export interface DispatchedSessionView {
  sid: string;
  title: string;
  via: 'delegate' | 'create';
}

/**
 * 造一张会话卡骨架（名字/旋转态由 render 填）。
 *
 * @param doc DOM 文档对象（由调用方注入，模块内不读全局 document）
 * @param sid 目标会话 id（真源 = dispatchedSessions[].sid）
 */
export function buildDispatchSessionCard(doc: Document, sid: string): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'dispatch-session-card';
  btn.setAttribute(DISPATCH_SESSION_ATTR, sid);
  // 图标只是装饰；状态由下方文字 + class 表达，读屏无需重复
  const icon = doc.createElement('span');
  icon.className = 'dispatch-session-card__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = getIconSvg('assistant', 13, 13); // 静态 SVG，无外部输入
  const name = doc.createElement('span');
  name.className = 'dispatch-session-card__name';
  // 未拿到标题快照前先显示 sid（不空着、不编名字）；render 到达后覆盖
  name.textContent = sid;
  btn.append(icon, name);
  return btn;
}

/**
 * 按盖章列表全量重建独立卡区（会话维度一张卡，sid 去重）。
 *
 * 全量重建而非增量打补丁：列表本身就是真源的投影，新增/移除/改名一律重建，
 * 保证「跑完卡还在、会话被移除才消失」，且不与落盘/重放产生第二份状态。
 * 卡片顺序沿用下发顺序（宿主已按需要排序），本层不再暗中重排。
 *
 * @param zone 独立卡区容器（#dispatchSessionCardZone）
 * @param sessions 盖章会话列表（真源 = session_activity.dispatchedSessions）
 * @param runningIds 正在跑流的会话 id（真源 = session_activity.runningIds）
 */
export function renderDispatchCardZone(
  zone: HTMLElement,
  sessions: readonly DispatchedSessionView[],
  runningIds: readonly string[],
): void {
  const running = new Set(runningIds);
  const seen = new Set<string>();
  const frag = zone.ownerDocument.createDocumentFragment();
  for (const s of sessions) {
    if (!s.sid || seen.has(s.sid)) continue; // sid 去重：会话维度一张卡
    seen.add(s.sid);
    const card = buildDispatchSessionCard(zone.ownerDocument, s.sid);
    const name = card.querySelector<HTMLElement>('.dispatch-session-card__name');
    const title = s.title || s.sid; // 真名为空回落 sid，不写空串冒充
    if (name) name.textContent = title;
    card.title = title;
    card.setAttribute('aria-label', title);
    card.classList.toggle('is-running', running.has(s.sid));
    card.dataset.via = s.via;
    frag.appendChild(card);
  }
  zone.replaceChildren(frag);
  zone.hidden = seen.size === 0;
}
