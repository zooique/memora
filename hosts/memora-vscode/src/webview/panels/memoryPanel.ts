/**
 * 记忆管理面板 — 侧边栏 Webview 视图提供者（2026-08-17 独立视图）
 *
 * 职责：
 *   - 渲染记忆库快照：顶栏统计（source 分布）+ 记忆列表（按 score 降序，展开看全文）；
 *   - 关键词/语义搜索（memory_search → 内核 MemoryInspector.searchHybrid）；
 *   - 通过 postMessage 与 extension host 通信，数据源唯一 = 内核 MemoryInspector。
 *
 * 设计（对齐 rolePackPanel.ts 独立视图范式 + 单一真理源）：
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM；
 *   - 数据源唯一 = 内核 MemoryInspector（list / stats / searchHybrid），零内核改动；
 *   - host 侧只做「内核返回 → DTO 归一化」（Memory/AgentSearchHit → MemoryItemDto）；
 *   - 懒装配 Agent（与 chat 面板共享同一单例），未就绪时推送空列表（webview 空态）。
 *
 * 排雷修正（2026-08-17）：
 *   - 列表数据源用 MemoryInspector.list(limit)（snapshot().archive 仅统计无条目）；
 *   - 统计用 stats()（非 getStats()）；
 *   - 空查询不走 searchHybrid（会 throw），空查询由列表路径承载。
 *   - 懒装配用 Promise 缓存而非 boolean 标记：resolve 的 load 与 webview 启动的
 *     memory_load 并发时共享一次装配，避免「先推空再推真」闪烁与重复装配；
 *   - search() 加异常边界：searchHybrid 抛错不产生未处理 rejection（报错 + 推空结果）。
 */
import * as vscode from 'vscode';
import type { Agent, MemoryInspector } from '@zooique/memora';
import type {
  ExtensionToWebviewMessage,
  MemoryItemDto,
  MemoryStatsDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { memoryStyles } from '../styles/memoryStyles.js';

/** 列表加载条数（MVP：只读浏览，先展示最常用的前 20 条） */
const MEMORY_LIST_LIMIT = 20;
/** 搜索结果条数 */
const MEMORY_SEARCH_LIMIT = 20;

/** 记忆管理视图提供者 */
export class MemoraMemoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.memory';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** Agent 懒装配 promise（与 chat 面板共享同一单例）
   *  undefined = 尚未尝试装配；装配中/成功 = 同一 Promise，并发调用共享一次装配；
   *  失败时 catch 内清空为 undefined，允许下次重试（替代 boolean 标记的冗余空推+重复装配） */
  private _agentPromise: Promise<Agent | undefined> | undefined;
  /** Agent 懒装配工厂（由 extension 注入，与 chat 面板同一 getOrCreateAgent） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;

  /**
   * @param extensionUri 插件扩展根 URI（用于 webview 本地资源加载 localResourceRoots）
   */
  constructor(private readonly extensionUri: vscode.Uri) {}

  /** 注入 Agent 懒装配工厂（与 chat 面板共享同一单例装配，SSOT） */
  public setAgentFactory(getAgent: (projectPath: string) => Promise<Agent>): void {
    this._getAgent = getAgent;
  }

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // 启用外部脚本（memoryView.js），localResourceRoots 指向 dist/webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'scripts', 'memoryView.js'),
    );
    // CSP script-src 用 webview.cspSource（本地资源源），对齐 roles 面板（P2-1 经验）
    webviewView.webview.html = buildHtml(scriptUri, webviewView.webview.cspSource);

    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      void this.handleMessage(msg);
    });

    // 首次打开即装配 Agent 并加载记忆列表
    void this.load();
  }

  /** 处理 webview 发来的消息（加载列表 / 搜索） */
  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    if (msg.type === 'memory_load') {
      await this.load();
    } else if (msg.type === 'memory_search') {
      await this.search(msg.query, msg.limit);
    }
  }

  /**
   * 懒装配 Agent（与 chat 面板 ensureAgent 同构，共享同一单例）
   *
   * 用户可能直接点活动栏「记忆」图标打开（未执行 open 命令），此时 agent 从未装配；
   * 此处自动装配。装配成功后返回 memory inspector（可能为 null，调用方处理空态）。
   *
   * 用 Promise 缓存而非 boolean 标记：resolveWebviewView 的 load() 与 webview 启动的
   * memory_load 并发触发时共享同一次装配，避免重复装配与「先推空列表再推真数据」的闪烁。
   */
  private async ensureMemory(): Promise<MemoryInspector | undefined> {
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
    return agent?.memory ?? undefined;
  }

  /** 加载记忆列表（统计 + 按 score 降序前 N 条）并推送 */
  private async load(): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      // agent 未装配或存储未就绪：推送空数据，让 webview 显示空态提示
      this.post({
        type: 'memory_loaded',
        stats: { bySource: {}, total: 0 },
        memories: [],
      });
      return;
    }
    const stats: MemoryStatsDto = memory.stats();
    // list() 返回按 score 降序的 Memory[]（含 content 全文，供详情展开）
    const memories: MemoryItemDto[] = memory.list(MEMORY_LIST_LIMIT).map(toItemDto);
    this.post({ type: 'memory_loaded', stats, memories });
  }

  /** 关键词/语义搜索并推送结果 */
  private async search(query: string, limit?: number): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) return;
    try {
      const hits = await memory.searchHybrid(query, limit ?? MEMORY_SEARCH_LIMIT);
      this.post({ type: 'memory_search_result', query, hits: hits.map(toSearchDto) });
    } catch (err) {
      // 边界守卫：搜索异常（存储不可用等）不产生未处理 rejection；报错 + 推空结果让 UI 自洽
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Memora 记忆搜索失败：${message}`);
      this.post({ type: 'memory_search_result', query, hits: [] });
    }
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }
}

/** 内核 Memory → 记忆条目 DTO（列表：保留全文 content，供详情展开） */
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

/** 内核 AgentSearchHit → 记忆条目 DTO（搜索结果：content 为截断预览） */
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

/** 生成 Webview HTML（记忆卡片列表 + 搜索框）
 *  @param scriptUri 外部脚本 memoryView.js 的 asWebviewUri（CSP script-src cspSource 加载）
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
  ${memoryStyles}
</style>
</head>
<body>
  <!-- 顶栏：标题 + 统计（对齐 roles 面板 header 范式） -->
  <div class="header">
    <h2>记忆</h2>
    <span id="statBar" class="stat-bar" hidden></span>
  </div>
  <!-- 搜索框：关键词/语义检索记忆（空查询由列表路径承载，见 memoryView） -->
  <div class="search-wrap">
    <input id="searchInput" class="search-input" type="text" placeholder="搜索记忆…" aria-label="搜索记忆" />
  </div>
  <!-- 记忆条目列表（由 memoryView.js 渲染，展开查看全文） -->
  <div id="list">
    <p class="hint">加载中…</p>
  </div>
  <!-- 提示：记忆按重要度（score）降序展示，点击卡片展开全文 -->
  <p class="footer-hint">记忆按重要度排序，点击条目查看全文。</p>

  <!-- 运行时脚本由外部 memoryView.js 提供（CSP script-src cspSource 加载） -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
