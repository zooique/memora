/**
 * 用户气泡的来源标签（「由 X 发送」）—— 托管轮的唯一盖章呈现点
 *
 * 为什么外置：chatView.ts 贴 max-lines 上限（2600 有效行），呈现工具放 helper 里自然生长，
 * 不删注释、不压平既有代码。
 *
 * 盖章取值单点 = 消息携带的发送者名（托管轮 = `HOSTED_SENDER_NAME`，2026-11-20 拍板统一，
 * 不再按来源会话取名）。无名字时用中性兜底文案，不编造会话标题。
 */
import * as l10n from '@vscode/l10n';

/**
 * 给用户气泡追加来源标签（只在 origin==='hosted' 时追加）
 *
 * @param div 用户气泡容器
 * @param meta 消息上的来源标记（origin + senderName）
 */
export function appendHostedOriginTag(
  div: HTMLElement,
  meta?: { origin?: string; senderName?: string },
): void {
  if (meta?.origin !== 'hosted') return;
  const tag = document.createElement('span');
  tag.className = 'msg-origin-tag';
  tag.textContent = meta.senderName
    ? l10n.t('Sent by {0}', meta.senderName)
    : l10n.t('Sent by the assistant');
  div.appendChild(tag);
}
