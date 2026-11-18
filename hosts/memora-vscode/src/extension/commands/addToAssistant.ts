/**
 * 命令：添加到助手（右键文件/目录 → 把引用挂到助手页输入区）
 *
 * ADDED-TO-ASSISTANT-1：与「添加到对话」共用同一条解析链（路径归属 / 图片嗅探 /
 * 选区行区间 / 去重全在 `addToChatCommand`），只注入不同的投递目标——文本引用投助手页
 * webview（草稿，与会话无关），真图按 IMAGE-TARGET-1 定向助手会话。零新增协议 type、
 * 零新会话实体、零第二份解析判据。
 *
 * 「自动打开」是用户拍板的体验形态（2026-11-19）：点命令先 `memora.openHosted` 打开助手页，
 * 引用再投；未 ready 由 hostedPanel 缓冲到 ready 补发（与侧栏 `_pendingRefs` 同构）。
 */
import * as vscode from 'vscode';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { MemoraHostedPanel } from '../../webview/panels/hostedPanel.js';
import { addToChatCommand, type RefDelivery } from './addToChat.js';
import { resolveCommandTitle } from '../host/manifestNls.js';

/** 注册「添加到助手」命令（extension.ts 只留一行接线） */
export function registerAddToAssistantCommand(
  context: vscode.ExtensionContext,
  chatProvider: MemoraChatViewProvider,
  hostedPanel: MemoraHostedPanel,
): void {
  const title = resolveCommandTitle(
    context.extensionUri.fsPath,
    vscode.env.language,
    'addToAssistant',
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.addToAssistant', (uri) =>
      addToChatCommand(uri, chatProvider, title, assistantDelivery(chatProvider, hostedPanel)),
    ),
  );
}

/**
 * 助手投递目标（差异只在「打开谁 + 往哪投」）
 *
 * 引用投 hostedPanel（草稿缓冲到 ready）；真图传助手会话 id 让回执定向助手页——
 * 空态未建会话时 id 为空，退回缺省侧栏投递，与既有助手窗空态加图同口径（不引入第三态）。
 */
function assistantDelivery(
  chatProvider: MemoraChatViewProvider,
  hostedPanel: MemoraHostedPanel,
): RefDelivery {
  return {
    focusCommand: 'memora.openHosted',
    attachRefs: (refs) => hostedPanel.attachRefs(refs),
    attachImages: (paths) =>
      chatProvider.pickAndAttachImages(paths, chatProvider.getAssistantSessionId()),
  };
}
