/**
 * sessionList — 「历史会话列表」消息载荷的唯一构建点（store → DTO 纯映射）
 *
 * 为什么外置：chatPanel 逼近 `max-lines` 基线（只降不升），而列表投影是纯映射，
 * 留在大文件里只会挤占行预算；外置后「加一个展示字段」按域改这里，不动面板。
 *
 * 口径（与 `shared/protocol.ts` 的 `session_list_data` 注释同源）：
 *   - 只返回非当前会话（当前会话不进历史记录 ⇒ 天然规避「删除当前会话」边界）；
 *   - **助手会话不进工作会话列表**（2026-11-17 用户定案）：助手窗有自己那一条会话与
 *     独立记录，但它不是「工作会话」；混进列表会被误读成「助手拿工作会话回话」。
 *     真源仍是会话存储，这里只是列表投影的排除项，不删数据；
 *   - 按 updatedAt 降序；无历史时 sessions 为空数组（webview 显示空态）；
 *   - sessions 是**全量**，archivedIds 只是留存区分组标签（单数据源 + 前端过滤，
 *     不拆两份列表——两份真相源必然出现「两边都有 / 两边都没有」）；
 *   - `lastOutcome` 是**读侧投影**：真源 = 该会话最后一轮的 `RoundStatus`（RoundStore 索引），
 *     这里只做状态 → 展示语义的映射，**不往 SessionMeta 写第二份终态**。
 */
import {
  isRoundSettled,
  isRoundSuccessful,
  type SessionMeta,
  type RoundStatus,
  type IRoundStore,
} from '@zooique/memora';
import { sessionDisplayTitle, type SessionTitleL10n } from '../../extension/host/sessionTitle.js';
import { hasRoundStatusIndex } from '../../extension/host/workspaceRoundStore.js';
import type { HostSessionStore } from '../../extension/host/sessionStore.js';
import { readSessionRolePackName } from '../../extension/host/sessionRolePack.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** `session_list_data` 消息类型（从协议联合中提取，宿主不另写一份 DTO） */
type SessionListMessage = Extract<ExtensionToWebviewMessage, { type: 'session_list_data' }>;

/**
 * 构建历史会话列表消息（对 `session_list` 的应答）
 *
 * @param store 宿主会话存储（读会话元数据与留存区分组标签）
 * @param currentSessionId 当前显示会话（从列表中排除）
 * @param l10n 本地化注入面（占位标题词形；SSOT-OWNERSHIP-1：归宿主，不取内核表）
 * @param readLastRoundStatus 轮状态读取口（可选；缺省 = 不投影 `lastOutcome`）。
 *   由调用方做结构化能力探测后注入——本模块不直接依赖 RoundStore 实现。
 * @param assistantSessionId 助手会话 id（可选；给了就从列表排除——助手窗自己的那条
 *   属于助手专属记录，不进工作会话列表）
 * @returns 可直接 postMessage 的 `session_list_data` 载荷
 */
export function buildSessionListMessage(
  store: HostSessionStore,
  currentSessionId: string,
  l10n: SessionTitleL10n,
  readLastRoundStatus?: (roundId: string) => RoundStatus | undefined,
  assistantSessionId?: string,
): SessionListMessage {
  // 非当前会话，按更新时间降序（当前会话不进历史记录是设计收敛，不是过滤失误）
  // origin='hosted' 是代理开的工作会话（主控调度用），不属于用户的自助历史记录 → 一并排除
  const metas = store
    .listSessionMetas()
    .filter(
      (m) =>
        m.sessionId !== currentSessionId &&
        m.sessionId !== assistantSessionId &&
        m.origin !== 'hosted',
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    type: 'session_list_data',
    sessions: metas.map((meta) => toSessionSummary(store, meta, l10n, readLastRoundStatus)),
    archivedIds: store.listArchivedIds(),
  };
}

/**
 * 列表推送的注入面（面板只给读口与投递口，不在此持有导航状态）
 */
export interface SessionListPushDeps {
  /** 会话存储 */
  store: HostSessionStore;
  /** 当前显示会话（从列表中排除） */
  currentSessionId: string;
  /** 本地化注入面 */
  l10n: SessionTitleL10n;
  /** 轮存储（可选）：支持状态索引时投影 `lastOutcome` */
  roundStore?: IRoundStore;
  /** 助手会话 id（可选；给了就从列表排除） */
  assistantSessionId?: string;
  /** 投递口（面板的 post 单点） */
  post: (msg: SessionListMessage) => void;
}

/**
 * 构建并推送历史会话列表（对 `session_list` 的应答）
 *
 * 终态投影只需要「末位轮什么状态」⇒ 用 RoundStore 索引直读，不加载整轮正文；
 * 能力探测失败就退化为不投影 `lastOutcome`（列表本身不受影响）。
 *
 * @param deps 读口 + 投递口
 */
export function postSessionList(deps: SessionListPushDeps): void {
  const { roundStore } = deps;
  const readLastRoundStatus =
    roundStore && hasRoundStatusIndex(roundStore)
      ? (roundId: string) => roundStore.getStatus(roundId)
      : undefined;
  deps.post(
    buildSessionListMessage(
      deps.store,
      deps.currentSessionId,
      deps.l10n,
      readLastRoundStatus,
      deps.assistantSessionId,
    ),
  );
}

/**
 * 轮状态 → 会话条目「上一轮结局」的展示语义（唯一映射点）
 *
 * - `complete` ⇒ `completed`（正常跑完）
 * - `interrupted` ⇒ `interrupted`（已收场的停 turn：用户停止 / 崩溃打捞升级）
 * - `pending` / `error` ⇒ `unsettled`（未收场）
 *
 * 状态判据一律调内核（`isRoundSuccessful` / `isRoundSettled`），**宿主不自写状态字面量比较**
 * —— 收场判据的第二真相源会被内核 `roundStore.test.ts` 的判据单源守卫当场拦下。
 * 三态无需内核新增出口：`settled && !successful` 在内核语义下只可能是 `interrupted`。
 *
 * ⚠️ `unsettled` 的文案必须是「上次未正常结束」：暂停检查点只在内存，重启后不可续跑，
 * 写「暂停中」会误导用户以为还能接着跑。
 *
 * @param status 轮状态（真源 = RoundStore 索引条目）
 * @returns 会话列表展示用的终态枚举
 */
function toLastOutcome(status: RoundStatus): 'completed' | 'interrupted' | 'unsettled' {
  if (isRoundSuccessful(status)) return 'completed';
  if (isRoundSettled(status)) return 'interrupted';
  // pending / error 都不算收场（error 是内核预留态，仅与 pending 共用「未收场」语义）
  return 'unsettled';
}

/**
 * 单条会话摘要投影（字段口径见协议注释，此处不重复定义）
 *
 * @param store 宿主会话存储（角色包名经单点判据读回，不在本处另写解析）
 * @param meta 会话元数据（计数已在 `getSessionMeta` 读路径现场派生，直取即新鲜值）
 * @param l10n 本地化注入面（占位标题词形）
 * @param readLastRoundStatus 轮状态读取口（可选；缺省 = 不投影终态）
 */
function toSessionSummary(
  store: HostSessionStore,
  meta: SessionMeta,
  l10n: SessionTitleL10n,
  readLastRoundStatus?: (roundId: string) => RoundStatus | undefined,
): SessionListMessage['sessions'][number] {
  // 末位轮 = 该会话「最近一次执行」的轮（roundIds 是有序真源，不另存 currentRoundId）
  const roundIds = store.getRoundIds(meta.sessionId);
  const lastRoundId = roundIds[roundIds.length - 1];
  const lastStatus =
    lastRoundId && readLastRoundStatus ? readLastRoundStatus(lastRoundId) : undefined;
  return {
    sessionId: meta.sessionId,
    // 标题兜底在读点补（占位串不进 meta）：displayName/autoName 都空 = 尚未命名，显示创建时刻
    title: sessionDisplayTitle(meta.sessionId, meta, l10n),
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    // FD-3-A 元数据搜索匹配域：undefined 经 postMessage JSON 序列化自然剔除
    keyTopics: meta.keyTopics,
    summary: meta.summary,
    // 角色包名同样走单点判据（缺字段 / 已卸载未知）→ undefined，旧会话保持零差异；
    // 这里只给名字快照，不判断包是否仍装着（可用性判断会造第二份状态源）
    activeRolePackName: readSessionRolePackName(store, meta.sessionId),
    // 会话来源标记（缺省 = 旧会话，按用户会话解释；本片只走数据层，不渲染图标）
    origin: meta.origin,
    // 终态同样是「有则投影、无则缺省」：索引查不到该轮 / 未注入读取口 ⇒ undefined
    lastOutcome: lastStatus ? toLastOutcome(lastStatus) : undefined,
  };
}
