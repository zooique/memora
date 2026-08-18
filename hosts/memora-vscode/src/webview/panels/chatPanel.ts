/**
 * 对话面板 — 侧边栏 Webview 视图提供者（u1 UX 改进）
 *
 * 职责：
 *   - 渲染对话消息区（用户 / AI）+ 输入框 + 主动提问框；
 *   - 将用户输入 postMessage 到 extension host，调 Agent.chat() 流式返回并渲染；
 *   - 收到 extension host 的 questionPending 事件渲染提问框，回答后 resumeExecution 续跑；
 *   - 会话持久化：打开面板时从 sessionStore 恢复历史，发消息时写入。
 *
 * 设计（薄壳 + 复用内核，单一真理源）：
 *   - 文档属「当前任务上下文」注入 chat 输入，不进入记忆召回；
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM 操作；
 *   - 持久化复用内核 sessionStore 机制（date-session 组织消息）；
 *   - 面板为通用对话宿主，功能定位由内置角色包（role-packs/doc-review）承载，
 *     角色名在 AI 消息头部标签 + 空状态标题展示（角色切换已独立到「角色」视图，2026-08-17）。
 */
import * as vscode from 'vscode';
import {
  defaultSessionTitle,
  formatDateKey,
  type Agent,
  type AgentChunk,
  type ISessionStore,
  type SessionMeta,
} from '@zooique/memora';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { createProvider } from '../../extension/host/llmConfig.js';
import { vscodeTracer } from '../../extension/host/tracer.js';
import { buildDropdownHtml, dropdownStyles } from '../components/dropdown.js';
import { chatStyles } from '../styles/chatStyles.js';
import { toolCardStyles } from '../styles/toolCard.js';
import { stripDocContextPrefix } from '../helpers/docContext.js';
import { ACTIVE_ROLE_PACK_KEY } from '../../shared/constants.js';

/** 历史回放单次最大条数：跨天合并视图聚焦近期对话，
 *  防止长期使用后消息累积导致每次打开/切换都全量回放 + 逐条建 DOM（对抗评估 P1-7） */
const MAX_HISTORY_MESSAGES = 200;

/** 文档上下文注入上限（字符，约 3~4k token，防大文档爆上下文） */
const MAX_DOC_CONTEXT_CHARS = 12000;

/** Agent Loop 自动续跑上限（默认 3 轮，防止死循环）——文件级常量，ChatPanel 内部使用 */
const MAX_LOOP_COUNT = 3;

/**
 * 从活动编辑器快照「当前文档上下文」（2026-08-17 A 层：实时跟随活动编辑器）
 *
 * 返回内容含「文件名」首行 + 文档全文（超上限截断）。宿主在 handleSend 将其作为
 * 「当前任务上下文」注入对话，让 Agent 能看到用户当前打开的文档，无需手动粘贴。
 *
 * @param editor 当前活动编辑器（无则返回 undefined → 不注入，退化为普通对话）
 * @returns 注入文本（文件名首行 + 截断全文），或 undefined
 */
function snapshotDocContext(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor) return undefined;
  const doc = editor.document;
  const name = doc.fileName.split(/[\\/]/).pop() || doc.fileName;
  const content = doc.getText();
  const truncated =
    content.length > MAX_DOC_CONTEXT_CHARS
      ? `${content.slice(0, MAX_DOC_CONTEXT_CHARS)}\n\n…[内容过长已截断]`
      : content;
  return `文件名：${name}\n${truncated}`;
}

/** 宿主会话存储类型：内核 ISessionStore + 宿主扩展能力（删除会话记录 + 会话标题元数据）。
 *  用交集类型收窄，替代 handleClear 中的 as unknown as 双重断言（对抗评估 P2-5）。
 *  listSessionMetas/getSessionMeta 为 ADR-024 会话标题层的宿主实现（会话列表导航依赖）。
 *  deleteSession 为 2026-08-17 会话管理重构（历史浮层删除会话记录，替代原 clearSession）。 */
type HostSessionStore = ISessionStore & {
  deleteSession: (sessionId: string) => void;
  truncateFrom: (date: string, session: string, fromTs: string) => boolean;
  listSessionMetas: () => SessionMeta[];
  getSessionMeta: (sessionId: string) => SessionMeta | undefined;
};

/** 侧边栏视图提供者 */
export class MemoraChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.chat';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** 角色 handoff 预填缓冲：对话视图未就绪时暂存，ready 后补发（消除时序竞态） */
  private _pendingPrefill?: string;
  /** 当前装配的 Agent（由 extension 装配后注入） */
  private _agent: Agent | undefined;
  /** 当前打磨文档上下文（2026-08-17 A 层：实时跟随活动编辑器，非一次性快照） */
  private _docContext: string | undefined;
  /** 大模型配置存储（用于底部模型下拉框 + 切换） */
  private readonly _providerStore: ProviderStore;
  /** Agent 懒装配工厂（由 extension 注入，打开面板即装配，不依赖先执行 open 命令） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 是否已尝试装配（避免面板每次展开都重复装配） */
  private _agentResolving = false;
  /** 当前激活角色包（对话面板承载的定位角色；装配时由 extension 注入，切换时持久化） */
  private _activeRolePack: string | undefined;
  /**
   * vscode 全局状态（2026-08-15 角色包状态持久化，2026-08-17 升为用户级）
   *
   * 由 extension 注入（setGlobalState）。角色包切换成功后写入，重启后恢复用户选择。
   * 未注入时静默跳过（降级为不持久化，保持向后兼容）。
   */
  private _globalState: vscode.Memento | undefined;
  /**
   * 当前活跃会话标识（YYYY-MM-DD-sessionName，ADR-024 会话标题层）
   *
   * 宿主从「按天 main 归档」升级为「手动创建会话」后，当前会话不再固定为
   * 当天 main，而是用户在会话列表中选择/新建的会话。写入内核与回放展示均
   * 以本会话为准（单一真理源），不再有跨天合并视图。
   */
  private _currentSessionId: string;
  /** 是否正在流式生成中（由 consumeFlow 维护）：生成中禁止切换历史，
   *  避免重放清空消息区后，进行中的 chunk 污染重放视图（对抗评估 P1-3） */
  private _streaming = false;
  /**
   * 当前进行中流的 AbortController（mvp-scope 打断能力）
   *
   * 停止按钮 / 生成中插话共用：abort() 中断 chat()/resumeExecution() 流，
   * 内核在下一 await 点退出并 yield aborted chunk。无进行中流时为 undefined
   * （stop 可安全 no-op）。
   */
  private _abortController: AbortController | undefined;
  /** 当前进行中流的 promise：生成中插话需 await 旧流彻底结束再发新流，
   *  避免 chatLock 未释放导致「发起新对话」busy 冲突 */
  private _currentFlow: Promise<void> | undefined;
  /**
   * Agent Loop 自动续跑计数（Phase 4 E1 Loop 增强）
   *
   * handoff{decision:'loop'} 自动续跑时累加，达到 MAX_LOOP_COUNT 后停止自动续跑，
   * 提示用户手动介入。每轮新对话 reset 为 0。
   */
  private _loopCount = 0;

  /**
   * @param extensionUri 插件扩展根 URI（用于 webview 本地资源加载 localResourceRoots）
   * @param sessionStore 会话存储（用于持久化/恢复对话历史）
   * @param providerStore 大模型配置存储（用于底部模型下拉框）
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStore: HostSessionStore,
    providerStore: ProviderStore,
  ) {
    this._providerStore = providerStore;
    // 初始会话：最近活跃会话（有历史时），否则当天 main 空会话（ADR-024）
    this._currentSessionId =
      this.sessionStore.listSessionMetas()[0]?.sessionId ??
      `${formatDateKey(new Date())}-main`;
    // 跟随当前活动编辑器：实时注入「当前打开文档」为对话上下文（2026-08-17 A 层）
    // 原 docContext 仅在 memora.open 命令路径注入一次快照，点活动栏图标打开面板完全
    // 不注入 → Agent 看不到当前文档（bug 根因）。此处持续跟随 activeTextEditor，
    // 任何打开方式（点图标/命令/首次就绪）都生效，切换文档自动更新。
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      this._docContext = snapshotDocContext(editor);
    });
    this._docContext = snapshotDocContext(vscode.window.activeTextEditor);
  }

  /** 注入 Agent 懒装配工厂（由 extension.ts 提供 getOrCreateAgent） */
  public setAgentFactory(getAgent: (projectPath: string) => Promise<Agent>): void {
    this._getAgent = getAgent;
  }

  /**
   * 注入 vscode 全局状态（2026-08-15 角色包状态持久化，2026-08-17 升为用户级）
   *
   * 由 extension.ts 注入 context.globalState，供角色包切换时持久化激活态。
   * 用户级而非工作区级：角色选择是用户偏好，跨项目共享（存储层级收敛）。
   *
   * @param globalState vscode 全局状态 Memento
   */
  public setGlobalState(globalState: vscode.Memento): void {
    this._globalState = globalState;
  }

  /** 由 extension 在装配 Agent 后注入（open 命令路径），同时绑定会话级可观测事件 */
  public setAgent(agent: Agent): void {
    this._agent = agent;
    // 与 ensureAgent 懒装配路径保持一致：注入即绑定，确保事件通知两条路径都生效
    // （bindAgentNoticeEvents 内部先 off 再 on，幂等，折叠展开重复注入不重复注册）
    this.bindAgentNoticeEvents();
    // 装配注入后补推角色信息（时序竞态修复，2026-08-15）：
    // webview ready 时 agent 可能尚未装配，replaySession 的 chat_role_pack / pushRolePacks
    // 会因 _agent 为空而跳过推送 → 输入区角色选择器永久缺失。此处装配完成即补推一次，
    // 面板未就绪时 post 静默忽略（_view 为空），由 replaySession 兜底再推。
    this.refreshRoleInfoAfterAssemble();
  }

  /**
   * 角色包内部名 → UI 展示名（SSOT，2026-08-15 演进）
   *
   * 从内核 RolePackManager.listMeta() 反查 manifest.displayName（与工具名中文化
   * 同一体验原则）。displayName 缺省时回退内部名（name）——显示名单一来源 =
   * `displayName ?? name`，替代原 UI 层硬编码 `rolePackDisplayName` 映射。
   *
   * @param rolePack 角色包内部名（如 'doc-review'）
   * @returns UI 展示名（displayName 或回退 name）
   */
  private roleDisplayName(rolePack: string): string {
    const meta = this._agent?.rolePackManager?.listMeta().find((m) => m.name === rolePack);
    return meta?.displayName ?? rolePack;
  }

  /**
   * Phase 4 E2：推送工具权限徽章（角色切换后能力面随之变化）
   *
   * 从内核 RolePackManager.getActive() 读取当前角色包的 capabilities 与 toolMode，
   * 映射为可读标签（如 file:read → 只读、web:search → 联网），推送给 webview 渲染徽章。
   * 能力面标签映射为中文（简单映射，避免前端硬编码）。
   */
  private postCapabilityBadge(): void {
    const agent = this._agent;
    if (!agent) return;
    const active = agent.rolePackManager?.getActive();
    if (!active) return;
    const toolMode = active.strategy.act?.toolMode ?? 'allow';
    // 能力标签映射（简单域→中文，复杂描述用 capability.description）
    const labels = active.capabilities.map((c) => {
      const [domain] = c.capability.split(':');
      const domainLabel: Record<string, string> = {
        file: '文件',
        web: '联网',
        memory: '记忆',
        llm: 'LLM',
      };
      const domainText = domainLabel[domain] ?? domain;
      return {
        capability: c.capability,
        label: domainText,
      };
    });
    this.post({ type: 'capability_badge', toolMode, capabilities: labels });
  }

  /**
   * 设置当前激活角色包（由 extension 装配时注入）
   *
   * 对话面板为通用宿主，定位由内置角色包承载；角色包名在就绪回放时推送给
   * webview 的 AI 消息头部标签 + 空状态标题（角色切换入口已独立到「角色」视图，2026-08-17）。
   *
   * @param rolePack 角色包内部名（如 'doc-review'）
   */
  public setRolePack(rolePack: string): void {
    this._activeRolePack = rolePack;
    // 视图已就绪时立即推送（而非等待下次 replaySession），保证角色选择器即时刷新；
    // 视图未就绪时由 replaySession 兜底（就绪回放时读取 _activeRolePack 推送）。
    if (this._view) {
      this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(rolePack) });
    }
  }

  /**
   * 角色 handoff 预填：将提示文案填入对话输入框（不自动发送，用户可编辑后回车）
   *
   * 对话视图已就绪 → 立即投递；未就绪（用户从设置视图首次带入对话）→ 缓冲到
   * _pendingPrefill，待 webview ready 后由 resolveWebviewView 补发，避免 postMessage
   * 在 webview 脚本监听器注册前丢失。
   */
  public prefillInput(text: string): void {
    if (this._view) {
      this.post({ type: 'prefill_input', text });
    } else {
      this._pendingPrefill = text;
    }
  }

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // 折叠/展开会触发 resolve 重建 HTML。不设 retainContextWhenHidden（避免 window
    // 全局标志残留与 document 重建的冲突），统一走「ready 回放」这一确定性机制：
    // 每次重建后，webview 脚本就绪发 ready，extension 再回放会话，保证数据不丢。
    // 阶段 B（P2-1）：启用外部脚本（chatView.js），localResourceRoots 指向 dist/webview
    // 供 webview.asWebviewUri 解析（CSP script-src 'self'，不再用 'unsafe-inline' 注入脚本）
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    // 仅设置 HTML（不在就绪前回放，避免消息在脚本监听器注册前丢失）
    this.render();

    // 打开面板即确保 Agent 装配（不依赖先执行 open 命令），避免发送无反应
    void this.ensureAgent();

    // 视图被销毁（折叠/关闭）时清理引用，避免向已销毁 webview postMessage
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) this._view = undefined;
    });

    // 处理来自 webview 的用户输入
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'ready') {
        // webview 脚本就绪后才回放会话（历史 + Provider 列表），消除时序竞态
        this.replaySession();
        // 角色 handoff 预填补发：视图解析后 webview 监听器已就绪，安全投递
        if (this._pendingPrefill !== undefined) {
          this.post({ type: 'prefill_input', text: this._pendingPrefill });
          this._pendingPrefill = undefined;
        }
      } else if (msg.type === 'send' && msg.text.trim()) {
        void this.handleSend(msg.text.trim());
      } else if (msg.type === 'clarify_answer' && msg.text.trim()) {
        void this.handleResume(msg.text.trim());
      } else if (msg.type === 'new_session') {
        // 标题条「＋」新建会话 → 切入空会话，旧会话归档进历史（2026-08-17 会话管理重构）
        void this.newSessionFromCommand();
      } else if (msg.type === 'session_list') {
        // 标题条「历史」按钮 → 返回非当前会话列表供 webview 渲染模态浮层
        this.pushSessionList();
      } else if (msg.type === 'switch_session') {
        // 历史浮层点击条目 → 切入该会话并回放
        void this.switchToSession(msg.sessionId);
      } else if (msg.type === 'delete_session') {
        // 历史浮层垃圾桶删除 → host 确认不可恢复后删除会话记录
        void this.handleDeleteSession(msg.sessionId);
      } else if (msg.type === 'rename_request') {
        // 标题条改名笔 → 弹 InputBox 输入新标题写入元数据
        void this.renameCurrentSession();
      } else if (msg.type === 'delete_turn') {
        // 删除单个问答闭环（AI 消息「删除」按钮触发）：确认不可恢复后截断该问答及之后所有
        void this.deleteTurnFrom(msg.ts);
      } else if (msg.type === 'chat_set_provider') {
        void this.handleSetProvider(msg.name);
      } else if (msg.type === 'chat_set_role_pack') {
        // 兼容兜底：旧版 webview 实例（含角色选择器）仍可能发送；新前端已走 roles_set_active
        void this.handleSetRolePack(msg.name);
      } else if (msg.type === 'stop') {
        // 停止生成：中断当前流式输出（mvp-scope 打断能力）
        this.handleStop();
      } else if (msg.type === 'pause') {
        // Phase 4：暂停生成：调 agent.pause() 暂停当前流
        this.handlePause();
      } else if (msg.type === 'resume') {
        // Phase 4：恢复生成：调 agent.resumeExecution() 续跑
        void this.handleResumeFromPause();
      }
    });
  }

  /**
   * 确保 Agent 已装配：若尚未装配则通过工厂懒装配一次
   *
   * 用户可能直接点活动栏面板图标打开（未执行 open 命令），此时 agent 从未装配，
   * 会导致发送无反应。此方法在打开面板时自动装配，失败时给出明确提示。
   */
  private async ensureAgent(): Promise<void> {
    if (this._agent || this._agentResolving || !this._getAgent) return;
    this._agentResolving = true;
    try {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        void vscode.window.showWarningMessage('Memora：请先打开一个工作区');
        return;
      }
      this._agent = await this._getAgent(ws);
      // 装配成功后绑定会话级可观测事件 → 错误提示（会话异常/恢复失败等，不插入消息区）
      this.bindAgentNoticeEvents();
      // 装配完成后补推角色信息（时序竞态修复，2026-08-15）：
      // 与 setAgent 路径一致——ready 时 agent 可能尚未装配 / _activeRolePack 未设置，
      // 装配完成即补推，避免输入区角色选择器永久缺失；面板未就绪时 post 静默，
      // 由 replaySession 兜底。
      this.refreshRoleInfoAfterAssemble();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
    } finally {
      this._agentResolving = false;
    }
  }

  // ─── 会话异常可观测出口（错误级 notice，功能→UI 对齐排雷 P1） ───
  // 监听内核会话级事件并转发为错误提示条。错误不插入消息区，避免污染对话历史；
  // 以下 handler 均为箭头函数属性，保证 off/on 引用一致（折叠展开防重复注册）。

  /** sessionError：会话异常（LLM 超时等） */
  private readonly onSessionError = (info: { cause: string }): void => {
    this.post({ type: 'notice', level: 'error', message: `会话异常：${info.cause}` });
  };

  /** sessionResumeFailed：恢复操作执行失败（如存储层异常） */
  private readonly onSessionResumeFailed = (info: { reason: string }): void => {
    this.post({ type: 'notice', level: 'error', message: `会话恢复失败：${info.reason}` });
  };

  /** sessionResumeBlocked：恢复被阻止（暂停超时检查点已清理） */
  private readonly onSessionResumeBlocked = (info: { reason: string }): void => {
    this.post({ type: 'notice', level: 'error', message: `会话无法恢复：${info.reason}` });
  };

  /** sessionPauseTimedOut：暂停超时，需重新开始 */
  private readonly onSessionPauseTimedOut = (): void => {
    this.post({ type: 'notice', level: 'error', message: '会话暂停超时，请重新开始' });
  };

  // ─── 低扰信息出口（info 级 notice，P1 后续波） ───
  // 上下文截断 / 记忆冲突 / 归档失败 / 权重持久化失败 —— 均为「知晓即可」的低频信息，
  // 统一走 notice info 级提示条（语义分级单一通道，不插入消息区，不污染对话历史）。
  // 提示条为独立元素，不随流式 chunk 重建，天然规避「截断提示被后续 chunk 覆盖」（排雷雷-6）。

  /** contextTruncated：上下文窗口截断（消息超出 token 上限被裁剪） */
  private readonly onContextTruncated = (info: { skippedCount: number; keptCount: number }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `上下文已截断：跳过 ${info.skippedCount} 条，保留 ${info.keptCount} 条`,
    });
  };

  /** conflictDetected 事件已随内核记忆关系图谱收敛移除（2026-08-14） */

  /** archiveFailed：记忆归档失败（insight / content 阶段） */
  private readonly onArchiveFailed = (info: { stage: string; message: string }): void => {
    this.post({ type: 'notice', level: 'info', message: `记忆归档失败（${info.stage}）：${info.message}` });
  };

  /** boostPersistFailed：boost score 持久化失败（记忆权重可能丢失） */
  private readonly onBoostPersistFailed = (info: { message: string }): void => {
    this.post({ type: 'notice', level: 'info', message: `记忆权重保存失败：${info.message}` });
  };

  /**
   * personaSwitched：角色包切换（内核 emit：粘性匹配自动切换 / 显式 activate / persona 切换）
   *
   * 三层对齐断点 A1（alignment-iteration.md）：内核在粘性匹配或显式激活切换角色包时
   * emit personaSwitched，但插件此前未绑定 → UI 角色选择器不刷新（真实链路断裂）。
   * 此处转发为现有 chat_role_pack 协议消息（复用，不新增类型），webview 即时刷新。
   *
   * Phase 4 E2：同步推送 capability_badge —— 工具权限徽章，展示当前角色的工具模式与能力列表。
   */
  private readonly onPersonaSwitched = (info: { from: string | null; to: string }): void => {
    // SSOT 修复（2026-08-17）：从同一 personaSwitched 事件维护内部激活角色状态，
    // 使其与内核 rolePackManager.activeName 一致，成为 replaySession 的单一真相源。
    // 此前仅 post 给当时可能已被 dispose 的 webview（被静默忽略），未更新 _activeRolePack
    // → 用户从「角色」视图切换后聚焦对话（chat 视图重解析），ensureAgent 因 _agent 已存在
    // 提前返回、refreshRoleInfoAfterAssemble 不再跑 → replaySession 读到陈旧 _activeRolePack
    // → 徽章显示旧角色（与设置视图不一致）。设置视图靠 activateRole 显式 loadRoles 才更新，
    // 两视图真相源分叉即 SSOT 违反。现由同一事件驱动状态，重解析即推正确角色。
    this._activeRolePack = info.to;
    // 仅转发切换后的角色显示名（to），触发角色选择器 + AI 消息标签同步（视图存活时）
    this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(info.to) });
    // Phase 4 E2：同步推送工具权限徽章（角色切换后能力面随之变化）
    this.postCapabilityBadge();
  };

  /**
   * skillMatched：技能匹配成功（Phase 3 技能系统接入）
   *
   * 内核在 LLM 输出匹配到技能关键词时 emit skillMatched，
   * 转发为 skill_activated 提示条「已激活技能：xxx」，让用户看见本轮用到了什么技能。
   * 内核事件形状：{ skill: string, score: number }（skill 为技能名，见 agent.ts matchAndInjectSkill）。
   */
  private readonly onSkillMatched = (info: { skill: string; score: number }): void => {
    const name = info.skill ?? '未知技能';
    this.post({ type: 'skill_activated', skillName: name });
  };

  // ─── 项目与工作投影事件（G2/G3 缺口修复，2026-08-18） ───

  /**
   * projectSwitched：项目切换（内核在 init/close 或显式切换时 emit）
   *
   * 转发为 notice info 级提示条，让用户感知当前工作目录已变更。
   * 内核事件形状：{ from: string | null; to: string; projectName: string }
   */
  private readonly onProjectSwitched = (info: { from: string | null; to: string; projectName: string }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `项目已切换：${info.projectName ?? info.to}`,
    });
  };

  /**
   * workProjectionGenerated：工作投影生成（内核后台投影完成时 emit）
   *
   * 转发为 notice info 级提示条，告知用户当前工作投影已更新。
   * 内核事件形状：{ sourcePath: string; summary: string }
   */
  private readonly onWorkProjectionGenerated = (info: { sourcePath: string; summary: string }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `工作投影已生成：${info.summary ?? info.sourcePath}`,
    });
  };

  // ─── 后台事件（G4 缺口修复，2026-08-18 调试可观测性） ───

  /** decayCompleted：记忆衰减完成（后台定时任务） */
  private readonly onDecayCompleted = (info: { decayedCount: number }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `记忆衰减完成：${info.decayedCount} 条已更新权重`,
    });
  };

  /** configReloaded：配置热重载完成 */
  private readonly onConfigReloaded = (info: { source: string }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `配置已重载（来源：${info.source}）`,
    });
  };

  /** archiveModeChanged：归档模式切换 */
  private readonly onArchiveModeChanged = (info: { from: string; to: string }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `归档模式已切换：${info.from} → ${info.to}`,
    });
  };

  /**
   * 绑定会话级可观测事件 → 错误提示
   *
   * Agent 为单例跨面板展开共享，此处先 off 再 on（命名 handler 引用一致），
   * 避免折叠/展开重建视图时重复注册导致重复通知。
   */
  private bindAgentNoticeEvents(): void {
    if (!this._agent) return;
    const a = this._agent;
    a.off('sessionError', this.onSessionError);
    a.on('sessionError', this.onSessionError);
    a.off('sessionResumeFailed', this.onSessionResumeFailed);
    a.on('sessionResumeFailed', this.onSessionResumeFailed);
    a.off('sessionResumeBlocked', this.onSessionResumeBlocked);
    a.on('sessionResumeBlocked', this.onSessionResumeBlocked);
    a.off('sessionPauseTimedOut', this.onSessionPauseTimedOut);
    a.on('sessionPauseTimedOut', this.onSessionPauseTimedOut);
    // P1 后续波：低扰信息（截断/归档失败/权重保存失败）→ info 级提示条
    a.off('contextTruncated', this.onContextTruncated);
    a.on('contextTruncated', this.onContextTruncated);
    a.off('archiveFailed', this.onArchiveFailed);
    a.on('archiveFailed', this.onArchiveFailed);
    a.off('boostPersistFailed', this.onBoostPersistFailed);
    a.on('boostPersistFailed', this.onBoostPersistFailed);
    // A1（alignment-iteration.md）：角色包切换 → UI 角色选择器实时对齐（内核粘性切换/显式激活）
    a.off('personaSwitched', this.onPersonaSwitched);
    a.on('personaSwitched', this.onPersonaSwitched);
    // Phase 3：技能匹配事件 → 提示条显示激活技能
    a.off('skillMatched', this.onSkillMatched);
    a.on('skillMatched', this.onSkillMatched);
    // G2/G3：项目切换 + 工作投影生成事件 → info 级提示条
    a.off('projectSwitched', this.onProjectSwitched);
    a.on('projectSwitched', this.onProjectSwitched);
    a.off('workProjectionGenerated', this.onWorkProjectionGenerated);
    a.on('workProjectionGenerated', this.onWorkProjectionGenerated);
    // G4：后台事件 → info 级提示条（调试可观测性）
    a.off('decayCompleted', this.onDecayCompleted);
    a.on('decayCompleted', this.onDecayCompleted);
    a.off('configReloaded', this.onConfigReloaded);
    a.on('configReloaded', this.onConfigReloaded);
    a.off('archiveModeChanged', this.onArchiveModeChanged);
    a.on('archiveModeChanged', this.onArchiveModeChanged);
  }

  /**
   * 删除单个问答闭环（AI 消息「删除」按钮，2026-08-16 对话闭环管理）
   *
   * 语义（truncate-from-turn，对齐市面主流）：删除【该问答及其之后所有】消息，保证剩余
   * 上下文自洽。以目标 assistant 消息的 timestamp 作锚点，调宿主 sessionStore.truncateFrom
   * 截断后重放当前会话刷新 UI。
   *
   * 依赖宿主扩展方法 truncateFrom（宿主 ISessionStore 实现，内核接口保持最小化）。
   */
  private async deleteTurnFrom(ts: string): Promise<void> {
    // 破坏性操作：确认不可恢复（与「清空对话」同强度确认）
    const choice = await vscode.window.showWarningMessage(
      `确定删除该问答及之后的所有对话？此操作不可恢复。`,
      { modal: true },
      '删除',
    );
    if (choice !== '删除') return;
    try {
      const { date, session } = this.parseSessionId(this._currentSessionId);
      this.sessionStore.truncateFrom(date, session, ts);
    } catch (err) {
      // 删除失败不阻塞展示（仅清理 UI），但需记录（SSOT 不藏错）
      console.warn('Memora 删除问答闭环失败', err);
    }
    // 截断后重放当前会话（消息已减少），保证 UI 与存储一致
    this.replayCurrentSession();
  }

  /**
   * 推送历史会话列表（对 session_list 的应答，2026-08-17 会话管理重构）
   *
   * 只返回非当前会话（设计收敛：当前会话不进历史记录），按 updatedAt 降序，
   * 供 webview 渲染历史模态浮层。无历史时 sessions 为空数组（webview 显示空态）。
   */
  private pushSessionList(): void {
    const metas = this.sessionStore
      .listSessionMetas()
      .filter((m) => m.sessionId !== this._currentSessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.post({
      type: 'session_list_data',
      sessions: metas.map((m) => ({
        sessionId: m.sessionId,
        title: m.title,
        updatedAt: m.updatedAt,
      })),
    });
  }

  /**
   * 删除指定历史会话（历史浮层垃圾桶触发，2026-08-17 会话管理重构）
   *
   * 危险操作确认走 host 侧原生 modal（对齐 delete_turn 的 P0-2 决策）。
   * 当前会话不进历史记录（设计收敛），正常不会删除到当前会话；防御性保护：若目标是
   * 当前会话则拒绝 + 提示（防未来 UI 变动误删当前会话导致空窗）。
   * 删除后重推列表（webview 浮层同步移除该项）。
   *
   * @param sessionId 目标会话标识（YYYY-MM-DD-sessionName）
   */
  private async handleDeleteSession(sessionId: string): Promise<void> {
    const meta = this.sessionStore.getSessionMeta(sessionId);
    const title = meta?.title ?? sessionId;
    const choice = await vscode.window.showWarningMessage(
      `确定删除会话「${title}」？此操作不可恢复。`,
      { modal: true },
      '删除',
    );
    if (choice !== '删除') return;
    if (sessionId === this._currentSessionId) {
      this.post({ type: 'notice', level: 'info', message: '当前会话不在历史记录，无法删除' });
      return;
    }
    try {
      this.sessionStore.deleteSession(sessionId);
    } catch (err) {
      // 删除失败不阻塞（重推列表仍可用），但需记录（SSOT 不藏错）
      console.warn('Memora 删除会话记录失败', err);
    }
    this.pushSessionList();
  }

  /**
   * 新建会话（由「＋ 新建会话」触发）：生成唯一会话名，调内核 switchToSession
   * 切入空会话（工作记忆清空），UI 清空消息区
   */
  public async newSessionFromCommand(): Promise<void> {
    if (this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '生成中，请稍候再新建会话' });
      return;
    }
    const agent = await this.getAgentOrWarn();
    if (!agent) return;
    // 生成唯一会话名（字母前缀，避免与数字日期混淆；标题层才是用户可读身份）
    const name = `s${Date.now().toString(36)}`;
    const sessionId = `${formatDateKey(new Date())}-${name}`;
    try {
      if (!agent.sessionManager) {
        this.post({ type: 'notice', level: 'error', message: 'Memora：会话管理未就绪，请稍候再试' });
        return;
      }
      await agent.sessionManager.switchToSession(sessionId);
      this._currentSessionId = sessionId;
      this.replayCurrentSession();
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 改当前会话名（由「✎ 改当前会话名」触发）：InputBox 输入新标题，调内核
   * renameSession 写入元数据（不改会话身份），UI 刷新标题
   */
  public async renameCurrentSession(): Promise<void> {
    const title = await vscode.window.showInputBox({
      prompt: '输入新的会话名称',
      value: this.currentSessionTitle(),
      validateInput: (v) => (v.trim() ? undefined : '会话名称不能为空'),
    });
    if (title === undefined || title === null) return; // 用户取消
    const trimmed = title.trim();
    if (!trimmed) return;
    // 会话管理未就绪时静默跳过落库（UI 刷新标题不阻塞，元数据由内核侧 SessionNamer 兜底）
    this._agent?.sessionManager?.renameSession(this._currentSessionId, trimmed);
    this.post({ type: 'session_title', title: trimmed });
  }

  /**
   * 切换到指定会话：调内核 switchToSession（切换身份 + 同步工作记忆），
   * 更新当前会话并回放其历史
   *
   * @param sessionId 目标会话标识（YYYY-MM-DD-sessionName）
   */
  public async switchToSession(sessionId: string): Promise<void> {
    if (this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '生成中，请稍候再切换会话' });
      return;
    }
    if (sessionId === this._currentSessionId) return; // 已在目标会话
    const agent = await this.getAgentOrWarn();
    if (!agent) return;
    try {
      if (!agent.sessionManager) {
        this.post({ type: 'notice', level: 'error', message: 'Memora：会话管理未就绪，请稍候再试' });
        return;
      }
      await agent.sessionManager.switchToSession(sessionId);
      this._currentSessionId = sessionId;
      this.replayCurrentSession();
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 确保 Agent 已装配（未装配时返回 undefined 并提示） */
  private async getAgentOrWarn(): Promise<Agent | undefined> {
    if (this._agent) return this._agent;
    await this.ensureAgent();
    if (!this._agent) {
      void vscode.window.showWarningMessage('Memora：Agent 尚未就绪，请稍候再试');
      return undefined;
    }
    return this._agent;
  }

  /** 清空 webview 消息区并重放当前会话历史 + 刷新会话标题 */
  private replayCurrentSession(): void {
    this.post({ type: 'clear_ok' });
    const history = this.loadHistory();
    for (const m of history) {
      this.post({ type: m.role, text: m.content, ts: m.ts });
    }
    this.post({ type: 'session_title', title: this.currentSessionTitle() });
  }

  /** 仅渲染 HTML 骨架（历史/Provider 在 webview 就绪后经 replaySession 回放）；
   *  脚本由外部 chatView.js 提供（阶段 B P2-1，经 asWebviewUri 引用） */
  private render(): void {
    if (!this._view) return;
    const scriptUri = this._view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'scripts', 'chatView.js'),
    );
    // CSP script-src 用 webview.cspSource（本地资源源）而非 'self'：
    // asWebviewUri 生成的外部脚本 URL 的 origin 是 https://*.vscode-resource.vscode-cdn.net，
    // 与 webview 文档自身 origin 不同，'self' 无法匹配 → 脚本被 CSP 拦截（历史加载/回放失效根因）
    this._view.webview.html = buildHtml(scriptUri, this._view.webview.cspSource);
  }

  /**
   * 回放当前会话（历史消息 + 历史日期列表 + Skill + Provider）
   *
   * 仅在 webview 发来 ready（脚本监听器已注册）后调用，避免 postMessage
   * 在监听器就绪前到达而被丢弃（折叠/展开重建 HTML 时尤其明显）。
   */
  private replaySession(): void {
    if (!this._view) return;
    // 恢复当前会话历史消息（ADR-024：只回放 _currentSessionId）
    const history = this.loadHistory();
    for (const m of history) {
      this.post({ type: m.role, text: m.content, ts: m.ts });
    }
    // 推送当前会话标题 → webview 顶部展示（主动可见，便于识别当前会话）
    this.post({ type: 'session_title', title: this.currentSessionTitle() });
    // 推送当前激活角色包 → 输入区角色选择器 + AI 消息标签（主动可见）。
    // 即使没有激活的角色包也推送，让 webview 正确处理状态
    if (this._activeRolePack) {
      this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(this._activeRolePack) });
    } else {
      // 无激活角色包：推送空信息，让 webview 清除角色标签
      this.post({ type: 'chat_role_pack', rolePack: '' });
    }
    // 推送 Provider 列表到 webview（底部模型下拉框）
    void this.pushProviders();
    // A3（alignment-iteration.md）：推送角色包列表到输入区切换下拉
    this.pushRolePacks();
    // Phase 4 E2：补推工具权限徽章（replaySession 时角色信息已就绪）
    this.postCapabilityBadge();
  }

  /**
   * 推送 Provider 列表到 webview（异步读取配置）
   *
   * 在 render 时调用，也可在切换 Provider 后再次调用以刷新下拉框。
   */
  private async pushProviders(): Promise<void> {
    try {
      const providers = await this._providerStore.listMasked();
      const activeName = this._providerStore.getActiveName();
      const list = providers.map((p) => ({ name: p.name, displayName: p.displayName || p.name }));
      this.post({ type: 'chat_providers', providers: list, activeName });
    } catch {
      // 推送失败不阻塞主流程
    }
  }

  /**
   * 装配完成后补推角色信息（时序竞态修复，2026-08-15）
   *
   * 懒装配路径（直接点活动栏面板图标）：ensureAgent 异步装配，webview ready 时
   * _agent 往往尚未就绪，replaySession 会因 _agent 为空（pushRolePacks）或
   * _activeRolePack 未设置（chat_role_pack，仅 open 命令路径的 setRolePack 会设置）
   * 而跳过推送 → 输入区角色选择器永久缺失。装配完成即补推一次：
   *   1. _activeRolePack 缺省时从 agent 实际激活角色补齐（懒装配路径没有 setRolePack）
   *   2. 补推 chat_role_pack → 角色选择器 / AI 消息标签可见（即使无激活角色也推送，
   *      让 webview 正确处理状态）
   *   3. 补推 chat_role_packs → 角色切换入口数据
   * 面板未就绪时 post 静默（_view 为空），由 replaySession 兜底；重复推送幂等。
   */
  private refreshRoleInfoAfterAssemble(): void {
    if (!this._agent) return;
    // 懒装配路径从未调用 setRolePack：从 agent 实际激活角色补齐（无角色包时为 undefined）
    if (!this._activeRolePack) {
      // ?? undefined：activeName 可能为 null（内核未激活任何角色包），归一并避免 null 赋值
      this._activeRolePack = this._agent.rolePackManager?.activeName ?? undefined;
    }
    // 角色数据：无论是否有激活角色都推送，让 webview 正确更新 UI 状态
    if (this._view) {
      if (this._activeRolePack) {
        this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(this._activeRolePack) });
      } else {
        // 无激活角色包时推送空信息，让 webview 清除角色标签
        this.post({ type: 'chat_role_pack', rolePack: '' });
      }
    }
    // 角色切换入口数据（webview 收到后自动显示输入区内下拉）
    this.pushRolePacks();
    // Phase 4 E2：装配完成即补推工具权限徽章
    this.postCapabilityBadge();
  }

  /**
   * 推送角色包列表到 webview（输入区角色切换下拉的数据，alignment-iteration.md A3）
   *
   * 从内核 RolePackManager 读取全部角色包（listMeta）+ 当前激活名（activeName），
   * 推送为 chat_role_packs 协议消息。即使列表为空也发送消息，确保 webview 能正确
   * 处理角色选择器的显示/隐藏状态（而非静默失败导致 UI 永远不更新）。
   * description 取自 manifest.description（listMeta 已含，零额外读取），供下拉展示副标题。
   */
  private pushRolePacks(): void {
    const rpm = this._agent?.rolePackManager;
    if (!rpm) {
      // agent 未装配或无 rolePackManager：发送空列表，让 webview 正确隐藏角色选择器
      this.post({ type: 'chat_role_packs', packs: [], activeName: '' });
      return;
    }
    const metaList = rpm.listMeta();
    const packs = metaList
      .filter((p) => p.name) // 过滤无 name 的异常包
      .map((p) => ({
        name: p.name,
        // SSOT：displayName 从 manifest 读取，缺省回退 name（单一来源）
        displayName: p.displayName ?? p.name,
        description: p.description ?? '', // 角色包定位描述（manifest.description，可选）
      }));
    // 即使列表为空也发送消息，让 webview 正确处理显示/隐藏
    // activeName 缺省时回退首个（与内核「默认激活首个」一致），无角色包时为空串
    const activeName = rpm.activeName ?? (packs.length > 0 ? packs[0]!.name : '');
    this.post({ type: 'chat_role_packs', packs, activeName });
  }

  /**
   * 处理用户切换激活角色包（输入区角色下拉，alignment-iteration.md A3）
   *
   * 走内核「单一切换入口」agent.switchRolePack(name)：内部完成
   * RolePackManager.activate + 发射 personaSwitched（onPersonaSwitched 已绑定，
   * 同步 _activeRolePack + 转发 chat_role_pack，UI 徽章 / AI 消息标签即时刷新）
   * + 刷新 AgentLoop 前缀（下一次对话即用新角色包 prompt）。切换失败（角色不存在）
   * 时仅低扰提示，不误导用户。
   *
   * 切换成功且已注入 globalState 时，将激活角色包写入持久化（用户级，重启后恢复用户选择，
   * 2026-08-15 角色包状态持久化，2026-08-17 由 workspaceState 升为用户级）；未注入则静默跳过。
   *
   * @param name 用户选中的角色包名
   */
  private handleSetRolePack(name: string): void {
    const agent = this._agent;
    if (!agent) return;
    const ok = agent.switchRolePack(name);
    // 刷新角色包列表（active 高亮；切换成功时 personaSwitched 已刷新徽章文案）
    this.pushRolePacks();
    if (ok) {
      // 持久化激活角色包（用户级偏好，跨项目共享）
      this._globalState?.update(ACTIVE_ROLE_PACK_KEY, name);
    } else {
      this.post({ type: 'notice', level: 'error', message: `角色包不存在：${name}` });
    }
  }

  /**
   * 处理用户切换激活 Provider（底部模型下拉框）
   *
   * 除持久化激活态外，还做「热生效」：复用装配工厂 createProvider（SSOT，
   * 不重复构造）构造新 Provider 并注入 Agent，让后续对话立即使用新模型。
   * 切换未生效时（对话进行中不可切换 / 配置缺失）回滚激活态并提示，避免
   * UI 显示已切换但实际未生效（功能→UI 对齐排雷 P0）。
   *
   * @param name 用户选中的 Provider 别名
   */
  private async handleSetProvider(name: string): Promise<void> {
    // 备份当前激活名，切换失败时回滚（保持 UI 与真实生效状态一致）
    const prev = this._providerStore.getActiveName();
    const r = await this._providerStore.setActive(name);
    if (!r.ok) return;
    try {
      // 热生效：Agent.setProvider 在对话进行中会抛 assertNotBusy，需捕获
      if (this._agent) {
        await this._agent.setProvider(await createProvider(this._providerStore));
      }
      await this.pushProviders();
    } catch (err) {
      // 切换未生效：回滚激活态 + 错误提示（不误导用户）
      // prev 存在 → 还原原激活 Provider；prev 为 undefined（原本无激活、靠 env 装配，
      // 见 llmConfig 回退路径）→ 清空激活态，否则 UI 显示新 provider 已激活但 agent
      // 仍用 env，造成功能↔UI 不一致（对抗评估 P1-3）。
      if (prev) {
        await this._providerStore.setActive(prev);
      } else {
        await this._providerStore.clearActive();
      }
      await this.pushProviders();
      this.post({
        type: 'notice',
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 从 sessionStore 恢复当前会话的完整历史（user + assistant）
   *
   * 多会话模型（ADR-024）下只加载「当前会话 _currentSessionId」的消息，不再遍历
   * main 会话跨天合并——每个会话独立展示，切换会话即替换回放视图。
   *
   * 恢复策略：
   *   - user 消息：回放剥离 `[当前打磨文档内容]` 前缀（该前缀为宿主注入的当前任务上下文，
   *     不属于用户实际输入，仅用于 LLM 上下文，不应回显）。
   *   - assistant 消息：回放上一次流式输出的完整内容（避免拼接不完整流）。
   *   - 内核注入的 `<user_input>` 系统消息跳过（由内核 appendUser 持久化的 user 消息替代）。
   *
   * @returns 带 role/timestamp 标记的会话消息列表（按时间升序）
   */
  private loadHistory(): { role: 'user' | 'assistant'; content: string; ts?: string }[] {
    try {
      const { date, session } = this.parseSessionId(this._currentSessionId);
      const result: { role: 'user' | 'assistant'; content: string; ts?: string }[] = [];
      const msgs = this.sessionStore.loadMessages(date, session) as {
        role?: string;
        content?: string;
        timestamp?: string;
      }[];
      for (const m of msgs) {
        if (!m.content || m.content.startsWith('<user_input>')) continue;
        result.push({
          role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as
            | 'user'
            | 'assistant',
          content: m.role === 'user' ? stripDocContextPrefix(m.content) : m.content,
          ts: m.timestamp,
        });
      }
      // 按时间升序（消息存储顺序可能因多次回放而乱序）
      result.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
      // 上限保护：仅回放最近 MAX_HISTORY_MESSAGES 条（按时间升序取末段）。
      // 避免超长会话逐条建 DOM 拖慢切换（对抗评估 P1-7）
      return result.slice(-MAX_HISTORY_MESSAGES);
    } catch (err) {
      // 读取失败不阻塞面板展示，但需记录（SSOT 不藏错，避免「历史空白」静默吞因）
      console.warn('Memora 加载会话历史失败', err);
      return [];
    }
  }

  /**
   * 解析会话标识（YYYY-MM-DD-sessionName）为日期 + 会话名
   *
   * 会话名可能含连字符（如 main-b1），故从最后一个 '-' 切分（日期固定 10 位）。
   */
  private parseSessionId(sessionId: string): { date: string; session: string } {
    const idx = sessionId.lastIndexOf('-');
    return { date: sessionId.slice(0, idx), session: sessionId.slice(idx + 1) };
  }

  /** 当前会话的 date/session（单真理源：始终解析 _currentSessionId，复用内核会话组织） */
  private sessionInfo(): { date: string; session: string; store: HostSessionStore } {
    return { ...this.parseSessionId(this._currentSessionId), store: this.sessionStore };
  }

  /** 当前会话标题（无元数据时回退占位标题，不暴露 sessionId，供 UI 展示） */
  private currentSessionTitle(): string {
    return this.sessionStore.getSessionMeta(this._currentSessionId)?.title ?? defaultSessionTitle();
  }

  /** 持久化一条消息 */
  private persist(role: 'user' | 'assistant', content: string): void {
    const { date, session, store } = this.sessionInfo();
    store.appendMessage(date, session, { role, content, timestamp: new Date().toISOString() });
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }

  /** 处理用户输入：面板上屏 + Agent 流式对话（持久化由内核 appendUser 完成，SSOT 不双写）
   *
   * 插话语义（mvp-scope 打断能力）：生成中用户发送新消息 = 中断当前流 + 作为新消息重发。
   * 必须 await 旧流彻底结束（chatLock 释放）再发起新 chat，否则触发 busy 冲突；等待期间
   * 旧流 consumeFlow 会发送 interrupted 通知 webview（恢复输入框 + 渲染「已停止」提示）。 */
  private async handleSend(input: string): Promise<void> {
    if (!this._agent) {
      // Agent 未装配（可能仍在懒装配中）：提示用户稍候，而非静默无反应
      void vscode.window.showWarningMessage('Memora：Agent 尚未就绪，请稍候片刻再发送');
      return;
    }
    // 插话：生成中发送 → 中断当前流（abort() 同步置 signal.aborted，供 consumeFlow
    // 判定并发送 interrupted），待旧流结束后走正常发送路径（此时 _streaming 已复位，
    // 不会再次进入本分支）
    if (this._streaming && this._abortController) {
      this._abortController.abort();
      await this._currentFlow;
    }
    // 确保 Agent 对齐到当前会话（ADR-024）：用户可能打开面板后直接发送，未显式
    // 切换会话。若 Agent 内部会话与 _currentSessionId 不一致，先 switchToSession 对齐，
    // 否则内核 appendUser 会写入错误会话。会话一致时跳过（不重复加载工作记忆）。
    const sessionManager = this._agent.sessionManager;
    if (sessionManager) {
      const info = sessionManager.getCurrentSessionInfo();
      if (info && `${info.date}-${info.session}` !== this._currentSessionId) {
        try {
          await sessionManager.switchToSession(this._currentSessionId);
        } catch (err) {
          this.post({
            type: 'notice',
            level: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
    }
    const now = new Date().toISOString();
    // 用户消息持久化由内核 chat() → appendUser 完成（写入当前会话 _currentSessionId），
    // 此处不再 persist，避免与内核双写同一条消息（SSOT 单一真理源）
    this.post({ type: 'user', text: input, ts: now });
    // Phase 4 E1：新用户对话开始 → 重置自动续跑计数（新一轮闭环计数独立）
    this._loopCount = 0;

    // 注入文档上下文（当前任务上下文，不进入记忆召回）
    const chatInput = this._docContext
      ? `[当前打磨文档内容]\n${this._docContext}\n[/当前打磨文档内容]\n\n用户请求：${input}`
      : input;

    // runFlow 统一管理 AbortController + consumeFlow + 同步抛错兜底
    await this.runFlow((signal) => this._agent!.chat(chatInput, signal));
  }

  /** 处理用户对主动提问的回答：persist + resumeExecution 续跑 */
  private async handleResume(input: string): Promise<void> {
    if (!this._agent) return;
    const now = new Date().toISOString();
    // resumeExecution 内核路径不写 user 消息（仅 appendAssistant），
    // 此处由 UI 补写，避免回答丢失（内核 resume 能力缺口，宿主补丁）
    this.persist('user', input);
    this.post({ type: 'user', text: input, ts: now });
    await this.runFlow((signal) => this._agent!.resumeExecution(input, signal));
  }

  /**
   * 运行一轮 Agent 流（chat / resumeExecution 的统一入口）
   *
   * 抽取动机：handleSend / handleResume 原先各写一份「新建 AbortController +
   * consumeFlow + catch 清理」样板，2 处重复构成该抽却漏抽的回溯信号
   * （coding-convention §3）。内部新建本轮 controller（上一轮已在 consumeFlow
   * finally 清理），以 factory 注入 signal 供内核流使用；同步抛错（如 chatLock
   * busy）时兜底给出可见错误（对抗评估 P1-2）——因从未进入 thinking 状态，输入框
   * 未被禁用，无需再补发 status done。
   */
  private async runFlow(
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
  ): Promise<void> {
    this._abortController = new AbortController();
    try {
      this._currentFlow = this.consumeFlow(
        factory(this._abortController.signal),
        this._abortController,
      );
      await this._currentFlow;
    } catch (err) {
      // 同步抛错路径：清理 controller，避免 AbortController 泄漏
      this._abortController = undefined;
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 停止生成：用户主动中断当前流式输出（mvp-scope 打断能力）
   *
   * 无进行中流时 no-op（可安全重复点击）。abort 后内核 generator 在下一个
   * await 点退出并 yield aborted chunk，consumeFlow 捕获后发送 interrupted
   * 通知 webview（恢复输入框 + 渲染「已停止」提示）。
   */
  private handleStop(): void {
    if (!this._streaming || !this._abortController) return;
    // abort() 同步置 signal.aborted，consumeFlow 末尾据此判定发送 interrupted
    this._abortController.abort();
  }

  /**
   * 暂停生成：用户软暂停当前 Agent 执行（Phase 4 暂停/恢复）
   *
   * 调 agent.pause('user-pause') 将状态机翻至 paused，当前流在下一 await 点 yield paused chunk，
   * 随后 consumeFlow 正常收尾并发送 status:'paused'。无进行中流时提示无可暂停。
   */
  private handlePause(): void {
    if (!this._agent) return;
    if (!this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '当前没有可暂停的生成' });
      return;
    }
    const ok = this._agent.pause('user-pause', 'user');
    if (!ok) {
      this.post({ type: 'notice', level: 'error', message: '暂停失败，请重试' });
    }
  }

  /**
   * 从暂停状态恢复执行（Phase 4 暂停/恢复）
   *
   * 复用 runFlow + agent.resumeExecution 路径，与对主动提问的回答同构。
   * 无暂停会话时内核会阻断，宿主捕获后提示用户。
   */
  private async handleResumeFromPause(): Promise<void> {
    if (!this._agent) return;
    const agent = this._agent;
    try {
      await this.runFlow((signal) => agent.resumeExecution(undefined, signal));
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 消费 Agent 流：转发 text chunk，监听主动提问事件，透出运行状态，支持用户打断
   *  @param gen Agent 流（chat / resumeExecution）
   *  @param controller 本轮 AbortController：stop / 插话经 abort() 中断流；
   *         finally 中与本轮 controller 比对后清理（避免误清下一轮的 controller） */
  private async consumeFlow(
    gen: AsyncGenerator<AgentChunk, void, unknown>,
    controller: AbortController,
  ): Promise<void> {
    if (!this._agent) return;
    // 监听主动提问事件 → 渲染提问框
    const onPendingQuestion = (questions: { slot: string; question: string }[]) => {
      this.post({ type: 'need_clarify', questions });
    };
    this._agent.on('questionPending', onPendingQuestion);
    // 监听记忆事件 → 转发到 webview 展示记忆条（recalled：「想起」/ added：「已沉淀」）
    // 对齐 kernel 对称事件：memoryRecalled {count,query} / memoryAdded {id,source,name}
    const onMemoryRecalled = (info: { count: number }) => {
      this.post({ type: 'memory', action: 'recalled', count: info.count });
    };
    const onMemoryAdded = (info: { id: string; source: string; name: string }) => {
      this.post({ type: 'memory', action: 'added', count: 1, detail: info });
    };
    this._agent.on('memoryRecalled', onMemoryRecalled);
    this._agent.on('memoryAdded', onMemoryAdded);

    // P0-2：进入生成状态（webview 展示加载动画 + 禁用输入）
    this.post({ type: 'status', state: 'thinking' });
    // 置位生成态：会话切换/新建据此拒绝（P1-3，避免重放与进行中流混血）
    this._streaming = true;
    // P1：流式第一条 chunk 的时间戳（作为本轮 assistant 回复的时间）
    let firstChunkTs = new Date().toISOString();
    // Phase 4：暂停标记——当轮是否收到 paused chunk（软暂停状态）
    let pausedOnPurpose = false;
    try {
      for await (const chunk of gen) {
        // 显式忽略的 chunk（取舍声明，排雷 2026-08-17）：
        //   - question_pending：已由 questionPending 事件驱动 need_clarify，chunk 通道不重复消费。
        if (chunk.type === 'aborted') {
          // 用户 stop/插话 → 内核 abort 应答：提前退出，不再转发后续 chunk
          //（中断通知统一由本方法末尾按 controller.signal.aborted 发出）
          break;
        }
        // Phase 1：召回明细转发（recall chunk 不走 memoryRecalled 事件，chunk 通道携带
        // 完整的 id/name/score/source，映射为 recalled_items 可展开展示）
        if (chunk.type === 'recall' && chunk.memories.length > 0) {
          this.post({
            type: 'memory',
            action: 'recalled_items',
            items: chunk.memories.map((m) => ({
              id: m.id,
              name: m.name,
              source: m.source,
              score: m.score,
            })),
          });
          continue;
        }
        if (chunk.type === 'text' && chunk.content) {
          // 转发 chunk（护栏已移除，chunk 不再携带 guardrailBlocked 标记）
          this.post({
            type: 'chunk',
            content: chunk.content,
            ts: firstChunkTs,
          });
        } else if (chunk.type === 'tool_start') {
          // 工具调用开始 → webview 渲染「执行中」卡片
          this.post({ type: 'tool_start', toolCallId: chunk.toolCallId, name: chunk.name, args: chunk.args });
        } else if (chunk.type === 'tool_result') {
          // 工具调用结束 → 更新卡片状态
          this.post({
            type: 'tool_result',
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            ok: chunk.ok,
            summary: chunk.summary,
          });
        } else if (chunk.type === 'selfReview') {
          // 自审查轮开始 → 转发为过程性提示（活动透明，交叉审核观察 A）
          this.post({ type: 'self_review', round: chunk.round });
        } else if (chunk.type === 'handoff') {
          // Phase 4 E1：衔接决策 → loop 自动续跑（限 3 轮，防死循环）
          if (chunk.decision === 'loop') {
            this._loopCount++;
            this.post({ type: 'loop_count', current: this._loopCount, max: MAX_LOOP_COUNT });
            this.post({ type: 'handoff', decision: chunk.decision, reason: chunk.reason });
            // 未达上限 → 300ms 后自动发起下一轮；达上限 → 提示用户手动介入
            if (this._loopCount < MAX_LOOP_COUNT) {
              setTimeout(() => {
                if (!this._agent || controller.signal.aborted) return;
                void this.runFlow((signal) => this._agent!.chat('继续任务', signal));
              }, 300);
            } else {
              this.post({ type: 'notice', level: 'info', message: '已达自动续跑上限，请手动指示下一步' });
              // 重置计数，让用户介入后可重新自动续跑
              this._loopCount = 0;
            }
          }
        } else if (chunk.type === 'retry') {
          // LLM 失败重试 → 转发低扰提示条
          this.post({
            type: 'retry',
            attempt: chunk.attempt,
            maxRetries: chunk.maxRetries,
            delayMs: chunk.delayMs,
            error: chunk.error,
          });
        } else if (chunk.type === 'paused') {
          // Agent 暂停（输入待定/迭代边界软暂停）→ 转发提示条 + 标记暂停态
          this.post({ type: 'paused' });
          pausedOnPurpose = true;
        } else if (chunk.type === 'thinking') {
          // B（alignment-iteration.md）：思考阶段 → 转发真实 phase（召回/处理/归档）
          this.post({ type: 'thinking', phase: chunk.phase });
        } else if (chunk.type === 'error') {
          // 流内错误 → 复用现有 error 协议消息（webview 已有分支，雷-3）
          this.post({ type: 'error', message: chunk.message });
        }
      }
      // assistant 消息持久化由内核 appendAssistant 完成（写入当前会话 _currentSessionId），
      // 此处不再 persist，避免与内核双写同一条回复（SSOT 单一真理源）
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this._agent.off('questionPending', onPendingQuestion);
      this._agent.off('memoryRecalled', onMemoryRecalled);
      this._agent.off('memoryAdded', onMemoryAdded);
      // 无论成败均清除生成态（恢复历史切换能力，P1-3）
      this._streaming = false;
      // 清理本轮 AbortController：仅当仍是本轮的 controller（防止下一轮已创建新 controller）
      if (this._abortController === controller) this._abortController = undefined;
    }
    // 结束状态：用户打断（abort() 已置 signal.aborted）→ interrupted（webview 渲染
    // 「已停止」并恢复输入框）；软暂停 → status:paused（按钮切为「继续」）；
    // 正常结束 → done。三者均恢复/切换按钮态，仅提示语义不同。
    if (controller.signal.aborted) {
      this.post({ type: 'interrupted' });
      this.post({ type: 'status', state: 'done' });
    } else if (pausedOnPurpose) {
      // 软暂停：不推送 done/interrupted，切换为 paused 状态（允许用户继续）
      this.post({ type: 'status', state: 'paused' });
    } else {
      this.post({ type: 'done' });
      this.post({ type: 'status', state: 'done' });
      // T2 Follow-up 建议：仅正常结束时推送（零 LLM、纯计算；打断/异常不给不完整回复挂建议）
      this.postSuggestions();
    }
    // 本轮流式结束 → 推送活动指标快照（P2：指纹 + 累计指标，默认折叠展示）
    this.postMetrics();
  }

  /**
   * 推送活动指标快照（P2：§13.x 透明面板 + §5.2.1 指纹可见）
   *
   * 从 vscodeTracer 提取最近一轮「模型看到了什么」指纹（只记 hash 不记内容），
   * 从 agent.getMetrics() 取累计指标；推送 webview 折叠区展示。
   * 指纹展示前 12 位（完整 hash 过长，仅作比对/调试抓手）。
   *
   * 深度隐藏（编排对齐）：指标是开发者调试信息，默认不推送——仅当用户显式开启
   * `memora.showMetrics` 配置时才推送，避免对普通用户造成噪音（不推送则 webview
   * 详情区不显示指标块，彻底隐藏而非「显示后折叠」）。
   */
  private postMetrics(): void {
    if (!this._agent) return;
    // 深度隐藏开关：默认 false（普通用户零噪音），调试可观测性时开启
    const show = vscode.workspace.getConfiguration('memora').get<boolean>('showMetrics', false);
    if (!show) return;
    const fp = vscodeTracer.getLatestFingerprints();
    const m = this._agent.getMetrics();
    this.post({
      type: 'metrics',
      fingerprints: {
        systemPromptHash: fp.systemPromptHash ? fp.systemPromptHash.slice(0, 12) : undefined,
        attachedMemoryCount: fp.attachedMemoryCount,
      },
      metrics: {
        llmCallCount: m.llm.callCount,
        recallHitRate: m.recall.hitRate,
        toolFailureCount: m.tools.failureCount,
        truncationCount: m.context.truncationCount,
        // D（alignment-iteration.md）：补齐 token 用量 + 记忆衰减运行次数（decay 可能为 null）
        llmTokenIn: m.llm.totalInputTokens,
        llmTokenOut: m.llm.totalOutputTokens,
        decayRunCount: m.decay?.runCount,
      },
    });
  }

  /**
   * 推送 Follow-up 建议（2026-08-17，T2：回复后关联推荐）
   *
   * 复用内核 governance.suggest()——零 LLM、纯计算（基于记忆库 score + 时效 + 多样性，
   * 见 memoryAdvisor.suggest），把「与你当前关注相关但未直接搜到」的记忆映射为
   * 「下一步可探索」chips 推给 webview。记忆名作 chip 标签（label），prompt 为填入输入框
   * 的完整下一步提问。记忆库为空/未装配（governance null）时不推送（webview 无建议块）。
   */
  private postSuggestions(): void {
    if (!this._agent) return;
    const hits = this._agent.governance?.suggest(undefined, { limit: 3 }) ?? [];
    if (hits.length === 0) return;
    this.post({
      type: 'suggestions',
      items: hits.map((h) => ({
        prompt: `继续深入：${h.name}`,
        label: h.name,
      })),
    });
  }
}

/** 生成 Webview HTML（含消息区 / 输入框 + 模型下拉框 / 主动提问框）
 *  @param scriptUri 外部脚本 chatView.js 的 asWebviewUri（CSP script-src cspSource 加载，阶段 B P2-1）
 *  @param cspSource webview 本地资源源（webview.cspSource，供 CSP script-src 放行 asWebviewUri 外部脚本） */
function buildHtml(scriptUri: vscode.Uri, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src ${cspSource};" />
<style>
  ${chatStyles}
  ${dropdownStyles}
  ${toolCardStyles}
</style>
</head>
<body>
  <!-- SSOT 收敛（2026-08-15）：顶部身份条已删；角色切换独立到「角色」视图（2026-08-17）。
       角色/模型/状态职责归位：模型选择收敛到输入区 composer（model-picker），生成状态由
       思考折叠块 + 发送按钮承载，「谁在回答」由 AI 消息头部标签 msg-ai-label 表达。
       面板结构收敛为三层：消息区 → 活动区 → 输入区。 -->

  <!-- ② 消息流：日期分隔线 + 消息 + 空状态引导（ui-redesign.md §4.1 ②） -->
  <!-- 会话标题条（ADR-024 会话标题层 + 2026-08-17 会话管理重构）：
       左侧 = 会话标题 + 改名笔；右侧 = 新建会话「＋」+ 历史记录按钮。
       「清空对话」已移除（伪需求，删除会话记录覆盖），会话导航全量收敛到标题条。 -->
  <div id="sessionTitleBar" class="session-title-bar" title="当前会话">
    <span id="sessionTitleText" class="session-title-bar__text"></span>
    <button id="renameSessionBtn" class="session-title-bar__btn" title="重命名会话" aria-label="重命名会话">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
    </button>
    <span class="session-title-bar__spacer"></span>
    <button id="newSessionBtn" class="session-title-bar__btn" title="新建会话" aria-label="新建会话">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <!-- 历史记录下拉（SSOT 剪枝 v2，2026-08-17）：复用 treedd 组件——trigger=历史按钮，
         菜单紧挨按钮下方弹出（无遮罩、轻量），开合/外部关闭/Escape 由 initDropdowns 管理 -->
    <div id="historyDd" class="treedd session-history" data-treedd data-on-select="__historyOnSelect">
      <button id="historyBtn" class="treedd__trigger" title="历史记录" aria-label="历史记录" aria-haspopup="menu">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>
      </button>
      <div id="historyMenu" class="treedd__menu" role="menu"></div>
    </div>
  </div>
  <div id="messages">
    <!-- 空状态引导：标题 + 提示 + 示例提问 chips（点击填入输入框，主动引导新用户）。
         标题/提示加 id（P3，2026-08-15 空状态角色化）：由 chatView 随激活角色包动态更新，
         切换角色不产生定位错位；示例 chips 由 chatView 随 showcase 角色动态渲染
         （方案设计师展示"种子收敛"引导，其余角色回退通用打磨引导），容器留空由脚本填充。 -->
    <div id="emptyState" class="empty-state" hidden>
      <div id="emptyTitle" class="empty-title">开始打磨你的设计文档</div>
      <div id="emptyHint" class="empty-hint">在下方输入你的想法，或点击示例提问快速开始</div>
      <div id="emptySuggestions" class="empty-suggestions"></div>
    </div>
    <!-- 一键到底（吸收养分：对齐 TRAE App / TraeWork「上滚后回到底部」）：
         用户上滚阅读离开底部时浮现，点击回到最新消息位置；吸底时隐藏 -->
    <button id="scrollToBottomBtn" class="scroll-to-bottom" hidden
      title="回到底部" aria-label="回到底部">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
    </button>
  </div>

  <!-- ③ 活动状态区（P0 错误 / P1 低扰 单条主状态 + P2 指标折叠详情）
       从顶部迁到消息流下方、composer 上方 —— 不再顶置挤占消息区（ui-redesign.md §3.1 C7）。
       原 memoryBar + noticeBar + metricsBox 三条并列收敛为单一通道，SSOT 不互相覆盖 -->
  <div id="activityBar" class="activity-bar" hidden></div>
  <details id="activityDetail" class="activity-detail" hidden>
    <summary>活动详情</summary>
    <div id="activityList" class="activity-list"></div>
    <!-- Phase 1（2026-08-17 召回可展开）：本次召回明细区，默认隐藏，recalled_items 到达时渲染 -->
    <div id="recallDetail" class="recall-detail" hidden></div>
    <div id="activityMetrics" class="activity-metrics" hidden></div>
  </details>
  <div id="clarifyBar">
    <div id="clarifyText"></div>
    <div id="clarifyOptions"></div>
    <div id="clarifyRow">
      <input id="clarifyInput" type="text" placeholder="回答 Agent 的问题，回车提交……" aria-label="回答 Agent 的问题" />
      <button id="clarifySend">提交回答</button>
    </div>
  </div>
  <div id="inputBar">
    <div id="inputWrap">
      <!-- Phase 3 C3：技能指示器（本轮已激活技能，持续展示到本轮结束） -->
      <div id="skillIndicator" class="skill-indicator" hidden></div>
      <textarea id="input" rows="1" placeholder="在文档上打磨你的想法……（Enter 发送，Shift+Enter 换行）" aria-label="消息输入"></textarea>
      <div id="inputFooter">
        <!-- Composer 左侧组：键盘提示 + 当前角色只读徽章 + 工具权限徽章（让用户感知当前定位；切换入口独立在「角色」视图） -->
        <div class="composer-left">
          <span id="currentRoleBadge" class="role-badge"></span>
          <!-- Phase 4 E2：工具权限徽章（角色能力面可见性，角色切换时自动更新） -->
          <span id="currentCapabilityBadge" class="capability-badge" hidden></span>
        </div>
        <!-- Composer 右侧操作组：模型选择 + 发送（SSOT 收敛：角色切换已移至独立角色视图，
             输入区只保留高频操作——模型切换与发送） -->
        <div class="composer-actions">
          ${buildDropdownHtml([], { extraClass: 'model-picker treedd--capsule', onSelect: '__modelPickerOnSelect' })}
          <button id="send" class="send-btn" title="发送 (Enter)" aria-label="发送">
            <svg class="send-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            <!-- 生成中切换为停止方块（loading 类驱动）：点击 = 停止当前生成（mvp-scope 打断能力） -->
            <svg class="stop-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
  <!-- 阶段 B（P2-1）：运行时脚本由外部 chatView.js 提供（CSP script-src cspSource 加载） -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
}