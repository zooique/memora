/**
 * 托管编辑器页（HOSTED-UI-SEAT-DECOUPLE-1）
 *
 * 形态（用户拍板 2026-11-16）：一个**独立的编辑器标签页**，就是微信式的对话前端——
 * 有输入框、能发图、显示气泡回答、顶部状态签。它对应**助手自己那条会话**（你和助手的对话
 * 线），与侧栏正在看的工作会话是两条；助手据此派活到那些工作会话。
 *
 * ⚠️ 绑定纪律（HOSTED-SEAT-SESSION-1）：本页注册时绑定**助手会话**（工作区指针）且声明
 * `bubbleOnly`——宿主按目标会话路由，本页只收该会话的气泡级消息。侧栏切工作会话不影响本页；
 * 在侧栏打开助手会话时，两页同屏（侧栏完整过程、本页气泡取景）。
 *
 * 为什么不是「另一套 UI」：本页与侧栏挂**同一个** `chatView.js` + 同一份 `buildHtml` 骨架，
 * 唯一差异是挂载常量 `body[data-form='assistant']`（样式层已就位）。上行消息经
 * `chatProvider.routeHostedMessage` 汇入**同一个**会话状态机；宿主广播经注册进同一广播器
 * 按会话投给两页。因此没有第二份渲染核心、第二份会话状态、第二份授权/确认真源。
 *
 * 生命周期照 `workbenchPanel`：单例容器，重复 open 只 reveal；不设 retainContextWhenHidden
 * （隐藏即销毁 webview 上下文，reveal 后脚本重发 ready，由 chatProvider 回放整份会话）。
 */
import * as vscode from 'vscode';
import { buildHtml } from './chatPanelHtml.js';
import type { MemoraChatViewProvider } from './chatPanel.js';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import { resolveAttachmentsDir } from '../../extension/host/projectDataDir.js';
import type { WorkbenchSnapshot } from '../../shared/workbenchDto.js';

/** 托管页依赖 */
export interface HostedPanelDeps {
  /** 扩展根（拼 chatView.js 资源地址） */
  extensionUri: vscode.Uri;
  /** 对话状态机宿主（注册视图 + 转发上行消息） */
  chatProvider: MemoraChatViewProvider;
  /** 工作区根（派生 attachments 资源根，与侧栏 chatPanel 同一真源） */
  workspacePath: string;
  /** 现场构建工作台快照（INLINE-WORKBENCH-1）：真源 = workbenchPanel.buildSnapshot，零第二套投影 */
  buildWorkbenchSnapshot: (orchestratorId: string) => WorkbenchSnapshot;
}

/** 托管编辑器页（单例容器） */
export class MemoraHostedPanel {
  public static readonly viewType = 'memora.hosted';

  private _panel: vscode.WebviewPanel | undefined;
  /** 广播器注销句柄（面板销毁时调用） */
  private _unregister: vscode.Disposable | undefined;

  private readonly _extensionUri: vscode.Uri;
  private readonly _chatProvider: MemoraChatViewProvider;
  private readonly _workspacePath: string;
  private readonly _buildWorkbenchSnapshot: (orchestratorId: string) => WorkbenchSnapshot;

  constructor(deps: HostedPanelDeps) {
    this._extensionUri = deps.extensionUri;
    this._chatProvider = deps.chatProvider;
    this._workspacePath = deps.workspacePath;
    this._buildWorkbenchSnapshot = deps.buildWorkbenchSnapshot;
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
        localResourceRoots: [
          vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview'),
          // IMG-2 K3 同口径对齐侧栏 chatPanel：助手窗收到图片回执后，悬停预览的
          // asWebviewUri 指向 attachments 目录，不放行则图加载失败退文本态。
          // 目录真源与侧栏同为 resolveAttachmentsDir，不新造路径拼接。
          vscode.Uri.file(resolveAttachmentsDir(this._workspacePath)),
        ],
      },
    );
    this._panel = panel;

    // 挂到对话广播器：绑定助手会话（指针，现场读取）+ 只收气泡级消息
    this._unregister = this._chatProvider.registerAdditionalView(panel.webview, {
      sessionId: () => this._chatProvider.getAssistantSessionId(),
      bubbleOnly: true,
    });

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'scripts', 'chatView.js'),
    );
    // 与侧栏唯一差异：form='assistant'（样式 / 文案 / 气泡取景全由这一常量驱动）
    panel.webview.html = buildHtml(scriptUri, panel.webview.cspSource, 'assistant');

    panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      if (this._panel !== panel) return;
      // INLINE-WORKBENCH-1：助手页「工作台」按钮就地展开抽屉，不再开独立 editor tab。
      // 上行 type 不变（assistantFormView 判据锁「只上报意图、选座/取数在宿主」）；
      // 宿主按当前助手会话现场构建快照直投本页，与独立面板同一投影真源、零新增 type。
      if (message.type === 'assistant_open_workbench') {
        const sid = this._chatProvider.getAssistantSessionId() ?? '';
        void panel.webview.postMessage({
          type: 'workbench_snapshot',
          snapshot: this._buildWorkbenchSnapshot(sid),
        });
        return;
      }
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
