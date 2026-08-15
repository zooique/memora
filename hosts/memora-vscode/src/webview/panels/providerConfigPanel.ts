/**
 * 大模型配置面板 — 侧边栏 Webview 视图提供者
 *
 * 职责：
 *   - 渲染多 Provider 卡片列表（激活徽章 + 设为当前/编辑/删除按钮）
 *   - 新增/编辑弹窗表单（别名/显示名/模型/BaseURL/API Key/测试连接）
 *   - 通过 postMessage 与 extension host 通信，读写 ProviderStore
 *
 * 设计（对齐 memora-sprite 的多 Provider 管理 + 单一真理源）：
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM
 *   - apiKey 传输给 webview 时为脱敏值；保存时留空=保留原值
 *   - 复用 shared/protocol.ts 的 LlmProviderConfig 与 cfg_* 消息契约
 */
import * as vscode from 'vscode';
import type { ProviderStore } from '../../extension/providers/providerStore.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { configStyles } from '../styles/configStyles.js';

/** 配置视图提供者 */
export class MemoraConfigViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.config';

  /** 当前 webview */
  private _view: vscode.WebviewView | undefined;

  /**
   * @param extensionUri 插件扩展根 URI（用于 webview 本地资源加载 localResourceRoots）
   * @param store 大模型配置存储（extension 注入）
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: ProviderStore,
  ) {}

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // 阶段 B（P2-1）：启用外部脚本（configView.js），localResourceRoots 指向 dist/webview
    // 供 webview.asWebviewUri 解析（CSP script-src 'self'，不再用 'unsafe-inline' 注入脚本）
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    // 渲染界面（外部脚本 configView.js 提供交互）
    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'scripts', 'configView.js'),
    );
    webviewView.webview.html = buildHtml(scriptUri);

    // 处理来自 webview 的配置操作
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      void this.handleMessage(msg);
    });

    // 首次加载列表
    void this.load();
  }

  /** 处理 webview 发来的配置消息 */
  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'cfg_load':
          await this.load();
          break;
        case 'cfg_save': {
          const r = await this.store.save(msg.config, msg.isEditing);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'save' });
          if (r.ok) await this.load();
          break;
        }
        case 'cfg_delete': {
          // 危险操作：VSCode webview 禁用原生 confirm()，改由 host 侧弹原生 modal 确认，
          // 避免「确认框静默失效 → 删除按钮无反应」的功能性缺陷（对抗评估 P0-2）
          const choice = await vscode.window.showWarningMessage(
            `确定删除服务商 "${msg.name}"？此操作不可恢复。`,
            { modal: true },
            '删除',
          );
          if (choice !== '删除') break;
          const r = await this.store.remove(msg.name);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'delete' });
          if (r.ok) await this.load();
          break;
        }
        case 'cfg_set_active': {
          const r = await this.store.setActive(msg.name);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'set_active' });
          if (r.ok) await this.load();
          break;
        }
        case 'cfg_test': {
          const r = await this.store.test(msg.config);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'test' });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.post({
        type: 'cfg_result',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        action: 'save',
      });
    }
  }

  /** 加载 Provider 列表并推送给 webview */
  private async load(): Promise<void> {
    // getActiveName 为同步读取，无需 Promise 包装（对抗评估 P2-7a）
    const providers = await this.store.listMasked();
    this.post({ type: 'cfg_loaded', providers, activeName: this.store.getActiveName() });
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }
}

/** 生成 Webview HTML（Provider 列表 + 表单弹窗）
 *  @param scriptUri 外部脚本 configView.js 的 asWebviewUri（CSP script-src 'self' 加载，阶段 B P2-1） */
function buildHtml(scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self';" />
<style>
  ${configStyles}
</style>
</head>
<body>
  <!-- ① 顶栏（sticky）：统计 + 添加，对齐 ui-redesign.md §4.2 ① -->
  <div class="header">
    <h2>大模型配置</h2>
    <span id="statBar" class="stat-bar" hidden></span>
    <button id="btnAdd" class="btn">添加 API</button>
  </div>
  <div id="list">
    <p class="hint">加载中…</p>
  </div>

  <!-- 新增/编辑弹窗 -->
  <div id="modal" class="modal-mask">
    <div class="modal">
      <h3 id="modalTitle">添加 API</h3>
      <!-- 表单语义：label 与 input 用 for/id 关联（可点击聚焦 + 读屏识别），
           支持 Enter 提交；非认证字段 autocomplete=off 避免密码管理器误触发。 -->
      <form id="cfgForm">
        <div class="field">
          <label for="f-name">别名（唯一，仅英文数字.-_）</label>
          <input id="f-name" name="name" type="text" placeholder="如 deepseek" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-display">显示名称</label>
          <input id="f-display" name="displayName" type="text" placeholder="如 DeepSeek" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-model">模型</label>
          <input id="f-model" name="model" type="text" placeholder="如 deepseek-chat" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-baseurl">API Base URL</label>
          <input id="f-baseurl" name="baseUrl" type="url" placeholder="https://api.deepseek.com/v1" autocomplete="url" />
        </div>
        <div class="field">
          <label for="f-apikey">API Key（编辑时留空保持不变）</label>
          <input id="f-apikey" name="apiKey" type="password" placeholder="sk-…" autocomplete="new-password" />
          <div id="apikeyHint" class="key-hint" hidden></div>
        </div>
        <div id="testResult" class="test-result" hidden></div>
        <div class="modal-actions">
          <button id="btnTest" type="button" class="btn btn-secondary">测试连接</button>
          <button id="btnCancel" type="button" class="btn btn-secondary">取消</button>
          <button id="btnSave" type="submit" class="btn">保存</button>
        </div>
      </form>
    </div>
  </div>

  <div id="toast"></div>

  <!-- 阶段 B（P2-1）：运行时脚本由外部 configView.js 提供（CSP script-src 'self'） -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
}