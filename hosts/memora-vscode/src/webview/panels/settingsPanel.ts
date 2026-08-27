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
import { createBackgroundProvider } from '../../extension/host/llmConfig.js';
import { MemoraChatViewProvider } from './chatPanel.js';
import type {
  ExtensionToWebviewMessage,
  GovernanceStatsDto,
  MemoryItemDto,
  MemoryStatsDto,
  SkillDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { capabilityLabel } from '../helpers/capabilityLabels.js';
import { listVisibleSkills } from '../../extension/host/skillAggregation.js';
import { settingsStyles } from '../styles/settingsStyles.js';
import { ACTIVE_ROLE_PACK_KEY, CONFIRM_WRITES_KEY } from '../../shared/constants.js';

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
  /** 是否已绑定 rolePackSwitched 事件（角色切换可观测，只绑定一次避免重复监听） */
  private _rolePackBound = false;
  /** Agent 懒装配工厂（由 extension 注入，与 chat 面板同一 getOrCreateAgent） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 全局状态存储（持久化激活角色包，用户级） */
  private _globalState: vscode.Memento | undefined;
  /** 待切换的子选项卡（configureModel 命令在视图未就绪时缓存，webview ready 后补发） */
  private _pendingTab: 'roles' | 'config' | 'memory' | 'skills' | undefined;
  /** 对话面板提供者（角色 handoff 预填需跨 webview 投递，由 extension 注入） */
  private _chatProvider: MemoraChatViewProvider | undefined;
  /** 用户技能目录路径（由 extension 注入，用于打开目录功能） */
  private _userSkillsDir: string | undefined;
  /** 系统内置配置目录（configDir/skills/ 所在父目录，extension 注入，用于技能来源判定） */
  private _configDir: string | undefined;

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

  /** 注入对话面板提供者（角色 handoff 预填跨 webview 投递，由 extension 装配时注入） */
  public setChatProvider(p: MemoraChatViewProvider): void {
    this._chatProvider = p;
  }

  /** 注入用户技能目录路径（用于打开目录功能） */
  public setUserSkillsDir(dir: string): void {
    this._userSkillsDir = dir;
  }

  /** 注入系统内置配置目录（技能来源判定需要） */
  public setConfigDir(dir: string): void {
    this._configDir = dir;
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
      void this.loadSkills();
      // 安全子视图：推送写入二次确认开关状态 + 白名单额外路径（G8）
      this.loadSecurityStatus();
      this.loadAllowedPathsStatus();
      return;
    }

    // ─── 角色子视图消息 ───
    if (msg.type === 'roles_set_active') {
      await this.activateRole(msg.name);
      return;
    }
    // 角色 handoff：切换激活角色包 + 聚焦对话视图（上下文由单 Agent 共享记忆承载）
    if (msg.type === 'roles_handoff') {
      const ok = await this.activateRole(msg.name);
      if (ok) {
        void vscode.commands.executeCommand(`${MemoraChatViewProvider.viewType}.focus`);
        const agent = await this.ensureAgent();
        const meta = agent?.rolePackManager?.listMeta().find((m) => m.name === msg.name);
        const displayName = meta?.displayName ?? msg.name;
        // 预填衔接文本：角色包自洽声明 handoffPrompt 优先（作者定制特色接手话术），
        // 缺省回退通用话术。SSOT：提示词真理源在角色包 meta（内核透传），宿主仅兜底，
        // 不引入跨包引用（角色包独立自洽，§11 插卡解耦）。
        const fallback = `继续以「${displayName}」的视角处理以上任务`;
        this._chatProvider?.prefillInput(meta?.handoffPrompt?.trim() ? meta.handoffPrompt : fallback);
      }
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
    if (msg.type === 'cfg_set_background') {
      // G5：设置后台模型 Provider（持久化 + 热更新 agent.setBackgroundProvider）
      await this.setBackgroundProvider(msg.name);
      return;
    }
    if (msg.type === 'cfg_save_embedding') {
      // G1：保存向量检索（Embedding）配置（重启插件后由装配注入 vectorStore 生效）
      await this.saveEmbedding(msg.config);
      return;
    }
    if (msg.type === 'cfg_clear_embedding') {
      // G1：清除向量检索（Embedding）配置
      await this.clearEmbedding();
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
    // ─── 记忆单条删除 / 恢复 / 回收站（G19，2026-08-25） ───
    if (msg.type === 'memory_delete') {
      await this.deleteMemory(msg.id);
      return;
    }
    if (msg.type === 'memory_restore') {
      await this.restoreMemory(msg.id);
      return;
    }
    if (msg.type === 'memory_recycle_load') {
      await this.loadRecycle();
      return;
    }
    if (msg.type === 'memory_purge') {
      await this.purgeMemory(msg.id);
      return;
    }
    if (msg.type === 'memory_recycle_clear') {
      await this.clearRecycle();
      return;
    }
    if (msg.type === 'memory_edit') {
      await this.editMemory(msg.id, msg.content);
      return;
    }

    // ─── 记忆治理消息（G4，2026-08-23） ───
    if (msg.type === 'governance_load') {
      await this.loadGovernance();
      return;
    }
    if (msg.type === 'governance_cleanup') {
      await this.runCleanup();
      return;
    }

    // ─── 技能子视图消息 ───
    if (msg.type === 'skills_load') {
      await this.loadSkills();
      return;
    }
    if (msg.type === 'skills_open_dir') {
      this.openUserSkillsDir();
      return;
    }
    // L2 渐进披露：按需读取技能正文（不预装载，用户点击展开时才读取）
    if (msg.type === 'skills_read_content') {
      await this.readSkillContent(msg.skillName);
      return;
    }

    // ─── 安全子视图消息（H0 写入审批 + G8 白名单，2026-08-23 / 2026-08-25） ───
    if (msg.type === 'security_toggle') {
      await this.toggleConfirmWrites(msg.enabled);
      return;
    }
    if (msg.type === 'allowed_paths_set') {
      await this.setAllowedPaths(msg.paths);
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
    // 只绑定一次 rolePackSwitched（角色包切换可观测 —— 跨面板一致）
    if (agent && !this._rolePackBound) {
      this._rolePackBound = true;
      agent.off('rolePackSwitched', this.onRolePackSwitched);
      agent.on('rolePackSwitched', this.onRolePackSwitched);
    }
    return agent;
  }

  private readonly onRolePackSwitched = (): void => {
    void this.loadRoles();
  };

  /** 切换激活角色包（SSOT：roles_set_active 与 roles_handoff 共用），返回是否成功 */
  private async activateRole(name: string): Promise<boolean> {
    const agent = await this.ensureAgent();
    if (!agent) return false;
    // 走内核「单一切换入口」agent.switchRolePack：activate + emit rolePackSwitched + 刷新 loop 前缀。
    // 角色视图刷新由 rolePackSwitched 事件驱动（onRolePackSwitched → loadRoles），不再显式
    // loadRoles——单一事件通知所有消费者，消除并行推送路径（SSOT 剪枝，2026-08-17）。
    const ok = agent.switchRolePack(name);
    if (ok) {
      this._globalState?.update(ACTIVE_ROLE_PACK_KEY, name);
    } else {
      this.post({ type: 'notice', level: 'error', message: `角色包不存在：${name}` });
    }
    return ok;
  }

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
    // G1:对账 Embedding 配置回显（enabled + 非敏感字段 + 是否已配 key）
    const embedCfg = await this.store.getEmbeddingConfig();
    const keyConfigured = (await this.store.getEmbeddingSecret()).length > 0;
    this.post({
      type: 'cfg_loaded',
      providers,
      activeName: this.store.getActiveName(),
      backgroundName: this.store.getBackgroundName(),
      embedding: {
        enabled: embedCfg.enabled,
        model: embedCfg.model,
        baseUrl: embedCfg.baseUrl,
        keyConfigured,
      },
    });
  }

  /**
   * 保存向量检索（Embedding）配置（G1：cfg_save_embedding）
   *
   * 持久化后提示「重启插件生效」——vectorStore 在 Agent 装配时注入，当前运行实例
   * 无热更新入口（不同于 G5 backgroundProvider 的 setBackgroundProvider），
   * 重启后由 createVectorStore 注入语义召回。
   */
  private async saveEmbedding(config: { model: string; baseUrl: string; apiKey: string }): Promise<void> {
    const r = await this.store.saveEmbedding(config);
    if (r.ok) {
      this.post({ type: 'notice', level: 'info', message: '向量检索配置已保存，重启插件后启用语义召回' });
    } else {
      this.post({ type: 'notice', level: 'error', message: r.message ?? '保存向量检索配置失败' });
    }
    await this.loadConfig();
  }

  /** 清除向量检索（Embedding）配置（G1：cfg_clear_embedding） */
  private async clearEmbedding(): Promise<void> {
    try {
      await this.store.clearEmbedding();
      this.post({ type: 'notice', level: 'info', message: '向量检索已关闭（回退关键词搜索）' });
    } catch (err) {
      this.post({ type: 'notice', level: 'error', message: `清除向量检索配置失败：${err instanceof Error ? err.message : String(err)}` });
    }
    await this.loadConfig();
  }

  /**
   * 设置后台模型 Provider（cfg_set_background，G5 多 Provider 路由）
   *
   * 持久化后台 Provider 选择后热更新 agent.setBackgroundProvider：后台任务（摘要/归档/
   * 润色/去重等）后续走独立轻量模型；name 为空 → setBackgroundProvider(null) 回退与实时对话相同。
   * 成功后刷新配置面板（后台模型下拉回显）。
   */
  private async setBackgroundProvider(name: string): Promise<void> {
    try {
      await this.store.setBackground(name);
      const agent = await this.ensureAgent();
      if (agent) {
        // 读刚持久化的选择创建后台 Provider（空 → undefined → 传给内核 null 回退前台）
        const background = await createBackgroundProvider(this.store);
        agent.setBackgroundProvider(background ?? null);
      }
      await this.loadConfig();
      this.post({ type: 'notice', level: 'info', message: name ? `后台模型已切换为「${name}」` : '后台模型已回退（与实时对话相同）' });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `切换后台模型失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

  // ─── 记忆单条删除 / 恢复 / 回收站（G19，2026-08-25） ───

  /**
   * 删除单条记忆（memory_delete，G19）
   *
   * 软删除：弹确认框后调 agent.memory.writeDelete(id)（进入回收站，可恢复），
   * 完成后推送 memory_deleted + 刷新记忆列表与治理统计。取消确认不推送。
   */
  private async deleteMemory(id: string): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({ type: 'memory_deleted', ok: false, id, message: 'Agent 未就绪，无法删除记忆' });
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      '确定删除这条记忆？它将进入回收站，可随时恢复。',
      { modal: true },
      '删除',
    );
    if (choice !== '删除') return;
    try {
      memory.writeDelete(id);
      this.post({ type: 'memory_deleted', ok: true, id });
      await this.loadMemory();
      await this.loadGovernance();
    } catch (err) {
      this.post({
        type: 'memory_deleted',
        ok: false,
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 恢复单条记忆（memory_restore，G19）
   *
   * 调 agent.memory.writeRestore(id) 从回收站恢复，完成后推送 memory_restored + 刷新
   * 记忆列表与治理统计；webview 收到 ok 后自行重新拉取回收站列表（若展开）。
   */
  private async restoreMemory(id: string): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({ type: 'memory_restored', ok: false, id, message: 'Agent 未就绪，无法恢复记忆' });
      return;
    }
    try {
      memory.writeRestore(id);
      this.post({ type: 'memory_restored', ok: true, id });
      await this.loadMemory();
      await this.loadGovernance();
    } catch (err) {
      this.post({
        type: 'memory_restored',
        ok: false,
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 永久删除回收站单条记忆（memory_purge，2026-08-26）
   *
   * 弹确认框后调 agent.memory.writePurge(id) 物理删除（不可恢复），完成后推送 memory_purged
   * + 刷新回收站/记忆列表/治理统计。
   */
  private async purgeMemory(id: string): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({ type: 'memory_purged', ok: false, id, message: 'Agent 未就绪，无法永久删除记忆' });
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      '永久删除这条记忆？此操作不可恢复。',
      { modal: true },
      '永久删除',
    );
    if (choice !== '永久删除') return;
    try {
      memory.writePurge(id);
      this.post({ type: 'memory_purged', ok: true, id });
      // 刷新回收站 + 列表（可能删的是活跃记忆外的回收条目，仅 count/回收站变化）
      await this.loadRecycle();
      await this.loadGovernance();
    } catch (err) {
      this.post({
        type: 'memory_purged',
        ok: false,
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 清空回收站（memory_recycle_clear，2026-08-26）
   *
   * 弹确认框后遍历 listDeleted() 逐个 writePurge 物理删除全部软删记忆（不可恢复），
   * 完成后推送 memory_recycle_cleared + 刷新回收站/治理统计。
   */
  private async clearRecycle(): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({ type: 'memory_recycle_cleared', ok: false, count: 0, message: 'Agent 未就绪，无法清空回收站' });
      return;
    }
    // 空回收站：无需确认，直接回报 0
    const deleted = memory.listDeleted(1000);
    if (deleted.length === 0) {
      this.post({ type: 'memory_recycle_cleared', ok: true, count: 0 });
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `确定清空回收站？将永久删除 ${deleted.length} 条记忆，此操作不可恢复。`,
      { modal: true },
      '清空回收站',
    );
    if (choice !== '清空回收站') return;
    try {
      for (const m of deleted) memory.writePurge(m.id);
      this.post({ type: 'memory_recycle_cleared', ok: true, count: deleted.length });
      await this.loadRecycle();
      await this.loadGovernance();
    } catch (err) {
      this.post({
        type: 'memory_recycle_cleared',
        ok: false,
        count: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 编辑单条记忆内容（memory_edit，G19 内联 edit 收尾，2026-08-25）
   *
   * read-modify-write：经 agent.memory.getById(id) 取真实 Memory，仅改 content 并标记
   * isModified（人工修改），writeUpsert 落盘（保留 accessedAt/metadata 等字段，避免从
   * 损失性 DTO 重建丢字段）。完成后推送 memory_edited + 刷新记忆列表与治理统计。
   */
  private async editMemory(id: string, content: string): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({ type: 'memory_edited', ok: false, id, message: 'Agent 未就绪，无法编辑记忆' });
      return;
    }
    const existing = memory.getById(id);
    if (!existing) {
      this.post({ type: 'memory_edited', ok: false, id, message: '记忆不存在或已被删除' });
      return;
    }
    try {
      memory.writeUpsert({ ...existing, content, isModified: true });
      this.post({ type: 'memory_edited', ok: true, id });
      await this.loadMemory();
      await this.loadGovernance();
    } catch (err) {
      this.post({
        type: 'memory_edited',
        ok: false,
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 加载回收站列表（memory_recycle_load，G19）
   *
   * 复用 MemoryInspector.listDeleted()（内核软删除契约，已含 writeDelete/writeRestore/listDeleted），
   * 映射为 MemoryItemDto[] 推送；agent.memory 未就绪时返回空列表。
   */
  private async loadRecycle(): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({ type: 'memory_recycle_loaded', items: [] });
      return;
    }
    const items = memory.listDeleted(1000).map(toItemDto);
    this.post({ type: 'memory_recycle_loaded', items });
  }

  // ─── 记忆治理数据加载（G4，2026-08-23） ───

  /** 治理数据清理阈值：永久删除 N 天前的软删除记忆（与 memora.cleanupMemories 命令对齐） */
  private static readonly CLEANUP_DAYS = 30;

  /**
   * 加载记忆治理统计（governance_load 应答）
   *
   * 活跃数取自 memory.stats()，回收站数取自 listDeleted()。
   * agent.memory 未就绪时推送全零统计（webview 渲染空治理区）。
   */
  private async loadGovernance(): Promise<void> {
    const agent = await this.ensureAgent();
    const memory = agent?.memory;
    if (!memory) {
      this.post({
        type: 'governance_loaded',
        stats: {
          active: 0,
          deleted: 0,
          bySource: {},
          superseded: 0,
        },
      });
      return;
    }
    const stats = memory.stats();
    const deleted = memory.listDeleted(1000).length;
    // supersede 治理模型：统计已被取代的活跃记忆（supersededBy 非空），对齐内核写路径取代语义
    const superseded = memory.list(1000).filter((m) => m.supersededBy !== undefined).length;
    const governance: GovernanceStatsDto = {
      active: stats.total,
      deleted,
      bySource: stats.bySource,
      superseded,
    };
    this.post({ type: 'governance_loaded', stats: governance });
  }

  /**
   * 清理过期软删除记忆（governance_cleanup）
   *
   * 破坏性操作：弹确认框后调 agent.memory.writePurgeExpired(N 天前) 永久删除，
   * 完成后刷新治理统计与记忆列表（复刻 memora.cleanupMemories 命令语义）。
   */
  private async runCleanup(): Promise<void> {
    const agent = await this.ensureAgent();
    if (!agent?.memory) {
      this.post({ type: 'governance_result', ok: false, message: 'Agent 未就绪，无法清理记忆', action: 'cleanup' });
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `将永久删除 ${MemoraSettingsViewProvider.CLEANUP_DAYS} 天前的软删除记忆，此操作不可撤销。`,
      { modal: true },
      '确认清理',
      '取消',
    );
    if (confirmed !== '确认清理') return;
    try {
      const cutoff = new Date(Date.now() - MemoraSettingsViewProvider.CLEANUP_DAYS * 24 * 60 * 60 * 1000);
      const purged = agent.memory.writePurgeExpired(cutoff);
      this.post({
        type: 'governance_result',
        ok: true,
        message: `已清理 ${purged} 条过期记忆`,
        action: 'cleanup',
      });
      await this.loadGovernance();
      await this.loadMemory();
    } catch (err) {
      this.post({
        type: 'governance_result',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        action: 'cleanup',
      });
    }
  }

  // ─── 技能子视图数据加载 ───

  /** 加载并推送三源技能清单（系统内置 / 启用角色包 / 用户目录，统一由 skillAggregation 聚合；含 G22 健康校验） */
  private async loadSkills(): Promise<void> {
    const agent = await this.ensureAgent();
    if (!agent || !this._configDir) {
      this.post({ type: 'skills_loaded', skills: [] });
      return;
    }
    const skills = listVisibleSkills({
      agent,
      configDir: this._configDir,
      userSkillsDir: this._userSkillsDir ?? '',
    });
    // G22 写→验→用（2026-08-25）：对带 filePath 的技能（builtin/user）逐项健康校验叠加 health/issues；
    // 角色包技能无绝对路径，本轮不校验（按可用处理）。error 技能 UI 标「未生效」且内核 buildSkillList 已过滤不注入 LLM。
    const sm = agent.skills;
    const validated: SkillDto[] = await Promise.all(
      skills.map(async (s) => {
        if (!s.filePath || !sm) return { ...s };
        try {
          const v = await sm.validateFile(s.filePath);
          return {
            ...s,
            health: v.ok ? (v.issues.length > 0 ? 'warn' : 'ok') : 'error',
            issues: v.issues.map((i) => ({ level: i.level, message: i.message })),
          };
        } catch {
          return { ...s };
        }
      }),
    );
    this.post({ type: 'skills_loaded', skills: validated });
  }

  /**
   * L2 渐进披露：按需读取技能正文（不预装载到 L1 列表，用户点击展开时才读取）
   *
   * 从 SkillManager 或 RolePackManager 获取技能 content，返回给 webview 渲染。
   * 优先从 SkillManager（全局技能）读取，回退到 RolePackManager（角色包内嵌技能）。
   */
  private async readSkillContent(skillName: string): Promise<void> {
    const agent = await this.ensureAgent();
    if (!agent) {
      this.post({ type: 'skill_content', skillName, content: '' });
      return;
    }
    // 1. 优先从全局 SkillManager 读取（内置 + 用户技能）
    const sm = agent.skills;
    if (sm) {
      const skill = sm.get(skillName);
      if (skill?.content) {
        this.post({ type: 'skill_content', skillName, content: skill.content });
        return;
      }
    }
    // 2. 回退到 RolePackManager（角色包内嵌技能）
    const rpm = agent.rolePackManager;
    if (rpm) {
      const content = await rpm.readSkillContent(skillName);
      if (content) {
        this.post({ type: 'skill_content', skillName, content });
        return;
      }
    }
    // 未找到 → 返回空内容
    this.post({ type: 'skill_content', skillName, content: '' });
  }

  /** 打开用户技能目录（在系统文件管理器中显示） */
  private openUserSkillsDir(): void {
    if (!this._userSkillsDir) {
      void vscode.window.showWarningMessage('用户技能目录未配置');
      return;
    }
    const uri = vscode.Uri.file(this._userSkillsDir);
    void vscode.commands.executeCommand('revealFileInOS', uri).then(
      () => {},
      () => {
        // revealFileInOS 可能失败，回退用 showItemInFolder
        void vscode.commands.executeCommand('showItemInFolder', uri);
      },
    );
  }

  // ─── 安全子视图方法（H0 写入审批，2026-08-23） ───

  /**
   * 切换写入二次确认开关（security_toggle 消息处理）
   *
   * 持久化到 globalState + 热更新 agent.security.setConfirmWrites()。
   * 无需重启 Agent——SecurityGuard 支持运行时切换。
   */
  private async toggleConfirmWrites(enabled: boolean): Promise<void> {
    try {
      // 1. 持久化到 globalState（用户级偏好）
      this._globalState?.update(CONFIRM_WRITES_KEY, enabled);
      // 2. 热更新已装配的 Agent（SecurityGuard 运行时切换）
      const agent = await this.ensureAgent();
      if (agent?.security) {
        agent.security.setConfirmWrites(enabled);
      }
      // 3. 推送最新状态给 webview
      this.post({ type: 'security_status', confirmWrites: enabled });
      this.post({
        type: 'notice',
        level: 'info',
        message: enabled ? '已开启写入二次确认（写文件前将弹出审批卡）' : '已关闭写入二次确认（写文件自动批准）',
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `切换写入确认开关失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * 加载并推送安全设置状态（settings 视图 ready 时调用）
   *
   * 从 globalState 读取持久化开关值，推送给 webview 渲染初始状态。
   */
  private loadSecurityStatus(): void {
    const enabled = this._globalState?.get<boolean>(CONFIRM_WRITES_KEY) ?? false;
    this.post({ type: 'security_status', confirmWrites: enabled });
  }

  /**
   * 设置白名单额外允许路径（allowed_paths_set 消息处理，G8）
   *
   * 持久化到 workspace 设置（memora.allowedPaths，落 .vscode/settings.json）+ 热更新
   * agent.security.setAllowedPaths()。无需重启 Agent——SecurityGuard 支持运行时热更新。
   * paths = 完整用户额外数组（不含 projectPath 基准根）。
   */
  private async setAllowedPaths(paths: string[]): Promise<void> {
    try {
      // 1. 持久化到 workspace 设置（项目级；projectPath 基准根恒在，不在此数组内）
      await vscode.workspace
        .getConfiguration('memora')
        .update('allowedPaths', paths, vscode.ConfigurationTarget.Workspace);
      // 2. 热更新已装配的 Agent（SecurityGuard 运行时切换）
      const agent = await this.ensureAgent();
      if (agent?.security) {
        agent.security.setAllowedPaths(paths);
      }
      // 3. 推送最新状态给 webview（含只读基准根 projectPath）
      const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      this.post({ type: 'allowed_paths_status', projectPath, paths });
      this.post({
        type: 'notice',
        level: 'info',
        message: paths.length > 0 ? `已更新允许路径白名单（${paths.length} 项）` : '已清空额外允许路径（仅保留项目目录）',
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `设置允许路径失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * 加载并推送白名单额外路径状态（settings 视图 ready 时调用，G8）
   *
   * 从 workspace 设置读取持久化的额外路径数组，推送给 webview 渲染初始列表。
   */
  private loadAllowedPathsStatus(): void {
    const paths = vscode.workspace.getConfiguration('memora').get<string[]>('allowedPaths', []);
    const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    this.post({ type: 'allowed_paths_status', projectPath, paths });
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
  public switchTab(tab: 'roles' | 'config' | 'memory' | 'skills'): void {
    this._pendingTab = tab;
    if (this._view) {
      this.post({ type: 'settings_switch_tab', tab });
      this._pendingTab = undefined;
    }
  }
}

/** 内核 Memory → 记忆条目 DTO（deletedAt 仅回收站条目携带；round-summary 顶层字段透传） */
function toItemDto(m: {
  id: string;
  name: string;
  source: string;
  score: number;
  content: string;
  createdAt?: string;
  deletedAt?: string;
  summaryType?: 'preference' | 'fact' | 'decision' | 'intent' | 'general';
  sessionName?: string;
  roundId?: string;
  isTraceable?: boolean;
  isModified?: boolean;
  supersededBy?: string;
}): MemoryItemDto {
  return {
    id: m.id,
    name: m.name,
    source: m.source,
    score: m.score,
    content: m.content,
    createdAt: m.createdAt,
    deletedAt: m.deletedAt,
    summaryType: m.summaryType,
    sessionName: m.sessionName,
    roundId: m.roundId,
    isTraceable: m.isTraceable,
    isModified: m.isModified,
    supersededBy: m.supersededBy,
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
  <!-- 选项卡栏：记忆（默认首页）/ 角色 / 大模型 / 技能 / 安全 -->
  <div class="tabs" role="tablist" aria-label="设置选项卡">
    <button class="tab-btn active" data-tab="memory" role="tab" aria-selected="true">记忆</button>
    <button class="tab-btn" data-tab="roles" role="tab" aria-selected="false">角色</button>
    <button class="tab-btn" data-tab="config" role="tab" aria-selected="false">大模型</button>
    <button class="tab-btn" data-tab="skills" role="tab" aria-selected="false">技能</button>
    <button class="tab-btn" data-tab="security" role="tab" aria-selected="false">安全</button>
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
      <p class="loading-hint">加载中…</p>
    </div>

    <!-- 回收站（G19，2026-08-25：软删除记忆的可恢复暂存区） -->
    <details id="recycle" class="recycle" role="region" aria-label="回收站">
      <summary>回收站</summary>
      <div id="recycleList"><p class="hint">回收站为空。</p></div>
    </details>
    <p id="memHint" class="mem-hint" hidden></p>

    <!-- 记忆治理区（G4，2026-08-23：统计卡 + 加权/清理操作） -->
    <div id="governance" class="governance" role="region" aria-label="记忆治理">
      <div class="governance-stats">
        <div class="governance-stat">
          <span id="govActive" class="gov-num">0</span>
          <span class="gov-label">活跃</span>
        </div>
        <div class="governance-stat">
          <span id="govDeleted" class="gov-num">0</span>
          <span class="gov-label">回收站</span>
        </div>
        <div class="governance-stat">
          <span id="govSuperseded" class="gov-num">0</span>
          <span class="gov-label">已被取代</span>
        </div>
      </div>
      <div class="governance-actions">
        <button id="btnCleanup" class="btn btn-danger" title="永久删除 30 天前的软删除记忆（不可撤销）">清理过期</button>
      </div>
      <p id="govDetail" class="governance-detail" hidden></p>
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
      <p class="loading-hint">加载中…</p>
    </div>
    <p class="footer-hint">「设为当前」仅切换默认角色；「带入对话」还会跳到对话并预填一句过渡语（不自动发送，可编辑后再发）。</p>
  </div>

  <!-- 大模型配置子视图（config 选项卡） -->
  <div id="config-root" role="tabpanel" aria-label="大模型配置" hidden>
    <div class="header">
      <h2>大模型配置</h2>
      <span id="statBar" class="stat-bar" hidden></span>
      <button id="btnAdd" class="btn">添加 API</button>
    </div>
    <!-- 模型通道分区（P1-1，2026-08-24：G5 后台 + G1 检索归入显式分区，与 Provider 列表的 group-title 语言一致） -->
    <div class="group-title">模型通道</div>
    <!-- 后台模型通道（G5 多 Provider 路由，2026-08-23）：后台任务（摘要/归档/润色）独立轻量模型 -->
    <div class="cfg-bg">
      <label for="bgModel" class="cfg-bg-label">后台模型（可选）</label>
      <select id="bgModel" class="cfg-bg-select" aria-label="后台模型，用于后台任务（摘要/归档/润色）">
        <option value="">同实时对话</option>
      </select>
      <p class="cfg-bg-hint">后台任务（轮次摘要 / 会话归档 / 文本润色 / 语义去重）走此模型，可选用轻量快模型节省成本。</p>
    </div>
    <!-- 向量检索区（G1 记忆语义检索，2026-08-23）：配置 Embedding 后记忆搜索启用语义召回 -->
    <details id="embeddingCfg" class="embedding-cfg">
      <summary>向量检索（Embedding，可选）</summary>
      <div class="embedding-fields">
        <div class="field">
          <label for="e-model">Embedding 模型</label>
          <input id="e-model" type="text" placeholder="如 text-embedding-3-small" autocomplete="off" />
        </div>
        <div class="field">
          <label for="e-baseurl">API Base URL</label>
          <input id="e-baseurl" type="url" placeholder="https://api.example.com/v1" autocomplete="url" />
        </div>
        <div class="field">
          <label for="e-apikey">API Key（留空保持不变）</label>
          <input id="e-apikey" type="password" placeholder="sk-…" autocomplete="new-password" />
        </div>
        <div class="embedding-actions">
          <button id="btnSaveEmbedding" class="btn">保存并启用</button>
          <button id="btnClearEmbedding" class="btn btn-secondary">停用</button>
        </div>
        <p id="embeddingStatus" class="embedding-status" hidden></p>
      </div>
    </details>
    <div id="list">
      <p class="loading-hint">加载中…</p>
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
            <input id="f-baseurl" name="baseUrl" type="url" placeholder="https://api.xiaomimimo.com/v1" autocomplete="url" />
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

  <!-- 技能子视图（skills 选项卡，2026-08-22 新增） -->
  <div id="skills-root" role="tabpanel" aria-label="技能" hidden>
    <div class="header">
      <h2>全局技能</h2>
      <span id="skillCount" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnOpenSkillsDir" class="btn btn-secondary" title="打开用户技能目录">📁 打开目录</button>
        <button id="btnRefreshSkills" class="btn btn-secondary">刷新</button>
      </div>
    </div>
    <div class="hint">全局技能是所有角色包共享的能力。支持单文件 <code>.md</code> 和文件夹 <code>SKILL.md</code> 两种格式。</div>
    <div id="skillsList">
      <p class="loading-hint">加载中…</p>
    </div>
    <p class="footer-hint">用户技能目录：<code>VS Code 全局存储 / skills /</code></p>
  </div>

  <!-- 安全子视图（security 选项卡，2026-08-23 H0 新增） -->
  <div id="security-root" role="tabpanel" aria-label="安全" hidden>
    <div class="header">
      <h2>安全</h2>
    </div>
    <div class="security-section">
      <div class="security-item">
        <div class="security-item-header">
          <label for="confirmWritesToggle" class="security-label">写入二次确认</label>
          <label class="toggle-switch">
            <input id="confirmWritesToggle" type="checkbox" role="switch" aria-label="写入二次确认开关" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="security-desc">开启后，AI 写文件前会弹出审批卡，需确认放行。默认关闭（owner 模式自动批准）。</p>
      </div>
      <div id="securityStatus" class="security-status" hidden></div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">允许路径白名单</label>
        </div>
        <p class="security-desc">项目目录始终允许访问。可添加项目之外的可信目录（如个人笔记、文档），Agent 即可读写；增删即时生效，重启后仍保留。敏感文件（.env/.ssh 等）黑名单仍强制拦截。</p>
        <ul id="allowedPathsList" class="allowed-paths-list"></ul>
        <div class="allowed-paths-add">
          <input id="allowedPathsInput" type="text" class="allowed-paths-input" placeholder="输入目录绝对路径，如 D:/我的笔记" aria-label="新增允许路径" />
          <button id="allowedPathsAdd" class="btn btn-secondary" type="button">添加</button>
        </div>
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}