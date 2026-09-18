/**
 * 时间工具函数
 *
 * 从 messageHistory.ts 提取的公共时间格式化函数，
 * 消除跨模块 `new Date().toISOString()` 内联重复。
 *
 * API 对齐：formatDateKey(date) 与精灵 shared/dateUtils.ts 语义一致，
 * 用于格式化任意 Date 为 YYYY-MM-DD（本地时区）。
 */

/** 一天对应的毫秒数（跨层共享，供天数差换算：诊断展示 daysSinceLastAccess / 推荐时效权重） */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 获取当前时间的 ISO 8601 时间戳
 *
 * @returns 如 "2026-06-21T12:34:56.789Z"
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 格式化 Date 为 YYYY-MM-DD 日期键（本地时区）
 *
 * 使用 getFullYear/getMonth/getDate（本地时区），替代 toISOString().slice(0,10)（UTC）。
 * 修复场景：Asia/Shanghai 凌晨 00:00-08:00 期间 UTC 仍是前一天，导致按日期分组的
 * 计数（chatTurns / dailyMessageCount）写入错误的日期 key。
 *
 * 与精灵 shared/dateUtils.ts:formatDateKey 行为完全对齐。
 *
 * @param date Date 对象
 * @returns YYYY-MM-DD 字符串（本地日期）
 */
export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 获取当前日期字符串（YYYY-MM-DD，本地时区）
 *
 * 委托 formatDateKey(new Date())，避免逻辑重复。
 * 保留无参形态是因为多数调用点只关心"今天"，无需先构造 new Date()。
 *
 * @returns 如 "2026-06-21"
 */
export function todayDate(): string {
  return formatDateKey(new Date());
}

// ── 会话标识格式契约（SSOT 单一真理源）────────────────────
// sessionId 统一格式：`${date}-${session}`，date 固定 YYYY-MM-DD（10 位）。
// session 名允许含连字符（如分叉产生的 main-b1），故拆解必须按「前 10 位日期」切、
// 不能用 split('-')（会把含连字符的 session 名拆断，或把 'proj-alpha-beta' 误当日期）。
// 此前内核/vscode/其他宿主各自手写 slice/split/正则实现，行为有细微差异；
// 现收敛为下方两个纯函数并统一从此导出，宿主经 src/index.ts 引入，禁止再手写解析。
//
// 契约边界（本函数为纯拆解，不校验合法性）：
//   - session 为空串：buildSessionId 返回纯 date（不产生尾 '-'）；
//   - 输入不足 11 位：splitSessionId 的 date 取整个串、session 为空串（不抛错，供调用方自判）。
//   需要严格合法性校验的场景（如存储写侧）应在调用方基于本函数返回值追加校验，
//   不在本层内置（保持纯函数零状态、零哨兵语义）。

/**
 * 组装会话标识：`date + "-" + session`
 *
 * @param date 日期键（YYYY-MM-DD，经 formatDateKey/todayDate 产生）
 * @param session 会话名（允许含连字符）
 * @returns 完整会话标识；session 为空串时返回纯 date（不产生尾 '-'）
 */
export function buildSessionId(date: string, session: string): string {
  if (!session) return date;
  return `${date}-${session}`;
}

/**
 * 拆解会话标识 → {date, session}
 *
 * 按「日期固定 10 位」切割（非 split，session 名可含连字符）。
 * 不校验、不抛错、不返回 null——本函数只做格式拆解，假定输入由 buildSessionId 生成；
 * 非法输入（不足 11 位）时 date 取整个串、session 为空串，由调用方按需处理。
 *
 * @param sessionId 完整会话标识（YYYY-MM-DD-sessionName）
 * @returns 拆解后的 {date, session}
 */
export function splitSessionId(sessionId: string): { date: string; session: string } {
  const date = sessionId.slice(0, 10);
  const session = sessionId.length > 11 ? sessionId.slice(11) : '';
  return { date, session };
}

/**
 * 校验会话标识是否为严格的 `YYYY-MM-DD-<会话名>` 格式
 *
 * 供需要"严格合法性判定"的调用方使用（如存储写侧、切换会话时的格式守卫）。
 * 与 splitSessionId 互补：本函数只做格式校验、不做拆解；二者组合 = 校验 + 拆解。
 * 若仅需拆解而无需严格校验，请用 splitSessionId。
 *
 * 判定规则：日期段必须是 4-2-2 的数字（`\d{4}-\d{2}-\d{2}`），且分隔后的会话名非空。
 *
 * @param sessionId 会话标识
 * @returns 是否匹配严格格式
 */
export function isValidSessionId(sessionId: string): boolean {
  return /^(\d{4}-\d{2}-\d{2})-(.+)$/.test(sessionId);
}
