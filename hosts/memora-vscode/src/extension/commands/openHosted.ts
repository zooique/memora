/**
 * 「打开助手窗」命令（侧栏标题栏按钮 + 命令面板共用一条入口）
 *
 * 助手唯一、入口唯一（HOSTED-SEAT-SESSION-1）：本命令只开窗，不看侧栏当前会话、不选座、
 * 不新建会话。窗口固定绑定**助手会话**（工作区指针）；首次打开无助手会话时是空态，
 * 用户第一次发送才建会话并写指针（见 chatPanel `handleHostedInput`）。
 */
import * as vscode from 'vscode';
import type { MemoraHostedPanel } from '../../webview/panels/hostedPanel.js';

/** 注册命令（extension.ts 只留一行接线） */
export function registerOpenHostedCommand(
  context: vscode.ExtensionContext,
  panel: MemoraHostedPanel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.openHosted', () => {
      try {
        panel.open();
      } catch (err) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to open the assistant panel: {0}', String(err)),
        );
      }
    }),
  );
}
