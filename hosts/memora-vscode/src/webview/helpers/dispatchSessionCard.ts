/**
 * 盖章会话卡（DISPATCH-CARD-INLINE-1）——对话区的第三种信息形态
 *
 * 心智：会话卡既非用户输入、也非助手回复，而是「被 memora 宝盖章启动的会话」独立存在。
 * 按用户 2026-11-19 真机拍板（参考 trae 宝）：卡片**按时间顺序穿插进助手会话的对话气泡之间**，
 * 每张卡紧跟触发它的那轮助手消息——不是脱离对话内容的顶部固定卡区。
 *
 * 数据真源（宿主下发，webview 只投影不推断）：
 *   - sid / via / title：来自 `session_activity.dispatchedSessions`（真名由宿主 sessionTitleFor 取）；
 *   - 运行中旋转：来自 `session_activity.runningIds`（真源 = 运行态表）；
 *   - 触发轮锚点：webview 侧现场解析——replay 用每轮 processEvents（dispatchedSidsFromEvents），
 *     实时用当前渲染轮 id。宿主无需下发 roundId（派发受理时触发轮尚未落盘，宿主拿不到）。
 *
 * 本模块是纯 DOM 投影：先撤旧卡（幂等），再按锚点插卡，不持状态、不注册监听。
 * 生命周期：跑完卡仍在（盖章是既成事实）；只有会话从盖章列表移除才撤卡。
 * 点击不在这里处理：复用 chatView 的 document click 委托（data-dispatch-session → switch_session），
 * 本模块只负责给按钮打锚点。
 */
import { getIconSvg } from '../scripts/icons.js';

/** 卡片锚点属性（点击委托与去重遍历共用） */
export const DISPATCH_SESSION_ATTR = 'data-dispatch-session';

/** 卡片节点的 class（resetChatView 清理、幂等撤卡共用） */
export const DISPATCH_CARD_CLASS = 'dispatch-session-card';

/** 一条盖章会话（形状与 protocol.ts dispatchedSessions 元素同构） */
export interface DispatchedSessionView {
  sid: string;
  title: string;
  via: 'delegate' | 'create';
}

/**
 * 造一张会话卡骨架（名字/旋转态由渲染填）。
 *
 * @param doc DOM 文档对象（由调用方注入，模块内不读全局 document）
 * @param sid 目标会话 id（真源 = dispatchedSessions[].sid）
 */
export function buildDispatchSessionCard(doc: Document, sid: string): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = DISPATCH_CARD_CLASS;
  btn.setAttribute(DISPATCH_SESSION_ATTR, sid);
  // 图标只是装饰；状态由下方文字 + class 表达，读屏无需重复
  const icon = doc.createElement('span');
  icon.className = 'dispatch-session-card__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = getIconSvg('assistant', 13, 13); // 静态 SVG，无外部输入
  const name = doc.createElement('span');
  name.className = 'dispatch-session-card__name';
  // 未拿到标题快照前先显示 sid（不空着、不编名字）；渲染到达后覆盖
  name.textContent = sid;
  btn.append(icon, name);
  return btn;
}

/**
 * 撤掉消息流里所有盖章卡（幂等重建第一步）。
 *
 * @param messages 消息流容器（#messages）
 * @returns 撤掉的卡数（供测试/诊断）
 */
export function removeDispatchCards(messages: HTMLElement): number {
  const cards = Array.from(messages.querySelectorAll<HTMLElement>(`.${DISPATCH_CARD_CLASS}`));
  for (const card of cards) card.remove();
  return cards.length;
}

/**
 * 把盖章卡按触发轮锚点插进消息流（全量重建：先撤旧卡再逐张插，天然幂等）。
 *
 * 锚点规则（sid → roundId）：
 *   - 有锚点且消息流里存在 `[data-round-id=锚点]` 的消息/轮容器 ⇒ 卡插到该轮**最后一条**相关节点之后
 *     （同一轮可能有多条 .msg：user + 若干 assistant；取最后一条，卡落在轮尾、时间顺序正确）；
 *   - 无锚点 / 锚点节点已不在流里（如被删除）⇒ 卡落**流尾**兜底（仍属对话内容，不脱离）。
 *
 * 顺序：先按 sessions 下发顺序插（宿主已按最近 turn 时间排序）；同锚点多张卡保持该顺序。
 * 这样「按时间自然平铺」= 轮间按轮序、轮内按宿主时间序。
 *
 * @param messages 消息流容器（#messages）
 * @param sessions 盖章会话列表（真源 = session_activity.dispatchedSessions）
 * @param runningIds 正在跑流的会话 id（真源 = session_activity.runningIds）
 * @param anchors sid → 触发轮 id（webview 现场解析；缺失即落流尾）
 */
export function renderDispatchCards(
  messages: HTMLElement,
  sessions: readonly DispatchedSessionView[],
  runningIds: readonly string[],
  anchors: ReadonlyMap<string, string>,
): void {
  removeDispatchCards(messages);
  const running = new Set(runningIds);
  const seen = new Set<string>();
  /** 每个锚点轮的"最后插入位"——同轮多张卡依次接龙，保持 sessions 下发顺序（y 不抢到 x 前） */
  const anchorCursor = new Map<string, Element>();
  for (const s of sessions) {
    if (!s.sid || seen.has(s.sid)) continue; // sid 去重：会话维度一张卡
    seen.add(s.sid);
    const card = buildDispatchSessionCard(messages.ownerDocument, s.sid);
    const name = card.querySelector<HTMLElement>('.dispatch-session-card__name');
    const title = s.title || s.sid; // 真名为空回落 sid，不写空串冒充
    if (name) name.textContent = title;
    card.title = title;
    card.setAttribute('aria-label', title);
    card.classList.toggle('is-running', running.has(s.sid));
    card.dataset.via = s.via;

    const anchorRound = anchors.get(s.sid);
    if (anchorRound && anchorCursor.has(anchorRound)) {
      // 同轮已有前一张卡：接在它后面，保持 sessions 顺序
      anchorCursor.get(anchorRound)!.after(card);
      anchorCursor.set(anchorRound, card);
      continue;
    }
    // 不用 CSS.escape（jsdom/部分 webview 无此 API）：直接比对 dataset，天然防特殊字符注入
    const anchorNodes = anchorRound
      ? Array.from(messages.querySelectorAll<HTMLElement>('[data-round-id]')).filter(
          (el) => el.dataset.roundId === anchorRound,
        )
      : [];
    const last = anchorNodes.at(-1);
    // 不用 isConnected：测试/游离 DOM 树里节点未挂 document 时为 false，但 anchorNodes 本就
    // 从 messages.querySelectorAll 查出、必属此树 ⇒ 非空即可安全 after()。
    if (last) {
      // 卡插在轮尾：若末节点在 .round-group 内，插到容器之后（footer 之后），
      // 不落在复制/删除栏与正文之间。
      const group = last.closest('.round-group');
      const target = group ?? last;
      target.after(card);
      anchorCursor.set(anchorRound!, card);
    } else {
      messages.appendChild(card);
    }
  }
}
