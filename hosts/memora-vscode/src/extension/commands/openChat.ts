/**
 * 命令：打开 Memora 对话面板（聚焦侧边栏视图）
 *
 * 职责：
 *   - 取当前工作区 → 懒加载装配 Agent → 注入侧边栏视图提供者 → 聚焦侧边栏
 *   - 「当前文档上下文」不再由命令注入（2026-08-17 A 层：已转移给 chatPanel 实时
 *     跟随 activeTextEditor——原命令路径仅点此命令生效，点活动栏图标打开面板不注入）。
 *
 * 设计（通用化）：插件是 memora 的通用落地宿主，功能定位由内置角色包承载。
 *   命令只负责装配 Agent + 聚焦视图，不再创建独立 WebviewPanel。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';

/**
 * 内置角色包名（面板徽章展示当前激活角色，在装配处声明，主动可见）
 *
 * 兜底值：装配后以 agent 实际激活角色为准（由持久化的用户选择或内核默认首个决定），
 * 仅当 agent 未装配/无角色包时回退此默认值。
 */
const BUILTIN_ROLE_PACK = 'doc-review';

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
    chatProvider.setAgent(agent);
    // 声明当前激活角色包 → toolbar 角色徽章（定位由角色包承载，主动可见）
    // 取 agent 实际激活角色（持久化用户选择 / 内核默认首个），未装配时回退默认
    chatProvider.setRolePack(agent.rolePackManager?.activeName ?? BUILTIN_ROLE_PACK);
    // 聚焦侧边栏视图
    void vscode.commands.executeCommand(`${MemoraChatViewProvider.viewType}.focus`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
  }
}
