/**
 * 时间格式化 — 纯函数（webview 运行时脚本直接 import 使用）
 *
 * fmtTime 作为纯函数被 chatView import，可直接 vitest 测试。
 * 本模块只做「日期/时间 → 展示串」，文案经 l10n（中文版式由 zh 译文给，不在代码里写死）。
 */
import * as l10n from '@vscode/l10n';

/**
 * 格式化 ISO 时间戳为 HH:MM（本地时区）；空/无效输入返回空串
 *
 * @param ts ISO 时间戳（如 "2026-06-21T12:34:56.789Z"）
 * @returns HH:MM（本地时区）或空串
 */
export function fmtTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 格式化日期为「月/日」短格式（日期分隔线用）
 *
 * 版式真源在 bundle：默认语言为 `{0}/{1}`，zh 译文给 `{0}月{1}日`——
 * 代码里不写死中文，否则等于绕过 l10n 契约。
 *
 * @param d 目标日期（本地时区）
 * @returns 月日短串（如 "11/9" 或中文 "11月9日"）
 */
export function fmtMonthDay(d: Date): string {
  // 月从 0 起算：对外展示一律 +1
  return l10n.t('{0}/{1}', String(d.getMonth() + 1), String(d.getDate()));
}
