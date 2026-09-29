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
import { MemoraChatViewProvider } from './chatPanel.js';
import type {
  ExtensionToWebviewMessage,
  GovernanceStatsDto,
  MemoryItemDto,
  MemoryStatsDto,
  SearchEngineSetting,
  SkillDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { capabilityLabel } from '../helpers/capabilityLabels.js';
import {
  findUnmatchedDisabled,
  listVisibleSkills,
  resolveSkill,
} from '../../extension/host/skillAggregation.js';
import { settingsStyles } from '../styles/settingsStyles.js';
import {
  ACTIVE_ROLE_PACK_KEY,
  CONFIRM_WRITES_KEY,
  CONFIRM_SCRIPTS_KEY,
  ROLE_PACK_TEAMS_KEY,
  MEMORY_RECYCLE_RETENTION_DAYS,
} from '../../shared/constants.js';
// 内核常量（宿主不复制字面量，SSOT 单一来源）：
//   BUILTIN_FALLBACK_PACK — 兜底契约包名，随内核包分发，宿主 UI 禁删标记；
//   MAX_TEAM_MEMBERS      — 小组会议组员上限，本处用于保存校验，并随 roles_loaded 下发给 webview。
import { BUILTIN_FALLBACK_PACK, MAX_TEAM_MEMBERS } from '@zooique/memora';

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
      // 安全子视图：推送写入二次确认开关状态 + 白名单额外路径 + 网页搜索引擎
      this.loadSecurityStatus();
      this.loadAllowedPathsStatus();
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
      });
      return;
    }
    // 组（会议名单）用户级数据：组员仅作小组会议参与者
    const teams =
      this._globalState?.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? [];
    // 组员名单索引：角色包 → 引用它的组长集合（供「小组会议用」标注）
    const memberOf = new Map<string, string[]>();
    for (const team of teams) {
      for (const member of team.members) {
        const list = memberOf.get(member) ?? [];
        if (!list.includes(team.leader)) list.push(team.leader);
        memberOf.set(member, list);
      }
    }
    const packs = rpm
      .listMeta()
      .filter((m) => m.name)
      .map((m) => {
        const pack = rpm.get(m.name);
        // 来源层判定：用户目录命中 → user，否则内置（内置优先语义；
        // 与技能 sourceOf 同思路，用 filePath 前缀，configDir 与用户目录天然不重叠）
        const source: 'builtin' | 'user' =
          this._userRolePacksDir && pack?.filePath?.startsWith(this._userRolePacksDir)
            ? 'user'
            : 'builtin';
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
          // 该包作为组员被哪些组引用（仅小组会议用）+ 兜底契约包禁删标记
          teamMembers: memberOf.get(m.name),
          isFallback: m.name === BUILTIN_FALLBACK_PACK,
          // 健康徽章：内核 validateManifest 全量 issues 透传给 webview（error/warning 均渲染）
          issues: (pack?.validationIssues ?? []).map((i) => ({
            level: i.severity,
            message: i.message,
          })),
        };
      });
    const activeName = rpm.activeName ?? (packs.length > 0 ? packs[0]!.name : '');
    // maxTeamMembers：内核常量透传给 webview（浏览器沙箱不可直连内核，UI 侧禁止另写字面量）
    this.post({ type: 'roles_loaded', packs, teams, activeName, maxTeamMembers: MAX_TEAM_MEMBERS });
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
      const hits = await memory.searchByKeyword(query, limit ?? MEMORY_SEARCH_LIMIT);
      this.post({ type: 'memory_search_result', query, hits: hits.map(toSearchDto) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
        message: err instanceof Error ? err.message : String(err),
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
        message: err instanceof Error ? err.message : String(err),
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
        message: err instanceof Error ? err.message : String(err),
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
        message: err instanceof Error ? err.message : String(err),
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
        message: err instanceof Error ? err.message : String(err),
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
      '取消',
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
        message: err instanceof Error ? err.message : String(err),
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
        message: `设置技能禁用失败：${err instanceof Error ? err.message : String(err)}`,
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
        message: `切换写入确认开关失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * 切换脚本/代码执行确认开关（security_scripts_toggle 消息处理）
   *
   * 持久化到 globalState + 热更新 agent.security.setConfirmScripts()。
   * 无需重启 Agent——SecurityGuard 支持运行时切换。语义：开 = run_code/run_project_script 执行前询问。
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
          ? '已开启脚本执行二次确认（运行脚本/代码前将弹出审批卡）'
          : '已关闭脚本执行二次确认（脚本自动运行）',
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: `切换脚本执行确认开关失败：${err instanceof Error ? err.message : String(err)}`,
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
        message: `设置允许路径失败：${err instanceof Error ? err.message : String(err)}`,
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
        message: `设置搜索引擎失败：${err instanceof Error ? err.message : String(err)}`,
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
            <input id="f-contextwindow" name="contextWindow" type="text" inputmode="decimal" placeholder="如 128（留空用默认 120K）" autocomplete="off" />
            <div class="key-hint">填千单位（K），如 128 表示 128K = 128,000 tokens；支持小数（如 1.5）；留空使用默认 120K。</div>
            <div id="f-contextwindow-feedback" class="key-hint" hidden></div>
          </div>
          <div class="field">
            <label for="f-maxtokens">输出上限（K）</label>
            <input id="f-maxtokens" name="maxTokens" type="text" inputmode="decimal" placeholder="如 64（留空用服务端默认）" autocomplete="off" />
            <div class="key-hint">模型单次回复的最大输出 token 数（含思考占用），如 64 = 64,000 tokens（K = ×1000，与上下文上限同口径）；留空由服务端默认。推理模型思考过长挤掉正文（空响应）时调大此值。</div>
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
          <label for="confirmScriptsToggle" class="security-label">脚本执行二次确认</label>
          <label class="toggle-switch">
            <input id="confirmScriptsToggle" type="checkbox" role="switch" aria-label="脚本执行二次确认开关" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="security-desc">开启后，AI 运行脚本/代码（run_project_script / run_code）前会弹出审批卡，需确认放行。默认关闭（脚本自动运行）。仅控制「是否询问」，不影响脚本能力本身（run_project_script 始终默认开放）。</p>
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
        <p class="security-desc">「联网搜索」工具使用的内部搜索后端。自动 = Bing 优先降级 DuckDuckGo；中文场景推荐切「百度/搜狗」提升命中质量。修改后需重载窗口生效。</p>
        <select id="searchEngineSelect" class="security-select" aria-label="网页搜索引擎">
          <option value="auto">自动（Bing → DuckDuckGo）</option>
          <option value="bing">必应（Bing）</option>
          <option value="baidu">百度（中文推荐）</option>
          <option value="sogou">搜狗</option>
        </select>
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}
