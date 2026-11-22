/**
 * 派活补派门（DISPATCH-REPAIR-1）——宿主侧判据
 *
 * 为什么外置：`dispatchReceiptHint.ts` 的凭证投影进 webview bundle，webview 运行时
 * 禁止值导入内核；补派门只在宿主运行，成功收场判据必须调内核单点 `isRoundSuccessful`
 * （不自写 `status === 'complete'`，那是判据散点）。按运行边界拆文件，不复制凭证文案
 * 与 DOM 投影；两边共用同一个回执真源 `dispatchedSidTextsFromEvents`。
 *
 * 触发谓词迁移时保持原语义：派发话术 / 会话创建话术 /（零工具 AND 用户派活意图）。
 */
import { isRoundSuccessful, type ProcessEvent, type Round } from '@zooique/memora';
import { isInternalSeedSender } from '../../shared/constants.js';
import { dispatchedSidTextsFromEvents } from './processEventText.js';

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

/** 正文里是否声称「已开 / 已建某个会话」 */
export function hasSessionCreationClaim(assistantText: string | undefined): boolean {
  const text = assistantText ?? '';
  return text
    .split(/[。；\n]/)
    .some((sentence) => SESSION_WORD.test(sentence) && SESSION_CREATE_DONE.test(sentence));
}

/** 用户原文是否在要求「派活 / 开新会话」 */
export function hasDispatchIntent(userText: string | undefined): boolean {
  const text = userText ?? '';
  return DISPATCH_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** 正文里是否声称「已派活」 */
export function hasDispatchClaim(assistantText: string | undefined): boolean {
  const text = assistantText ?? '';
  return DISPATCH_CLAIM_WORDS.some((word) => text.includes(word));
}

/** 本轮是否零工具动作——结构化事实，真源 = `processEvents` 的 `tool_start` */
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
  /** 轮终态（成功收场判据走内核 `isRoundSuccessful`） */
  status: Round['status'];
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
 * 与凭证共用同一回执判据 `dispatchedSidTextsFromEvents`，不写第二份；成功收场
 * 判据直接调内核 `isRoundSuccessful`，不自写状态字面量比较。
 *
 * 四条排除：
 *   - 非成功收场：中断 / 软暂停的正文可能半截，不当承诺；
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
  if (!isRoundSuccessful(round.status)) return false;
  if (isInternalSeedSender(round.userMessage?.name)) return false;
  // 缺省按 'user' 解释，与协议 RoundView.origin 的存量兼容口径一致。
  if ((round.origin ?? 'user') !== 'user') return false;
  const events = round.processEvents ?? [];
  if (!shouldAuditDispatch(round.assistantMessage?.content, events, round.userMessage?.content))
    return false;
  return dispatchedSidTextsFromEvents(events).length === 0;
}
