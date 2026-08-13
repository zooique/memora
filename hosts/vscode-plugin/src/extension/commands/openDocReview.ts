/**
 * 命令：打开设计文档打磨面板
 *
 * 职责：
 *   - 取当前工作区 → 懒加载装配 Agent → 打开对话打磨面板（切片 A）
 *   - 读取当前活动编辑器的 .md 文档内容，作为对话上下文注入（任务 A）
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { openChatPanel } from '../../webview/panels/chatPanel.js';

/**
 * 读取当前活动编辑器中的 Markdown 文档内容
 *
 * 仅当活动文档为 .md 时返回全文；否则返回 undefined（退化为普通对话）。
 * 文档属于「当前任务上下文」，交给 chatPanel 注入对话，不进入记忆召回。
 *
 * @returns Markdown 文档文本，或 undefined（无活动 .md 文档）
 */
function readActiveMarkdown(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const doc = editor.document;
  if (doc.languageId !== 'markdown') return undefined;
  return doc.getText();
}

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
    // 读取当前 .md 文档作为对话上下文（任务 A）
    const docContext = readActiveMarkdown();
    openChatPanel(agent, docContext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
  }
}
