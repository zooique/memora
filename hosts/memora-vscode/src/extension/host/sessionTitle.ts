/**
 * 会话标题读侧兜底（displayName → autoName → 创建时刻占位）
 *
 * 三处消费面（历史列表 / 面板标题条 / getSessionMeta 的占位 meta）必须是同一口径，
 * 否则同一会话在三处显示不同标题。
 *
 * 🔴 占位串是「读时展示兜底」，**不是数据**：不得写回 meta——写回会压住 `autoName`
 * 且永久锁死自动命名（真机实锤）。时间取**会话创建时刻**：优先 id 的 `-s<base36>` 段，
 * 缺失时用 `meta.createdAt`（分叉会话名是 `session-<base36>`，解析不出时间但落盘了
 * createdAt），最后才回退到 id 日期 00:00（旧会话无从得知时刻）；不取读取时刻——
 * 同一会话每次刷新必须显示同一时间。
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
 * @param sessionId 会话 id（创建时刻的首选来源：`-s<base36>` 段）
 * @param meta 会话元数据（可能为 undefined：占位 meta / 尚未落盘的会话；`createdAt` 为次选时刻来源）
 */
export function sessionDisplayTitle(sessionId: string, meta: SessionMeta | undefined): string {
  // 创建时刻三档兜底：id 时间后缀（普通会话）→ meta.createdAt（分叉会话）→ id 日期 00:00（旧会话）
  const metaCreatedAt = meta?.createdAt;
  const createdAt =
    sessionIdCreatedAt(sessionId) ??
    (metaCreatedAt && !Number.isNaN(Date.parse(metaCreatedAt))
      ? metaCreatedAt
      : `${sessionId.slice(0, 10)}T00:00:00`);
  return getSessionDisplayName(meta) || defaultSessionTitle(createdAt);
}
