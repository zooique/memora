/**
 * historyLoad — 会话历史读取（round-based 投影 + legacy 扁平回退）的唯一实现
 *
 * 为什么外置：`chatPanel.ts` 贴 `max-lines` 只降不升基线，而两段读取都是「读 store → 投影」
 * 的纯数据逻辑（无 UI 裁决、无锁、无流状态），留在面板里只挤占行预算。
 *
 * 口径（与 `replayHistory` 注释同源）：
 *   - 有 viewLoader ⇒ round-based：一条 `turn_update`（replay:true）承载全量 rounds；
 *   - 无 viewLoader ⇒ legacy 只回放 user 消息（正文 strip 注入信封前缀）；
 *   - 两段都按上限截断（轮/条），防长期使用后全量回放。
 */
import { splitSessionId, type SessionView } from '@zooique/memora';
import type { WorkspaceSessionViewLoader } from '../../extension/host/sessionViewLoader.js';
import type { HostSessionStore } from '../../extension/host/sessionStore.js';
import type { RoundView } from '../../shared/protocol.js';
import { stripInjectedContextPrefix } from './docContext.js';

/** 历史回放单次最大条数：跨天合并视图聚焦近期对话，防长期使用后累积导致每次打开/切换全量回放 + 逐条建 DOM。 */
const MAX_HISTORY_MESSAGES = 200;

/** 历史回放最大轮数（round-based 模式）：按完整 round 截断，杜绝「正文有、过程无」的半轮不对称 */
const MAX_HISTORY_ROUNDS = 60;

/**
 * round-based 历史投影（viewLoader 注入时的唯一读取路径）
 *
 * @param viewLoader 会话视图加载器（未注入 ⇒ 空数组并 warn，由调用方回退 legacy）
 * @param sessionStore 会话存储（空会话守卫读 roundIds）
 * @param sessionId 目标会话
 * @returns 截断后的 round 投影（正文与过程事件同源同轮）
 */
export function loadRoundBasedHistory(
  viewLoader: WorkspaceSessionViewLoader | undefined,
  sessionStore: HostSessionStore,
  sessionId: string,
): RoundView[] {
  if (!viewLoader) {
    console.warn('Memora：round-based 会话需要 viewLoader，但未注入');
    return [];
  }
  // 空会话守卫（SSOT 单点：replayHistory / postTurnUpdate / collectHistoryMessages 共用判据）：
  // 无轮次记录（新建/空会话）→ 返回空数组，不触发 loadView「会话不存在」抛错路径。
  // 判据直用完整 sessionId（getRoundIds 以 sessionId 为键，parse 再拼回是恒等变换）
  if (sessionStore.getRoundIds(sessionId).length === 0) {
    return [];
  }

  try {
    const view: SessionView = viewLoader.loadView(sessionId);
    const rounds: RoundView[] = [];

    // 从 SessionView 中提取并投影为 RoundView（正文与过程事件同源同轮，单文件内聚）：
    // 直接透出 Round 形状（不手工扁平化为 {content,ts}），由 postTurnUpdate 承载投递；
    // replay 单通道投递 rounds（不派生 user/replay_events/assistant 消息风暴）。
    for (const round of view.rounds) {
      rounds.push({
        id: round.id,
        // 用户正文剥离宿主注入的上下文信封前缀（技能块 + 文档块），与实时回显发裸 input 对称
        userMessage: {
          ...round.userMessage,
          content: stripInjectedContextPrefix(round.userMessage.content),
        },
        assistantMessage: round.assistantMessage,
        interactiveInputs: round.interactiveInputs,
        assistantLog: round.assistantLog,
        status: round.status,
        createdAt: round.createdAt,
        completedAt: round.completedAt,
        // 过程事件与证据同源同轮：view.rounds 即 roundStore.getByIds 返回的完整 Round
        // （含 processEvents/evidence），与正文同对象，直接透出——不再经 _eventLogRoundStore
        // 二次 getById（同 store 重复查缓存，且与 evidence 取法不一致）。无则空/undefined。
        processEvents: round.processEvents ?? [],
        // 裁决证据（悬案取证轨）：随 Round 整对象已在 view.rounds 中，直接透出（无证据轮
        // undefined，零冗余）。重放经本投影下发；运行时由宿主 settle 从同一 roundStore 读出随
        // done/interrupted 下发（证据轮末才落盘，不进 processEvents，见内核 RoundEvidenceEvent）。
        evidence: round.evidence,
      });
    }

    // 按完整 round 截断（杜绝「正文有、过程无」半轮不对称）
    return rounds.slice(-MAX_HISTORY_ROUNDS);
  } catch (err) {
    console.warn('Memora 加载 round-based 会话历史失败', err);
    return [];
  }
}

/**
 * legacy 扁平回退：经 ISessionStore.loadMessages 加载（仅在 viewLoader 未注入时启用）
 *
 * @param sessionStore 会话存储
 * @param sessionId 目标会话（内核 splitSessionId 拆解，格式契约 SSOT）
 * @returns 按时间升序、截断后的 user/assistant 消息
 */
export function loadMessagesHistory(
  sessionStore: HostSessionStore,
  sessionId: string,
): { role: 'user' | 'assistant'; content: string; ts?: string; roundId?: string }[] {
  const { date, session } = splitSessionId(sessionId);
  const result: { role: 'user' | 'assistant'; content: string; ts?: string; roundId?: string }[] =
    [];
  const msgs = sessionStore.loadMessages(date, session) as {
    role?: string;
    content?: string;
    timestamp?: string;
    roundId?: string;
  }[];
  for (const m of msgs) {
    if (!m.content || m.content.startsWith('<user_input>')) continue;
    result.push({
      role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as 'user' | 'assistant',
      content: m.role === 'user' ? stripInjectedContextPrefix(m.content) : m.content,
      ts: m.timestamp,
      roundId: m.roundId,
    });
  }
  // 按时间升序（消息存储顺序可能因多次回放而乱序）
  result.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  // 上限保护：仅回放最近 MAX_HISTORY_MESSAGES 条
  return result.slice(-MAX_HISTORY_MESSAGES);
}
