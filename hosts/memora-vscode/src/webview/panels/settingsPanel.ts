/**
 * 设置面板 — 侧边栏 Webview 视图提供者（2026-08-17 选项卡合并）
 *
 * 合并角色 / 大模型 / 记忆 三个独立面板为单一"设置"视图，内部通过选项卡切换子视图。
 * 三个子视图保留各自独立行为逻辑，通过共享同一 webview 文档 + root 容器 id 空间隔离共存。
 *
 * 设计（对齐单一真理源 + 自然生长）：
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM；
 *   - 子视图数据源与之前完全一致（roles: RolePackManager / config: ProviderStore / memory: MemoryInspector）；
 *   - 三个子视图的 load 逻辑在 host 侧统一由 settingsPanel 分发（根据 activeTab 决定推送哪个子视图的数据）；
 *   - 选项卡切换时只切换 content 区域显示隐藏，不销毁/重建 DOM（保留子视图状态，减少闪烁）。
 */
import * as vscode from 'vscode';
import type { Agent, MemoryInspector } from '@zooique/memora';
import type { ProviderStore } from '../../extension/providers/providerStore.js';
import type {
  ExtensionToWebviewMessage,
  MemoryItemDto,
  MemoryStatsDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { capabilityLabel } from '../helpers/capabilityLabels.js';
import { settingsStyles } from '../styles/settingsStyles.js';
import { ACTIVE_ROLE_PACK_KEY } from '../../shared/constants.js';

/** 列表加载条数（MVP：只读浏览，先展示最常用的前 20 条） */
const MEMORY_LIST_LIMIT = 20;
/** 搜索结果条数 */
const MEMORY_SEARCH_LIMIT = 20;

/** 设置视图提供者（合并角色 / 大模型 / 记忆三个子视图） */
export class MemoraSettingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.settings';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** Agent 懒装配 promise（与 chat 面板共享同一单例，roles + memory 两个子视图共用一条装配路径）
   *  undefined = 尚未尝试装配；装配中/成功 = 同一 Promise，并发调用共享一次装配；
   *  失败时 catch 内清空为 undefined，允许下次重试（替代 boolean 标记的冗余空推+重复装配） */
  private _agentPromise: Promise<Agent | undefined> | undefined;
  /** 是否已绑定 personaSwitched 事件（角色切换可观测，只绑定一次避免重复监听） */
  private _personaBound = false;
  /** Agent 懒装配工厂（由 extension 注入，与 chat 面板同一 getOrCreateAgent） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 全局状态存储（持久化激活角色包，用户级） */
  private _globalState: vscode.Memento | undefined;
  /** 待切换的子选项卡（configureModel 命令在视图未就绪时缓存，webview ready 后补发） */
  private _pendingTab: 'roles' | 'config' | 'memory' | undefined;

  /**
   * @param extensionUri 插件扩展根 URI（用于 webview 本地资源加载 localResourceRoots）
   * @param store 大模型配置存储（extension 注入，供 config 子视图使用）
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: ProviderStore,
  ) {}

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
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'scripts', 'settingsView.js'),
    );
    webviewView.webview.html = buildHtml(scriptUri, webviewView.webview.cspSource);

    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      void this.handleMessage(msg);
    });
  }

  /** 处理 webview 发来的消息（ready 握手 + 三个子视图各自的消息路由） */
  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    // ready 握手：webview 脚本已就绪（全部子视图监听器已注册）→ 补发待切选项卡 + 统一推送三个子视图数据
    if (msg.type === 'ready') {
      // configureModel 命令可能在视图未就绪时触发：待切选项卡缓存在此，就绪后补发，
      // 保证命令落点与用户意图一致（对齐 chatPanel replaySession 的 ready 时序修复）
      if (this._pendingTab) {
        this.post({ type: 'settings_switch_tab', tab: this._pendingTab });
        this._pendingTab = undefined;
      }
      // 恢复独立面板「宿主主动推送」兜底：ready 握手保证所有监听器已注册，此时推送
      // 三个子视图数据必然可达。即使 webview 拉取消息（cfg_load/memory_load）因时序
      // 丢失，也不会让子视图停留「加载中…」（角色/记忆依赖 Agent 装配，配置/记忆拉取
      // 可能早于装配完成；统一在就绪后推送一次是稳妥的收敛点）。
      void this.loadRoles();
      void this.loadConfig();
      void this.loadMemory();
      return;
    }

    // ─── 角色子视图消息 ───
    if (msg.type === 'roles_set_active') {
      const agent = await this.ensureAgent();
      const rpm = agent?.rolePackManager;
      if (!rpm) return;
      const ok = rpm.activate(msg.name);
      if (ok) {
        this._globalState?.update(ACTIVE_ROLE_PACK_KEY, msg.name);
      } else {
        this.post({ type: 'notice', level: 'error', message: `角色包不存在：${msg.name}` });
      }
      void this.loadRoles();
      return;
    }

    // ─── 大模型配置子视图消息 ───
    if (msg.type === 'cfg_load') {
      await this.loadConfig();
      return;
    }
    if (msg.type === 'cfg_save') {
      try {
        const r = await this.store.save(msg.config, msg.isEditing);
        this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'save' });
        if (r.ok) await this.loadConfig();
      } catch (err) {
        this.post({
          type: 'cfg_result',
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          action: 'save',
        });
      }
      return;
    }
    if (msg.type === 'cfg_delete') {
      const choice = await vscode.window.showWarningMessage(
        `确定删除服务商 "${msg.name}"？此操作不可恢复。`,
        { modal: true },
        '删除',
      );
      if (choice !== '删除') return;
      try {
        const r = await this.store.remove(msg.name);
        this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'delete' });
        if (r.ok) await this.loadConfig();
      } catch (err) {
        this.post({
          type: 'cfg_result',
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          action: 'delete',
        });
      }
      return;
    }
    if (msg.type === 'cfg_set_active') {
      try {
        const r = await this.store.setActive(msg.name);
        this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'set_active' });
        if (r.ok) await this.loadConfig();
      } catch (err) {
        this.post({
          type: 'cfg_result',
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          action: 'set_active',
        });
      }
      return;
    }
    if (msg.type === 'cfg_test') {
      try {
        const r = await this.store.test(msg.config);
        this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'test' });
      } catch (err) {
        this.post({
          type: 'cfg_result',
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          action: 'test',
        });
      }
      return;
    }

    // ─── 记忆子视图消息 ───
    if (msg.type === 'memory_load') {
      await this.loadMemory();
      return;
    }
    if (msg.type === 'memory_search') {
      await this.searchMemory(msg.query, msg.limit);
      return;
    }
  }

  // ─── 角色子视图数据加载 ───

  private async ensureAgent(): Promise<Agent | undefined> {
    if (!this._getAgent) return undefined;
    if (!this._agentPromise) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        void vscode.window.showWarningMessage('Memora：请先打开一个工作区');
        return undefined;
      }
      // 装配失败清空 promise（允许下次重试）；并发调用共享同一次装配
      this._agentPromise = this._getAgent(ws).catch((err) => {
        this._agentPromise = undefined;
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Memora 装配失败：${message}`);
        return undefined;
      });
    }
    const agent = await this._agentPromise;
    // 只绑定一次 personaSwitched（角色切换可观测 —— 跨面板一致）
    if (agent && !this._personaBound) {
      this._personaBound = true;
      agent.off('personaSwitched', this.onPersonaSwitched);
      agent.on('personaSwitched', this.onPersonaSwitched);
    }
    return agent;
  }

  private readonly onPersonaSwitched = (): void => {
    void this.loadRoles();
  };

  private async loadRoles(): Promise<void> {
    const agent = await this.ensureAgent();
    const rpm = agent?.rolePackManager;
    if (!rpm) {
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
          displayName: m.displayName ?? m.name,
          description: m.description ?? '',
          capabilities: (pack?.capabilities ?? []).map((c) => ({
            capability: c.capability,
            label: capabilityLabel(c.capability),
          })),
        };
      });
    const activeName = rpm.activeName ?? (packs.length > 0 ? packs[0]!.name : '');
    this.post({ type: 'roles_loaded', packs, activeName });
  }

  // ─── 大模型配置子视图数据加载 ───

  private async loadConfig(): Promise<void> {
    const providers = await this.store.listMasked();
    this.post({ type: 'cfg_loaded', providers, activeName: this.store.getActiveName() });
  }

  // ─── 记忆子视图数据加载 ───

  private async ensureMemory(): Promise<MemoryInspector | undefined> {
    const agent = await this.ensureAgent();
    return agent?.memory ?? undefined;
  }

  private async loadMemory(): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({
        type: 'memory_loaded',
        stats: { bySource: {}, total: 0 },
        memories: [],
      });
      return;
    }
    const stats: MemoryStatsDto = memory.stats();
    const memories: MemoryItemDto[] = memory.list(MEMORY_LIST_LIMIT).map(toItemDto);
    this.post({ type: 'memory_loaded', stats, memories });
  }

  private async searchMemory(query: string, limit?: number): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) return;
    try {
      const hits = await memory.searchHybrid(query, limit ?? MEMORY_SEARCH_LIMIT);
      this.post({ type: 'memory_search_result', query, hits: hits.map(toSearchDto) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Memora 记忆搜索失败：${message}`);
      this.post({ type: 'memory_search_result', query, hits: [] });
    }
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }

  /**
   * 切换子选项卡（由 host 命令触发，如 configureModel 命令切换到「大模型」）
   *
   * 向 webview 推送 settings_switch_tab 指令，webview 切换选项卡高亮 + 显示对应子视图；
   * 视图尚未就绪时缓存待切选项卡，等 ready 握手后补发（避免命令消息被丢弃）。
   */
  public switchTab(tab: 'roles' | 'config' | 'memory'): void {
    this._pendingTab = tab;
    if (this._view) {
      this.post({ type: 'settings_switch_tab', tab });
      this._pendingTab = undefined;
    }
  }
}

/** 内核 Memory → 记忆条目 DTO */
function toItemDto(m: {
  id: string;
  name: string;
  source: string;
  score: number;
  content: string;
  createdAt?: string;
}): MemoryItemDto {
  return {
    id: m.id,
    name: m.name,
    source: m.source,
    score: m.score,
    content: m.content,
    createdAt: m.createdAt,
  };
}

/** 内核 AgentSearchHit → 记忆条目 DTO */
function toSearchDto(h: {
  id: string;
  name: string;
  source: string;
  score: number;
  contentPreview: string;
  createdAt?: string;
}): MemoryItemDto {
  return {
    id: h.id,
    name: h.name,
    source: h.source,
    score: h.score,
    content: h.contentPreview,
    createdAt: h.createdAt,
  };
}

/** 生成 Webview HTML（选项卡栏 + 三个子视图根容器）
 *  @param scriptUri 外部脚本 settingsView.js 的 asWebviewUri（CSP script-src cspSource 加载）
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
  ${settingsStyles}
</style>
</head>
<body>
  <!-- 选项卡栏：记忆（默认首页）/ 角色 / 大模型 -->
  <div class="tabs" role="tablist" aria-label="设置选项卡">
    <button class="tab-btn active" data-tab="memory" role="tab" aria-selected="true">记忆</button>
    <button class="tab-btn" data-tab="roles" role="tab" aria-selected="false">角色</button>
    <button class="tab-btn" data-tab="config" role="tab" aria-selected="false">大模型</button>
  </div>

  <!-- 记忆子视图（memory 选项卡，默认首页） -->
  <div id="memory-root" role="tabpanel" aria-label="记忆">
    <div class="header">
      <h2>记忆</h2>
      <span id="statBar" class="stat-bar" hidden></span>
    </div>
    <div class="search-wrap">
      <input id="searchInput" class="search-input" type="text" placeholder="搜索记忆…" aria-label="搜索记忆" />
    </div>
    <div id="list">
      <p class="hint">加载中…</p>
    </div>
    <p class="footer-hint">记忆按重要度排序，点击条目查看全文。</p>
  </div>

  <!-- 角色子视图（roles 选项卡） -->
  <div id="roles-root" role="tabpanel" aria-label="角色" hidden>
    <div class="header">
      <h2>角色</h2>
      <span id="statBar" class="stat-bar" hidden></span>
    </div>
    <div id="list">
      <p class="hint">加载中…</p>
    </div>
    <p class="footer-hint">角色决定对话定位与可用能力，切换后长期生效。</p>
  </div>

  <!-- 大模型配置子视图（config 选项卡） -->
  <div id="config-root" role="tabpanel" aria-label="大模型配置" hidden>
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
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}