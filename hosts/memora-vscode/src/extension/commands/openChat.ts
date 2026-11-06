/**
 * 命令：打开 Memora 对话面板（聚焦侧边栏视图）
 *
 * 职责：
 *   - 取当前工作区 → 懒加载装配 Agent → 注入侧边栏视图提供者 → 聚焦侧边栏
 *   - 「当前文档上下文」不由命令注入，由 chatPanel 在发送时实时读 activeTextEditor
 *     （若由命令注入，仅点此命令生效、点活动栏图标打开面板不注入——坑）。
 *     2026-10-20 起该上下文有显式入口：输入框上方的「当前文件 chip」（`HOST-CTX-3`），
 *     可见「指针 / 全文已附」并能按会话关闭——命令侧仍不参与，避免第二处真相。
 *
 * 设计（通用化）：插件是 memora 的通用落地宿主，功能定位由内置角色包承载。
 *   命令只负责装配 Agent + 聚焦视图，不再创建独立 WebviewPanel。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { toNoticeText } from '../host/noticeText.js';
import { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';

/**
 * 打开对话面板（聚焦侧边栏视图）
 *
 * @param getAgent 按工作区路径懒加载/复用 Agent 的工厂（由 extension.ts 注入）
 * @param chatProvider 侧边栏对话视图提供者（注入 Agent）
 */
export async function openChatCommand(
  getAgent: (projectPath: string) => Promise<Agent>,
  chatProvider: MemoraChatViewProvider,
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('Memora：请先打开一个工作区');
    return;
  }
  try {
    const agent = await getAgent(workspaceFolder.uri.fsPath);
    // 注入 Agent（文档上下文由 chatPanel 实时跟随活动编辑器，见构造函数）
    // 角色徽章由 `bindAgent` 按 agent 真实激活值投影——不再额外写一份「回退默认名」，
    // 否则内核无激活包时徽章会显示一个并未生效的角色名（谎报）
    chatProvider.setAgent(agent);
    // 聚焦侧边栏视图
    void vscode.commands.executeCommand(`${MemoraChatViewProvider.viewType}.focus`);
  } catch (err) {
    const msg = toNoticeText(err);
    void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
  }
}
