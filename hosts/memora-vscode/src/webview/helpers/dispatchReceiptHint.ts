/**
 * 「派活承诺对账」提示（DISPATCH-CLAIM-HINT-1）——判据 + 幂等 DOM 投影
 *
 * 解决的问题：助手正文写「已派给某会话」，但本轮没有任何一次**业务受理成功**的派发回执
 * （零工具，或 send_to_session / create_session 返回 E_BUSY 等业务失败）。既有判据
 * （Round.status / metrics.success / toolFailureCount）只验「有没有坏」，不验「有没有做」。
 *
 * 本模块只做**证据缺口提示**，不做完成态定性：
 *   - 不改助手正文、不改 Round.status、不改 metrics.success；
 *   - 文案固定为「本轮未核到会话派发回执」，禁止升级成「未完成 / 失败 / 没做」。
 *
 * 两个判据同源：
 *   - 回执：直接复用会话卡解析 `dispatchedSidTextsFromEvents`（SSOT，不写第二份配对逻辑）；
 *   - 措辞：窄词表（只作提示器输入，永远是启发式——换词 / 引用 / 假设 / 跨轮复述抓不全）。
 *
 * 呈现纪律：
 *   - 只助手形态（与盖章会话卡同构）；
 *   - 插在 `.round-group` 内、footer 之前（**常显**元素，不挂在 hover 才显形的底栏里）；
 *   - 实时与重放共用同一谓词，实时插入先撤后插（同一轮会多次 turn_update）。
 *
 * 范围边界：只对 `status === 'complete'` 计算——中断轮是用户主动打断，正文可能半截，
 * 把半截断言当成「承诺」会明显增大误报；要放开须单独立项，不在此顺手扩。
 */
import type { ProcessEvent } from '@zooique/memora';
import * as l10n from '@vscode/l10n';
import { isInternalSeedSender } from '../../shared/constants.js';
import { dispatchedSidTextsFromEvents } from './processEventText.js';

/** 提示元素 class（幂等重建与测试定位共用） */
export const DISPATCH_HINT_CLASS = 'round-group__dispatch-hint';

/**
 * 派发义窄词表（只收「明确说派给某处」的写法）
 *
 * 刻意不收（各有误伤面，理由就地写清，不引过程稿）：
 *   - `已完成`：完成态断言，不是派活（实测 7 条命中里 6 条是它，最大误伤源）；
 *   - `已安排`：与任务表 / 计划语义重叠（「已安排好任务项」）；
 *   - `已发送`：可指任意发送，语义过宽；
 *   - `已交给`：多指 delegate_task 或修辞（「交给读者」），本判据只认会话派发。
 */
const DISPATCH_CLAIM_WORDS: readonly string[] = ['已派给', '派给', '已受理并派'];

/**
 * 正文里是否声称「已派活」
 *
 * @param assistantText 该轮终态正文（实时取 turn_update 的 assistantMessage，重放取 RoundView）
 * @returns 命中派发义窄词表即 true
 */
export function hasDispatchClaim(assistantText: string | undefined): boolean {
  const text = assistantText ?? '';
  return DISPATCH_CLAIM_WORDS.some((word) => text.includes(word));
}

/** 完成门判据输入：只取判据需要的四个字段（Round 与测试替身同型） */
export interface DispatchRepairInput {
  /** 轮终态（只有 complete 才参与对账） */
  status: string;
  /** 助手正文（派发措辞的触发器） */
  assistantMessage?: { content?: string } | undefined;
  /** 用户消息（只读 name：识别内部种子轮，防补派检查自己再触发） */
  userMessage?: { name?: string } | undefined;
  /** 进程事件（回执判据的唯一输入） */
  processEvents?: ProcessEvent[] | undefined;
}

/**
 * 完成门判据（DISPATCH-REPAIR-1）：这一轮是否该自动起一轮「补派检查」
 *
 * 与提示**同源**：同一措辞表（`hasDispatchClaim`）+ 同一回执判据
 * （`dispatchedSidTextsFromEvents`），不写第二份。
 *
 * 三条排除：
 *   - 非 complete：中断 / 软暂停的正文可能半截，不当承诺；
 *   - 内部种子轮：补派检查自己也是内部种子，若再触发会无限自唤；
 *   - 有受理回执：已派成功（含后续投递）不算缺口。
 *
 * 注意：这只是**概率修复**。词表抓不到换说法 / 引用 / 假设；它只负责「提醒模型去补」，
 * 绝不代替模型发送——真正的派发仍必须在补派轮里由模型调用工具完成。
 *
 * @param round 判据输入（只读，不改任何落盘状态）
 * @returns true = 需要起一轮补派检查
 */
export function shouldNudgeDispatchRepair(round: DispatchRepairInput): boolean {
  if (round.status !== 'complete') return false;
  if (isInternalSeedSender(round.userMessage?.name)) return false;
  if (!hasDispatchClaim(round.assistantMessage?.content)) return false;
  return dispatchedSidTextsFromEvents(round.processEvents ?? []).length === 0;
}

/**
 * 本轮是否有「业务受理成功」的派发回执
 *
 * 直接复用会话卡解析——同一份 `tool_start` 配对 `tool_result` 的事实，不另写判据。
 *
 * @param events 本轮过程事件
 */
function hasAcceptedDispatchReceipt(events: readonly ProcessEvent[]): boolean {
  return dispatchedSidTextsFromEvents(events).length > 0;
}

/**
 * 提示谓词（实时 / 重放共用）：声称已派 且 本轮无成功回执
 *
 * 无状态、每次从全量事件算，不做 seq 去重——重放 / 切会话结果一致。
 *
 * @param assistantText 该轮终态正文
 * @param events 本轮过程事件
 */
function shouldShowDispatchClaimHint(
  assistantText: string | undefined,
  events: readonly ProcessEvent[],
): boolean {
  return hasDispatchClaim(assistantText) && !hasAcceptedDispatchReceipt(events);
}

/**
 * 幂等投影：先撤旧提示，再按判据决定是否挂一条
 *
 * 只助手形态生效（与盖章卡同构；self 工作会话不显示）。插入位置在容器 footer 之前——
 * 底栏在助手形态默认 `opacity:0`（hover 才显形），提示不能跟着一起藏起来。
 *
 * @param doc DOM 文档（由调用方注入，模块内不读全局 document）
 * @param group 该轮的 `.round-group` 容器（找不到则什么都不做）
 * @param show 是否显示（由 {@link shouldShowDispatchClaimHint} 算好）
 */
function applyDispatchClaimHint(doc: Document, group: HTMLElement | null, show: boolean): void {
  if (!group) return;
  group.querySelector(`.${DISPATCH_HINT_CLASS}`)?.remove();
  if (!show || doc.body.dataset.form !== 'assistant') return;
  const hint = doc.createElement('div');
  hint.className = DISPATCH_HINT_CLASS;
  // 文案 = 证据缺口，不是结论；textContent 走纯文本（无注入面）。
  // 「会话派发」限定作用域：delegate_task 不在回执判据内，避免读者把两者混为一谈。
  hint.textContent = l10n.t('No session dispatch receipt found for this turn');
  const foot = group.querySelector('.round-group__footer');
  if (foot) group.insertBefore(hint, foot);
  else group.appendChild(hint);
}

/** 投影所需的最小轮形状（RoundView 结构子集，避免 helper 依赖整个协议类型） */
export interface DispatchHintRound {
  id: string;
  /** 只对终态轮计算（中断轮不算「承诺已兑现」） */
  status: string;
  assistantMessage?: { content: string } | null;
  processEvents?: readonly ProcessEvent[];
}

/**
 * 轮级投影入口（重放 / 实时共用，避免 chatView 里出现两份接线）
 *
 * 按 `data-round-id` 在消息容器内定位该轮容器；非终态轮直接返回（同时在跑的轮不上提示，
 * 防止流式正文里出现「已派给」就闪一下）。
 *
 * @param doc DOM 文档
 * @param root 消息容器（`#messages`）
 * @param round 该轮（终态 / 正文 / 过程事件）
 */
export function projectDispatchClaimHintInRound(
  doc: Document,
  root: ParentNode,
  round: DispatchHintRound,
): void {
  if (round.status !== 'complete') return;
  const group =
    Array.from(root.querySelectorAll<HTMLElement>('.round-group')).find(
      (el) => el.dataset.roundId === round.id,
    ) ?? null;
  applyDispatchClaimHint(
    doc,
    group,
    shouldShowDispatchClaimHint(round.assistantMessage?.content, round.processEvents ?? []),
  );
}
