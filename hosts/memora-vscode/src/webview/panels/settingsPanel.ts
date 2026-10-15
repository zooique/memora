/**
 * 设置面板 — 侧边栏 Webview 视图提供者（选项卡式单一视图）
 *
 * 角色 / 大模型 / 记忆 三个子视图共存于单一"设置"视图，内部通过选项卡切换子视图。
 * 三个子视图保留各自独立行为逻辑，通过共享同一 webview 文档 + root 容器 id 空间隔离共存。
 *
 * 设计（对齐单一真理源 + 自然生长）：
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM；
 *   - 子视图数据源（roles: RolePackManager / config: ProviderStore / memory: MemoryInspector）；
 *   - 三个子视图的 load 逻辑在 host 侧统一由 settingsPanel 分发（根据 activeTab 决定推送哪个子视图的数据）；
 *   - 选项卡切换时只切换 content 区域显示隐藏，不销毁/重建 DOM（保留子视图状态，减少闪烁）。
 */
import * as vscode from 'vscode';
import type { Agent, MemoryInspector } from '@zooique/memora';
import type { ProviderStore } from '../../extension/providers/providerStore.js';
import { createBackgroundProvider } from '../../extension/host/llmConfig.js';
import { inspectRolePackTeams } from '../../extension/host/rolePackTeams.js';
import { MemoraChatViewProvider } from './chatPanel.js';
import { toNoticeText } from '../../extension/host/noticeText.js';
import type {
  CustomSearchEngineConfig,
  ExtensionToWebviewMessage,
  GovernanceStatsDto,
  MemoryItemDto,
  MemoryStatsDto,
  SearchEngineSetting,
  SearchEngineTestResult,
  SkillDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { PRESET_SEARCH_ENGINES } from '../../shared/protocol.js';
// 判据单点复用：validateCustomEngines 定义在搜索引擎域（extension/host/searchEngines.ts），
// 本面板的「测试 / 保存」两条路径与装配侧 resolveSearchEndpoints 共用同一函数；
// probeSearchEngine 同域导入，禁在本文件另写校验规则。
import { probeSearchEngine, validateCustomEngines } from '../../extension/host/searchEngines.js';
import { capabilityLabel } from '../helpers/capabilityLabels.js';
import {
  findUnmatchedDisabled,
  listVisibleSkills,
  resolveSkill,
} from '../../extension/host/skillAggregation.js';
import { settingsStyles } from '../styles/settingsStyles.js';
import { buildHtmlHead, resolveHtmlLang } from '../helpers/htmlShell.js';
import {
  ACTIVE_ROLE_PACK_KEY,
  CONFIRM_WRITES_KEY,
  CONFIRM_SCRIPTS_KEY,
  ROLE_PACK_TEAMS_KEY,
  MEMORY_RECYCLE_RETENTION_DAYS,
} from '../../shared/constants.js';
// 内核常量与键面/校验入口（宿主不复制字面量，SSOT 单一来源）：
//   BUILTIN_FALLBACK_PACK — 兜底契约包名，随内核包分发，宿主 UI 禁删标记；
//   MAX_TEAM_MEMBERS      — 小组会议组员上限，本处用于保存校验，并随 roles_loaded 下发给 webview；
//   describeStrategyKeys  — UI 键面唯一来源（strategyKeys.ts），随 roles_loaded 下发，宿主零清单维护；
//   validateManifestText  — 角色包保存前校验入口（宿主不重写判据，校验失败不写盘）。
import {
  BUILTIN_FALLBACK_PACK,
  MAX_TEAM_MEMBERS,
  describeStrategyKeys,
  validateManifestText,
} from '@zooique/memora';
// 角色包 manifest 原文读写（详情弹窗初值 + 全量保真写回的真源是文件原文，不是装配值）
import { readFile, writeFile } from 'node:fs/promises';

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
  /** 用户角色包目录路径（extension 注入，用于打开目录功能 + 角色来源判定） */
  private _userRolePacksDir: string | undefined;
  /** 「恢复初始状态」处理器（extension 注入：modal 确认 + 用户级数据清理 + reload window；
   *  与命令面板 memora.resetUserData 共用同一函数，单一路径）。
   *  返回 cancelled=true 表示用户在确认弹窗主动取消（非失败，webview 中性提示）。 */
  private _resetHandler:
    (() => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>) | undefined;

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

  /** 注入用户角色包目录路径（用于打开目录功能 + 角色来源判定） */
  public setUserRolePacksDir(dir: string): void {
    this._userRolePacksDir = dir;
  }

  /**
   * 注入「恢复初始状态」处理器（extension 装配时注入）
   *
   * 面板侧只做按钮 → 请求 → 回执三段，清理逻辑（清什么、什么顺序、何时 reload）
   * 全在处理器内——与命令面板入口共用同一函数，杜绝两条路径漂移。
   */
  public setResetHandler(
    handler: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>,
  ): void {
    this._resetHandler = handler;
  }

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // 视图被销毁（折叠/关闭/切走隐藏也会触发）时清理引用，避免向已销毁 webview postMessage；
    // 与 chatPanel 同款。不清则 switchTab 把 _pendingTab 写进死 view 后清空，
    // ready 握手的补发兜底失效 → 点角色徽章/配置大模型落在默认「记忆」页。
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) this._view = undefined;
    });
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
    // webview 错误边界上报（T1）：落扩展宿主日志留痕，不驱动任何 UI 状态——与 chatPanel
    // 同款（各面板消费自己 webview 的上报）。必须独立成分支：边界装在工厂之前，
    // 上报可先于 ready 握手到达
    if (msg.type === 'host_diag') {
      console.warn(`Memora webview 未处理异常 [${msg.source}] ${msg.message}`, msg.stack ?? '');
      return;
    }
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
      // 安全子视图：推送写入二次确认开关状态 + 白名单额外路径 + 网页搜索引擎
      this.loadSecurityStatus();
      this.loadAllowedPathsStatus();
      this.loadCustomSearchEnginesStatus();
      this.loadSearchEngineStatus();
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
        // 不引入跨包引用（角色包独立自洽，插卡解耦）。
        const fallback = `继续以「${displayName}」的视角处理以上任务`;
        this._chatProvider?.prefillInput(
          meta?.handoffPrompt?.trim() ? meta.handoffPrompt : fallback,
        );
      }
      return;
    }
    // 保存角色包组（会议名单）：校验 → 持久化 globalState → 热更新内核 → 重推角色视图 → 通知 chatPanel
    if (msg.type === 'roles_team_save') {
      const result = await this.saveRolePackTeam(msg.leader, msg.members);
      this.post({
        type: 'notice',
        level: result.ok ? 'info' : 'error',
        message: result.ok ? '小组已保存' : result.reason,
      });
      if (result.ok) {
        await this.loadRoles();
        // 热更新通知：chatPanel 重推 chat_role_pack 让 chatView 刷新 team 图标（组长队伍变更后图标显隐）
        this._chatProvider?.refreshActiveRolePackForTeam();
      }
      return;
    }
    // 删除角色包组（会议名单）：持久化移除 + 热更新内核 → 通知 chatPanel
    if (msg.type === 'roles_team_delete') {
      await this.deleteRolePackTeam(msg.leader);
      await this.loadRoles();
      // 热更新通知：同上，删除组长队伍后 team 图标应隐藏
      this._chatProvider?.refreshActiveRolePackForTeam();
      return;
    }
    // 打开用户角色包目录（与技能系统入口一致）
    if (msg.type === 'roles_open_dir') {
      this.openUserRolePacksDir();
      return;
    }
    // 重扫用户角色包目录（刷新按钮）：内核对账后 notice 结果 + 刷新下发
    if (msg.type === 'roles_refresh') {
      await this.refreshRolePacks();
      return;
    }
    // 角色配置详情：读 manifest 原文 strategy 段回发（初值真源 = 原文，禁读装配值）
    if (msg.type === 'roles_detail') {
      await this.handleRolesDetail(msg.name);
      return;
    }
    // 保存角色策略键：内置真拒绝 → 全量保真写回 → 校验 → reload → 刷新下发
    if (msg.type === 'roles_save') {
      await this.handleRolesSave(msg.name, msg.strategy);
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
          message: toNoticeText(err),
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
          message: toNoticeText(err),
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
          message: toNoticeText(err),
          action: 'set_active',
        });
      }
      return;
    }
    if (msg.type === 'cfg_set_background') {
      // 设置后台模型 Provider（持久化 + 热更新 agent.setBackgroundProvider）
      await this.setBackgroundProvider(msg.name);
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
          message: toNoticeText(err),
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
    if (msg.type === 'memory_page') {
      await this.loadMemoryPage(msg.page, msg.pageSize);
      return;
    }
    // ─── 记忆单条删除 / 恢复 / 回收站 ───
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

    // ─── 记忆治理消息 ───
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
    // 延长线开关：切换单个技能的禁用状态（写回 VS Code 配置，不在此回推列表）
    if (msg.type === 'toggle_skill_disabled') {
      await this.toggleSkillDisabled(msg.name, msg.disabled);
      return;
    }

    // ─── 安全子视图消息（写入审批 + 路径白名单） ───
    if (msg.type === 'security_toggle') {
      await this.toggleConfirmWrites(msg.enabled);
      return;
    }
    if (msg.type === 'security_scripts_toggle') {
      await this.toggleConfirmScripts(msg.enabled);
      return;
    }
    if (msg.type === 'allowed_paths_set') {
      await this.setAllowedPaths(msg.paths);
      return;
    }
    // 网页搜索引擎：持久化设置 + 回显选中下拉
    if (msg.type === 'search_engine_set') {
      await this.setSearchEngine(msg.engine);
      return;
    }
    // 自定义搜索引擎清单：持久化 + 回显编辑器
    if (msg.type === 'custom_search_engines_set') {
      await this.setCustomSearchEngines(msg.engines);
      return;
    }
    // 自定义搜索引擎连通性验证（保存前先验证的预览探针）
    if (msg.type === 'custom_search_engine_test') {
      // 静态校验先用同一判据过一遍（非法配置不必发网络请求），合法才实测抓取+解析
      const problem = validateCustomEngines([msg.engine]);
      const result: SearchEngineTestResult = problem
        ? { engineName: msg.engine?.name || '(空)', ok: false, count: 0, error: problem }
        : await probeSearchEngine(msg.engine);
      this.post({ type: 'custom_search_engine_test_result', result });
      return;
    }
    // 「恢复初始状态」：按钮 → 注入的处理器（extension 侧 modal + 清理 + reload），
    // 结果回推 webview 恢复按钮态。面板不自行实现清理逻辑（单一路径，与命令面板共用）。
    if (msg.type === 'reset_user_data') {
      const result = await this.runReset();
      this._view?.webview.postMessage({
        type: 'reset_user_data_result',
        ok: result.ok,
        cancelled: result.cancelled,
        message: result.message,
      });
      return;
    }
  }

  /**
   * 执行「恢复初始状态」（委托 extension 注入的处理器）
   *
   * 处理器未注入（理论不可达——activate 恒注入）时返回失败回执，
   * 不静默吞掉（否则按钮点了没反应，用户无从判断是没点到还是坏了）。
   */
  private async runReset(): Promise<{ ok: boolean; cancelled?: boolean; message?: string }> {
    if (!this._resetHandler) {
      return { ok: false, message: '初始化功能未就绪，请重载窗口后重试' };
    }
    try {
      return await this._resetHandler();
    } catch (err) {
      const message = toNoticeText(err);
      return { ok: false, message };
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
        const message = toNoticeText(err);
        void vscode.window.showErrorMessage(`Memora 装配失败：${message}`);
        return undefined;
      });
    }
    const agent = await this._agentPromise;
    // 只绑定一次 rolePackSwitched + rolePackSwitchLocked（角色包切换可观测 —— 跨面板一致）
    if (agent && !this._rolePackBound) {
      this._rolePackBound = true;
      agent.off('rolePackSwitched', this.onRolePackSwitched);
      agent.on('rolePackSwitched', this.onRolePackSwitched);
      // 切换被锁时提示宿主（同步 emit，activateRole 内可据此区分"被锁"vs"不存在"）
      agent.off('rolePackSwitchLocked', this.onRolePackSwitchLocked);
      agent.on('rolePackSwitchLocked', this.onRolePackSwitchLocked);
    }
    return agent;
  }

  private readonly onRolePackSwitched = (): void => {
    void this.loadRoles();
  };

  /**
   * rolePackSwitchLocked：**触发**锁定的那一次切换弹 info 提示。
   * 注意该次切换本身是成功的（内核 activate 返回 true），被锁期间的后续切换不发射本事件。
   */
  private readonly onRolePackSwitchLocked = (info: {
    reason: string;
    lockedSeconds: number;
  }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `角色包切换被锁定：${info.reason}，${info.lockedSeconds} 秒后再试`,
    });
  };

  /** 切换激活角色包（SSOT：roles_set_active 与 roles_handoff 共用），返回是否成功 */
  private async activateRole(name: string): Promise<boolean> {
    const agent = await this.ensureAgent();
    if (!agent) return false;
    // 走内核「单一切换入口」agent.switchRolePack：activate + emit rolePackSwitched + 刷新 loop 前缀。
    // 角色视图刷新由 rolePackSwitched 事件驱动（onRolePackSwitched → loadRoles），不再显式
    // loadRoles——单一事件通知所有消费者，消除并行推送路径（SSOT）。
    const ok = agent.switchRolePack(name);
    if (ok) {
      this._globalState?.update(ACTIVE_ROLE_PACK_KEY, name);
    } else {
      // ok=false 有两种成因，须用内核公开判据区分：
      // rolePackSwitchLocked 只在**触发锁定**那一次发射（该次返回 true），被锁期间的切换
      // 直接 return false 且不发射任何事件——故「未收到事件」不能推断为"角色包不存在"。
      const lock = agent.getRolePackSwitchLockStatus();
      if (lock.locked) {
        const remain =
          lock.unlockAt === null
            ? null
            : Math.max(0, Math.ceil((lock.unlockAt - Date.now()) / 1000));
        this.post({
          type: 'notice',
          level: 'info',
          message:
            remain === null
              ? '角色包切换已被限流锁定，请稍后再试'
              : `角色包切换已被限流锁定，${remain} 秒后再试`,
        });
      } else {
        this.post({ type: 'notice', level: 'error', message: `角色包不存在：${name}` });
      }
    }
    return ok;
  }

  /**
   * 保存角色包组（会议名单）：校验 → 持久化用户级 globalState → 热更新内核组数据。
   * 组 = 组长角色包的会议名单（非选择对象）；组员仅作小组会议参与者，不用于日常。
   * 校验：组长/组员须为存在的角色包、名单非空、组长身份唯一（一个角色包只能是一个组的组长）。
   */
  private async saveRolePackTeam(
    leader: string,
    members: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const agent = await this.ensureAgent();
    const rpm = agent?.rolePackManager;
    if (!rpm || !leader) return { ok: false, reason: '小组保存失败：内核未就绪' };
    const validPacks = new Set(rpm.listMeta().map((m) => m.name));
    const deduped = [...new Set(members)];
    // 校验（全部分支在此收口，失败均带可直接展示的原因，调用方不再猜测）：
    // 组长存在、组员存在、组员非空且不重复、组长与组员身份互斥、组员数量不超上限
    if (!validPacks.has(leader))
      return { ok: false, reason: `小组保存失败：组长「${leader}」不存在` };
    if (deduped.length === 0) return { ok: false, reason: '小组保存失败：至少选择 1 名组员' };
    if (deduped.some((m) => !validPacks.has(m))) {
      return { ok: false, reason: '小组保存失败：存在不存在的组员角色包' };
    }
    if (deduped.includes(leader))
      return { ok: false, reason: '小组保存失败：组长不能同时是自己的组员' };
    // 5 人组上限（队长 1 + 组员 ≤ MAX_TEAM_MEMBERS，组队功能用户约定）：超限拒绝保存
    if (deduped.length > MAX_TEAM_MEMBERS) {
      return {
        ok: false,
        reason: `小组保存失败：组员最多 ${MAX_TEAM_MEMBERS} 名（队长 1 + 组员 ≤ ${MAX_TEAM_MEMBERS} = ${MAX_TEAM_MEMBERS + 1} 人组上限）`,
      };
    }
    // 组长身份唯一：同一组长不允许两处建组
    const teams =
      this._globalState?.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? [];
    const others = teams.filter((t) => t.leader !== leader);
    const next = [...others, { leader, members: deduped }];
    await this._globalState?.update(ROLE_PACK_TEAMS_KEY, next);
    // 热更新内核组数据（运行时立即生效，无需重启）
    rpm.setRolePackTeams(next);
    return { ok: true };
  }

  /** 删除角色包组（会议名单）：持久化移除 + 热更新内核组数据。 */
  private async deleteRolePackTeam(leader: string): Promise<void> {
    const agent = await this.ensureAgent();
    const teams =
      this._globalState?.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? [];
    const next = teams.filter((t) => t.leader !== leader);
    await this._globalState?.update(ROLE_PACK_TEAMS_KEY, next);
    agent?.rolePackManager?.setRolePackTeams(next);
  }

  /**
   * 角色包来源层判定（单点收口）：用户目录命中 → user，否则内置。
   * 与 loadRoles 的列表来源判定同源（filePath 前缀，configDir 与用户目录天然不重叠），
   * 保存链路的内置包拒绝判据也复用本方法——禁第二份前缀判定副本。
   */
  private rolePackSource(filePath: string | undefined): 'builtin' | 'user' {
    return this._userRolePacksDir && filePath?.startsWith(this._userRolePacksDir)
      ? 'user'
      : 'builtin';
  }

  /**
   * 角色配置详情（roles_detail）：读 manifest 原文 strategy 段回发 roles_detail_data。
   *
   * 初值真源 = 文件原文：装配值（rpm.get().strategy）是合并默认值后的完整策略，
   * 回填保存会把默认值固化成显式声明（红线 1），故必须读文件。
   */
  private async handleRolesDetail(name: string): Promise<void> {
    const agent = await this.ensureAgent();
    const rpm = agent?.rolePackManager;
    if (!rpm) {
      this.post({ type: 'notice', level: 'error', message: 'Agent 未就绪，无法读取角色配置' });
      return;
    }
    const pack = rpm.get(name);
    if (!pack?.filePath) {
      this.post({ type: 'notice', level: 'error', message: `角色包不存在：${name}` });
      return;
    }
    const source = this.rolePackSource(pack.filePath);
    try {
      const raw = JSON.parse(await readFile(pack.filePath, 'utf-8')) as {
        strategy?: Record<string, Record<string, unknown>>;
      };
      this.post({ type: 'roles_detail_data', name, source, strategy: raw.strategy });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `读取角色包配置失败：${toNoticeText(err)}`,
      });
    }
  }

  /**
   * 保存角色策略键（roles_save）：内置真拒绝 → 全量保真写回 → 校验 → 写盘 → reload → 刷新下发。
   *
   * 执行序（每步失败即短路，不写盘不留半态）：
   *   1. 内置包真拒绝在本层（红线 3：webview 隐藏编辑按钮只是呈现，直接发消息也必须被拒）；
   *   2. 全量保真：读原文全量对象只替换 strategy 段（skills/capabilities/name 等原样保留，
   *      禁止从表单数据重建整个 manifest）；空 strategy 段 = 删除该键（保持「未声明」语义）；
   *   3. validateManifestText 校验失败不写盘；
   *   4. 写盘后必须 rpm.reload()（_cachedAssembly 缓存装配结果，不 reload 下个 turn 仍用旧配置）；
   *   5. 回发 roles_detail_data（弹窗回显新原文）+ loadRoles（列表策略徽章刷新）。
   */
  private async handleRolesSave(
    name: string,
    strategy: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    const agent = await this.ensureAgent();
    const rpm = agent?.rolePackManager;
    if (!rpm) {
      this.post({ type: 'notice', level: 'error', message: 'Agent 未就绪，无法保存角色配置' });
      return;
    }
    const pack = rpm.get(name);
    if (!pack?.filePath) {
      this.post({ type: 'notice', level: 'error', message: `角色包不存在：${name}` });
      return;
    }
    const source = this.rolePackSource(pack.filePath);
    // 内置包真拒绝（判据与列表来源判定同源：rolePackSource 单点）
    if (source !== 'user') {
      this.post({
        type: 'notice',
        level: 'error',
        message: `「${name}」是内置角色包，不可编辑；可将其复制到用户角色包目录后修改`,
      });
      return;
    }
    try {
      // 全量保真写回：只换 strategy 段，其余字段原样保留
      const manifest = JSON.parse(await readFile(pack.filePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      if (strategy && Object.keys(strategy).length > 0) {
        manifest.strategy = strategy;
      } else {
        delete manifest.strategy;
      }
      // 2 空格缩进 + 尾换行：手编排版会被归一（可接受边界，文件本为机器读）
      const text = `${JSON.stringify(manifest, null, 2)}\n`;
      // 校验失败不写盘（复用内核 validateManifestText，宿主不重写判据）
      const result = validateManifestText(text);
      const firstError = result.issues.find((i) => i.severity === 'error');
      if (firstError) {
        this.post({
          type: 'notice',
          level: 'error',
          message: `保存失败：${firstError.message}`,
        });
        return;
      }
      await writeFile(pack.filePath, text, 'utf-8');
      // 装配缓存失效防线：写盘后重扫（保留运行时注入项），下个 turn 立即用新配置
      await rpm.reload();
      this.post({
        type: 'roles_detail_data',
        name,
        source,
        strategy: manifest.strategy as Record<string, Record<string, unknown>> | undefined,
      });
      await this.loadRoles();
      this.post({ type: 'notice', level: 'info', message: `「${name}」的策略配置已保存` });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `保存失败：${toNoticeText(err)}`,
      });
    }
  }

  private async loadRoles(): Promise<void> {
    const agent = await this.ensureAgent();
    const rpm = agent?.rolePackManager;
    if (!rpm) {
      this.post({
        type: 'roles_loaded',
        packs: [],
        teams: [],
        activeName: '',
        maxTeamMembers: MAX_TEAM_MEMBERS,
        // 键面与 rpm 无关（静态派生），未就绪时也下发，编辑模式不因装配时序缺席
        keyface: describeStrategyKeys(),
      });
      return;
    }
    // 读期健康检测（唯一接线点，只读不写回）：对照包池算出每支队伍的受损状态
    // （组长失效=遗留队伍 / 组员失效=缺员），随 teams 下发供角色页持久标注；
    // 「清理/修复」由用户主动触发（roles_team_delete / roles_team_save），宿主不静默改用户数据。
    const teamHealth = inspectRolePackTeams(rpm, this._globalState);
    // 组（会议名单）用户级数据：组员仅作小组会议参与者
    const teams = (
      this._globalState?.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? []
    ).map((t) => {
      // 检测视图附加（读期派生，不落盘）：健康组不带标记字段，存量 webview 兼容旧载荷
      const health = teamHealth.get(t.leader);
      return health && (health.leaderMissing || health.missingMembers.length > 0)
        ? {
            ...t,
            leaderMissing: health.leaderMissing,
            missingMembers: health.missingMembers,
          }
        : t;
    });
    const packs = rpm
      .listMeta()
      .filter((m) => m.name)
      .map((m) => {
        const pack = rpm.get(m.name);
        // 来源层判定：rolePackSource 单点（与保存链路内置拒绝判据同源，禁第二份前缀副本）
        const source = this.rolePackSource(pack?.filePath);
        // 提取策略指示器：从内核完整策略中提炼 UI 友好的摘要
        const strategy = pack?.strategy;
        // 温度分组：基于 temperature 值动态计算
        const temp = strategy?.act?.temperature ?? 0.7;
        const tempGroup = temp >= 0.8 ? 'high' : temp <= 0.4 ? 'low' : 'mid';
        // 推理模式：基于 multiStepReasoning 字段
        const reasoningMode = strategy?.act?.multiStepReasoning;

        const strategyHint = strategy
          ? {
              toolReadonly: strategy.act?.toolReadonly,
              tempGroup: tempGroup as 'high' | 'mid' | 'low',
              reasoningMode: reasoningMode as 'auto' | 'manual' | undefined,
              summaryFocus: strategy.prepare?.summaryFocus,
              outputLimit: strategy.act?.outputLimit,
            }
          : undefined;

        return {
          name: m.name,
          displayName: m.displayName ?? m.name,
          source,
          description: m.description ?? '',
          capabilities: (pack?.capabilities ?? []).map((c) => ({
            capability: c.capability,
            label: capabilityLabel(c.capability),
          })),
          // 从装配结果中传递 traits/handoffPrompt 等字段
          traits: pack?.traits,
          handoffPrompt: pack?.meta.handoffPrompt,
          strategyHint,
          interactionType: pack?.meta.interactionType,
          version: pack?.meta.version,
          // 兜底契约包禁删标记（组员反向索引已退役：组员不感知被引用，见 ADR-028 收敛补记）
          isFallback: m.name === BUILTIN_FALLBACK_PACK,
          // 健康徽章：内核装配期的校验 issues 全量透传给 webview（error/warning 均渲染）
          issues: (pack?.validationIssues ?? []).map((i) => ({
            level: i.severity,
            message: i.message,
          })),
        };
      });
    const activeName = rpm.activeName ?? (packs.length > 0 ? packs[0]!.name : '');
    // maxTeamMembers：内核常量透传给 webview（浏览器沙箱不可直连内核，UI 侧禁止另写字面量）
    // keyface：内核键面透传（UI 键面唯一来源 = describeStrategyKeys，宿主零清单维护）
    this.post({
      type: 'roles_loaded',
      packs,
      teams,
      activeName,
      maxTeamMembers: MAX_TEAM_MEMBERS,
      keyface: describeStrategyKeys(),
    });
  }

  // ─── 大模型配置子视图数据加载 ───

  private async loadConfig(): Promise<void> {
    const providers = await this.store.listMasked();
    this.post({
      type: 'cfg_loaded',
      providers,
      activeName: this.store.getActiveName(),
      backgroundName: this.store.getBackgroundName(),
    });
  }

  /**
   * 设置后台模型 Provider（cfg_set_background，多 Provider 路由）
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
      this.post({
        type: 'notice',
        level: 'info',
        message: name ? `后台模型已切换为「${name}」` : '后台模型已回退（与实时对话相同）',
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `切换后台模型失败：${toNoticeText(err)}`,
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
      const hits = await memory.searchByKeyword(query, limit ?? MEMORY_SEARCH_LIMIT);
      this.post({ type: 'memory_search_result', query, hits: hits.map(toSearchDto) });
    } catch (err) {
      const message = toNoticeText(err);
      void vscode.window.showErrorMessage(`Memora 记忆搜索失败：${message}`);
      this.post({ type: 'memory_search_result', query, hits: [] });
    }
  }

  /**
   * 记忆列表翻页（memory_page）
   *
   * MemoryInspector.list 按 accessedAt 降序；翻页取「前 page*pageSize 条」后切出目标页——
   * 复用唯一检索入口（inMemoryStorage.search），零内核改动；页面浏览期间记忆库静止，
   * accessedAt 排序稳定，前页数据与首屏 memory_loaded 一致。
   */
  private async loadMemoryPage(page: number, pageSize: number): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory || page < 1 || pageSize < 1) return;
    const all = memory.list(page * pageSize);
    const items: MemoryItemDto[] = all.slice((page - 1) * pageSize, page * pageSize).map(toItemDto);
    this.post({ type: 'memory_page_result', page, items });
  }

  // ─── 记忆单条删除 / 恢复 / 回收站 ───

  /**
   * 删除单条记忆（memory_delete）
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
        message: toNoticeText(err),
      });
    }
  }

  /**
   * 恢复单条记忆（memory_restore）
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
        message: toNoticeText(err),
      });
    }
  }

  /**
   * 永久删除回收站单条记忆（memory_purge）
   *
   * 弹确认框后调 agent.memory.writePurge(id) 物理删除（不可恢复），完成后推送 memory_purged
   * + 刷新回收站/记忆列表/治理统计。
   */
  private async purgeMemory(id: string): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({
        type: 'memory_purged',
        ok: false,
        id,
        message: 'Agent 未就绪，无法永久删除记忆',
      });
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
        message: toNoticeText(err),
      });
    }
  }

  /**
   * 清空回收站（memory_recycle_clear）
   *
   * 弹确认框后遍历 listDeleted() 逐个 writePurge 物理删除全部软删记忆（不可恢复），
   * 完成后推送 memory_recycle_cleared + 刷新回收站/治理统计。
   */
  private async clearRecycle(): Promise<void> {
    const memory = await this.ensureMemory();
    if (!memory) {
      this.post({
        type: 'memory_recycle_cleared',
        ok: false,
        count: 0,
        message: 'Agent 未就绪，无法清空回收站',
      });
      return;
    }
    // 空回收站：无需确认，直接回报 0
    // 取全部（不传 limit）——本函数把 deleted 同时用作「删除操作集合」与「上报条数」，
    // 任何截断都会造成部分清理 + 谎报条数（deleted 条数即上报 count，须取全量，不能传上限）。
    const deleted = memory.listDeleted();
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
        message: toNoticeText(err),
      });
    }
  }

  /**
   * 编辑单条记忆内容（memory_edit，内联编辑）
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
        message: toNoticeText(err),
      });
    }
  }

  /**
   * 加载回收站列表（memory_recycle_load）
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
    // 全量列举：内核契约 listDeleted(缺省) = 全部；回收站视图无分页，截断会静默丢条目
    const items = memory.listDeleted().map(toItemDto);
    this.post({ type: 'memory_recycle_loaded', items });
  }

  // ─── 记忆治理数据加载 ───

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
    // 回收站数：listDeleted(缺省) = 全部（传上限会在超量时低报）
    const deleted = memory.listDeleted().length;
    // supersede 治理模型：统计已被取代的活跃记忆（supersededBy 非空），对齐内核写路径取代语义。
    // list() 默认仅 50 条，须按 stats().total（精确活跃数）取全量，否则超量时低报。
    const superseded = memory.list(stats.total).filter((m) => m.supersededBy !== undefined).length;
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
   * 破坏性操作：弹确认框后调 agent.memory.writePurgeExpired(保留期前) 永久删除，
   * 完成后刷新治理统计与记忆列表（与 memora.cleanupMemories 命令同语义、同保留期常量）。
   */
  private async runCleanup(): Promise<void> {
    const agent = await this.ensureAgent();
    if (!agent?.memory) {
      this.post({
        type: 'governance_result',
        ok: false,
        message: 'Agent 未就绪，无法清理记忆',
        action: 'cleanup',
      });
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `将永久删除 ${MEMORY_RECYCLE_RETENTION_DAYS} 天前的软删除记忆，此操作不可撤销。`,
      { modal: true },
      '确认清理',
      // 不传显式「取消」：VS Code modal 自带系统级取消，再传出现双取消（对齐全仓多数派）
    );
    if (confirmed !== '确认清理') return;
    try {
      const cutoff = new Date(Date.now() - MEMORY_RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
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
        message: toNoticeText(err),
        action: 'cleanup',
      });
    }
  }

  // ─── 技能子视图数据加载 ───

  /** 加载并推送三源技能清单（系统内置 / 启用角色包 / 用户目录，统一由 skillAggregation 聚合；含健康校验） */
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
    // 写→验→用：对带 filePath 的技能（builtin/user）逐项健康校验叠加 health/issues；
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
    // 禁用集里「未找到需要禁用的技能」的名字（非阻断提示，只进 UI）。
    // 判定复用**同一份** `skills` 聚合结果（与 UI 展示同名集），不自造第二份名单。
    const unmatchedDisabled = findUnmatchedDisabled(
      sm?.disabledSkillNames ?? [],
      skills.map((s) => ({ name: s.name }) as SkillDto),
    );
    this.post({ type: 'skills_loaded', skills: validated, unmatchedDisabled });
  }

  /**
   * 重推技能清单（供 extension 在「技能启停」配置变更 / 手动重载后调用）
   *
   * 复用 `loadSkills()` **单一实现**而非另写一份：该方法同时承载 health 校验与
   * 「已禁用」标注，配置变更后两条标注都需按最新禁用集/最新文件重算 —— 分开写迟早分叉
   * （改可见集时只刷一半消费通道是既有教训）。
   *
   * 代价说明：`loadSkills` 对带 filePath 的技能逐项 `validateFile`（读盘）。配置变更是低频
   * 用户操作，且健康态是设置页卡片的**既有展示维度**，省掉校验会让卡片回退成无 health 快照。
   */
  public async refreshSkillList(): Promise<void> {
    await this.loadSkills();
  }

  /**
   * 切换单个技能的禁用状态（面板延长线开关）
   *
   * 语义：Memora 面板开关 = VS Code 原生设置的**延长线**，唯一动作是
   * 写回配置 `memora.disabledSkills`（ConfigurationTarget.Global——该键 scope=application，
   * 写 workspace settings 不生效），不造第二套状态机；后续同步全走既有
   * `onDidChangeConfiguration` 监听（syncDisabledSkills → 内核 setDisabledSkills +
   * chat/settings 双通道 refreshSkillList），面板不做本地乐观翻转、以 skills_loaded
   * 回推刷新为准。
   *
   * 新数组基数 = 内核 `disabledSkillNames`（**实际生效集**，真源），**不重读**宿主配置副本
   * ——两源会在 reloadConfig 重设禁用集后分叉。开关只做增量增/删：
   * 禁用 → 补名；启用 → 移名。
   *
   * @param name 技能名（仅全局池 builtin/user；rolepack 免疫禁用集，不发送本消息）
   * @param disabled 目标态：true = 禁用
   */
  private async toggleSkillDisabled(name: string, disabled: boolean): Promise<void> {
    const agent = await this.ensureAgent();
    if (!agent?.skills) {
      this.post({ type: 'notice', level: 'error', message: 'Agent 未就绪，无法切换技能禁用状态' });
      return;
    }
    // 增量增/删（base 为只读快照，不改数组内容直接得出 next）
    const base = agent.skills.disabledSkillNames;
    const next = disabled
      ? base.includes(name)
        ? base
        : [...base, name]
      : base.filter((n) => n !== name);
    try {
      // 唯一动作：整组写回用户级配置；生效与 UI 刷新交给既有配置监听接管
      await vscode.workspace
        .getConfiguration('memora')
        .update('disabledSkills', next, vscode.ConfigurationTarget.Global);
      this.post({
        type: 'notice',
        level: 'info',
        message: `已${disabled ? '禁用' : '启用'}技能「${name}」`,
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `设置技能禁用失败：${toNoticeText(err)}`,
      });
    }
  }

  /**
   * L2 渐进披露：按需读取技能正文（不预装载到 L1 列表，用户点击展开时才读取）
   *
   * 解析顺序收口于 `skillAggregation.resolveSkill`（角色包 → 全局，与内核 `read_skill` 同序）——
   * 同名技能双存时宿主解析序须与 composer 注入序一致，否则预览正文与实际注入分叉。
   * 本方法只取正文交给 webview 渲染，不自写两级回退。
   */
  private async readSkillContent(skillName: string): Promise<void> {
    const agent = await this.ensureAgent();
    if (!agent) {
      this.post({ type: 'skill_content', skillName, content: '' });
      return;
    }
    const resolved = await resolveSkill(agent, skillName);
    this.post({ type: 'skill_content', skillName, content: resolved?.content ?? '' });
  }

  /** 在系统文件管理器中打开指定目录（revealFileInOS 失败回退 showItemInFolder；供技能/角色包目录共用，SSOT 消除重复） */
  private openDirInOs(dir: string | undefined, label: string): void {
    if (!dir) {
      void vscode.window.showWarningMessage(`${label}目录未配置`);
      return;
    }
    const uri = vscode.Uri.file(dir);
    void vscode.commands.executeCommand('revealFileInOS', uri).then(
      () => {},
      () => {
        // revealFileInOS 可能失败，回退用 showItemInFolder
        void vscode.commands.executeCommand('showItemInFolder', uri);
      },
    );
  }

  /** 打开用户技能目录（在系统文件管理器中显示） */
  private openUserSkillsDir(): void {
    this.openDirInOs(this._userSkillsDir, '用户技能');
  }

  /** 打开用户角色包目录（在系统文件管理器中显示，与技能目录入口一致） */
  private openUserRolePacksDir(): void {
    this.openDirInOs(this._userRolePacksDir, '用户角色包');
  }

  /**
   * roles_refresh：重扫用户角色包目录，对账内核内存池（刷新按钮）。
   *
   * 背景：loadExtraDir 仅在 Agent 启动时执行一次，面板折叠展开读内存快照——
   * 用户在目录里新增/改名/删除角色包后，不重启宿主不会生效。本方法调用内核
   * resyncUserPacks 完成对账（摘除旧注入项 → 重扫 → 激活悬空走兜底单链），
   * 结果以 notice 反馈并经 loadRoles 下发最新列表。
   */
  private async refreshRolePacks(): Promise<void> {
    const agent = await this.ensureAgent();
    const rpm = agent?.rolePackManager;
    if (!rpm || !this._userRolePacksDir) {
      this.post({ type: 'notice', level: 'error', message: '角色包系统未就绪，无法刷新' });
      return;
    }
    const r = await rpm.resyncUserPacks(this._userRolePacksDir);
    // 净差对账文案（对用户诚实）：同名重注入 = 更新生效，不与新增/移除混报
    const parts: string[] = [];
    if (r.added > 0) parts.push(`新增 ${r.added} 个`);
    if (r.updated.length > 0) parts.push(`更新 ${r.updated.length} 个（${r.updated.join('、')}）`);
    if (r.removed.length > 0) parts.push(`移除 ${r.removed.length} 个（${r.removed.join('、')}）`);
    if (r.activeFallback) parts.push('原激活包已不在，已回退兜底角色包');
    this.post({
      type: 'notice',
      level: 'info',
      message: parts.length > 0 ? `角色包已刷新：${parts.join('；')}` : '角色包已刷新：无变化',
    });
    await this.loadRoles();
  }

  // ─── 安全子视图方法（写入审批） ───

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
      // 3. 推送最新状态给 webview（脚本确认沿用持久值，保持双开关状态一致）
      const scriptsEnabled = this._globalState?.get<boolean>(CONFIRM_SCRIPTS_KEY) ?? false;
      this.post({
        type: 'security_status',
        confirmWrites: enabled,
        confirmScripts: scriptsEnabled,
      });
      this.post({
        type: 'notice',
        level: 'info',
        message: enabled
          ? '已开启写入二次确认（写文件前将弹出审批卡）'
          : '已关闭写入二次确认（写文件自动批准）',
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `切换写入确认开关失败：${toNoticeText(err)}`,
      });
    }
  }

  /**
   * 切换脚本/代码/命令执行确认开关（security_scripts_toggle 消息处理）
   *
   * 持久化到 globalState + 热更新 agent.security.setConfirmScripts()。
   * 无需重启 Agent——SecurityGuard 支持运行时切换。语义：开 = run_code / run_project_script /
   * run_command（普通命令）执行前询问。⚠️ git 写操作与 npm publish 属 ALWAYS_ASK 档，
   * **不受本开关影响**（恒询问且不可豁免，见内核 `pathGuard.classifyCommand`）——
   * 故下方关闭态文案必须带上这句，否则用户会误以为关掉开关就能跳过 git 提交审批。
   */
  private async toggleConfirmScripts(enabled: boolean): Promise<void> {
    try {
      // 1. 持久化到 globalState（用户级偏好）
      this._globalState?.update(CONFIRM_SCRIPTS_KEY, enabled);
      // 2. 热更新已装配的 Agent（SecurityGuard 运行时切换）
      const agent = await this.ensureAgent();
      if (agent?.security) {
        agent.security.setConfirmScripts(enabled);
      }
      // 3. 推送最新状态给 webview（confirmWrites 沿用持久值，保持双开关状态一致）
      const writesEnabled = this._globalState?.get<boolean>(CONFIRM_WRITES_KEY) ?? false;
      this.post({ type: 'security_status', confirmWrites: writesEnabled, confirmScripts: enabled });
      this.post({
        type: 'notice',
        level: 'info',
        message: enabled
          ? '已开启执行二次确认（运行脚本/代码或执行普通命令前将弹出审批卡）'
          : '已关闭执行二次确认（脚本与普通命令自动放行；git 写操作与发布仍每次询问）',
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `切换脚本执行确认开关失败：${toNoticeText(err)}`,
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
    const scripts = this._globalState?.get<boolean>(CONFIRM_SCRIPTS_KEY) ?? false;
    this.post({ type: 'security_status', confirmWrites: enabled, confirmScripts: scripts });
  }

  /**
   * 设置白名单额外允许路径（allowed_paths_set 消息处理）
   *
   * 归类：目录白名单 = 这台机器信任的数据目录（机器级信任，
   * 跨项目通用），归 ConfigurationTarget.Global——个人绝对路径不进项目
   * .vscode/settings.json（避免随项目入库泄漏本机目录结构 + 跨项目重复配置）。
   * 热更新 agent.security.setAllowedPaths()。无需重启 Agent——SecurityGuard 支持运行时热更新。
   * paths = 完整用户额外数组（不含 projectPath 基准根）。
   */
  private async setAllowedPaths(paths: string[]): Promise<void> {
    try {
      // 1. 持久化到用户级设置（机器级信任；projectPath 基准根恒在，不在此数组内）
      await vscode.workspace
        .getConfiguration('memora')
        .update('allowedPaths', paths, vscode.ConfigurationTarget.Global);
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
        message:
          paths.length > 0
            ? `已更新允许路径白名单（${paths.length} 项）`
            : '已清空额外允许路径（仅保留项目目录）',
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `设置允许路径失败：${toNoticeText(err)}`,
      });
    }
  }

  /**
   * 加载并推送白名单额外路径状态（settings 视图 ready 时调用）
   *
   * 从 workspace 设置读取持久化的额外路径数组，推送给 webview 渲染初始列表。
   */
  private loadAllowedPathsStatus(): void {
    const paths = vscode.workspace.getConfiguration('memora').get<string[]>('allowedPaths', []);
    const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    this.post({ type: 'allowed_paths_status', projectPath, paths });
  }

  /**
   * 设置内部网页搜索引擎（search_engine_set 消息处理）
   *
   * 归类：搜索引擎是**用户级偏好**（跨项目一致，与模型/provider 同属用户设置），
   * 写入 ConfigurationTarget.Global——不进项目 .vscode/settings.json，避免个人偏好
   * 入库/跨仓漂移（与 providerStore 的 providers 同 scope）。
   * 装配期一次性注入，修改后需重载窗口（或重建会话）生效——此处仅持久化 + 回显，不做热装配。
   */
  private async setSearchEngine(engine: SearchEngineSetting): Promise<void> {
    const customs = this.readCustomSearchEngines();
    const valid =
      (PRESET_SEARCH_ENGINES as readonly string[]).includes(engine) ||
      customs.some((e) => e.name === engine);
    if (!valid) {
      this.post({ type: 'notice', level: 'error', message: `无效的搜索引擎：${engine}` });
      return;
    }
    try {
      await vscode.workspace
        .getConfiguration('memora')
        .update('searchEngine', engine, vscode.ConfigurationTarget.Global);
      this.post({ type: 'search_engine_status', engine });
      this.post({
        type: 'notice',
        level: 'info',
        message: `已切换网页搜索引擎：${engine}（重载窗口后生效）`,
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `设置搜索引擎失败：${toNoticeText(err)}`,
      });
    }
  }

  /** 加载并推送当前搜索引擎选择（settings 视图 ready 时调用） */
  private loadSearchEngineStatus(): void {
    const engine = vscode.workspace
      .getConfiguration('memora')
      .get<SearchEngineSetting>('searchEngine', 'auto');
    this.post({ type: 'search_engine_status', engine });
  }

  /** 读取用户自定义搜索引擎清单 */
  private readCustomSearchEngines(): CustomSearchEngineConfig[] {
    return vscode.workspace
      .getConfiguration('memora')
      .get<CustomSearchEngineConfig[]>('customSearchEngines', []);
  }

  /**
   * 持久化用户自定义搜索引擎清单（custom_search_engines_set 消息处理）
   *
   * 校验：每项需名称非空、URL 模板含 {query}、解析策略合法；任一不合规整体拒绝并提示，
   * 不写入（避免半合法状态）。合法则写入用户级设置 + 回推状态 + 提示。
   */
  /**
   * 拒绝一次保存：报出原因，并**回推当前已持久化状态**令 webview 收敛。
   * 校验失败与探针未通过两条路径都走这里 ⇒ 回滚行为单点，不留第二份逻辑。
   */
  private rejectCustomEngines(reason: string): void {
    this.post({ type: 'notice', level: 'error', message: reason });
    this.post({ type: 'custom_search_engines_status', engines: this.readCustomSearchEngines() });
  }

  private async setCustomSearchEngines(engines: CustomSearchEngineConfig[]): Promise<void> {
    const problem = validateCustomEngines(engines);
    if (problem) {
      this.rejectCustomEngines(`自定义搜索引擎${problem}，未保存`);
      return;
    }
    // 保存前实测验证（host 权威门禁）：仅对相对已持久化清单发生变化的引擎探针（未变引擎跳过，避免重复网络探测）；
    // 任一变化引擎验证未通过（网络失败 / 接口无结构化结果）→ 整体拒绝保存，webview 即便跳过「测试」也无法绕过。
    const persisted = this.readCustomSearchEngines();
    for (const e of engines) {
      const unchanged = persisted.some(
        (p) =>
          p.name === e.name &&
          p.urlTemplate === e.urlTemplate &&
          p.parseStrategy === e.parseStrategy,
      );
      if (unchanged) continue;
      const r = await probeSearchEngine(e);
      if (!r.ok) {
        this.rejectCustomEngines(
          `搜索引擎「${e.name || '(空)'}」验证未通过，未保存：${r.error ?? `接口未返回可解析结果（${r.count} 条）`}`,
        );
        return;
      }
    }
    try {
      await vscode.workspace
        .getConfiguration('memora')
        .update('customSearchEngines', engines, vscode.ConfigurationTarget.Global);
      this.post({ type: 'custom_search_engines_status', engines });
      this.post({
        type: 'notice',
        level: 'info',
        message: `已保存 ${engines.length} 个自定义搜索引擎（重载窗口后生效）`,
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `保存自定义搜索引擎失败：${toNoticeText(err)}`,
      });
    }
  }

  /** 加载并推送自定义搜索引擎清单（settings 视图 ready 时先于 search_engine_status 调用） */
  private loadCustomSearchEnginesStatus(): void {
    this.post({ type: 'custom_search_engines_status', engines: this.readCustomSearchEngines() });
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
  content: string;
  createdAt?: string;
  accessedAt?: string;
  deletedAt?: string;
  summaryType?: 'preference' | 'fact' | 'decision' | 'intent' | 'general';
  sessionName?: string;
  roundId?: string;
  isModified?: boolean;
  supersededBy?: string;
}): MemoryItemDto {
  return {
    id: m.id,
    name: m.name,
    source: m.source,
    content: m.content,
    createdAt: m.createdAt,
    accessedAt: m.accessedAt,
    deletedAt: m.deletedAt,
    summaryType: m.summaryType,
    sessionName: m.sessionName,
    roundId: m.roundId,
    isModified: m.isModified,
    supersededBy: m.supersededBy,
  };
}

/** 内核 AgentSearchHit → 记忆条目 DTO（透传 accessedAt 排序依据） */
function toSearchDto(h: {
  id: string;
  name: string;
  source: string;
  contentPreview: string;
  createdAt?: string;
  accessedAt?: string;
}): MemoryItemDto {
  return {
    id: h.id,
    name: h.name,
    source: h.source,
    content: h.contentPreview,
    createdAt: h.createdAt,
    accessedAt: h.accessedAt,
  };
}

/** 生成 Webview HTML（选项卡栏 + 三个子视图根容器）
 *  @param scriptUri 外部脚本 settingsView.js 的 asWebviewUri（CSP script-src cspSource 加载）
 *  @param cspSource webview 本地资源源（webview.cspSource，供 CSP 放行外部脚本） */
function buildHtml(scriptUri: vscode.Uri, cspSource: string): string {
  return `${buildHtmlHead({
    lang: resolveHtmlLang(vscode.env?.language),
    cspSource,
    styles: settingsStyles,
  })}
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

    <!-- 回收站：软删除记忆的可恢复暂存区 -->
    <details id="recycle" class="recycle" role="region" aria-label="回收站">
      <summary>回收站</summary>
      <div id="recycleList"><p class="hint">回收站为空。</p></div>
    </details>
    <p id="memHint" class="mem-hint" hidden></p>

    <!-- 记忆治理区：统计卡 + 加权/清理操作 -->
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
        <button id="btnCleanup" class="btn btn-danger" title="永久删除 ${MEMORY_RECYCLE_RETENTION_DAYS} 天前的软删除记忆（不可撤销）">清理过期</button>
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
      <div class="header-actions">
        <button id="btnOpenRolePacksDir" class="btn btn-secondary btn-icon-solo" title="打开用户角色包目录">
          <span class="btn-icon" data-icon="folder"></span>
        </button>
        <button id="btnRefreshRolePacks" class="btn btn-secondary btn-icon-solo" title="刷新角色包列表（重扫用户角色包目录）">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
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
    <!-- 模型通道分区：后台 + 检索归入显式分区，与 Provider 列表的 group-title 语言一致 -->
    <div class="group-title">模型通道</div>
    <!-- 后台模型通道（多 Provider 路由）：后台任务（摘要/归档/润色）独立轻量模型 -->
    <div class="cfg-bg">
      <label for="bgModel" class="cfg-bg-label">后台模型（可选）</label>
      <select id="bgModel" class="cfg-bg-select" aria-label="后台模型，用于后台任务（摘要/归档/润色）">
        <option value="">同实时对话</option>
      </select>
      <p class="cfg-bg-hint">后台任务（轮次摘要 / 会话归档 / 文本润色 / 语义去重）走此模型，可选用轻量快模型节省成本。</p>
    </div>
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
          <div class="field">
            <label for="f-providertype">来源类型</label>
            <select id="f-providertype" name="provider">
              <option value="cloud">云端 API（DeepSeek / 豆包 / 通义等）</option>
              <option value="local">本地运行时（Ollama / LM Studio）</option>
            </select>
            <div class="key-hint">云端服务商默认启用原生工具调用；本地运行时是否支持工具调用由下方显式声明（无法从地址推断）。</div>
          </div>
          <div id="toolcalling-field" class="field" hidden>
            <label class="checkbox-label" for="f-toolcalling">
              <input id="f-toolcalling" name="supportsToolCalling" type="checkbox" checked />
              <span>支持原生工具调用（OpenAI Function Calling）</span>
            </label>
            <div class="key-hint">勾选：本地模型可调用工具（联网搜索 / 读写文件 / 建记忆等）；取消：仅文本对话，工具通道自动收起并告知模型不可用。</div>
          </div>
          <div class="field">
            <label for="f-contextwindow">上下文窗口上限（K）</label>
            <input id="f-contextwindow" name="contextWindow" type="text" inputmode="decimal" placeholder="如 128（留空用默认窗口）" autocomplete="off" />
            <div class="key-hint">填千单位（K），如 128 表示 128K = 128,000 tokens；支持小数（如 1.5）；留空使用内核默认窗口（以内核常量为真源，此处不写死数字）。</div>
            <div id="f-contextwindow-feedback" class="key-hint" hidden></div>
          </div>
          <div class="field">
            <label for="f-maxtokens">输出上限（K）</label>
            <input id="f-maxtokens" name="maxTokens" type="text" inputmode="decimal" placeholder="如 64（留空用服务端默认）" autocomplete="off" />
            <div class="key-hint">模型单次回复的最大输出 token 数（含思考占用），如 64 = 64,000 tokens（K = ×1000，与上下文上限同口径）；留空 = 不传 max_tokens、由服务端默认。<span class="hint-warn-icon" data-icon="warning" role="img" aria-label="注意"></span>推理模型思考与正文共享输出预算，留空极易触发空响应，建议必填（mimo v2.6 建议 32–64K）；填后仍截断可再调大（超模型上限由服务端报错，不会静默生效）。</div>
            <div id="f-maxtokens-feedback" class="key-hint" hidden></div>
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

  <!-- 技能子视图（skills 选项卡） -->
  <div id="skills-root" role="tabpanel" aria-label="技能" hidden>
    <div class="header">
      <h2>全局技能</h2>
      <span id="skillCount" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnOpenSkillsDir" class="btn btn-secondary btn-icon-solo" title="打开用户技能目录">
          <span class="btn-icon" data-icon="folder"></span>
        </button>
        <button id="btnRefreshSkills" class="btn btn-secondary btn-icon-solo" title="刷新技能列表">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div class="hint">全局技能是所有角色包共享的能力。支持单文件 <code>.md</code> 和文件夹 <code>SKILL.md</code> 两种格式。</div>
    <div id="skillsList">
      <p class="loading-hint">加载中…</p>
    </div>
    <p class="footer-hint">用户技能目录：<code>VS Code 全局存储 / skills /</code></p>
  </div>

  <!-- 安全子视图（security 选项卡：写入审批） -->
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
      <div class="security-item">
        <div class="security-item-header">
          <label for="confirmScriptsToggle" class="security-label">执行二次确认</label>
          <label class="toggle-switch">
            <input id="confirmScriptsToggle" type="checkbox" role="switch" aria-label="脚本与命令执行二次确认开关" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="security-desc">开启后，AI 运行脚本/代码（run_project_script / run_code）或执行普通 shell 命令（run_command）前会弹出审批卡，需确认放行。默认关闭（自动放行）。仅控制「是否询问」，不影响能力本身（这些能力始终开放）。<strong>注意：git 写操作（commit / push / reset / rebase / merge）与 npm publish 不受本开关影响，每次都会询问、且无法豁免</strong>——它们属于不可逆操作。</p>
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
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label" for="searchEngineSelect">网页搜索引擎</label>
        </div>
        <p class="security-desc">「联网搜索」工具使用的内部搜索后端。自动 = Bing 优先降级 DuckDuckGo；中文场景推荐切「百度/搜狗」提升命中质量。也可选用下方自定义引擎。修改后需重载窗口生效。</p>
        <select id="searchEngineSelect" class="security-select" aria-label="网页搜索引擎"></select>
        <p class="security-desc">自定义引擎需返回结构化结果：OpenSearch RSS / Atom，或 JSON（<code>{results:[{title,url,…}]}</code>）。普通网页（一堆 HTML）与需登录的平台不支持。点「编辑」填写后先「测试」再「保存」。</p>
        <div id="customSearchEngines" class="custom-search-engines"></div>
        <button id="addCustomEngineBtn" class="btn btn-secondary ce-add-btn" type="button">+ 添加自定义搜索引擎</button>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">恢复初始状态</label>
        </div>
        <p class="security-desc">一键清空插件的<strong>全部用户级数据</strong>：用户技能、用户角色包、大模型配置（含 API Key）、激活角色包、角色包组、安全开关与用户级设置，恢复到第一次使用插件的状态。<strong>项目数据完整保留</strong>：当前项目的记忆、会话记录（.memora/）与项目设置不动——它们已经是项目的一部分。清理完成后将自动重载窗口，进行中的对话会中断。</p>
        <button id="resetUserDataBtn" class="btn btn-danger security-reset-btn" type="button">清空用户级数据…</button>
        <span id="resetUserDataHint" class="security-status security-reset-hint" hidden></span>
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}
