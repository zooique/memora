/**
 * 交互提醒的 VS Code 适配层（HOST-ATTN-1）
 *
 * 只做一件事：把 `attentionNotice.ts`（纯逻辑、零 vscode 依赖、可单测）需要的六个能力
 * 接到真实 VS Code API 上。判据与文案全在纯逻辑层，本文件**不含任何判断**——薄到不需要
 * 单测，靠 tsc 与真机验收兜底（同 `chatPanel` 内所有 vscode 调用的处理口径）。
 */
import * as vscode from 'vscode';
import { ATTENTION_URI, createAttentionNotifier, type AttentionNotifier } from './attentionNotice.js';
import { createSystemToastSender } from './systemToast.js';

/**
 * 系统 toast 点击回跳地址（定义在 `attentionNotice.ts`，此处转出便于调用方就近引用）
 *
 * 由 VS Code 的协议处理器交给已运行实例，扩展侧在 `extension.ts` 注册 `registerUriHandler`
 * 承接。**不保证多窗口下的落点**（VS Code 可能问「在哪个窗口打开」）——故它只是 L3 的
 * 增强：主承接面是失焦后持久保留的 workbench toast。
 */
export { ATTENTION_URI };

/**
 * 构造带 VS Code 宿主的提醒器
 *
 * @param getView 惰性读当前对话视图（视图会被折叠/重建，**不可快照**——快照会让提醒
 *                永远基于已销毁的实例判断可见性）
 */
export function createVscodeAttention(
  getView: () => vscode.WebviewView | undefined,
): AttentionNotifier {
  return createAttentionNotifier({
    isViewVisible: () => getView()?.visible === true,
    isWindowFocused: () => vscode.window.state.focused,
    showChatView: () => {
      const view = getView();
      // 视图存在 → 原地展开（preserveFocus=false：用户主动点了「去处理」，就该把键盘焦点
      // 交还给对话面板，否则点完还要再点一次输入框）
      if (view) {
        view.show(false);
        return;
      }
      // 视图尚未解析（面板从未打开/已销毁）→ 展开整个 memora 容器；视图随之 resolve
      void vscode.commands.executeCommand('workbench.view.extension.memora');
    },
    showInfoMessage: (message, action) => vscode.window.showInformationMessage(message, action),
    showSystemToast: createSystemToastSender(),
    launchUri: ATTENTION_URI,
  });
}
