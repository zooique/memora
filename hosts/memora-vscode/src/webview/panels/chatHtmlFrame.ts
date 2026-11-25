/**
 * 对话面板 HTML 首帧装配（CHAT-TEXT-SCALE-1）
 *
 * 把「读配置 → 调静态骨架」收在这里，chatPanel.ts / hostedPanel.ts 两个面板
 * 各留一行调用——面板本身逼近 max-lines 闸门，不再容纳多行参数拼装。
 * buildHtml 仍是纯静态骨架（不读配置），本 wrapper 才持有运行时读口。
 */
import * as vscode from 'vscode';
import { buildHtml } from './chatPanelHtml.js';
import type { UiForm } from '../../shared/protocol.js';
import { readChatTextScale } from '../../extension/host/chatTextScaleConfig.js';

export function buildChatHtml(scriptUri: vscode.Uri, cspSource: string, form: UiForm): string {
  return buildHtml(scriptUri, cspSource, form, readChatTextScale());
}
