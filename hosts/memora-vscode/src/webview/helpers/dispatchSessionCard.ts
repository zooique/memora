/**
 * 派活会话卡 — 工具行内的「打开目标会话」入口（DISPATCH-SESSION-CARD-1）
 *
 * 为什么是工具行而非气泡底栏：一次回答可派多个会话，卡片必须与**每一次** send_to_session
 * 调用一一绑定；sid 就在该工具行的 `args` 里，是唯一不会张冠李戴的锚点。气泡底栏是轮级
 * 操作面（一轮一个），挂那里会让「派给谁」和「哪次派」失去对应。
 *
 * 数据分两路、真源唯一：
 *   - sid：来自工具入参 `send_to_session.args.sid`（落盘事实，随工具行下发）；
 *   - 展示名 + 是否运行：来自宿主 `session_activity` 的 `titleById` / `runningIds`
 *     （真源 = sessionTitleFor / 会话级运行态表，webview 只投影不推断）。
 * 故本模块是纯函数：产 DOM 骨架 + 按快照刷新，不持状态、不注册监听。
 *
 * 点击不在这里处理：委托留在 chatView 的 document click（动态渲染的元素统一走委托），
 * 本模块只负责给按钮打 `data-dispatch-session="sid"` 锚点。
 */
import { getIconSvg } from '../scripts/icons.js';

/** 卡片锚点属性（点击委托与刷新遍历共用） */
export const DISPATCH_SESSION_ATTR = 'data-dispatch-session';

/**
 * 造一张派活会话卡骨架（名字/旋转态留给 refresh 填）。
 *
 * @param doc DOM 文档对象（由调用方注入，模块内不读全局 document）
 * @param sid 目标会话 id（真源 = send_to_session.args.sid）
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
  // 未拿到标题快照前先显示 sid（不空着、不编名字）；refresh 到达后覆盖
  name.textContent = sid;
  btn.append(icon, name);
  return btn;
}

/**
 * 按最新活跃度快照刷新当前视图内所有派活会话卡。
 *
 * 两处细节：
 *   - 标题未命中（会话已离开遍历面 / 快照未到）时保留骨架已有的 sid，不用空串冒充；
 *   - 旋转态用 class 切换而非新增环节点（环由 CSS ::after + toolSpinner 承担，零新令牌）。
 *
 * @param root 查询根（document 或某个容器）
 * @param titleById sid → 展示名（来自 session_activity.titleById）
 * @param runningIds 正在跑流的会话 id（来自 session_activity.runningIds）
 */
export function refreshDispatchSessionCards(
  root: ParentNode,
  titleById: Record<string, string>,
  runningIds: readonly string[],
): void {
  const running = new Set(runningIds);
  for (const card of root.querySelectorAll<HTMLElement>(`[${DISPATCH_SESSION_ATTR}]`)) {
    const sid = card.getAttribute(DISPATCH_SESSION_ATTR);
    if (!sid) continue;
    const name = card.querySelector<HTMLElement>('.dispatch-session-card__name');
    const title = titleById[sid];
    if (name && title) name.textContent = title;
    card.title = title ?? sid;
    card.setAttribute('aria-label', card.title);
    card.classList.toggle('is-running', running.has(sid));
  }
}
