/**
 * 命令：新建会话并选择运行模式（托管模式 v0 · 路线 §14.21.4「甲案」）
 *
 * 为什么放在命令面板而不是标题条按钮：
 * - 模式是「这一次会话按什么身份装配」的低频选择，塞进标题条会让主界面多一层状态；
 * - 命令触发后仍走标题条「＋」的同一条草稿路径（`newSessionFromCommand`），不另造建会话链路。
 *
 * 默认值只有一个来源：宿主 `SessionModeStore` 里的用户级「上次模式」。
 * 本模块只做「选择 → 传值」，不解释模式语义，也不写 origin（落盘归 `createSession`）。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { SessionMode, SessionModeStore } from '../host/sessionModeStore.js';
import { openChatCommand } from './openChat.js';

/** QuickPick 项：`value` 是唯一载荷；label / description 只做展示 */
type ModePickItem = vscode.QuickPickItem & { value: SessionMode };

/**
 * 新建会话命令：选择模式 → 聚焦对话面板 → 进入草稿
 *
 * @param getAgent 按工作区懒装配 Agent 的工厂（与 `memora.open` 同一份）
 * @param chatProvider 对话面板提供者（复用标题条「＋」的入口）
 * @param sessionModes 会话模式容器（只读「上次模式」作默认值）
 */
export async function newSessionCommand(
  getAgent: (projectPath: string) => Promise<Agent>,
  chatProvider: MemoraChatViewProvider,
  sessionModes: SessionModeStore,
): Promise<void> {
  const lastMode = sessionModes.getLastMode();

  /** 自助模式项：origin 落 'user' */
  const selfItem: ModePickItem = {
    value: 'self',
    label: vscode.l10n.t('Self mode'),
    description: vscode.l10n.t('You drive the session'),
  };
  /** 托管模式项：origin 落 'hosted'，装配注入主控工具面 */
  const managedItem: ModePickItem = {
    value: 'managed',
    label: vscode.l10n.t('Managed mode'),
    description: vscode.l10n.t('A host orchestrates the session'),
  };

  // VS Code QuickPick 没有「默认选中」API：把上次模式置顶并标注，等价视觉默认
  const defaultItem = lastMode === 'managed' ? managedItem : selfItem;
  defaultItem.detail = vscode.l10n.t('Used last time');
  const items = lastMode === 'managed' ? [managedItem, selfItem] : [selfItem, managedItem];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Choose how the new session runs'),
  });
  if (!picked) return; // 取消 = 什么都不做（不制造空草稿）

  // 与标题条「＋」同一条路径：先确保面板可见，再进入草稿；真正建会话仍在首次发送
  await openChatCommand(getAgent, chatProvider);
  await chatProvider.newSessionFromCommand(picked.value);
}

/**
 * 注册「新建会话（选择模式）」命令
 *
 * 与 `registerAddToChatCommand` / `registerResidentRuleCommands` 同构：extension.ts 只留一行接线，
 * 命令实现与快速选择细节不外泄到入口文件（该文件已贴 max-lines 上限）。
 */
export function registerNewSessionCommand(
  context: vscode.ExtensionContext,
  getAgent: (projectPath: string) => Promise<Agent>,
  chatProvider: MemoraChatViewProvider,
  sessionModes: SessionModeStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.newSession', () =>
      newSessionCommand(getAgent, chatProvider, sessionModes),
    ),
  );
}
