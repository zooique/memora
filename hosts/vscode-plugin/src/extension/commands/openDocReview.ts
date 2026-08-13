/**
 * 命令：打开设计文档打磨面板
 *
 * 职责：
 *   - 取当前工作区 → 懒加载装配 Agent → 打开对话打磨面板（切片 A）
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { openChatPanel } from '../../webview/panels/chatPanel.js';

/**
 * 打开打磨面板
 *
 * @param getAgent 按工作区路径懒加载/复用 Agent 的工厂（由 extension.ts 注入）
 */
export async function openDocReviewCommand(
  getAgent: (projectPath: string) => Promise<Agent>,
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('Memora：请先打开一个工作区');
    return;
  }
  try {
    const agent = await getAgent(workspaceFolder.uri.fsPath);
    openChatPanel(agent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
  }
}
