/**
 * 对话正文档位 — webview 侧应用（CHAT-TEXT-SCALE-1）
 *
 * 只做一件事：把宿主下发的档位归一化后写进 body 的 data-text-scale 属性。
 * CSS 令牌层（tokens.ts）读到该属性即切换 --font-chat-text，无需重建 webview、
 * 无需碰 chatView.ts 的渲染状态（草稿 / 滚动 / 在途流一律保留）。
 *
 * 归一化复用 shared/textScale.ts：消息面不信任，未知值回退 normal（与缺省逐字等价）。
 */
import { normalizeTextScale } from '../../shared/textScale.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 入口监听器：只认 general_setting 的 chatTextScale kind，其余消息一律不理。 */
export function applyTextScaleMessage(msg: ExtensionToWebviewMessage, body: HTMLElement): void {
  if (msg.type !== 'general_setting' || msg.kind !== 'chatTextScale') return;
  body.dataset.textScale = normalizeTextScale(msg.value);
}
