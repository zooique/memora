/**
 * 会话标题读侧兜底（displayName → autoName → 创建时刻占位）
 *
 * 三处消费面（历史列表 / 面板标题条 / getSessionMeta 的占位 meta）必须是同一口径，
 * 否则同一会话在三处显示不同标题。
 *
 * 🔴 占位串是「读时展示兜底」，**不是数据**：不得写回 meta——写回会压住 `autoName`
 * 且永久锁死自动命名（真机实锤）。时间取**会话创建时刻**（id 的 `-s<base36>` 段），
 * 不取读取时刻：同一会话每次刷新必须显示同一时间。
 */
import {
  defaultSessionTitle,
  getSessionDisplayName,
  sessionIdCreatedAt,
  type SessionMeta,
} from '@zooique/memora';

/**
 * 取会话展示标题（meta 为空 / 两个名字都空时返回创建时刻占位名）
 *
 * @param sessionId 会话 id（创建时刻的唯一来源）
 * @param meta 会话元数据（可能为 undefined：占位 meta / 尚未落盘的会话）
 */
export function sessionDisplayTitle(sessionId: string, meta: SessionMeta | undefined): string {
  return (
    getSessionDisplayName(meta) ||
    defaultSessionTitle(sessionIdCreatedAt(sessionId) ?? `${sessionId.slice(0, 10)}T00:00:00`)
  );
}
