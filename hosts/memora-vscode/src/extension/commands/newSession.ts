/**
 * 命令：新建会话（恒为普通会话）
 *
 * 为什么不再选「运行模式」（2026-11-17 定案）：助手唯一、入口唯一——助手只从「打开助手窗」
 * 进入，侧栏新建会话一律是普通会话（`self` 装配）。原先的托管模式选项已随入口收口退役，
 * 这里不再需要 QuickPick，也不需要读用户级「上次模式」。
 *
 * 触发后仍走标题条「＋」的同一条草稿路径（`newSessionFromCommand`），不另造建会话链路。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import { openChatCommand } from './openChat.js';

/**
 * 新建会话命令：聚焦对话面板 → 进入草稿
 *
 * @param getAgent 按工作区懒装配 Agent 的工厂（与 `memora.open` 同一份）
 * @param chatProvider 对话面板提供者（复用标题条「＋」的入口）
 */
export async function newSessionCommand(
  getAgent: (projectPath: string) => Promise<Agent>,
  chatProvider: MemoraChatViewProvider,
): Promise<void> {
  // 与标题条「＋」同一条路径：先确保面板可见，再进入草稿；真正建会话仍在首次发送
  await openChatCommand(getAgent, chatProvider);
  await chatProvider.newSessionFromCommand();
}

/**
 * 注册「新建会话」命令
 *
 * 与 `registerAddToChatCommand` / `registerResidentRuleCommands` 同构：extension.ts 只留一行接线，
 * 命令实现不外泄到入口文件（该文件已贴 max-lines 上限）。
 */
export function registerNewSessionCommand(
  context: vscode.ExtensionContext,
  getAgent: (projectPath: string) => Promise<Agent>,
  chatProvider: MemoraChatViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.newSession', () =>
      newSessionCommand(getAgent, chatProvider),
    ),
  );
}
