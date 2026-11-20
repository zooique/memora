/**
 * 正文摘要截断（工作台末轮投影 + 落定通知的交付摘录**共用同一口径**）
 *
 * 为什么必须共享：两处都在回答「这轮交付了什么」，阈值一旦各写一份就会出现
 * 「工作台截 280、通知截 200」这种同一事实两种长度。上限只在这里改。
 *
 * @param text 原始正文（用户请求 / 助手回答）
 * @returns 去首尾空白后的摘录；超上限保留开头并加省略号（开头最说明问题）
 */
export const SUMMARY_TEXT_LIMIT = 280;

/**
 * 按共用口径截断正文
 *
 * @param text 原始正文
 * @returns 可直接展示的摘录（不做 markdown 处理，不改写内容）
 */
export function clipSummaryText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SUMMARY_TEXT_LIMIT ? `${trimmed.slice(0, SUMMARY_TEXT_LIMIT)}…` : trimmed;
}
