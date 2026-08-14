/**
 * 命令：打开 Memora 对话面板（聚焦侧边栏视图）
 *
 * 职责：
 *   - 取当前工作区 → 懒加载装配 Agent → 注入侧边栏视图提供者 → 聚焦侧边栏
 *   - 读取当前活动编辑器的 .md 文档内容，作为对话上下文注入（任务 A）
 *
 * 设计（通用化）：插件是 memora 的通用落地宿主，功能定位由内置角色包承载。
 *   命令只负责装配 Agent + 注入上下文 + 聚焦视图，不再创建独立 WebviewPanel。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';

/**
 * 内置角色包名（面板徽章展示当前激活角色，在装配处声明，主动可见）
 *
 * 插件出厂携带唯一内置角色包 doc-review（文档打磨定位）；
 * 后续支持导入角色包时，此处由用户选择的角色包名动态替换。
 */
const BUILTIN_ROLE_PACK = 'doc-review';

/**
 * 读取当前活动编辑器中的 Markdown 文档内容
 *
 * 仅当活动文档为 .md 时返回全文；否则返回 undefined（退化为普通对话）。
 * 文档属于「当前任务上下文」，交给侧边栏注入对话，不进入记忆召回。
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
 * 打开对话面板（聚焦侧边栏视图）
 *
 * @param getAgent 按工作区路径懒加载/复用 Agent 的工厂（由 extension.ts 注入）
 * @param chatProvider 侧边栏对话视图提供者（注入 Agent + 文档上下文）
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
    // 注入 Agent + 当前 .md 文档上下文（任务 A）
    chatProvider.setAgent(agent);
    chatProvider.setDocContext(readActiveMarkdown());
    // 声明当前激活角色包 → toolbar 角色徽章（定位由角色包承载，主动可见）
    chatProvider.setRolePack(BUILTIN_ROLE_PACK);
    // 聚焦侧边栏视图
    void vscode.commands.executeCommand(`${MemoraChatViewProvider.viewType}.focus`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
  }
}
