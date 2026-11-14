/**
 * 「打开工作台」命令（命令面板 + 侧栏标题栏按钮共用同一条入口）
 *
 * 解析「看哪一条座位」的三档，全部基于既有事实（本进程的托管装配表）：
 *   ① 当前聊天会话是托管会话 → 就是它；
 *   ② 本进程恰有一条托管会话 → 用它；
 *   ③ 多条 → QuickPick 让用户选（不做「猜一个」的默认值）。
 * 一条都没有 → 如实提示当前没有代理在替你安排，**不打开一个空面板假装有**。
 *
 * 边界：本命令只负责选座位与开面板；座位身份、状态与清单全由工作台面板按既有
 * 事实现场读取（命令不缓存、不落盘、不新增状态）。
 */
import * as vscode from 'vscode';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { MemoraWorkbenchPanel } from '../../webview/panels/workbenchPanel.js';
import type { SessionModeStore } from '../host/sessionModeStore.js';
import type { HostSessionStore } from '../host/sessionStore.js';
import { sessionDisplayTitle } from '../host/sessionTitle.js';

/** 命令依赖（全部为既有单例） */
export interface OpenWorkbenchDeps {
  /** 聊天面板（读当前会话） */
  chatProvider: MemoraChatViewProvider;
  /** 工作台面板（打开 / 改绑） */
  workbench: MemoraWorkbenchPanel;
  /** 会话模式表（只读：哪些会话按托管装配） */
  sessionModes: SessionModeStore;
  /** 会话存储（QuickPick 展示标题） */
  sessionStore: HostSessionStore;
}

/**
 * 命令实现：解析座位并打开工作台
 *
 * @param deps 既有单例依赖
 */
export async function openWorkbench(deps: OpenWorkbenchDeps): Promise<void> {
  const target = await resolveSeat(deps);
  if (!target) return;
  deps.workbench.open(target);
}

/**
 * 解析座位会话
 *
 * @param deps 既有单例依赖
 * @returns 座位会话 id（无座位 / 用户取消时为 undefined）
 */
async function resolveSeat(deps: OpenWorkbenchDeps): Promise<string | undefined> {
  // ① 当前显示会话就是托管会话：入口最自然的语义
  const current = deps.chatProvider.getCurrentSessionId();
  if (current && deps.sessionModes.isManaged(current)) return current;

  const managed = deps.sessionModes.listManagedSessionIds();
  if (managed.length === 0) {
    // 如实说「没有」，不建空面板：空面板会让人误以为代理在、只是没活
    void vscode.window.showInformationMessage(
      vscode.l10n.t('No managed agent session is running right now'),
    );
    return undefined;
  }
  // ② 唯一一条：直接打开
  if (managed.length === 1) return managed[0];

  // ③ 多条：让用户选（标题取与历史列表同一口径；id 作描述便于排错）
  const picked = await vscode.window.showQuickPick(
    managed.map((sessionId) => ({
      label: sessionDisplayTitle(
        sessionId,
        deps.sessionStore.getSessionMeta(sessionId),
        vscode.l10n,
      ),
      description: sessionId,
      sessionId,
    })),
    { placeHolder: vscode.l10n.t('Choose the agent session to inspect') },
  );
  return picked?.sessionId;
}

/**
 * 注册命令（extension.ts 只留一行接线）
 *
 * @param context 扩展上下文（命令随订阅释放）
 * @param deps 既有单例依赖
 */
export function registerOpenWorkbenchCommand(
  context: vscode.ExtensionContext,
  deps: OpenWorkbenchDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.openWorkbench', () => openWorkbench(deps)),
  );
}
