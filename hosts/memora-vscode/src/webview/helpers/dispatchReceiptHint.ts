/**
 * 派发凭证行（DISPATCH-RECEIPT-1）——事实呈现 + 幂等 DOM 投影
 *
 * 解决的问题：助手嘴上说「已派」而用户看不到系统事实。本模块只在**业务受理成功**
 * 时挂一行凭证；无回执的轮一个字不加，DOM 与普通对话轮逐节点一致。凭证不是完成态
 * 判定——不改助手正文、不改 `Round.status`、不改 `metrics.success`。
 *
 * 唯一判据 = `dispatchedSidTextsFromEvents` 非空（既有回执解析，单源）。
 * 不读正文、不读轮状态、不读用户意图：中断 / 进行中的轮只要有受理回执也显示，
 * 因为回执本身是系统事实；「半截断言」是补派门的事，已按运行边界外置到宿主侧
 * `dispatchRepairGate.ts`（webview 运行时禁止值导入内核）。
 *
 * 多条派发合并为一行并报总数：总数直接取同一份解析结果的 `items.length`，不重算。
 */
import * as l10n from '@vscode/l10n';
import { dispatchedSidTextsFromEvents, type DispatchedSidText } from './processEventText.js';
import type { ProcessEvent } from '@zooique/memora';

/** 凭证行 class（气泡下的常显单行，不长成卡片、无图标、不可点） */
export const DISPATCH_RECEIPT_CLASS = 'round-group__dispatch-receipt';

/**
 * 会话标题来源（结构最小接口）
 *
 * `createDispatchCardProjection` 的实例天然满足（已持 `dispatchedSessions` 快照），
 * 故 chatView 直接传实例即可，无需在调用点再包一层 lambda（也避免双份接线）。
 */
export interface DispatchTitleSource {
  /** sid → 会话标题；取不到返回 undefined（调用方降级显示 sid） */
  titleFor(sid: string): string | undefined;
}

/**
 * 本轮凭证文案（助手形态气泡下的一行）
 *
 * 只对**业务受理成功**的回执产出文本（判据 = 既有 `isAcceptedDispatchResult` 的消费面
 * `dispatchedSidTextsFromEvents`，不新增判据、不读正文）。无回执 ⇒ undefined，调用方
 * 一个字都不加——这是本批的核心：让没有凭证的轮看起来就是一句普通的话。
 *
 * 多条派发合并为一行并报总数：总数直接取 items.length（同一份已算好的结果，不重算、不新增
 * 事实源）；单派走原键原句，多派另有键（≥2 才用，「等 N 个」的计数歧义由此规避）。
 *
 * @param items 本轮成功盖章的 (sid, text, via) 列表
 * @param titles 会话标题来源（取不到返回 undefined，降级显示 sid，不编造）
 * @returns 一行短文案；无回执返回 undefined
 */
export function dispatchReceiptText(
  items: readonly DispatchedSidText[],
  titles: DispatchTitleSource,
): string | undefined {
  const first = items[0];
  if (!first) return undefined;
  const title = titles.titleFor(first.sid) ?? first.sid;
  // 单派（绝大多数情况）：文案逐字不变，不被多派计数污染成「等 1 个」
  if (items.length === 1) {
    return first.via === 'create'
      ? l10n.t('Created session “{0}” · receipt confirmed', title)
      : l10n.t('Dispatched to “{0}” · receipt confirmed', title);
  }
  // 多派：总数前置 + 「含」指出被命名的那一条，规避「等 N 个」的两派读法
  const count = String(items.length);
  // 全部 create 才说「已新建」；混合轮一律「已派给」——说成「新建 N 个」是撒谎
  const allCreated = items.every((it) => it.via === 'create');
  return allCreated
    ? l10n.t('Created {0} sessions (incl. “{1}”) · receipt confirmed', count, title)
    : l10n.t('Dispatched to {0} sessions (incl. “{1}”) · receipt confirmed', count, title);
}

/**
 * 幂等投影：先撤旧凭证行，再按判据决定是否挂一条
 *
 * 只助手形态生效（与盖章卡同构）；插入位置沿用既有位置族（footer 之前，常显）。
 * 无凭证时**只撤不加**——不产生任何占位、灰字或提示。
 *
 * @param doc DOM 文档（调用方注入，模块内不读全局 document）
 * @param group 该轮的 `.round-group` 容器
 * @param text 凭证文案（undefined = 本轮无回执）
 */
function applyDispatchReceipt(
  doc: Document,
  group: HTMLElement | null,
  text: string | undefined,
): void {
  if (!group) return;
  group.querySelector(`.${DISPATCH_RECEIPT_CLASS}`)?.remove();
  if (!text || doc.body.dataset.form !== 'assistant') return;
  const line = doc.createElement('div');
  line.className = DISPATCH_RECEIPT_CLASS;
  line.textContent = text;
  const foot = group.querySelector('.round-group__footer');
  if (foot) group.insertBefore(line, foot);
  else group.appendChild(line);
}

/** 投影所需的最小轮形状（避免 helper 依赖整个协议类型） */
export interface DispatchHintRound {
  id: string;
  /** 过程事件（回执判据的唯一输入；轮状态不参与凭证） */
  processEvents?: readonly ProcessEvent[];
}

/**
 * 轮级投影入口（重放 / 实时共用，避免 chatView 里出现两份接线）
 *
 * 按 `data-round-id` 定位该轮容器；判据唯一：`dispatchedSidTextsFromEvents(events)` 非空。
 *
 * @param doc DOM 文档
 * @param root 消息容器（`#messages`）
 * @param round 该轮（过程事件）
 * @param titles 会话标题来源（传 `dispatchCards` 实例即可）
 */
export function projectDispatchReceiptInRound(
  doc: Document,
  root: ParentNode,
  round: DispatchHintRound,
  titles: DispatchTitleSource,
): void {
  const group =
    Array.from(root.querySelectorAll<HTMLElement>('.round-group')).find(
      (el) => el.dataset.roundId === round.id,
    ) ?? null;
  applyDispatchReceipt(
    doc,
    group,
    dispatchReceiptText(dispatchedSidTextsFromEvents(round.processEvents ?? []), titles),
  );
}
