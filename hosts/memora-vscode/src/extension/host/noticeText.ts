/**
 * 错误 → 用户可见通知文本（宿主单一出口）
 *
 * 内核 `MemoraError` 分三层：`message` 只含标题（`super(opts.title)`），原因（detail）
 * 与排查建议（suggestions）在**结构字段**里。宿主各 catch 若直接 `err.message` 转发，
 * 结构化诊断在宿主边界被吞——实测症状：会话分叉失败只提示「无法分叉会话」五个字，
 * 内核准备的成因与建议全部丢失，用户与开发者都无从定位。
 *
 * 本函数是宿主把 catch 到的错误转成通知文本的**唯一出口**：
 * - `MemoraError` → 本文件自渲染（标题 + 原因 + 建议三层拼接，7.0.0 起内核不再提供
 *   `format()`）：内核只给结构化字段，**渲染归消费者**；
 * - 其余错误 → 维持 `err.message` / `String(err)` 原语义，零行为变化。
 *
 * **语言（7.0.0 起）**：三个标签（`❌ Error:` / `Reason:` / `Suggestions:`）走
 * `vscode.l10n.t`，中文界面由 `l10n/bundle.l10n.zh-cn.json` 给译文 ⇒ 英文界面从此全英文。
 * 这取代了旧形态（内核 `format()` 的中文标签硬编码，英文界面恒为「英文键 + 中文正文」混排）。
 *
 * 适用范围 = **extension host 侧**的 catch 转发（chatPanel / settingsPanel / extension.ts）。
 * ⚠️ 本文件因此 **import vscode**（旧版曾是纯 node 文件）——单测以 `vi.mock('vscode')`
 * 提供 `l10n.t` 替身，见 `__tests__/noticeText.test.ts`。
 * webview 侧（chatView / settingsView 的本地 catch）刻意不用——内核不进 webview bundle，
 * 其错误本就是全文，不存在「三层只剩标题」的吞信息问题。
 */
import * as vscode from 'vscode';
import { MemoraError } from '@zooique/memora';

/**
 * 把宿主 catch 到的未知错误转成用户可读的完整通知文本
 *
 * @param err catch 到的未知值
 * @returns MemoraError 的多行完整文案；其余错误的 message（非 Error 值 String 化）
 */
export function toNoticeText(err: unknown): string {
  if (!(err instanceof MemoraError)) {
    return err instanceof Error ? err.message : String(err);
  }
  // 三层逐层拼接：标题恒有，原因与建议按存在性省略（与旧 format() 的排版逐字对齐）
  const lines: string[] = [vscode.l10n.t('❌ Error: {0}', err.title)];
  if (err.detail) lines.push(vscode.l10n.t('   Reason: {0}', err.detail));
  if (err.suggestions.length > 0) {
    lines.push(vscode.l10n.t('   Suggestions:'));
    for (const suggestion of err.suggestions) {
      lines.push(`     - ${suggestion}`);
    }
  }
  return lines.join('\n');
}
