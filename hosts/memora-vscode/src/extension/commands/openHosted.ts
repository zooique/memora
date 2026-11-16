/**
 * 「打开托管页」命令（侧栏标题栏按钮 + 命令面板共用一条入口）
 *
 * 托管页是**当前会话的 assistant 取景**（HOSTED-UI-SEAT-DECOUPLE-1）：微信式气泡对话前端，
 * 输入汇入侧栏同一台状态机。因此本命令不需要选座、不新建会话——它只是把「当前这条会话」
 * 在编辑器区再开一个取景视图。若当前在草稿态（无会话），打开后首次发送会按既有建会话链
 * 落会话，两视图一起回放，无需本命令介入。
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
