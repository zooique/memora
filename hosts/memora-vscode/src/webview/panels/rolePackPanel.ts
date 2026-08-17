/**
 * 角色管理面板 — 侧边栏 Webview 视图提供者（2026-08-17 独立视图）
 *
 * 职责：
 *   - 渲染全部角色包卡片（激活徽章 + 定位描述 + 能力标签 + 「设为当前」按钮）；
 *   - 通过 postMessage 与 extension host 通信，切换激活角色（复用内核 rolePackManager）；
 *   - 角色切换是低频需求（决定插件定位与工具集），独立成视图承载「能力展示」，
 *     从对话输入区移出（角色选择器不再占用高频操作位）。
 *
 * 设计（对齐 providerConfigPanel.ts 的独立视图范式 + 单一真理源）：
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM；
 *   - 角色数据源唯一 = 内核 RolePackManager（listMeta + get(name).capabilities）；
 *   - 能力名（域:动作）由 capabilityLabels.ts 翻译为中文 label（未知回退原名）；
 *   - 切换角色复用 chat 面板同一路径：activate + 持久化用户级激活态（SSOT）；
 *   - 绑定 personaSwitched 事件：chat 面板切换角色时本视图同步刷新（跨面板一致）。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { capabilityLabel } from '../helpers/capabilityLabels.js';
import { rolesStyles } from '../styles/rolesStyles.js';
import { ACTIVE_ROLE_PACK_KEY } from '../../shared/constants.js';

/** 角色管理视图提供者 */
export class MemoraRolePackViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.roles';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** 当前装配的 Agent（懒装配，与 chat 面板共享同一单例） */
  private _agent: Agent | undefined;
  /** 是否已尝试装配（避免视图每次展开都重复装配） */
  private _agentResolving = false;
  /** Agent 懒装配工厂（由 extension 注入，与 chat 面板同一 getOrCreateAgent） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 全局状态存储（持久化激活角色包，用户级） */
  private _globalState: vscode.Memento | undefined;

  /**
   * @param extensionUri 插件扩展根 URI（用于 webview 本地资源加载 localResourceRoots）
   */
  constructor(private readonly extensionUri: vscode.Uri) {}

  /** 注入 Agent 懒装配工厂（与 chat 面板共享同一单例装配，SSOT） */
  public setAgentFactory(getAgent: (projectPath: string) => Promise<Agent>): void {
    this._getAgent = getAgent;
  }

  /** 注入全局状态（持久化激活角色包，用户级，跨项目共享） */
  public setGlobalState(gs: vscode.Memento): void {
    this._globalState = gs;
  }

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // 启用外部脚本（rolesView.js），localResourceRoots 指向 dist/webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'scripts', 'rolesView.js'),
    );
    // CSP script-src 用 webview.cspSource（本地资源源），对齐 config 面板（P2-1 经验）
    webviewView.webview.html = buildHtml(scriptUri, webviewView.webview.cspSource);

    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      void this.handleMessage(msg);
    });

    // 首次打开不立即加载：等待 webview 脚本就绪（ready 握手）后再推送角色列表，
    // 避免 roles_loaded 在脚本 message 监听器注册前到达而被丢弃（时序竞态，对齐 chatPanel）。
  }

  /** 处理 webview 发来的消息（ready 握手 + 切换激活角色） */
  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    // ready 握手：webview 脚本已就绪（message 监听器已注册）→ 加载角色列表，
    // 保证 roles_loaded 在监听器就绪后才推送（时序竞态修复，对齐 chatPanel replaySession）
    if (msg.type === 'ready') {
      await this.load();
      return;
    }
    if (msg.type === 'roles_set_active') {
      const agent = await this.ensureAgent();
      const rpm = agent?.rolePackManager;
      if (!rpm) return;
      const ok = rpm.activate(msg.name);
      if (ok) {
        // 持久化激活角色包（用户级偏好，跨项目共享，与 chat 面板 handleSetRolePack 同源）
        this._globalState?.update(ACTIVE_ROLE_PACK_KEY, msg.name);
      } else {
        this.post({ type: 'notice', level: 'error', message: `角色包不存在：${msg.name}` });
      }
      // 切换后重推列表（激活徽章 + 能力高亮刷新）
      await this.load();
    }
  }

  /**
   * 懒装配 Agent（与 chat 面板 ensureAgent 同构，共享同一单例）
   *
   * 用户可能直接点活动栏「角色」图标打开（未执行 open 命令），此时 agent 从未装配；
   * 此处自动装配，装配成功后绑定 personaSwitched 事件（chat 面板切角色时本视图同步刷新）。
   */
  private async ensureAgent(): Promise<Agent | undefined> {
    if (this._agent || this._agentResolving || !this._getAgent) return this._agent;
    this._agentResolving = true;
    try {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        void vscode.window.showWarningMessage('Memora：请先打开一个工作区');
        return undefined;
      }
      this._agent = await this._getAgent(ws);
      // 角色切换可观测：chat 面板/本视图任一切换 → 本视图重推列表（跨面板一致）
      this._agent.off('personaSwitched', this.onPersonaSwitched);
      this._agent.on('personaSwitched', this.onPersonaSwitched);
      return this._agent;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
      return undefined;
    } finally {
      this._agentResolving = false;
    }
  }

  /** 角色切换事件 → 重推角色列表（跨面板同步） */
  private readonly onPersonaSwitched = (): void => {
    void this.load();
  };

  /** 加载角色包列表（含能力中文标签）并推送给 webview */
  private async load(): Promise<void> {
    const agent = await this.ensureAgent();
    const rpm = agent?.rolePackManager;
    if (!rpm) {
      // agent 未装配或装配失败：推送空列表，让 webview 显示空态/提示
      this.post({ type: 'roles_loaded', packs: [], activeName: '' });
      return;
    }
    const packs = rpm
      .listMeta()
      .filter((m) => m.name)
      .map((m) => {
        const pack = rpm.get(m.name);
        return {
          name: m.name,
          // SSOT：displayName 从 manifest 读取，缺省回退 name（单一来源）
          displayName: m.displayName ?? m.name,
          description: m.description ?? '',
          // 能力声明 → 中文标签（未知能力回退原名；capabilityLabels.ts 单一映射）
          capabilities: (pack?.capabilities ?? []).map((c) => ({
            capability: c.capability,
            label: capabilityLabel(c.capability),
          })),
        };
      });
    const activeName = rpm.activeName ?? (packs.length > 0 ? packs[0]!.name : '');
    this.post({ type: 'roles_loaded', packs, activeName });
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }
}

/** 生成 Webview HTML（角色包卡片列表）
 *  @param scriptUri 外部脚本 rolesView.js 的 asWebviewUri（CSP script-src cspSource 加载）
 *  @param cspSource webview 本地资源源（webview.cspSource，供 CSP 放行外部脚本） */
function buildHtml(scriptUri: vscode.Uri, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src ${cspSource};" />
<style>
  ${rolesStyles}
</style>
</head>
<body>
  <!-- 顶栏：标题 + 统计（对齐 config 面板 §4.2 ①） -->
  <div class="header">
    <h2>角色</h2>
    <span id="statBar" class="stat-bar" hidden></span>
  </div>
  <!-- 角色包卡片列表（由 rolesView.js 渲染） -->
  <div id="list">
    <p class="hint">加载中…</p>
  </div>
  <!-- 提示：角色决定插件定位与工具集，切换后长期生效 -->
  <p class="footer-hint">角色决定对话定位与可用能力，切换后长期生效。</p>

  <!-- 阶段 B（P2-1）：运行时脚本由外部 rolesView.js 提供（CSP script-src cspSource 加载） -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
