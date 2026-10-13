/**
 * 错误 → 用户可见通知文本（宿主单一出口）
 *
 * 内核 `MemoraError` 分三层：`message` 只含标题（`super(opts.title)`），原因（detail）
 * 与排查建议（suggestions）只在 `format()` 里。宿主各 catch 若直接 `err.message` 转发，
 * 结构化诊断在宿主边界被吞——实测症状：会话分叉失败只提示「无法分叉会话」五个字，
 * 内核准备的成因与建议全部丢失，用户与开发者都无从定位。
 *
 * 本函数是宿主把 catch 到的错误转成通知文本的**唯一出口**：
 * - `MemoraError` → `format()` 全文（标题 + 原因 + 建议；文案模板 SSOT 在内核，宿主零自建措辞）；
 * - 其余错误 → 维持 `err.message` / `String(err)` 原语义，零行为变化。
 *
 * 适用范围 = **extension host 侧**的 catch 转发（chatPanel / settingsPanel / extension.ts）。
 * webview 侧（chatView / settingsView 的本地 catch）刻意不用——内核不进 webview bundle，
 * 其错误本就是全文，不存在「三层只剩标题」的吞信息问题。
 */
import { MemoraError } from '@zooique/memora';

/**
 * 把宿主 catch 到的未知错误转成用户可读的完整通知文本
 *
 * @param err catch 到的未知值
 * @returns MemoraError 的多行完整文案；其余错误的 message（非 Error 值 String 化）
 */
export function toNoticeText(err: unknown): string {
  if (err instanceof MemoraError) return err.format();
  return err instanceof Error ? err.message : String(err);
}
