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
 *
 * 本地化（SSOT-OWNERSHIP-1）：占位词形是**展示文案**，归宿主——内核 `defaultTitle`（旧公开
 * 别名 `defaultSessionTitle`）已退出公开面。本模块只依赖注入的 `l10n.t`，**不 import `vscode`**
 * ——保持纯逻辑可在 node 环境直测（与 `buildRolesBodyHtml(l10n)` 同一注入范式）。
 */
import { getSessionDisplayName, sessionIdCreatedAt, type SessionMeta } from '@zooique/memora';

/** 本地化注入面：只依赖 `t`，避免本模块耦合 `vscode`（生产传 `vscode.l10n`） */
export interface SessionTitleL10n {
  /** 取当前语言的文案（键 = 英文源文案本身，宿主机契约） */
  t(message: string): string;
}

/**
 * 缺省注入面：按键直出（= 英文源文案）
 *
 * ⚠️ **不得用于 UI 生产构造**：UI 构造点（`extension.ts` 的 sessionStore）必须传 `vscode.l10n`，
 * 否则中文界面会显示英文占位标题，且没有任何测试会红。缺省值只是给纯单测/无宿主上下文的
 * 调用一个不抛错的地板。
 */
export const IDENTITY_L10N: SessionTitleL10n = { t: (message) => message };

/**
 * 生成创建时刻占位标题（中文 = `新会话 HH:MM`，英文 = `New session HH:MM`）
 *
 * @param createdAt 会话创建时刻（三档兜底已由调用方算好）
 * @param l10n 本地化注入面（词形归宿主 bundle，本处不写死语言）
 */
function placeholderTitle(createdAt: Date | string | number, l10n: SessionTitleL10n): string {
  const at = createdAt instanceof Date ? createdAt : new Date(createdAt);
  // 时刻非法只留不含时间的占位（与内核旧实现同一降级口径）
  if (Number.isNaN(at.getTime())) return l10n.t('New session');
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${l10n.t('New session')} ${hh}:${mm}`;
}

/**
 * 取会话展示标题（meta 为空 / 两个名字都空时返回创建时刻占位名）
 *
 * @param sessionId 会话 id（创建时刻的首选来源：`-s<base36>` 段）
 * @param meta 会话元数据（可能为 undefined：占位 meta / 尚未落盘的会话；`createdAt` 为次选时刻来源）
 * @param l10n 本地化注入面（**必传**：占位词形归宿主；测试传 `IDENTITY_L10N`）
 */
export function sessionDisplayTitle(
  sessionId: string,
  meta: SessionMeta | undefined,
  l10n: SessionTitleL10n,
): string {
  // 创建时刻三档兜底：id 时间后缀（普通会话）→ meta.createdAt（分叉会话）→ id 日期 00:00（旧会话）
  const metaCreatedAt = meta?.createdAt;
  const createdAt =
    sessionIdCreatedAt(sessionId) ??
    (metaCreatedAt && !Number.isNaN(Date.parse(metaCreatedAt))
      ? metaCreatedAt
      : `${sessionId.slice(0, 10)}T00:00:00`);
  return getSessionDisplayName(meta) || placeholderTitle(createdAt, l10n);
}
