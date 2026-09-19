/**
 * 流式错误 category → 用户可见文案（**单一真理源**，Node 侧与 webview 侧共用）
 *
 * 为何必须放 `shared/`：同一份映射被两端同时需要 —— ① Node 侧 `chatPanel.consumeFlow` 的 `error`
 * 分支（实时提示条）；② webview 侧 `chatView.appendInterruptedRow`（中断轮平铺停止行，含失败原因）。
 * 各写一份即「文案双源漂移」（`chatView.stopReasonLabel` 的注释已就此告警）。
 * `shared/` 是两端唯一共同可引层（`protocol.ts` / `constants.ts` 同处）。
 *
 * 未收录的 category（如 'unknown'）**回退原始 message** —— 与收口前 `chatPanel` 的既有行为逐字等价
 * （不改既有错误展示：保留技术细节供排查，不做二次加工）。
 */
import type { LlmErrorCategory } from '@zooique/memora';

/** category → 友好文案（未收录 = 不映射，走回退原文） */
const FRIENDLY_ERROR_TEXT: Partial<Record<LlmErrorCategory, string>> = {
  connection: '对话连接中断，已保留部分回答，请检查网络后重试',
  timeout: '对话处理超时，请稍后重试',
};

/**
 * 取错误展示文案。
 *
 * @param category 内核判定的结构化分类（缺省 = 普通错误 / 旧数据）
 * @param rawMessage 内核原始 message（回退用）
 * @returns 友好文案；无对应映射时返回 rawMessage
 */
export function friendlyErrorMessage(
  category: LlmErrorCategory | undefined,
  rawMessage: string,
): string {
  return (category !== undefined && FRIENDLY_ERROR_TEXT[category]) || rawMessage;
}
