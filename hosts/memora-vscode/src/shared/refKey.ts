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

/** 行区间（1-based 闭区间）。与协议 `ChatRef.range` **同形**——刻意不另造类型名。 */
type Range = { start: number; end: number };

/**
 * 行区间不变量归一化（**唯一判定点**）
 *
 * 合法 = 两个端点皆为整数、`start >= 1`、`end >= start`；其余一律 `undefined`
 * （调用方按「无区间 = 整文件引用」降级）。
 *
 * 为什么要单点：`range` 可从协议外部上行（webview 构造的 `open_ref` 载荷），
 * 不校验就流到「`limit = end - start + 1`」这类算式会算出 0 / 负数，模型据此读不到内容
 * 却没有任何报错。生产端（`selectionToRefRange`）本来就保证有序，但**保证不能只靠上游**。
 */
export function normalizeRefRange(range: Range | undefined | null): Range | undefined {
  if (!range) return undefined;
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < 1 || end < start) return undefined;
  return { start, end };
}

/**
 * 行区间标签（**显示格式唯一产地**）：单行 `#L7`，跨行 `#L5-L24`
 *
 * 键（`refKeyOf`）、chip 行号 span、信封 `参考文件：` 行一律经此拼串。
 * 曾四处各写一遍（键恒不折叠、信封恒不折叠、chip 折叠到单行、行号 span 再抄一遍），
 * 同一引用在 UI 显示 `#L7`、喂给模型却是 `#L7-L7` —— 改一处必漂移，故下沉单点。
 * 非法区间返回空串（**不是** `#Lundefined`）。
 */
export function formatRefRange(range: Range | undefined | null): string {
  const r = normalizeRefRange(range);
  if (!r) return '';
  return r.start === r.end ? `#L${r.start}` : `#L${r.start}-L${r.end}`;
}

/**
 * 引用的身份键（**去重判据 SSOT**）
 *
 * 同文件不同行区间是**两条**引用：先加整个文件再加选区，若按 path 合并则用户第二次
 * 操作静默失效（「加了等于没加」）。故键含行区间，且区间部分与显示共用 `formatRefRange`
 * （键不落盘、只在内存比较，折叠单行不会与整文件键冲突：整文件键 = 裸 path）。
 * 键内不含 pinned：钉住态是纯 UI 态，不参与身份判定。
 */
export function refKeyOf(ref: ChatRef): string {
  return `${ref.path}${formatRefRange(ref.range)}`;
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
