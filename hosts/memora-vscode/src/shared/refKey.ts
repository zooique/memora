/**
 * refKey — 对话引用的身份键与去重规则（宿主与 webview 共用，零依赖）
 *
 * **为什么独立成文件**：宿主（缓冲合并）与 webview（chip 合并）都要**值导入**它，
 * 而它零依赖、`@zooique/memora` 也不需要 ⇒ 放进 `shared/protocol.ts` 会把 1500+ 行
 * 协议的运行时常量一并打进 webview bundle，放这里则体积可控。
 *
 * **为什么要有单点**：该规则曾两处并列复制（`chatPanel.pushRefs` 的缓冲去重 +
 * `chatView.addRefs` 的 seen 去重），改判据时极易只改一处 ⇒ 下沉到这里单点定义。
 */
import type { ChatRef } from './protocol.js';

/**
 * 引用的身份键（**去重判据 SSOT**）
 *
 * 同文件不同行区间是**两条**引用：先加整个文件再加选区，若按 path 合并则用户第二次
 * 操作静默失效（「加了等于没加」）。故键含行区间。
 * 键内不含 pinned：钉住态是纯 UI 态，不参与身份判定。
 */
export function refKeyOf(ref: ChatRef): string {
  return ref.range ? `${ref.path}#L${ref.range.start}-L${ref.range.end}` : ref.path;
}

/** 按 `refKeyOf` 去重（保留首次出现序） */
export function dedupeRefs(refs: readonly ChatRef[]): ChatRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = refKeyOf(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
