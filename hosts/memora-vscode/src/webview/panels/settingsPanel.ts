/**
 * 设置面板 — editor tab Webview 面板（选项卡式七页合一，单例管理）
 *
 * 各子视图（角色 / 大模型 / 记忆 / 技能 / MCP / 安全 / 作品和规则，清单 SSOT = `shared/settingsTabs.ts`）
 * 共存于单一「设置」面板，内部通过选项卡切换。
 * 子视图保留各自独立行为逻辑，通过共享同一 webview 文档 + root 容器 id 空间隔离共存。
 *
 * L3 分家（2026-10-26）：设置六页整体从侧栏 view 迁入 editor tab（六页合一迁入，非回退到分页前
 * 形态）；对话仍留侧栏。关 tab 即 dispose，重开走 ready 握手重建 + _pendingTab 补发。
 *
 * 上下文保留：panel **设** `retainContextWhenHidden: true`（editor tab 失焦是常态，不设即丢各页
 * 表单草稿）。⚠️ 别按「panel 无该选项」的旧结论决策——`WebviewPanelOptions & WebviewOptions`
 * 明载该字段。隐藏期投递语义官方注释自相矛盾 ⇒ 按不可靠设计：凡「投出就清状态」必经
 * `isDeliverable()`（panel 在 ∧ 已 ready ∧ 可见），隐藏期只记 `_pendingTab`、转可见
 * `flushPendingTab()` 补发；`refreshAll()` 是「宿主侧无推送路径的变更」收敛网，不是补偿。
 *
 * 设计（对齐单一真理源 + 自然生长）：
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM；
 *   - 子视图数据源（roles: RolePackManager / config: ProviderStore / memory: MemoryInspector）；
 *   - 各子视图 load 由本面板按 activeTab 分发；切选项卡只显隐 content 区，不销毁/重建 DOM。
 */
import * as vscode from 'vscode';
const { l10n } = vscode; // 通知文案 l10n（切片 2，ADR-042）：短引用省折行租金
import type { Agent, ArchiveMode, MemoryInspector } from '@zooique/memora';
import { hasActiveSuperseder } from '@zooique/memora';
import type { ProviderStore } from '../../extension/providers/providerStore.js';
// 会话存储（角色切换成功后按会话落盘；只用 updateSessionMeta 这一写点）
import type { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { createBackgroundProvider } from '../../extension/host/llmConfig.js';
import {
  saveRolePackTeam,
  deleteRolePackTeam,
  describeTeamBroadcast,
  type TeamBroadcastResult,
} from '../../extension/host/rolePackTeams.js';
import { MemoraChatViewProvider } from './chatPanel.js';
// 静态 DOM 骨架外置（settingsPanelHtml.ts）：本文件贴 max-lines 只降不升，骨架线性增长
import { buildHtml } from './settingsPanelHtml.js';
import { refreshUserRolePacksFlow, refreshUserSkillsFlow } from './userAssetRefresh.js';
// 用户级「新建会话默认角色包」的单点读口（配置键只在那里被读取）
import { readDefaultRolePackSetting } from '../../extension/host/rolePackDefault.js';
import { toNoticeText } from '../../extension/host/noticeText.js';
// 模态确认框唯一入口（禁自开 showWarningMessage + modal: true，见 scripts/verify-modal-cancel.mjs 严闸）
import { confirmModal } from '../../extension/host/ui/confirmModal.js';
import type {
  CustomSearchEngineConfig,
  ExtensionToWebviewMessage,
  GovernanceStatsDto,
  McpWriteAckDto,
  MemoryItemDto,
  MemoryStatsDto,
  SearchEngineSetting,
  SearchEngineTestResult,
  SkillDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
// MCP 运行时状态（MCP 选项卡的观察面；真源 = 已应用配置 ∪ 运行态 ∪ 失败表）
import {
  getMcpServerStatus,
  reconcileMcpConfig,
  restartMcpServer,
  setMcpStatusListener,
} from '../../extension/host/mcp/runtime.js';
// MCP 写操作实现（`mcp_write` 全部 op 的唯一落点；写配置/回执/重启/接入都在那边）
import { applyMcpWrite, type McpOpsDeps } from './mcpServerOps.js';
// 记忆写操作（删除/恢复/永久删除/清空/编辑/清理）：面板只留一行委派，保住 max-lines 余量
import {
  clearRecycleOp,
  deleteMemoryOp,
  editMemoryOp,
  purgeMemoryOp,
  restoreMemoryOp,
  runCleanupOp,
  type MemoryOpsContext,
} from './settingsMemoryOps.js';
// 配置原值 = 面板列表的「有哪些」，只经唯一读取点（禁就地 getConfiguration，判据散点）
import { readMcpServers, readMcpToolAllowlist } from '../../extension/mcpConfig.js';
// 配置写入唯一通道（5s 超时兜底：只读/受管设置上 update 可能永不 settle ⇒ 静默吞输入）
import { writeErrorText, writeSetting } from '../../extension/settingsWrite.js';
// tab 标识 / 顺序 / 可见名唯一真源：本文件此前手写的两处联合都漏了 'security'
// （⇒ 安全页无法从任何命令跳转过去），不再手写，统一取这一份
import type { SettingsTab } from '../../shared/settingsTabs.js';
import { PRESET_SEARCH_ENGINES } from '../../shared/protocol.js';
// 判据单点复用：validateCustomEngines 定义在搜索引擎域（extension/host/searchEngines.ts），
// 本面板的「测试 / 保存」两条路径与装配侧 resolveSearchEndpoints 共用同一函数；
// probeSearchEngine 同域导入，禁在本文件另写校验规则。
import { probeSearchEngine, validateCustomEngines } from '../../extension/host/searchEngines.js';
// 角色列表投影外置（纯投影不占本文件行数；判据全部来自既有点）
import { postRolePackList } from '../helpers/rolePackListView.js';
// 三条零面板状态依赖的「读配置 → 推消息」动作外置（先腾行后接入作品页）
import {
  pushArchiveModePreference,
  pushCustomSearchEnginesStatus,
  pushSearchEngineStatus,
  pushSecurityStatus,
  readCustomSearchEngines,
} from '../helpers/settingsStatusPush.js';
// 作品投影桥接（数据推送 / 动作执行面 / 打开原文件；侧边栏 TreeView 退役后的唯一消费面）
import {
  WorkProjectionBridge,
  setWorkProjectionListener,
} from '../../extension/host/workProjectionBridge.js';
// 角色选择动作外置（草稿选择 / 设为默认；校验链与文案单点，见模块头）
import { selectDraftRolePack, setDefaultRolePack } from '../helpers/rolePackSelectionActions.js';
// 角色包目录编目读面（与建会话同一份；类型来自决策模块，实现在 extension/host/rolePackCatalog.ts）
import type { RolePackCatalogReader } from '../../extension/host/newSessionRolePack.js';
import {
  findUnmatchedDisabled,
  listVisibleSkills,
  resolveSkill,
} from '../../extension/host/skillAggregation.js';
// 角色包来源判定的判据单点（与技能聚合共用：normalize + sep 边界）
import { isPathWithin } from '../../extension/host/userAssets/path.js';
// 项目级 → 用户级复制编排层（执行面 = zipImport 的事务化原语，本面板只分发）
import { copyProjectRolePackToUser, copyProjectSkillToUser } from './assetCopyToUser.js';
import { CONFIRM_SCRIPTS_KEY } from '../../shared/constants.js';
// 内核常量与键面/校验入口（宿主不复制字面量，SSOT 单一来源）：
//   BUILTIN_FALLBACK_PACK — 兜底契约包名，随内核包分发，宿主 UI 禁删标记；
//   validateManifestText  — 角色包保存前校验入口（宿主不重写判据，校验失败不写盘）。
import { BUILTIN_FALLBACK_PACK, validateManifestText } from '@zooique/memora';
// 角色包 manifest 原文读写（详情弹窗初值 + 全量保真写回的真源是文件原文，不是装配值）
import { readFile, writeFile } from 'node:fs/promises';

/** 列表加载条数（MVP：只读浏览，先展示最常用的前 20 条） */
const MEMORY_LIST_LIMIT = 20;
/** 搜索结果条数 */
const MEMORY_SEARCH_LIMIT = 20;

/** 设置面板（editor tab 单例；七页合一：角色 / 大模型 / 记忆 / 技能 / MCP / 安全 / 作品和规则） */
export class MemoraSettingsPanel {
  /** 面板类型标识（createWebviewPanel 首参；沿用原侧栏 view id 作面板类型键，不另造） */
  public static readonly viewType = 'memora.settings';

  /** 当前面板（关 tab 即 dispose → undefined；undefined = 未打开） */
  private _panel: vscode.WebviewPanel | undefined;
  /** 同步探视指定会话的已登记 Agent（无参 = 当前会话；不装配；其余取用走 `_getAgent`） */
  private _peekAgent: ((sessionId?: string) => Agent | undefined) | undefined;
  /** 已绑定角色包监听的会话 id（只存 id、不持有 Agent 引用；解绑时按 id 取回旧实例） */
  private _boundSessionId: string | undefined;
  /** 当前显示会话解析（与取用面同一真源；切会话时据此判定是否需要解绑旧监听） */
  private _resolveSessionId: (() => string | undefined) | undefined;
  /** 草稿态判据（chat 面板内存态）：草稿没有会话 id/Agent，角色选择只写草稿内存（见 activateRole） */
  private _isDraftSession: (() => boolean) | undefined;
  /**
   * 草稿期角色选择的读写桥（由 extension 注入 chat 面板的两个既有面）
   *
   * 草稿期没有 Agent 可切，选择只记在草稿内存；真正落盘发生在建会话时那一次
   * `updateSessionMeta`（chatPanel.createSession），不另开写入路径。
   * 未注入 ⇒ 草稿期切换如实失败（不静默写全局、不装配任何会话）。
   */
  private _draftRolePackAccess:
    { getName: () => string | undefined; setName: (name: string) => void } | undefined;
  /**
   * 角色包目录编目读面（由 extension 注入，与建会话校验同一份，见 `rolePackCatalog.ts`）
   *
   * 设置默认角色时据此判「包在不在」：冷启动无已装配实例同样可读，
   * 因此不再需要「请先在对话中打开任一会话」这条与建会话口径不一致的拒绝理由。
   * 未注入 ⇒ 视同「读不到」，如实失败（不得乐观放行）。
   */
  private _readRolePackCatalog: RolePackCatalogReader | undefined;
  /** Agent 懒装配工厂（由 extension 注入，与 chat 面板同一 `AgentRegistry` 取用面） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 会话存储（角色切换成功后写回该会话的 `activeRolePackName`；extension 注入） */
  private _sessionStore: WorkspaceSessionStore | undefined;
  /** 全局状态存储（Memento；角色激活态已改为**会话级**落盘，这里不再承载角色，保留供其他用户级配置） */
  private _globalState: vscode.Memento | undefined;
  /** 组队热更广播器（extension 注入，真源 = `AgentRegistry.listEntries()`）。
   *  组队数据是用户级全局一份 ⇒ 写时必须打所有已装配实例（`TEAM-HOTUPDATE-FANOUT-1`）；
   *  未注入时退回当前显示会话（改造前行为，仅覆盖未接线装配路径）。 */
  private _broadcastTeams:
    ((teams: { leader: string; members: string[] }[]) => TeamBroadcastResult) | undefined;
  /** 待切换的子选项卡（configureModel 命令在视图未就绪时缓存，webview ready 后补发） */
  private _pendingTab: SettingsTab | undefined;
  /** webview 是否已发 `ready`（html context 已建立 + 全部子视图监听器已注册）。
   *  **不是** `_panel` 的副本：`_panel` 有值 = tab 存在，与此事实正交；生命周期严格跟随当前
   *  panel（创建即 false，dispose 归 false），写点仅此两处 + ready 分支一处。 */
  private _webviewReady = false;
  /** 对话面板提供者（角色 handoff 预填需跨 webview 投递，由 extension 注入） */
  private _chatProvider: MemoraChatViewProvider | undefined;
  /** 作品投影桥（数据 / 动作 / 打开原文件的唯一入口；只读探视 Agent，不触发懒装配） */
  private readonly works = new WorkProjectionBridge({
    post: (msg) => this.post(msg),
    peekAgent: () => this._peekAgent?.(this._resolveSessionId?.()),
  });
  /** 用户技能目录路径（由 extension 注入，用于打开目录功能） */
  private _userSkillsDir: string | undefined;
  /** 系统内置配置目录（configDir/skills/ 所在父目录，extension 注入，用于技能来源判定） */
  private _configDir: string | undefined;
  /** 项目级资产目录（`<workspace>/.memora/skills` 与 `.memora/role-packs`，extension 注入，用于来源判定） */
  private _projectSkillsDir: string | undefined;
  private _projectRolePacksDir: string | undefined;
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
  ) {
    // MCP 运行态变化（断线 / 启动失败 / 重启）**不是配置变更**，onDidChangeConfiguration 不会
    // 触发 ⇒ 由运行时回调驱动回推，否则面板停在旧值（台账缺口②）。注册在这里而不是
    // extension.ts：那边是贴 max-lines 上限的文件，且「谁要这份状态」本就是视图自己的事。
    setMcpStatusListener(() => this.pushMcpStatus());
    // 清单被本进程改动（登记 / 切换 / 移除）后回推作品页；报告刷新另走内核事件订阅
    setWorkProjectionListener(() => void this.works.load());
  }

  /** 注入 Agent 取用面（真源 = extension 的 `AgentRegistry`；本面板**不缓存实例**）
   *  `getAgent` 可能触发装配；`peekAgent` 同步探视已登记实例（不装配，MCP restart 用）；
   *  `resolveSessionId` 提供「当前显示会话」——切会话时按它解绑旧监听 */
  public setAgentFactory(
    getAgent: (projectPath: string) => Promise<Agent>,
    peekAgent?: (sessionId?: string) => Agent | undefined,
    resolveSessionId?: () => string | undefined,
    isDraftSession?: () => boolean,
  ): void {
    this._getAgent = getAgent;
    this._peekAgent = peekAgent;
    this._resolveSessionId = resolveSessionId;
    this._isDraftSession = isDraftSession;
  }

  /** 注入会话存储：角色切换成功后按会话落盘（装配期读回的唯一写入侧） */
  public setSessionStore(store: WorkspaceSessionStore): void {
    this._sessionStore = store;
  }

  /** 注入草稿期角色选择桥（extension 接线；不注入 = 草稿期只能显示、不能切） */
  public setDraftRolePackAccess(access: {
    getName: () => string | undefined;
    setName: (name: string) => void;
  }): void {
    this._draftRolePackAccess = access;
  }

  /** 注入角色包目录编目读面（与建会话同一份；不注入 = 无法校验，如实失败） */
  public setRolePackCatalog(reader: RolePackCatalogReader): void {
    this._readRolePackCatalog = reader;
  }

  /** 注入全局状态（Memento；角色激活态已改为会话级，不再经此持久化） */
  public setGlobalState(gs: vscode.Memento): void {
    this._globalState = gs;
  }

  /**
   * 注入组队热更广播器（真源 = `AgentRegistry.listEntries()`，见 `broadcastRolePackTeams`）
   *
   * 为什么必须广播：组队名单存 `globalState`（用户级、全局一份），装配期注入**所有**会话。
   * 写的时候只打当前显示会话 = 「读的时候全局、写的时候单实例」的不对称：A 改组后 B 仍持
   * 旧名单，且用户无从察觉。故广播的判据是**数据归属**，不是「哪个面板在改」。
   */
  public setTeamBroadcaster(
    broadcast: (teams: { leader: string; members: string[] }[]) => TeamBroadcastResult,
  ): void {
    this._broadcastTeams = broadcast;
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

  /** 注入项目级资产目录（技能/角色包来源判定；与用户级目录名同构、来源由根路径区分） */
  public setProjectDirs(skillsDir?: string, rolePacksDir?: string): void {
    this._projectSkillsDir = skillsDir;
    this._projectRolePacksDir = rolePacksDir;
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

  /**
   * 打开设置面板（单例：已开则 reveal，未开则创建——editor tab 形态）
   *
   * 原侧栏 view 的 resolveWebviewView 懒初始化逻辑随 L3 分家迁至此处：
   * 装配 html / 注册消息回调 / dispose 清引用三段不变，仅容器从 WebviewView 换为 WebviewPanel。
   */
  public open(): void {
    // 单例复用：重复打开只 reveal 同一 panel，不建第二个
    if (this._panel) {
      this._panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MemoraSettingsPanel.viewType,
      l10n.t('Settings'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // 上下文保留：editor tab 失焦是常态，默认「不可见即销毁」会丢各页表单草稿（webview 无 setState 兜底）
        // 代价（隐藏期收不到 postMessage）由 onDidChangeViewState 补刷，见文件头说明。
        retainContextWhenHidden: true,
        // roots 刻意不放行 attachments/（零图片消费面，D6 无消费不放宽；与 chatPanel 分岔是刻意的，勿顺手对齐）
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
      },
    );
    this._panel = panel;
    // 新 panel 的 html context 尚未建立、脚本未注册监听器 ⇒ ready 之前不可投递。
    // 与 onDidDispose 的清零成对：`_webviewReady` 只描述「当前这一个 panel」的脚本状态。
    this._webviewReady = false;
    // 关 tab（或工作区关闭）时清理两个状态，避免向已销毁 webview postMessage；
    // 不清则 switchTab 把 _pendingTab 写进死 panel 后清空，ready 补发兜底失效 → 落回默认「记忆」页。
    panel.onDidDispose(() => {
      if (this._panel !== panel) return;
      this._panel = undefined;
      this._webviewReady = false;
    });
    // 由隐藏转可见：补发隐藏期攒下的导航 + 全量补刷一次数据。数据面这条是**收敛网**
    // （隐藏期有些变更没有推送路径，如别处改归档模式 / 技能启停），非「消息全丢」补偿（见文件头）。
    panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.visible || this._panel !== panel) return;
      this.flushPendingTab();
      this.refreshAll();
    });

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'scripts', 'settingsView.js'),
    );
    panel.webview.html = buildHtml(scriptUri, panel.webview.cspSource);

    panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      void this.handleMessage(msg);
    });
  }

  /** 处理 webview 发来的消息（ready 握手 + 三个子视图各自的消息路由） */
  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    // webview 错误边界上报（T1）：落扩展宿主日志留痕，不驱动 UI 状态；必须独立成分支
    // ——边界装在工厂之前，上报可先于 ready 握手到达
    if (msg.type === 'host_diag') {
      console.warn(`Memora webview 未处理异常 [${msg.source}] ${msg.message}`, msg.stack ?? '');
      return;
    }
    // ready 握手：webview 脚本已就绪（全部子视图监听器已注册）→ 补发待切选项卡 + 全量推一次数据
    if (msg.type === 'ready') {
      // ready = 「脚本已加载、全部子视图监听器已注册」的唯一真源（webview 侧发出，host 侧仅此处）
      this._webviewReady = true;
      // configureModel 命令可能在视图未就绪时触发：待切选项卡缓存在此，就绪后补发，
      // 保证命令落点与用户意图一致（对齐 chatPanel replaySession 的 ready 时序修复）
      this.flushPendingTab();
      this.refreshAll();
      return;
    }
    // 作品页：一条通道四个动作，执行面与文件右键 / QuickPick / 命令面板共用
    if (msg.type === 'work_projection') {
      await this.works.handle(msg.action, msg.source);
      return;
    }
    // .zip 导入：三入口共用同一命令处理器（面板只做路由）
    if (msg.type === 'import_asset_zip') {
      void vscode.commands.executeCommand('memora.importAsset');
      return;
    }
    // ─── 角色子视图消息 ───
    if (msg.type === 'roles_set_active') {
      // 一个通道两种作用域：default = 用户级「新建会话默认角色」（不切换当前会话、不写任何 meta）
      if (msg.scope === 'default') await this.setDefaultRole(msg.name);
      else await this.activateRole(msg.name);
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
        const cue = l10n.t(
          'Continue handling the above task from the perspective of "{0}"',
          displayName,
        );
        this._chatProvider?.prefillInput(meta?.handoffPrompt?.trim() ? meta.handoffPrompt : cue);
      }
      return;
    }
    // 保存角色包组（会议名单）：校验 → 持久化 globalState → 广播热更所有已装配实例 → 重推角色视图
    if (msg.type === 'roles_team_save') {
      // 保存成功后的用户可见提示（含广播汇总）由本分支统一发，避免两条 notice 打架
      const agent = await this.ensureAgent();
      const result = await saveRolePackTeam(
        {
          globalState: this._globalState,
          rpm: agent?.rolePackManager ?? undefined,
          broadcast: this._broadcastTeams,
        },
        msg.leader,
        msg.members,
      );
      if (!result.ok) {
        this.post({ type: 'notice', level: 'error', message: result.reason });
        return;
      }
      // 有失败会话 = 部分会话未生效：提示升为 error，避免用户以为全量成功（不静默吞）
      const hasFailure = (result.broadcast?.failed.length ?? 0) > 0;
      this.post({
        type: 'notice',
        level: hasFailure ? 'error' : 'info',
        message: describeTeamBroadcast('save', result.broadcast),
      });
      await this.loadRoles();
      // 热更新通知：chatPanel 重推 chat_role_pack 让 chatView 刷新 team 图标（组长队伍变更后图标显隐）
      this._chatProvider?.refreshActiveRolePackForTeam();
      return;
    }
    // 删除角色包组（会议名单）：持久化移除 + 广播热更 → 通知 chatPanel
    if (msg.type === 'roles_team_delete') {
      const agent = await this.ensureAgent();
      const result = await deleteRolePackTeam(
        {
          globalState: this._globalState,
          rpm: agent?.rolePackManager ?? undefined,
          broadcast: this._broadcastTeams,
        },
        msg.leader,
      );
      // 删除只在广播失败时提示（成功删除无需新增确认；失败必须可见，不许静默吞）
      if (result && result.failed.length > 0) {
        this.post({
          type: 'notice',
          level: 'error',
          message: describeTeamBroadcast('delete', result),
        });
      }
      await this.loadRoles();
      // 热更新通知：同上，删除组长队伍后 team 图标应隐藏
      this._chatProvider?.refreshActiveRolePackForTeam();
      return;
    }
    if (msg.type === 'roles_open_dir') {
      this.openDirInOs(this._userRolePacksDir, l10n.t('user role packs'));
      return;
    }
    // 重扫项目与用户角色包目录（刷新按钮）：内核对账后 notice 结果 + 刷新下发
    if (msg.type === 'roles_refresh') {
      await refreshUserRolePacksFlow({
        agent: await this.ensureAgent(),
        userRolePacksDir: this._userRolePacksDir,
        post: (notice) => this.post(notice),
        reloadList: () => this.loadRoles(),
      });
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
      const confirmed = await confirmModal({
        // 服务商名走 {0} 插值（插值内容不参与翻译，键 = 英文整句）
        message: l10n.t('Delete provider "{0}"? This cannot be undone.', msg.name),
        confirmLabel: l10n.t('Delete'),
      });
      if (!confirmed) return;
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
      this.openDirInOs(this._userSkillsDir, l10n.t('user skills'));
      return;
    }
    if (msg.type === 'skills_refresh') {
      await refreshUserSkillsFlow({
        agent: await this.ensureAgent(),
        post: (notice) => this.post(notice),
        reloadList: () => this.loadSkills(),
        refreshChatSkills: () => this._chatProvider?.refreshSkillList(),
      });
      return;
    }
    // 项目级 → 用户级复制（拷贝非同步，同名覆盖先备份可回滚；与 import_asset_zip 同为单条通道）
    if (msg.type === 'asset_copy_to_user') {
      const deps = {
        ensureAgent: () => this.ensureAgent(),
        post: (notice: ExtensionToWebviewMessage) => this.post(notice),
        configDir: this._configDir,
        userSkillsDir: this._userSkillsDir,
        projectSkillsDir: this._projectSkillsDir,
        userRolePacksDir: this._userRolePacksDir,
        projectRolePacksDir: this._projectRolePacksDir,
        loadSkills: () => this.loadSkills(),
        loadRoles: () => this.loadRoles(),
        refreshChatSkills: () => this._chatProvider?.refreshSkillList(),
      };
      if (msg.assetKind === 'skill') await copyProjectSkillToUser(deps, msg.name);
      else await copyProjectRolePackToUser(deps, msg.name);
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

    // ─── 安全子视图消息（执行确认 + 路径白名单） ───
    // 写入确认开关已退役（E4 批 4：写文件一律直接落盘），本通道只剩执行确认语义
    if (msg.type === 'security_toggle') {
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
    // 会话归档模式：持久化用户级设置 + 热更新 agent.setArchiveMode（繁忙顺延）
    if (msg.type === 'archive_mode_set') {
      await this.setArchiveMode(msg.mode);
      return;
    }
    // ─── MCP 子视图消息（观察面 + 免确认点选 + 服务器增删改停启） ───
    // 全部写操作共用一条通道（`op` 判别），实现单点在 mcpServerOps（唯一写入路径）
    if (msg.type === 'mcp_write') {
      await applyMcpWrite(this.mcpOpsDeps(), msg);
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
    // 「在设置中调整」：设置页只做导航，配置读写真源仍是 VS Code 原生设置
    // （不在 webview 复制第二套输入框/开关，否则键名、默认值、scope 三处各存一份）。
    if (msg.type === 'open_setting') {
      // 第二参数 = 搜索词：VS Code 直接定位到该配置项
      void vscode.commands.executeCommand('workbench.action.openSettings', msg.key);
      return;
    }
    // 「恢复初始状态」：按钮 → 注入的处理器（extension 侧 modal + 清理 + reload），
    // 结果回推 webview 恢复按钮态。面板不自行实现清理逻辑（单一路径，与命令面板共用）。
    if (msg.type === 'reset_user_data') {
      const result = await this.runReset();
      this._panel?.webview.postMessage({
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

  /**
   * 取「面板当前显示会话」的 Agent（**不缓存实例**：复用/在途/登记全在 extension 登记表）
   *
   * 会话归属由 extension 的取用面解析（chat 面板 `_currentSessionId` 只读）⇒ 设置页的
   * 动作恒作用于**当前显示**的会话；角色包监听按 `_boundSessionId` 解绑——不持有旧实例引用。
   */
  private async ensureAgent(): Promise<Agent | undefined> {
    if (!this._getAgent) return undefined;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) {
      void vscode.window.showWarningMessage(l10n.t('Memora: open a workspace first'));
      return undefined;
    }
    let agent: Agent | undefined;
    try {
      agent = await this._getAgent(ws);
    } catch (err) {
      const message = toNoticeText(err);
      void vscode.window.showErrorMessage(l10n.t('Memora assembly failed: {0}', message));
      return undefined;
    }
    // 装配工厂可能以 undefined 收场（「Agent 未就绪」的一条出口）：此时不得去碰事件面
    if (!agent) return undefined;
    // 切会话：按旧 id 取回旧实例解绑（只存 id、不留 Agent 引用），再在当前实例上幂等重绑
    const sessionId = this._resolveSessionId?.();
    if (this._boundSessionId !== undefined && this._boundSessionId !== sessionId) {
      const previous = this._peekAgent?.(this._boundSessionId);
      previous?.off('rolePackSwitched', this.onRolePackSwitched);
      previous?.off('rolePackSwitchLocked', this.onRolePackSwitchLocked);
      previous?.off('roundSummaryGenerated', this.onRoundSettledForWorks);
    }
    this._boundSessionId = sessionId;
    agent.off('rolePackSwitched', this.onRolePackSwitched);
    agent.on('rolePackSwitched', this.onRolePackSwitched);
    agent.off('rolePackSwitchLocked', this.onRolePackSwitchLocked);
    agent.on('rolePackSwitchLocked', this.onRolePackSwitchLocked);
    // 一轮对话结束 ⇒ 报告已变，回推作品页徽标；中断轮靠 refreshAll 收敛网兜底（见文件头）。
    agent.off('roundSummaryGenerated', this.onRoundSettledForWorks);
    agent.on('roundSummaryGenerated', this.onRoundSettledForWorks);
    return agent;
  }

  /** 轮结算回推（报告刷新在内核 turn 入口；这里只负责把最新态送到 webview） */
  private readonly onRoundSettledForWorks = (): void => {
    void this.works.load();
  };

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
      message: l10n.t(
        'Role pack switching is locked: {0}. Try again in {1} seconds.',
        info.reason,
        info.lockedSeconds,
      ),
    });
  };

  /**
   * 草稿期角色选择（activateRole 的草稿分支）：校验链与文案外置在 rolePackSelectionActions
   *
   * @param name 角色包名
   * @returns 是否记录成功
   */
  private selectDraftRolePack(name: string): Promise<boolean> {
    return selectDraftRolePack(
      {
        peekRolePackManager: () => this._peekAgent?.(this._resolveSessionId?.())?.rolePackManager,
        hasDraftBridge: !!this._draftRolePackAccess,
        setDraftRolePackName: (value) => this._draftRolePackAccess?.setName(value),
        post: (message) => this.post(message),
        reloadRoles: () => this.loadRoles(),
      },
      name,
    );
  }

  /**
   * 设置 / 取消「新建会话默认角色包」：写用户级配置，不碰任何会话 meta
   *
   * 实现外置在 rolePackSelectionActions（校验链与文案单点）；本方法只注入面板能力。
   * 校验读面 = 角色包目录编目（与建会话同一份，冷启动无实例亦可校验）。
   *
   * @param name 角色包名；空串 = 取消默认（恢复内核兜底包）
   * @returns 是否写入成功
   */
  private setDefaultRole(name: string): Promise<boolean> {
    return setDefaultRolePack(
      {
        readRolePackCatalog: this._readRolePackCatalog,
        post: (message) => this.post(message),
        reloadRoles: () => this.loadRoles(),
      },
      name,
    );
  }

  /** 切换激活角色包（SSOT：roles_set_active 与 roles_handoff 共用），返回是否成功 */
  private async activateRole(name: string): Promise<boolean> {
    // 草稿期（2026-11-07 用户否掉「不可切换」初版）：只写草稿内存，落盘随建会话的 meta 一次完成。
    // 存在性判据取已登记实例的 `rolePackManager`（与真实会话同一条内核目录），**不装配任何会话**、
    // 不写 globalState；必须在 ensureAgent 之前——命令路径会把「当前会话」解析成上一个停留会话，
    // 放行就会把角色切到**错误的会话**上（静默改错目标）。
    if (this._isDraftSession?.()) return this.selectDraftRolePack(name);
    const agent = await this.ensureAgent();
    if (!agent) return false;
    // 走内核「单一切换入口」agent.switchRolePack：activate + emit rolePackSwitched + 刷新 loop 前缀。
    // 角色视图刷新由 rolePackSwitched 事件驱动（onRolePackSwitched → loadRoles），不再显式
    // loadRoles——单一事件通知所有消费者，消除并行推送路径（SSOT）。
    // 角色选择是**会话级**状态（方案 A，2026-11-06 定案）：切换只作用于当前会话的 agent，
    // 不再写 globalState——那会让下一个新建会话偷偷继承「上次全局选择」的默认值。
    // 新会话默认角色 = 用户级 `memora.defaultRolePack`（未设置则内核 §4.1 单链兜底包）；
    // 本路径只切当前会话，绝不把「切了什么」写成全局默认。
    const ok = agent.switchRolePack(name);
    // 落盘（方案 A）：**只在切换成功时写**——失败 / 被限流锁定不写，避免把「没切成」记成用户选择。
    // 会话 id 与下方监听解绑共用 `_resolveSessionId` 同一解析面（不另算「当前会话」）。
    if (ok) {
      const sessionId = this._resolveSessionId?.();
      if (sessionId) {
        this._sessionStore?.updateSessionMeta(sessionId, { activeRolePackName: name });
      }
    }
    if (!ok) {
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
              ? l10n.t('Role pack switching is rate-limited. Please try again later.')
              : l10n.t('Role pack switching is rate-limited. Try again in {0} seconds.', remain),
        });
      } else {
        this.post({
          type: 'notice',
          level: 'error',
          message: l10n.t('Role pack not found: {0}', name),
        });
      }
    }
    return ok;
  }

  /** 来源层单点判定：与技能聚合共用 `isPathWithin`，禁第二份前缀副本（裸 startsWith 会把 `role-packs-x` 误判进 `role-packs`） */
  private rolePackSource(filePath: string | undefined): 'builtin' | 'user' | 'project' {
    if (isPathWithin(this._projectRolePacksDir, filePath)) return 'project';
    return isPathWithin(this._userRolePacksDir, filePath) ? 'user' : 'builtin';
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
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Agent is not ready; cannot read the role configuration'),
      });
      return;
    }
    const pack = rpm.get(name);
    if (!pack?.filePath) {
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Role pack not found: {0}', name),
      });
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
        message: l10n.t('Failed to read the role pack configuration: {0}', toNoticeText(err)),
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
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Agent is not ready; cannot save the role configuration'),
      });
      return;
    }
    const pack = rpm.get(name);
    if (!pack?.filePath) {
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Role pack not found: {0}', name),
      });
      return;
    }
    const source = this.rolePackSource(pack.filePath);
    // 内置包真拒绝（判据与列表来源判定同源：rolePackSource 单点）；
    // 用户级与项目级都可写（项目级是工作区内的自有文件，随仓库分发）。
    if (source === 'builtin') {
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t(
          '"{0}" is a built-in role pack and cannot be edited; copy it to the user role pack directory and edit that copy instead',
          name,
        ),
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
          message: l10n.t('Save failed: {0}', firstError.message),
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
      this.post({
        type: 'notice',
        level: 'info',
        message: l10n.t('The strategy configuration for "{0}" has been saved', name),
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Save failed: {0}', toNoticeText(err)),
      });
    }
  }

  private async loadRoles(): Promise<void> {
    // 草稿期：**不得** ensureAgent（命令路径会把「当前会话」解析成上一个停留会话，白白装配它）。
    // 目录只读已登记实例；当前角色 = 草稿选择 ?? 内核兜底契约包（**不是** packs[0]，那是第二份回落真源）。
    if (this._isDraftSession?.()) {
      this.postRoleList(
        this._peekAgent?.(this._resolveSessionId?.())?.rolePackManager,
        this._draftRolePackAccess?.getName() ?? BUILTIN_FALLBACK_PACK,
      );
      return;
    }
    const agent = await this.ensureAgent();
    this.postRoleList(agent?.rolePackManager);
  }

  /**
   * `roles_loaded` 的单点发送（真实会话 / 草稿共用）
   *
   * 投影实现外置在 `helpers/rolePackListView.ts`：本文件贴 max-lines 只降不升基线，
   * 纯投影（无面板状态、无写盘）不该占本文件行数。
   *
   * @param rpm 角色包管理器（undefined = 目录不可得：如实空列表，不伪造条目）
   * @param draftActiveName 草稿期「当前角色」显式值（未选时 = 内核兜底包；真实会话传 undefined）
   */
  private postRoleList(rpm: Agent['rolePackManager'] | undefined, draftActiveName?: string): void {
    postRolePackList(
      {
        post: (msg) => this.post(msg),
        globalState: this._globalState,
        rolePackSource: (filePath) => this.rolePackSource(filePath),
      },
      rpm,
      draftActiveName,
      readDefaultRolePackSetting(),
    );
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
   * 持久化后台 Provider 选择后热更新 agent.setBackgroundProvider：后台任务（摘要 / 归档 /
   * 润色）后续走独立轻量模型；name 为空 → setBackgroundProvider(null) 回退与实时对话相同。
   * 成功后刷新配置面板（后台模型下拉回显）。
   */
  private async setBackgroundProvider(name: string): Promise<void> {
    // 先落盘再热切换：写失败即回执并中止（避免「运行时切了、下次装配又变回去」）
    const written = await this.store.setBackground(name);
    if (!written.ok) {
      this.post({
        type: 'notice',
        level: 'error',
        message: written.message ?? '切换后台模型失败（原因未记录）',
      });
      return;
    }
    try {
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

  /**
   * 记忆写操作的宿主能力视图（实现外置到 `settingsMemoryOps.ts`）
   *
   * 只传「取句柄 / 回推 / 刷新」三类能力，不把整个面板交出去——写操作不需要面板状态，
   * 反向依赖会让外置失去意义（也挡住「外置模块自己再写一套查询」的旁路）。
   */
  private memoryOps(): MemoryOpsContext {
    return {
      ensureMemory: () => this.ensureMemory(),
      ensureAgent: () => this.ensureAgent(),
      post: (msg) => this.post(msg),
      loadMemory: () => this.loadMemory(),
      loadRecycle: () => this.loadRecycle(),
      loadGovernance: () => this.loadGovernance(),
    };
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
    const memories: MemoryItemDto[] = memory
      .list(MEMORY_LIST_LIMIT)
      .map((m) => toItemDto(m, memory));
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
      void vscode.window.showErrorMessage(l10n.t('Memora memory search failed: {0}', message));
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
    const items: MemoryItemDto[] = all
      .slice((page - 1) * pageSize, page * pageSize)
      .map((m) => toItemDto(m, memory));
    this.post({ type: 'memory_page_result', page, items });
  }

  // ─── 记忆单条删除 / 恢复 / 回收站 ───

  /**
   * 删除单条记忆（memory_delete）—— 实现外置在 `settingsMemoryOps.ts`（面板只留委派）
   */
  private async deleteMemory(id: string): Promise<void> {
    await deleteMemoryOp(this.memoryOps(), id);
  }

  /**
   * 恢复单条记忆（memory_restore）—— 实现外置在 `settingsMemoryOps.ts`
   */
  private async restoreMemory(id: string): Promise<void> {
    await restoreMemoryOp(this.memoryOps(), id);
  }

  /**
   * 永久删除回收站单条记忆（memory_purge）—— 实现外置在 `settingsMemoryOps.ts`
   */
  private async purgeMemory(id: string): Promise<void> {
    await purgeMemoryOp(this.memoryOps(), id);
  }

  /**
   * 清空回收站（memory_recycle_clear）—— 实现外置在 `settingsMemoryOps.ts`
   */
  private async clearRecycle(): Promise<void> {
    await clearRecycleOp(this.memoryOps());
  }

  /**
   * 编辑单条记忆内容（memory_edit，内联编辑）—— 实现外置在 `settingsMemoryOps.ts`
   */
  private async editMemory(id: string, content: string): Promise<void> {
    await editMemoryOp(this.memoryOps(), id, content);
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
    const items = memory.listDeleted().map((m) => toItemDto(m, memory));
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
    const superseded = memory
      .list(stats.total)
      .filter((m) => hasActiveSuperseder(m, memory)).length;
    const governance: GovernanceStatsDto = {
      active: stats.total,
      deleted,
      bySource: stats.bySource,
      superseded,
    };
    this.post({ type: 'governance_loaded', stats: governance });
  }

  /**
   * 清理过期软删除记忆（governance_cleanup）—— 实现外置在 `settingsMemoryOps.ts`
   */
  private async runCleanup(): Promise<void> {
    await runCleanupOp(this.memoryOps());
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
      projectSkillsDir: this._projectSkillsDir,
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
   * 重推技能清单（配置变更 / 手动重载后调用）
   *
   * 复用 `loadSkills()` 单一实现：health 校验与「已禁用」标注一并重算——分开写必分叉。
   */
  public async refreshSkillList(): Promise<void> {
    await this.loadSkills();
  }

  /** 重推角色包清单（写盘后由命令调用；重扫归命令，本方法只做投影刷新） */
  public async refreshRolePackList(): Promise<void> {
    await this.loadRoles();
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
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Memora Agent is not ready; cannot toggle the skill disabled state'),
      });
      return;
    }
    // 增量增/删（base 为只读快照，不改数组内容直接得出 next）
    const base = agent.skills.disabledSkillNames;
    const next = disabled
      ? base.includes(name)
        ? base
        : [...base, name]
      : base.filter((n) => n !== name);
    // 唯一动作：整组写回用户级配置；生效与 UI 刷新交给既有配置监听接管。
    // 经统一写入通道（带 5s 上限）：只读/受管设置上 update 可能永不 settle，否则下方提示永不执行。
    const written = await writeSetting('disabledSkills', next);
    if (!written.ok) {
      this.post({
        type: 'notice',
        level: 'error',
        message: writeErrorText(l10n.t('Skill disabled setting'), written),
      });
      return;
    }
    this.post({
      type: 'notice',
      level: 'info',
      // 两态各自整句（禁把 '禁用'/'启用' 做成碎片键：静态采集只认字面量）
      message: disabled
        ? l10n.t('Disabled skill "{0}"', name)
        : l10n.t('Enabled skill "{0}"', name),
    });
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
      void vscode.window.showWarningMessage(l10n.t('{0} directory is not configured', label));
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

  // ─── 安全子视图方法（执行确认） ───

  /**
   * 切换脚本/代码/命令执行确认开关（security_toggle 消息处理）
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
      // 3. 推送最新状态给 webview（写入确认已退役，只剩执行确认这一项）
      this.post({ type: 'security_status', confirmScripts: enabled });
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

  // 零面板状态依赖的「读配置 → 推消息」动作统一外置到 helpers/settingsStatusPush.ts

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
    // 1. 持久化到用户级设置（机器级信任；projectPath 基准根恒在，不在此数组内）。
    //    经统一写入通道（带 5s 上限）：写不进去就回执并中止，不热更一份没落盘的偏好。
    const written = await writeSetting('allowedPaths', paths);
    if (!written.ok) {
      this.post({
        type: 'notice',
        level: 'error',
        message: writeErrorText('允许路径设置', written),
      });
      return;
    }
    try {
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
    const customs = readCustomSearchEngines();
    const valid =
      (PRESET_SEARCH_ENGINES as readonly string[]).includes(engine) ||
      customs.some((e) => e.name === engine);
    if (!valid) {
      this.post({ type: 'notice', level: 'error', message: `无效的搜索引擎：${engine}` });
      return;
    }
    // 经统一写入通道（带 5s 上限）：失败（含不 settle 超时）即回执，不回显未落盘的选择
    const written = await writeSetting('searchEngine', engine);
    if (!written.ok) {
      this.post({
        type: 'notice',
        level: 'error',
        message: writeErrorText('搜索引擎设置', written),
      });
      return;
    }
    this.post({ type: 'search_engine_status', engine });
    this.post({
      type: 'notice',
      level: 'info',
      message: `已切换网页搜索引擎：${engine}（重载窗口后生效）`,
    });
  }

  // ─── 会话归档模式（archive_mode_set 消息处理） ───

  /**
   * 设置会话归档模式（archive_mode_set 消息处理）
   *
   * 语义：full=自动归档（切走/分叉/暂停超时时自动生成会话摘要元数据）；manual=仅手动。
   * 轮次摘要不受影响（无模式开关，总是生成）。
   *
   * 流程（对齐 security_toggle / setAllowedPaths 的「持久化 + 热更新 + 回推」三段式）：
   *   ① 枚举校验（webview 下拉本只含合法值；直接发消息的越界值照拒——不依赖前端收敛）；
   *      拒收后**回推一次持久值**——下拉可能已被改到非法值，不回推就停在假值上（UI 谎报）；
   *   ② 持久化用户级设置 memora.archiveMode（ConfigurationTarget.Global——用户偏好随人）；
   *   ③ 热更新 agent.setArchiveMode()：内核判 busy（chatLock.isBusy）后**暂存并抛错**
   *      （ADR-041 方案 A2，对齐 reloadConfig 的 pendingConfigReload 契约）⇒ 偏好落盘
   *      即排队，流退出时补执行到账；提示如实说明顺延，不谎报「已生效」。
   *      ⚠ agent 未就绪（无装配工厂 / 无工作区 / 装配失败）时运行时**零动作**，且没有
   *      「对话结束后补应用」的载体 ⇒ 走 error 级降级提示，**不得**推成功提示：
   *      applied 初值恒真的旧实现把 `if (agent)` 的空分支也算成功，该路径会报
   *      「已切换归档模式」而实际上什么都没切（假成功，2026-10-16 审查发现）。
   */
  private async setArchiveMode(mode: ArchiveMode): Promise<void> {
    if (mode !== 'full' && mode !== 'manual') {
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Invalid archive mode: {0}', String(mode)),
      });
      // 拒收即复位：下拉此时已停在（被篡改的）非法值上，回推持久值让它回到偏好。
      // 口径与切换路径一致——archive_mode_status 恒推持久值，webview 据此回写 select。
      pushArchiveModePreference((m) => this.post(m));
      return;
    }
    // 先落盘再热更新：用户偏好是持久真相，运行时切换是 hot-path 优化。
    // 落盘失败 ⇒ 偏好仍是旧值：回执 + 回推持久值复位下拉，且不做热更新（假成功回归锚点）。
    const written = await writeSetting('archiveMode', mode);
    if (!written.ok) {
      this.post({
        type: 'notice',
        level: 'error',
        message: writeErrorText(l10n.t('Archive mode settings'), written),
      });
      pushArchiveModePreference((m) => this.post(m));
      return;
    }
    // ⚠ 初值必须 false：「已应用」只由「内核真的切了」这一个事实决定。旧实现初值 true
    // 且把 `if (agent)` 的空分支也算成功 ⇒ agent 未就绪时报「已切换」而运行时零动作。
    let applied = false;
    try {
      const agent = await this.ensureAgent();
      if (agent) {
        agent.setArchiveMode(mode); // 繁忙时暂存+抛错（内核 A2：流退出时补执行）
        applied = true;
      } else {
        // 降级：偏好已落盘（下次装配读取即生效），但运行时此刻没切、也没有补应用载体
        // ⇒ 如实降级为 error 级，不谎报「已切换归档模式」。
        this.post({
          type: 'notice',
          level: 'error',
          message: l10n.t(
            'Preference saved: the Agent is not ready, so the runtime mode was not switched. It takes effect after the next assembly (or after reloading the window).',
          ),
        });
      }
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'info',
        message: l10n.t(
          'Preference saved: {0} — the runtime mode takes effect after the current conversation ends',
          toNoticeText(err),
        ),
      });
    }
    // 回推状态（持久值口径，与 search_engine_status 一致）：下拉反映偏好，
    // 热更新失败的顺延语义由上方 notice 说明，不伪造「已生效」。
    this.post({ type: 'archive_mode_status', mode });
    if (applied) {
      this.post({
        type: 'notice',
        level: 'info',
        message:
          mode === 'full'
            ? l10n.t('Archive mode switched: automatic')
            : l10n.t('Archive mode switched: manual only'),
      });
    }
  }

  // 归档模式偏好推送见 helpers/settingsStatusPush.ts（持久值，不是内核运行时真相）

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
    this.post({ type: 'custom_search_engines_status', engines: readCustomSearchEngines() });
  }

  private async setCustomSearchEngines(engines: CustomSearchEngineConfig[]): Promise<void> {
    const problem = validateCustomEngines(engines);
    if (problem) {
      this.rejectCustomEngines(`自定义搜索引擎${problem}，未保存`);
      return;
    }
    // 保存前实测验证（host 权威门禁）：仅对相对已持久化清单发生变化的引擎探针（未变引擎跳过，避免重复网络探测）；
    // 任一变化引擎验证未通过（网络失败 / 接口无结构化结果）→ 整体拒绝保存，webview 即便跳过「测试」也无法绕过。
    const persisted = readCustomSearchEngines();
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
    // 经统一写入通道（带 5s 上限）：写不进去即回执 + 回推已持久化清单（复选回滚单点 = rejectCustomEngines）
    const written = await writeSetting('customSearchEngines', engines);
    if (!written.ok) {
      this.rejectCustomEngines(writeErrorText('自定义搜索引擎设置', written));
      return;
    }
    this.post({ type: 'custom_search_engines_status', engines });
    this.post({
      type: 'notice',
      level: 'info',
      message: `已保存 ${engines.length} 个自定义搜索引擎（重载窗口后生效）`,
    });
  }

  // 自定义搜索引擎清单的「读配置 → 推送」已外置到 helpers/settingsStatusPush.ts（ready / 拒收复位共用）

  /**
   * 推送 MCP 服务器状态（MCP 选项卡的观察面）
   *
   * 两个来源各管一段（`getMcpServerStatus(configured)` 的契约）：
   *   - **有哪些** ⇒ 这里传 `readMcpServers()`（配置原值，唯一读取点）。不传会漏掉「配了
   *     但还没装配」的台：设置面板先于对话面板打开时 Agent 未装配，列表会谎报空态。
   *   - **怎么样** ⇒ runtime 内的运行态 ∪ 失败表（`pending` = 装配前的诚实态，不是失败）。
   * 第三个字段 `omitted` **必须一起发**：列表只装得下「有寻址键」的条目，缺 name / 重名的
   * 两类整条不出现；不带计数，面板就会把「配置 2 条、显示 1 条」画成「配置 1 条」。
   * `ack` 只有 `mcp_write{op:'upsert'}` 的收尾回推才带（webview 靠 `reqId` 认领，写失败时
   * 复开表单还输入）；ready / 热更 / 运行态变化触发的推送不带。
   * 公开方法：配置热更生效后由 extension.ts 回推；运行态变化（启停失败 / 断线 / 重启）
   * 由 runtime 的状态监听器回调到这里（监听器在本文件构造器里注册，理由见该处注释）。
   */
  public pushMcpStatus(ack?: McpWriteAckDto): void {
    const configured = readMcpServers();
    const { servers, omitted } = getMcpServerStatus(configured);
    this.post({ type: 'mcp_status', servers, omitted, ...(ack ? { ack } : {}) });
  }

  /**
   * 构造 MCP 写操作依赖（注入给 mcpServerOps —— 写操作实现不持有 panel 实例）
   *
   * 三件事都是回调注入：回推 / 回执 / 重启/接入。`restart` 只走**已装配**的 agent
   * （不懒装配：重启是「恢复现有运行时」，不该顺手把 Agent 拉起来）；`connect` 正相反，
   * 它就是「待接入」那张卡的唯一出路——走 `ensureAgent()`（与对话面板共用同一
   * `AgentRegistry` 按会话取用面，不会出现第二个 MCP 运行时）。
   */
  private mcpOpsDeps(): McpOpsDeps {
    return {
      // ack 原样透传：写操作的收尾回执只在「带着 ack 的那一次」回推里有（视图按 reqId 认领）
      pushStatus: (ack) => this.pushMcpStatus(ack),
      notice: (level, message) => this.post({ type: 'notice', level, message }),
      connect: async () => {
        // 「接入」= 按当前配置让运行态追平（pending 的判据 = 「该名没进 applied」，
        // 本动作就是让它进 applied）。**不能**拿「Agent 是否装配过」当完成条件：
        // 装配早于配置变更 / 热更被静默跳过时两者会同时成立，按钮就成了假动作。
        // 未装配才懒装配（与 restart「只走已装配」相对，语义见 mcpServerOps 的 deps 注释）。
        // 装配判据的检查只在 ensureAgent 内部一处（这里不复制一份「是否已登记」）。
        const agent = await this.ensureAgent();
        // ensureAgent 的失败已在窗口层提示过（无工作区 → warning / 装配异常 → error），
        // 这里只补一条指向它的回执：让用户知道「点了接入、没成功」而不是按钮失灵。
        if (!agent) return { ok: false, error: '装配未完成（原因见窗口提示）' };
        const result = await reconcileMcpConfig(agent, readMcpServers(), {
          allowlist: readMcpToolAllowlist(),
        });
        // 差分内部已 notifyStatus；这里兜底再推一次，覆盖「状态无变化时监听器不触发」的路径
        this.pushMcpStatus();
        return result;
      },
      restart: async (name) => {
        // 只探视已登记实例：未装配时「按当前配置启动」是下次装配的天然行为，不为重启而装配
        const agent = this._peekAgent?.();
        if (!agent) {
          return { ok: false, error: 'Agent 未装配（下次装配会按当前配置启动，无需重启）' };
        }
        // 日志/版本不在此传：runtime 沿用最近一次应用配置时的注入值（单点，不为此加面板字段）
        return restartMcpServer(agent, name);
      },
    };
  }

  /**
   * 向 webview 发送消息（**尽力投递，不判断可达性**）
   *
   * 静默失败的两类：① 面板没开（`_panel` 为空）；② html context 未就绪 / 已隐藏——官方注释
   * 在此自相矛盾（见文件头），故一律按不可靠处理。
   *
   * 调用方纪律：只求「有新数据就送一份」的推送直接调本方法即可（丢了下一轮还会送）；
   * **凡「投出后要清状态」的调用方必须先过 {@link isDeliverable}**（如 {@link switchTab}），
   * 否则丢的不是一条消息，而是一次导航。历史消息不补发（补发要造第二套队列语义），
   * 补的是**当前态**。
   */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._panel?.webview.postMessage(msg);
  }

  /**
   * 全量推一次各子视图数据（**单点**）
   *
   * 两个触发面共用，不各写一份 load 清单（否则加一个子视图要改两处、漏一处即某个入口的页面停在「加载中」）：
   *   ① webview `ready` 握手——上下文刚建立，监听器已全部注册，首帧推送必然可达。
   *      即使 webview 主动拉取（cfg_load / memory_load）因时序丢失，也不会让子视图停在「加载中…」
   *      （角色 / 记忆依赖 Agent 装配，拉取可能早于装配完成）。
   *   ② panel 由隐藏转可见（`onDidChangeViewState`）——**收敛网**：隐藏期宿主侧可能发生了
   *      没有推送路径的状态变更（别处改归档模式 / 技能启停 / 装配完成），回来全量对齐一次。
   */
  private refreshAll(): void {
    void this.loadRoles();
    void this.loadConfig();
    void this.loadMemory();
    void this.loadSkills();
    // 安全子视图：写入二次确认开关状态 + 白名单额外路径 + 网页搜索引擎
    pushSecurityStatus((m) => this.post(m), this._globalState);
    this.loadAllowedPathsStatus();
    pushCustomSearchEnginesStatus((m) => this.post(m));
    pushSearchEngineStatus((m) => this.post(m));
    // 记忆子视图：会话归档模式当前值（归档模式下拉的回显真源）
    pushArchiveModePreference((m) => this.post(m));
    // MCP 子视图：服务器/工具运行态（无独立拉取消息，统一由本函数推送——
    // 未装配时是合法空态，装配完成后由 extension 的热更回推覆盖）
    this.pushMcpStatus();
    void this.works.load();
  }

  /**
   * 切换子选项卡（由 host 命令触发，如 configureModel 命令切换到「大模型」）
   *
   * 向 webview 推送 settings_switch_tab 指令，webview 切换选项卡高亮 + 显示对应子视图；
   * 面板未开 / 未 ready / 不可见时只记 `_pendingTab`，由 {@link flushPendingTab} 在下一个
   * 可投时机补发（**判据是「可投递」，不是「panel 存在」**——后者会让指令投出即丢）。
   *
   * @param tab 目标选项卡——**任意** tab 均可。此前形参是手写联合且漏了 `'security'`
   *   （编译期就把安全页挡在路由之外），现统一取 {@link SettingsTab}：加 tab 无需回来补签名。
   */
  public switchTab(tab: SettingsTab): void {
    this._pendingTab = tab; // 唯一缓冲：不具备投递条件时留在此，等下一个可投时机补发
    this.flushPendingTab();
  }

  /**
   * 补发待切选项卡（**唯一投递点 + 唯一清空点**）
   *
   * 三个时机共用：`switchTab`（此刻可投则立即发）、webview `ready`、panel 由隐藏转可见。
   * 只在此处清 `_pendingTab` ⇒ 「清空」恒等于「这条导航指令已经投出」，不会有第二条路径
   * 先清后丢（旧实现 `if (this._panel) { post; pending = undefined }` 正是这个漏洞：
   * open→ready 之间与隐藏期投出即清，用户落在默认页却查无日志）。
   */
  private flushPendingTab(): void {
    if (!this._pendingTab || !this.isDeliverable()) return;
    this.post({ type: 'settings_switch_tab', tab: this._pendingTab });
    this._pendingTab = undefined;
  }

  /**
   * 此刻投出的消息是否会被 webview 处理
   *
   * 三个条件都不可省：
   *   - `_panel` 存在：tab 都没开，无处可投；
   *   - `_webviewReady`：`_panel` 有值 ≠ 脚本已注册监听器。``postMessage`` 契约原文
   *     「A response of true does not mean that the message was actually received … no message
   *     listeners may have been hooked up」⇒ open→ready 之间投出即丢；
   *   - `visible`：隐藏态语义官方两说（见文件头）⇒ 按不可靠处理，宁可在转可见时补发一次。
   */
  private isDeliverable(): boolean {
    return this._panel !== undefined && this._webviewReady && this._panel.visible;
  }
}

/** 内核 Memory → 记忆条目 DTO（deletedAt 仅回收站条目携带；round-summary 顶层字段透传） */
function toItemDto(
  m: {
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
  },
  lookup: MemoryInspector,
): MemoryItemDto {
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
    // 悬空取代指针（替代物已移除/软删）不呈现为「已被取代」——经内核单一判据 hasActiveSuperseder
    // 判定，与内核召回口径一致（见 @zooique/memora supersedeResolve）。
    supersededBy: hasActiveSuperseder(m, lookup) ? m.supersededBy : undefined,
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
