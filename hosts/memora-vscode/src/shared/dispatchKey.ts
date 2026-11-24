/**
 * 派活对账键（宿主侧唯一格式化产地，零依赖）
 *
 * **为什么要有单点**：落定通知（`webview/helpers/hostedSessionNotice.ts` 的 `formatNotice`）
 * 与派活账本注入（`extension/host/` 的 `buildDispatchLedgerTurnContext`）必须对同一条
 * 会话 / 轮给出**逐字相同**的 `sid=…，round=…` 片段，宝才能把「账本里的一行」和
 * 「那条落定通知」对上号。这两处曾各写一份模板且已经漂移（一处全角逗号、一处半角逗号），
 * 属于「注释声称同源、实现是两份」，改一处必失配——故下沉到这里。
 *
 * **为什么放 shared/**：两侧都要值导入它；本文件零依赖、不碰 `@zooique/memora`，
 * 放进任何一侧都会把另一侧的模块图卷进来。
 *
 * 边界：
 *   - 只拼**身份片段**，不负责整句文案、括号与分隔符（各通知外壳自持）；
 *   - 标点固定全角（中文正文语境；落定通知是既有用户可见形态，保持原文不迁移）；
 *   - `roundId` 缺省 / 纯空白 ⇒ 只出 `sid=…`，不写空的 `round=`。
 */

/**
 * 拼对账身份片段：`sid=<会话>`（有轮时再带 `，round=<轮>`）
 *
 * @param sessionId 目标会话 id（调用方保证非空；空串由外壳自己决定是否展示）
 * @param roundId 目标轮 id（可选；缺省 / 空白 = 只报会话级身份）
 * @returns 例如 `sid=2026-11-24-a，round=2026-11-24-a-1`
 */
export function formatDispatchKey(sessionId: string, roundId?: string): string {
  const round = roundId?.trim();
  return round ? `sid=${sessionId}，round=${round}` : `sid=${sessionId}`;
}
