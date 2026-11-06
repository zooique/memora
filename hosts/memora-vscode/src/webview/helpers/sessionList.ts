/**
 * sessionList — 「历史会话列表」消息载荷的唯一构建点（store → DTO 纯映射）
 *
 * 为什么外置：chatPanel 贴 `max-lines` 上限（只降不升），而列表投影是纯映射，
 * 留在大文件里只会挤占行预算；外置后「加一个展示字段」按域改这里，不动面板。
 *
 * 口径（与 `shared/protocol.ts` 的 `session_list_data` 注释同源）：
 *   - 只返回非当前会话（当前会话不进历史记录 ⇒ 天然规避「删除当前会话」边界）；
 *   - 按 updatedAt 降序；无历史时 sessions 为空数组（webview 显示空态）；
 *   - sessions 是**全量**，archivedIds 只是留存区分组标签（单数据源 + 前端过滤，
 *     不拆两份列表——两份真相源必然出现「两边都有 / 两边都没有」）。
 */
import { getSessionDisplayName, type SessionMeta } from '@zooique/memora';
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
 * @returns 可直接 postMessage 的 `session_list_data` 载荷
 */
export function buildSessionListMessage(
  store: HostSessionStore,
  currentSessionId: string,
): SessionListMessage {
  // 非当前会话，按更新时间降序（当前会话不进历史记录是设计收敛，不是过滤失误）
  const metas = store
    .listSessionMetas()
    .filter((m) => m.sessionId !== currentSessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    type: 'session_list_data',
    sessions: metas.map((meta) => toSessionSummary(store, meta)),
    archivedIds: store.listArchivedIds(),
  };
}

/**
 * 单条会话摘要投影（字段口径见协议注释，此处不重复定义）
 *
 * @param store 宿主会话存储（角色包名经单点判据读回，不在本处另写解析）
 * @param meta 会话元数据（计数已在 `getSessionMeta` 读路径现场派生，直取即新鲜值）
 */
function toSessionSummary(
  store: HostSessionStore,
  meta: SessionMeta,
): SessionListMessage['sessions'][number] {
  return {
    sessionId: meta.sessionId,
    title: getSessionDisplayName(meta),
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    // FD-3-A 元数据搜索匹配域：undefined 经 postMessage JSON 序列化自然剔除
    keyTopics: meta.keyTopics,
    summary: meta.summary,
    // 角色包名同样走单点判据（缺字段 / 已卸载未知）→ undefined，旧会话保持零差异；
    // 这里只给名字快照，不判断包是否仍装着（可用性判断会造第二份状态源）
    activeRolePackName: readSessionRolePackName(store, meta.sessionId),
  };
}
