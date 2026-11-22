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
 *   - 触发：派发话术 OR 会话创建话术 OR（零工具 AND 用户派活意图）。前两支抓措辞
 *     命中，零工具分支抓「换了说法」的形态，但必须带用户意图门——纯聊天轮也零工具，
 *     不能一律标成「未核到派发回执」。真源都是已落盘的结构化事实，不新增判据通道。
 *
 * 为什么保留词表分支：业务受理失败（内核 ok 但业务 ok=false）有 `tool_start`，零工具分支
 * 看不见它；删掉词表分支就是拿新形态覆盖旧能力，属带伤。
 *
 * 呈现纪律：
 *   - 只助手形态（与盖章会话卡同构）；
 *   - 插在 `.round-group` 内、footer 之前（**常显**元素，不挂在 hover 才显形的底栏里）；
 *   - 实时与重放共用同一谓词，实时插入先撤后插（同一轮会多次 turn_update）。
 *
 * 范围边界：只对 `status === 'complete'` 计算——中断轮是用户主动打断，正文可能半截，
 * 把半截断言当成「承诺」会明显增大误报；要放开须单独立项，不在此顺手扩。
 */
import type { ProcessEvent, Round } from '@zooique/memora';
import * as l10n from '@vscode/l10n';
import { isInternalSeedSender } from '../../shared/constants.js';
import { dispatchedSidTextsFromEvents, type DispatchedSidText } from './processEventText.js';

/** 凭证行 class（与既有缺口提示同一位置族，语义相反：这条是「有回执」） */
export const DISPATCH_RECEIPT_CLASS = 'round-group__dispatch-receipt';

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
 * 会话创建义断言（按句判定：同一句里同时出现「会话」与完成词）
 *
 * 为什么不用固定窗口正则：真实正文常写成「新会话「名字」已创建」，名字长度不定，
 * 固定 8~10 字窗口会漏。按句配对既覆盖名字夹在中间，又避免「已创建文件」误伤
 * （句内没有「会话 / session」就不算）。
 */
const SESSION_WORD = /会话|session/i;
const SESSION_CREATE_DONE = /已创建|已开|新建|创建了|开好了/;

/**
 * 用户是否在要求「派活 / 开新会话」——零工具分支的意图门
 *
 * 零工具本身不是承诺：纯聊天轮（「5+9 等于几」「能暂停吗」）也零工具。若只看
 * 零工具，会把所有答问轮都标成「未核到派发回执」——这是实锤误伤（测试记录里
 * 28 个零工具无承诺轮）。因此零工具分支必须再问一句：**用户这轮有没有让开/派**。
 *
 * 不读别的通道：用户原文本来就在 Round 里，不新增落盘字段、不新增协议。
 */
const DISPATCH_INTENT_PATTERNS: readonly RegExp[] = [
  /派给|派活/,
  /(?:安排|交给)[^。；\n]{0,8}(?:会话|它|他)/,
  /(?:新开|再开|开一?个|新建|创建)[^。；\n]{0,8}(?:会话|session|测试)/,
  /(?:会话|session)[^。；\n]{0,8}(?:新开|再开|新建|创建)/,
];

/**
 * 正文里是否声称「已开 / 已建某个会话」
 *
 * @param assistantText 该轮终态正文
 * @returns 任一命中断言即 true
 */
export function hasSessionCreationClaim(assistantText: string | undefined): boolean {
  const text = assistantText ?? '';
  return text
    .split(/[。；\n]/)
    .some((sentence) => SESSION_WORD.test(sentence) && SESSION_CREATE_DONE.test(sentence));
}

/**
 * 用户原文是否在要求「派活 / 开新会话」
 *
 * @param userText 该轮用户消息正文
 * @returns 命中任一意图模式即 true
 */
export function hasDispatchIntent(userText: string | undefined): boolean {
  const text = userText ?? '';
  return DISPATCH_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

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

/**
 * 本轮是否零工具动作——结构化事实，真源 = `processEvents` 的 `tool_start`
 *
 * 不读正文：模型换了说法（「会话已开 / 回执成功」）词表一个词都不命中，但工具事件
 * 有无是确定的。只认 `tool_start`：只读查询也算进了工具闭环，不再当「没动手」。
 */
function hasNoToolActivity(events: readonly ProcessEvent[]): boolean {
  return !events.some((event) => event.type === 'tool_start');
}

/**
 * 对账触发器：派发话术 OR 会话创建话术 OR（零工具 AND 用户有派活意图）
 *
 * 三个分支不可互相替代：
 *   - 派发话术：保留业务受理失败（有 tool_start）的覆盖；
 *   - 会话创建话术：覆盖「调了别的工具，却声称会话已建」；
 *   - 零工具 + 用户意图：覆盖换词后词表失明的复发形态，同时不误伤纯聊天轮。
 * 都不新增词表通道外的判据，不新增落盘字段。
 */
function shouldAuditDispatch(
  assistantText: string | undefined,
  events: readonly ProcessEvent[],
  userText: string | undefined,
): boolean {
  if (hasDispatchClaim(assistantText)) return true;
  if (hasSessionCreationClaim(assistantText)) return true;
  return hasNoToolActivity(events) && hasDispatchIntent(userText);
}

/** 完成门判据输入：只取判据需要的五个字段（Round 与测试替身同型） */
export interface DispatchRepairInput {
  /** 轮终态（只有 complete 才参与对账） */
  status: string;
  /** 助手正文（派发措辞的触发器） */
  assistantMessage?: { content?: string } | undefined;
  /** 用户消息（name 识别内部种子轮；content 是零工具分支的意图门） */
  userMessage?: { name?: string; content?: string } | undefined | null;
  /** 轮来源（零工具分支的门控：只审计用户发起的轮，系统通知轮零工具是常态） */
  origin?: Round['origin'];
  /** 进程事件（回执判据与零工具判据的唯一输入） */
  processEvents?: ProcessEvent[] | undefined;
}

/**
 * 完成门判据（DISPATCH-REPAIR-1）：这一轮是否该自动起一轮「补派检查」
 *
 * 与提示**同源**：同一触发谓词（`hasDispatchClaimOrNoToolActivity`）+ 同一回执判据
 * （`dispatchedSidTextsFromEvents`），不写第二份。
 *
 * 四条排除：
 *   - 非 complete：中断 / 软暂停的正文可能半截，不当承诺；
 *   - 内部种子轮：补派检查自己也是内部种子，若再触发会无限自唤；
 *   - 非用户来源：落定通知等 hosted 轮零工具是常态，不能拿它起补派；
 *   - 有受理回执：已派成功（含后续投递）不算缺口。
 *
 * 注意：这只是**概率修复**。它只负责「提醒模型去补」，绝不代替模型发送——真正的
 * 派发仍必须在补派轮里由模型调用工具完成。
 *
 * @param round 判据输入（只读，不改任何落盘状态）
 * @returns true = 需要起一轮补派检查
 */
export function shouldNudgeDispatchRepair(round: DispatchRepairInput): boolean {
  if (round.status !== 'complete') return false;
  if (isInternalSeedSender(round.userMessage?.name)) return false;
  // 缺省按 'user' 解释，与协议 RoundView.origin 的存量兼容口径一致。
  if ((round.origin ?? 'user') !== 'user') return false;
  const events = round.processEvents ?? [];
  if (!shouldAuditDispatch(round.assistantMessage?.content, events, round.userMessage?.content))
    return false;
  return dispatchedSidTextsFromEvents(events).length === 0;
}

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
  // 纯文本（无注入面）；不长成卡片：单行、无图标、不可点
  line.textContent = text;
  const foot = group.querySelector('.round-group__footer');
  if (foot) group.insertBefore(line, foot);
  else group.appendChild(line);
}

/** 投影所需的最小轮形状（RoundView 结构子集，避免 helper 依赖整个协议类型） */
export interface DispatchHintRound {
  id: string;
  /** 只对终态轮计算（中断轮的过程可能半截，凭证不以半截为据） */
  status: string;
  /** 轮来源（保留字段：凭证不拘来源，但调用方与判据共用同一形状） */
  origin?: Round['origin'];
  assistantMessage?: { content: string } | null;
  /** 用户原文（保留字段：补派判据的意图门，凭证不读） */
  userMessage?: { content?: string } | null;
  processEvents?: readonly ProcessEvent[];
}

/**
 * 轮级投影入口（重放 / 实时共用，避免 chatView 里出现两份接线）
 *
 * 按 `data-round-id` 定位该轮容器；非终态轮直接返回。判据唯一：
 * `dispatchedSidTextsFromEvents(events)` 非空 = 这轮确有业务受理成功的回执。
 *
 * @param doc DOM 文档
 * @param root 消息容器（`#messages`）
 * @param round 该轮（终态 / 过程事件）
 * @param titles 会话标题来源（传 `dispatchCards` 实例即可）
 */
export function projectDispatchReceiptInRound(
  doc: Document,
  root: ParentNode,
  round: DispatchHintRound,
  titles: DispatchTitleSource,
): void {
  if (round.status !== 'complete') return;
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
