/**
 * 托管编辑器页（HOSTED-UI-SEAT-DECOUPLE-1）
 *
 * 形态（用户拍板 2026-11-16）：一个**独立的编辑器标签页**，就是微信式的对话前端——
 * 有输入框、能发图、显示气泡回答、顶部状态签。它对应**助手自己那条会话**（你和助手的对话
 * 线），与侧栏正在看的工作会话是两条；助手据此派活到那些工作会话。
 *
 * ⚠️ 现行实现与上述形态不符（台账 HOSTED-SEAT-SESSION-1，勿当设计读）：本页注册进广播器
 * 后收到的仍是 chatPanel 按 `_currentSessionId` 产生的消息，因此在侧栏切工作会话时，本页会
 * 跟着显示那条会话。要修好须拆出「每视图绑定会话 + 会话级消息按目标投递 + 流态按会话分片」。
 *
 * 为什么不是「另一套 UI」：本页与侧栏挂**同一个** `chatView.js` + 同一份 `buildHtml` 骨架，
 * 唯一差异是挂载常量 `body[data-form='assistant']`（样式层已就位）。上行消息经
 * `chatProvider.routeHostedMessage` 汇入**同一个**会话状态机；宿主广播经注册进同一广播器
 * 同时投给两页。因此没有第二份渲染核心、第二份会话状态、第二份授权/确认真源。
 *
 * 生命周期照 `workbenchPanel`：单例容器，重复 open 只 reveal；不设 retainContextWhenHidden
 * （隐藏即销毁 webview 上下文，reveal 后脚本重发 ready，由 chatProvider 回放整份会话）。
 */
import * as vscode from 'vscode';
import { buildHtml } from './chatPanelHtml.js';
import type { MemoraChatViewProvider } from './chatPanel.js';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';

/** 托管页依赖 */
export interface HostedPanelDeps {
  /** 扩展根（拼 chatView.js 资源地址） */
  extensionUri: vscode.Uri;
  /** 对话状态机宿主（注册视图 + 转发上行消息） */
  chatProvider: MemoraChatViewProvider;
}

/** 托管编辑器页（单例容器） */
export class MemoraHostedPanel {
  public static readonly viewType = 'memora.hosted';

  private _panel: vscode.WebviewPanel | undefined;
  /** 广播器注销句柄（面板销毁时调用） */
  private _unregister: vscode.Disposable | undefined;

  private readonly _extensionUri: vscode.Uri;
  private readonly _chatProvider: MemoraChatViewProvider;

  constructor(deps: HostedPanelDeps) {
    this._extensionUri = deps.extensionUri;
    this._chatProvider = deps.chatProvider;
  }

  /** 打开（或聚焦）托管页；标题随当前会话展示，切会话后由 open 时重取 */
  public open(): void {
    if (this._panel) {
      this._panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MemoraHostedPanel.viewType,
      vscode.l10n.t('Assistant mode'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
      },
    );
    this._panel = panel;

    // 挂到对话广播器：宿主消息从此扇出到本页（与侧栏同一状态机）
    this._unregister = this._chatProvider.registerAdditionalView(panel.webview);

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'scripts', 'chatView.js'),
    );
    // 与侧栏唯一差异：form='assistant'（样式 / 文案 / 气泡取景全由这一常量驱动）
    panel.webview.html = buildHtml(scriptUri, panel.webview.cspSource, 'assistant');

    panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      if (this._panel !== panel) return;
      this._chatProvider.routeHostedMessage(message);
    });

    panel.onDidDispose(() => {
      if (this._panel !== panel) return;
      this._unregister?.dispose();
      this._unregister = undefined;
      this._panel = undefined;
    });
  }
}
