/**
 * 工作台 v0 — 编辑器区只读面板（两块：代理是谁 / 最近在办什么）
 *
 * 生命周期（宿主里的**第三种组合**，刻意与现有两种都不同）：
 *   - 侧栏聊天视图：webview **不保活**，面板对象由 VS Code 持有；
 *   - 设置面板：webview **保活**（`retainContextWhenHidden: true`）；
 *   - 本面板：**面板对象存活 + webview 上下文不保活**——隐藏即销毁，`reveal()` 时
 *     脚本重载并重发 `ready`，宿主收到 `ready` 后**全量回放**一整个快照。
 *
 * 为什么选择这种组合：工作台是纯读侧投影（无表单草稿、无本地交互状态），保活只会
 * 让「屏上数据」与「宿主事实」多一条可能分叉的路径；销毁重建 + 全量回放让
 * 「你看到的 = 宿主此刻的事实」成为唯一路径，代价是每次显示多一次读。
 *
 * 只读：没有输入框、不发送消息；唯一上行动作是「去这个会话」（切换聊天面板并聚焦）。
 */
import * as vscode from 'vscode';
import { buildWorkbenchHtml } from './workbenchHtml.js';
import { buildWorkbenchSnapshot, type WorkbenchSnapshotInputs } from '../helpers/workbenchModel.js';
import type { WorkbenchHistoryResult } from '../helpers/workbenchHistory.js';
import type { WorkbenchSeatSource } from '../../shared/workbenchDto.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

/**
 * 快照读口（每次 push 现场组装）
 *
 * 接口而非直接塞一个 inputs 对象：座位 id 在面板存活期可能被「为另一条会话打开」
 * 改写，读口必须按当前 id 现场产出一份全新的 inputs（禁缓存快照——缓存即第二状态源）。
 */
export interface WorkbenchDataSource {
  /**
   * 打开时从历史重建子会话（**只在该面板 open 时调用**）
   *
   * 不在每次刷新 / 插件激活时调用：重建要读盘，代价必须有上限且只在用户看的时候付。
   */
  rebuildHistory(orchestratorId: string): WorkbenchHistoryResult;
  /** 组装一次快照的全部读口（`history` 是 open 时那次重建的缓存结果） */
  buildInputs(
    orchestratorId: string,
    history: WorkbenchHistoryResult,
    seatSource: WorkbenchSeatSource,
  ): WorkbenchSnapshotInputs;
}

/** 面板依赖 */
export interface WorkbenchPanelDeps {
  /** 扩展根（拼脚本 / 样式资源地址） */
  extensionUri: vscode.Uri;
  /** 数据读口 */
  dataSource: WorkbenchDataSource;
  /** 「去这个会话」：切聊天面板的显示会话并聚焦（失败由面板弹错误提示） */
  openSession: (sessionId: string) => Promise<void> | void;
}

/** 可见期刷新周期（只读快照很轻；隐藏/销毁即停，不做后台轮询） */
const REFRESH_INTERVAL_MS = 3000;

/**
 * 工作台面板（单例容器）
 *
 * 单例：重复打开只 `reveal` 并改绑座位，不开第二个标签页。
 */
export class MemoraWorkbenchPanel {
  /** 面板类型标识（命令 / 恢复逻辑的唯一键） */
  public static readonly viewType = 'memora.workbench';

  /** 当前面板实例（undefined = 未打开 / 已关闭） */
  private _panel: vscode.WebviewPanel | undefined;
  /** 当前绑定的座位会话 id */
  private _orchestratorId = '';
  /** 当前座位的来源（live = 实时托管；history = 重启后按历史重建，无实时驱动方） */
  private _seatSource: WorkbenchSeatSource = 'live';
  /** 当前座位的「打开时历史重建」缓存（undefined = 尚未 open / 需重建） */
  private _history: WorkbenchHistoryResult | undefined;
  /** 当前 webview 上下文是否已发 ready（隐藏即归零：上下文已销毁） */
  private _ready = false;
  /** 可见期刷新定时器（仅 ready 后存在） */
  private _timer: ReturnType<typeof setInterval> | undefined;

  /** 扩展根 */
  private readonly _extensionUri: vscode.Uri;
  /** 数据读口 */
  private readonly _dataSource: WorkbenchDataSource;
  /** 切会话回调 */
  private readonly _openSession: (sessionId: string) => Promise<void> | void;

  constructor(deps: WorkbenchPanelDeps) {
    this._extensionUri = deps.extensionUri;
    this._dataSource = deps.dataSource;
    this._openSession = deps.openSession;
  }

  /**
   * 打开（或改绑）工作台
   *
   * @param orchestratorId 座位会话 id（一条托管会话）
   * @param options 座位来源；缺省 `live`（命令入口在进程内托管表为空时传 `history`）
   */
  public open(orchestratorId: string, options: { seatSource?: WorkbenchSeatSource } = {}): void {
    this._orchestratorId = orchestratorId;
    this._seatSource = options.seatSource ?? 'live';
    // 每次「打开」都重建一次历史（换座位 / 重新打开都算）：清单可能来自上一次进程，
    // 账本是空的；这里读的是既有历史，不新增任何持久化。
    this._history = this._dataSource.rebuildHistory(orchestratorId);
    if (this._panel) {
      this._panel.reveal();
      // 已可见时 reveal 不会重载 ⇒ 现场刷新一次；隐藏时上下文已销毁（_ready=false），
      // 由新脚本的 ready 触发全量回放——两条路径都不依赖旧 webview 的内存。
      if (this._ready) this.push();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MemoraWorkbenchPanel.viewType,
      vscode.l10n.t('Workbench'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // 刻意不设 retainContextWhenHidden（默认 false）：见文件头「第三种组合」
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
      },
    );
    this._panel = panel;
    this._ready = false;

    panel.onDidDispose(() => {
      if (this._panel !== panel) return;
      this._panel = undefined;
      this._ready = false;
      this.stopTimer();
    });

    panel.onDidChangeViewState((event) => {
      if (this._panel !== panel) return;
      if (!event.webviewPanel.visible) {
        // 隐藏 = webview 上下文被 VS Code 销毁：就绪位必须归零，
        // 否则 reveal 后不会等新的 ready，首屏会空白（无保活时没有「旧内容」可看）
        this._ready = false;
        this.stopTimer();
        return;
      }
      // 可见但未重建（例如只换了列）：补刷一次；真正重建时 _ready=false，等 ready 回放
      if (this._ready) this.push();
    });

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'scripts', 'workbenchView.js'),
    );
    panel.webview.html = buildWorkbenchHtml(scriptUri, panel.webview.cspSource);

    panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      if (this._panel !== panel) return;
      if (message.type === 'ready') {
        // ready = 脚本已加载且监听器已注册的唯一真源：此后才允许投递
        this._ready = true;
        this.push();
        this.startTimer();
        return;
      }
      if (message.type === 'workbench_open_session') {
        void Promise.resolve(this._openSession(message.sessionId)).catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            vscode.l10n.t('Could not open the session: {0}', String(error)),
          );
        });
      }
    });
  }

  /**
   * 投递一次全量快照
   *
   * 未 ready / 面板已销毁时静默跳过（不是丢失：重建后的 ready 会重发整份）。
   */
  private push(): void {
    const panel = this._panel;
    if (!panel || !this._ready || !this._history) return;
    const snapshot = buildWorkbenchSnapshot(
      this._dataSource.buildInputs(this._orchestratorId, this._history, this._seatSource),
    );
    void panel.webview.postMessage({
      type: 'workbench_snapshot',
      snapshot,
    } satisfies ExtensionToWebviewMessage);
  }

  /** 启动可见期刷新（幂等：先停旧的，避免重复定时器） */
  private startTimer(): void {
    this.stopTimer();
    this._timer = setInterval(() => this.push(), REFRESH_INTERVAL_MS);
  }

  /** 停止可见期刷新 */
  private stopTimer(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = undefined;
  }
}
