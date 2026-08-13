/**
 * Memora Doc Review — VS Code 插件入口（ADR-VC-001 宿主）
 *
 * 职责：
 *   - 注册命令（打开面板 / 审阅文档）
 *   - 懒加载装配 Agent（assembleDocReviewAgent）
 *   - 打开 Webview 面板（docReviewPanel）
 *
 * 阶段 0：命令「打开设计文档打磨」→ 装配 Agent → Webview 对话。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { assembleDocReviewAgent } from './host/assemble.js';
import { openDocReviewPanel } from '../webview/docReviewPanel.js';

/** 懒加载的 Agent 单例（跨命令复用） */
let agentPromise: Promise<Agent> | null = null;

/** 获取（或创建）当前工作区的 Agent 实例 */
function getOrCreateAgent(projectPath: string): Promise<Agent> {
  if (!agentPromise) {
    agentPromise = assembleDocReviewAgent({ projectPath }).catch((err) => {
      // 装配失败则重置，下次命令重试
      agentPromise = null;
      throw err;
    });
  }
  return agentPromise;
}

/** 插件激活入口 */
export function activate(context: vscode.ExtensionContext): void {
  // 命令：打开设计文档打磨面板
  context.subscriptions.push(
    vscode.commands.registerCommand('memoraDocReview.open', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        void vscode.window.showErrorMessage('Memora：请先打开一个工作区');
        return;
      }
      try {
        const agent = await getOrCreateAgent(workspaceFolder.uri.fsPath);
        openDocReviewPanel(agent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
      }
    }),
  );

  // 命令：审阅当前文档自洽性（阶段 0 占位，阶段 2 实现自洽检查）
  context.subscriptions.push(
    vscode.commands.registerCommand('memoraDocReview.review', () => {
      void vscode.window.showInformationMessage('文档自洽检查将在阶段 2 开放');
    }),
  );
}

/** 插件停用入口 */
export function deactivate(): void {
  // Agent 由宿主持有；如需优雅关闭可在后续阶段补充 agent.close()
}
