/**
 * 命令：侧栏形态切换（自助 ⇄ 助手）
 *
 * 为什么做成两条命令而不是输入区里的一个开关控件：
 * - 助手形态的输入区**只能有输入框和发送键**（用户硬约束），第二控件不许出现；
 * - 宿主原生 `view/title` 按钮正好表达「两个并列形态」：两条互斥的菜单项 + 一个
 *   context key，谁在场由 VS Code 自己按 `when` 判，不另写显隐状态机。
 *
 * 边界：本模块只把「用户点了哪个形态」转给面板；形态状态、会话自动切换、
 * 向 webview 下发 `ui_form` 全在 `MemoraChatViewProvider.setUiForm`（唯一写点）。
 */
import * as vscode from 'vscode';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import { UI_FORM_CONTEXT_KEY } from '../../webview/panels/assistantFormOps.js';
import type { UiForm } from '../../shared/protocol.js';

/** 切回自助形态的命令 id */
export const FORM_SELF_COMMAND = 'memora.form.self';

/** 切到助手形态的命令 id */
export const FORM_ASSISTANT_COMMAND = 'memora.form.assistant';

/**
 * 按当前形态播种 context key
 *
 * 必须在注册时先播种一次：`when` 判据读不到值时两条菜单项都不出现（或同时出现），
 * 用户会看到「切不回去 / 两个按钮都在」。缺省值 `self` = 启动即自助形态。
 *
 * @param chatProvider 对话面板提供者（形态真源）
 */
export function syncUiFormContext(chatProvider: MemoraChatViewProvider): void {
  void vscode.commands.executeCommand('setContext', UI_FORM_CONTEXT_KEY, chatProvider.getUiForm());
}

/**
 * 注册形态切换命令
 *
 * @param context 扩展上下文（命令随扩展生命周期释放）
 * @param chatProvider 对话面板提供者
 */
export function registerAssistantFormCommands(
  context: vscode.ExtensionContext,
  chatProvider: MemoraChatViewProvider,
): void {
  const switchTo = (form: UiForm) => async (): Promise<void> => {
    await chatProvider.setUiForm(form);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(FORM_SELF_COMMAND, switchTo('self')),
    vscode.commands.registerCommand(FORM_ASSISTANT_COMMAND, switchTo('assistant')),
  );
  syncUiFormContext(chatProvider);
}
