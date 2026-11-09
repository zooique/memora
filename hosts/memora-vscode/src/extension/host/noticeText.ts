/**
 * 错误 → 用户可见通知文本（宿主单一出口，纯 node 可测——禁 import vscode，
 * 窗口通知文案函数在 `windowNotices.ts`）
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
 *
 * ⚠️ **已知缺口（登记台账，不是遗漏）**：`MemoraError.format()` 的标签（「原因：」「建议：」）
 * 与三层正文都是**内核中文 SSOT**，故英文界面下本函数输出仍是中文全文——调用点会得到
 * 「英文键 + 中文正文」的混排。宿主**不得**为消除混排自建英文模板：那会成为第二套错误渲染
 * 真源（同一错误两种排版，改一处漏一处）。真解 = 内核文案英文化（切片 5 之后），届时本函数
 * 零改动即可跟随。
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
