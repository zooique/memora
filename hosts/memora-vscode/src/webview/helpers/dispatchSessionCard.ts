/**
 * 盖章会话卡（DISPATCH-CARD-TURN-1）——对话区的第三种信息形态
 *
 * 心智：卡片身份不是会话，而是**该会话的一次派活 turn**（sid + roundId）。名字只是给人看的
 * 会话标签；同一会话在不同轮派活会出现多张同名卡，各自钉死在触发轮，后续新 turn 不移动旧卡。
 * 按用户 2026-11-21 真机改判：翻历史时"当时那次派活"必须留在原地。
 *
 * 数据真源（宿主下发，webview 只投影不推断）：
 *   - sid / via / title：来自 `session_activity.dispatchedSessions`（存在性与展示名真源）；
 *   - turn 锚点：webview 从 replay 的 processEvents 或实时 `process_event.roundId` 现场解析，
 *     按 `(sid, roundId)` 登记（见 dispatchCardProjection），宿主在派发受理当下拿不到 roundId；
 *   - 运行中旋转：来自 `session_activity.runningIds`（真源 = 运行态表）。
 *
 * 本模块是纯 DOM 投影：先撤旧卡（幂等），再按轮锚点插卡，不持状态、不注册监听。
 * 生命周期：跑完卡仍在（盖章是既成事实）；只有会话从盖章列表移除才撤卡。
 * 点击不在这里处理：复用 chatView 的 document click 委托（data-dispatch-session +
 * data-dispatch-round → switch_session），本模块只负责给按钮打锚点。
 */
import { getIconSvg } from '../scripts/icons.js';

/** 卡片锚点属性（点击委托与去重遍历共用） */
export const DISPATCH_SESSION_ATTR = 'data-dispatch-session';

/** 卡片对应的 turn 锚点（点击携带；与会话名标签分离） */
export const DISPATCH_ROUND_ATTR = 'data-dispatch-round';

/** 派活原文（跨会话定位锚：助手轮 roundId 在目标会话不存在，靠这句逐字配对） */
export const DISPATCH_TEXT_ATTR = 'data-dispatch-text';

/** 卡片节点的 class（resetChatView 清理、幂等撤卡共用） */
export const DISPATCH_CARD_CLASS = 'dispatch-session-card';

/** 一条盖章会话（形状与 protocol.ts dispatchedSessions 元素同构） */
export interface DispatchedSessionView {
  sid: string;
  title: string;
  via: 'delegate' | 'create';
}

/** 一张卡的身份：会话 + 那次派活 turn（roundId 只作身份去重；text 才是跨会话定位锚） */
export interface DispatchCardEntry {
  sid: string;
  roundId?: string;
  text?: string;
}

/**
 * 造一张会话卡骨架（名字/旋转态由渲染填）。
 *
 * @param doc DOM 文档对象（由调用方注入，模块内不读全局 document）
 * @param sid 目标会话 id（真源 = dispatchedSessions[].sid）
 * @param roundId 该次派活所在 turn（真源 = 事件解析结果）
 */
export function buildDispatchSessionCard(
  doc: Document,
  sid: string,
  roundId?: string,
  text?: string,
): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = DISPATCH_CARD_CLASS;
  btn.setAttribute(DISPATCH_SESSION_ATTR, sid);
  if (roundId) btn.setAttribute(DISPATCH_ROUND_ATTR, roundId);
  if (text) btn.setAttribute(DISPATCH_TEXT_ATTR, text);
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
 * 把盖章卡按 turn 锚点插进消息流（全量重建：先撤旧卡再逐张插，天然幂等）。
 *
 * 规则（DISPATCH-CARD-TURN-1）：
 *   - 身份 = `(sid, roundId)`，同一会话多轮 → 多张同名卡，各自插在对应轮尾，互不顶替；
 *   - 该轮的节点已不在流里 ⇒ 卡落流尾兜底（仍属对话内容，不脱离）；
 *   - 存在性与展示名只认当前快照：会话从盖章列表移除 ⇒ 不再渲染。
 *
 * 顺序：按快照顺序（宿主已按最近 turn 时间降序），同会话多轮按 entries 登记时序接龙。
 * 回执未到但**正在跑**的会话先出一张无锚卡落流尾——存在性不依赖 tool_result（DISPATCH-CARD-LIVE-1）；
 * 不在跑且无轮锚的会话仍不凭存在性编卡（旧判据保留，防残留快照凭空插卡）。
 *
 * @param messages 消息流容器（#messages）
 * @param sessions 盖章会话列表（真源 = session_activity.dispatchedSessions，**存在性唯一闸门**）
 * @param runningIds 正在跑流的会话 id（真源 = session_activity.runningIds）
 * @param entries 轮锚点列表（真源 = webview 现场解析的 sid + roundId；只决定卡插在哪轮，不决定出不出卡）
 */
export function renderDispatchCards(
  messages: HTMLElement,
  sessions: readonly DispatchedSessionView[],
  runningIds: readonly string[],
  entries: readonly DispatchCardEntry[],
): void {
  removeDispatchCards(messages);
  const running = new Set(runningIds);
  const seen = new Set<string>();
  /** 每个锚点轮的"最后插入位"——同轮多张卡依次接龙，保持登记顺序 */
  const anchorCursor = new Map<string, Element>();
  // entries 只按 sid 归集轮锚，存在性仍只认快照。create_session 的 tool_result 要等首轮
  // runFlow 收场才回执（hostedSessionCreate 在 await startFlow 后才 return），若拿 entries
  // 当存在性闸门，卡片会晚一个 turn 才上屏；而快照在受理瞬间（onCreated 记账本）已含该 sid。
  const anchorsBySid = new Map<string, DispatchCardEntry[]>();
  for (const entry of entries) {
    const list = anchorsBySid.get(entry.sid);
    if (list) list.push(entry);
    else anchorsBySid.set(entry.sid, [entry]);
  }

  /** 落一张卡；anchor 缺省 = 回执未到，先落流尾，回执到位后由同函数按锚重排（不产第二张） */
  const place = (meta: DispatchedSessionView, anchor?: DispatchCardEntry): void => {
    const key = `${meta.sid.length}:${meta.sid}:${anchor?.roundId ?? ''}`;
    if (seen.has(key)) return; // 同一 turn 同一会话幂等；不再按 sid 全局去重
    seen.add(key);
    const card = buildDispatchSessionCard(
      messages.ownerDocument,
      meta.sid,
      anchor?.roundId,
      anchor?.text,
    );
    const name = card.querySelector<HTMLElement>('.dispatch-session-card__name');
    const title = meta.title || meta.sid; // 真名为空回落 sid，不写空串冒充
    if (name) name.textContent = title;
    card.title = title;
    card.setAttribute('aria-label', title);
    card.classList.toggle('is-running', running.has(meta.sid));
    card.dataset.via = meta.via;

    const anchorRound = anchor?.roundId;
    if (anchorRound && anchorCursor.has(anchorRound)) {
      anchorCursor.get(anchorRound)!.after(card);
      anchorCursor.set(anchorRound, card);
      return;
    }
    // 不用 CSS.escape（jsdom/部分 webview 无此 API）：直接比对 dataset，天然防特殊字符注入
    const anchorNodes = anchorRound
      ? Array.from(messages.querySelectorAll<HTMLElement>('[data-round-id]')).filter(
          (el) => el.dataset.roundId === anchorRound,
        )
      : [];
    const last = anchorNodes.at(-1);
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
  };

  for (const meta of sessions) {
    const anchors = anchorsBySid.get(meta.sid);
    if (!anchors?.length) {
      // 只在「正在跑」时先出无锚卡：turn 起流瞬间快照已含身份（onCreated 记账本）且
      // runningIds 已置位，不必等 tool_result；不跑的会话仍按旧判据不凭存在性编卡
      // （重启后的历史会话 / reset 后残留快照不会被凭空插一张指向它的卡）。
      if (running.has(meta.sid)) place(meta);
      continue;
    }
    for (const anchor of anchors) place(meta, anchor);
  }
}
