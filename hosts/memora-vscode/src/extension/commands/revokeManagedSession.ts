/**
 * 命令：收回本会话（撤销助手代理，回到「我自己聊」）
 *
 * 为什么是命令面板而不是会话列表按钮：
 * - 撤销是低频、且需要明确「作用在当前会话上」的操作，塞进列表行会增加误触；
 * - 与 `memora.newSession` 对称：一个在开头选「谁推进」，一个在中途把推进权收回。
 *
 * 文案只对用户说人话（「收回」「我自己聊」），不出现「托管 / 主控」这类内部模式名。
 * 本模块只做「用户意图 → 面板动作」的转发，模式容器与重装链路全在 `chatPanel`。
 */
import * as vscode from 'vscode';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';

/** 命令 id（与 package.json#contributes.commands 的值同源维护） */
export const REVOKE_MANAGED_SESSION_COMMAND = 'memora.revokeManagedSession';

/**
 * 收回本会话：把当前会话从助手代理名下撤下
 *
 * @param chatProvider 对话面板提供者（模式容器与装配链路都在它手里）
 */
export async function revokeManagedSessionCommand(
  chatProvider: MemoraChatViewProvider,
): Promise<void> {
  await chatProvider.revokeManagedSession();
}

/**
 * 注册「收回本会话」命令
 *
 * 与 `registerNewSessionCommand` 同构：extension.ts 只留一行接线，实现不外泄到入口文件。
 *
 * @param context 扩展上下文（命令随扩展生命周期释放）
 * @param chatProvider 对话面板提供者
 */
export function registerRevokeManagedSessionCommand(
  context: vscode.ExtensionContext,
  chatProvider: MemoraChatViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REVOKE_MANAGED_SESSION_COMMAND, () =>
      revokeManagedSessionCommand(chatProvider),
    ),
  );
}
