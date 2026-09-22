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
 *   - 面板为通用对话宿主，功能定位由内核同步的内置角色包承载，
 *     角色名在 AI 消息头部标签 + 空状态标题展示（角色切换已独立到「角色」视图，2026-08-17）。
 */
import * as vscode from 'vscode';
import type { RoundTruncateResult } from '../../extension/host/sessionStore.js';
import {
  defaultSessionTitle,
  formatDateKey,
  getSessionDisplayName,
  resolveContextWindow,
  estimateOccupancy,
  estimateTokensMessages,
  splitSessionId,
  type Agent,
  type AgentChunk,
  type InteractiveInputKind,
  type IRoundStore,
  type ISessionStore,
  type ProcessEvent,
  type SessionMeta,
  type WriteConfirmationRequest,
  type SessionView,
} from '@zooique/memora';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
// 错误文案映射单一真理源（与 webview 重放渲染共用，防文案双源漂移）
import { friendlyErrorMessage } from '../../shared/errorText.js';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { createProvider } from '../../extension/host/llmConfig.js';
import { vscodeTracer } from '../../extension/host/tracer.js';
import { buildDropdownHtml, dropdownStyles } from '../components/dropdown.js';
import { chatStyles } from '../styles/chatStyles.js';
import {
  buildDocContextBlock,
  buildInjectedContextEnvelope,
  stripInjectedContextPrefix,
} from '../helpers/docContext.js';
import { getToolDisplayName } from '../helpers/toolNameMap.js';
import { isSkillDisabled, listVisibleSkills, skillPromptFor } from '../../extension/host/skillAggregation.js';
import type { WorkspaceSessionViewLoader } from '../../extension/host/sessionViewLoader.js';

/** 历史回放单次最大条数：跨天合并视图聚焦近期对话，
 *  防止长期使用后消息累积导致每次打开/切换都全量回放 + 逐条建 DOM（对抗评估 P1-7） */
const MAX_HISTORY_MESSAGES = 200;

/** 历史回放最大轮数（round-based 模式，v1.5）：按完整 round 截断，杜绝「正文有、过程无」的半轮不对称 */
const MAX_HISTORY_ROUNDS = 60;

/**
 * thought 落盘截断上限（字符，2026-09-13，Turn 意图理解与模型思考展示设计）：
 * 模型思考内容可能很长（deepseek 深度思考数千 token），落盘前截断防 Round 文件膨胀
 * （SSOT 常量：仅宿主落盘侧消费；展示侧流式全量，不受影响）。命名与既有 thinking 相位事件无关。
 */
export const MAX_THOUGHT_PAYLOAD_LENGTH = 4000;

/**
 * ask_user 提问等待超时（ms，2026-09-08）：超时未答 → cancelAsk（[ASK_ABORTED] 占位）
 * + resumeExecution('timeout') 自动续跑（LLM 自决）。0/负值 = 禁用超时保底。
 * 语义 = 保底而非打扰：选项/自由输入仍是唯一主动通道，无「跳过」按钮。
 */
const ASK_TIMEOUT_MS = 120_000;

/**
 * ask 超时交互记录正文（镜像内核 orchestrator.ts ASK_TIMEOUT_NOTICE，防运行时/重放
 * 文案分叉——post 给 webview 即时渲染与内核落盘 content 必须同值；改此须同步内核。
 */
const ASK_TIMEOUT_NOTICE = '用户未在时限内回答，已自动继续';

/**
 * 单轮重放视图（v1.5 交织重放）
 *
 * 正文（user/assistant）与过程事件（processEvents）同源同轮——同一 Round 文件内读取，
 * 由 sendRoundView 按 §3.7 时序发送（user → meta → 其余 replay_events → assistant）。
 */
interface ReplayRound {
  /** 问答闭环 ID */
  roundId: string;
  /** 用户消息（缺省 = 该轮无用户正文，如 resume 轮） */
  user?: { content: string; ts?: string };
  /** AI 消息（仅 complete 轮有） */
  assistant?: { content: string; ts?: string };
  /** 是否为中断轮（Round.status === 'interrupted'，2026-09-15）：重放过程独立平铺可见，不进折叠块 */
  interrupted?: boolean;
  /** 该轮过程事件（Round.processEvents；无过程数据则空数组，只回放正文） */
  processEvents: ProcessEvent[];
  /** 问答闭环内交互输入（TS-9：主动提问回答/补充，折叠块渲染，不分裂新轮） */
  interactiveInputs?: {
    content: string;
    ts?: string;
    kind: InteractiveInputKind;
    /** G26：该回答所对的 ask_user 提问原文（question-answer 且随轮落盘时有） */
    question?: string;
    /** G26：LLM 提问候选选项（静态展示用） */
    options?: string[];
  }[];
  /** 问答闭环内前序 assistant 段（TS-9：如主动提问，排在交互输入之前） */
  assistantLog?: { content: string; ts?: string }[];
}

/** 文档上下文注入上限（字符，约 3~4k token，防大文档爆上下文） */
const MAX_DOC_CONTEXT_CHARS = 12000;

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
 *  deleteSession 为 2026-08-17 会话管理重构（历史浮层删除会话记录，替代原 clearSession）。
 *  返回被物理回收的 Round 列表（⑥ 记忆联动），truncateFrom 返回 RoundTruncateResult。
 *  Omit<ISessionStore,'deleteSession'>：避免内核契约 void 签名与宿主扩展 string[] 签名做方法交集导致返回类型坍缩。 */
type HostSessionStore = Omit<ISessionStore, 'deleteSession'> & {
  deleteSession: (sessionId: string) => string[];
  truncateFrom: (date: string, session: string, fromTs: string) => RoundTruncateResult;
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
  /** 系统内置配置目录 + 用户技能目录（extension 注入，composer 动态技能清单来源判定） */
  private _configDir: string | undefined;
  private _userSkillsDir: string | undefined;

  /** 注入技能聚合所需目录（composer 动态技能下拉与设置面板同一清单来源） */
  public setSkillDirs(configDir: string, userSkillsDir: string): void {
    this._configDir = configDir;
    this._userSkillsDir = userSkillsDir;
  }
  /** 当前打磨文档上下文（2026-08-17 A 层：实时跟随活动编辑器，非一次性快照） */
  private _docContext: string | undefined;
  /** 活动编辑器追踪订阅（vscode.window 全局事件，需随面板销毁显式释放，见 ensureEditorTracking） */
  private _editorSub: vscode.Disposable | null = null;
  /** 大模型配置存储（用于底部模型下拉框 + 切换） */
  private readonly _providerStore: ProviderStore;
  /** Agent 懒装配工厂（由 extension 注入，打开面板即装配，不依赖先执行 open 命令） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 是否已尝试装配（避免面板每次展开都重复装配） */
  private _agentResolving = false;
  /**
   * Agent 装配 Promise（T1，2026-09-09 增强）：缓存「在途装配」供等待，而非仅布尔标记——
   * 否则 'ready' 在装配进行中调用 ensureAgent() 会早退，崩溃恢复打捞（依赖 agent.agentHistory）
   * 与首次回放产生时序竞态。装配失败在内部消化（resolves 而非 rejects），等待方不抛。
   */
  private _agentReady: Promise<void> | null = null;
  /** 崩溃残留轮升级为 stop turn 是否已执行（T1，2026-09-09）：每面板实例一次；
   *  升级后轮已 complete + refCount>0，listInterruptedRecent 不再命中，重复执行无意义 */
  private _salvageUpgraded = false;
  /** 当前激活角色包（对话面板承载的定位角色；装配时由 extension 注入，切换时持久化） */
  private _activeRolePack: string | undefined;
  /**
   * 当前活跃会话标识（YYYY-MM-DD-sessionName，ADR-024 会话标题层）
   *
   * 宿主从「按天 main 归档」升级为「手动创建会话」后，当前会话不再固定为
   * 当天 main，而是用户在会话列表中选择/新建的会话。写入内核与回放展示均
   * 以本会话为准（单一真理源），不再有跨天合并视图。
   */
  private _currentSessionId: string;
  /** 是否在流式生成中（由 consumeFlow 维护）：生成中禁止切换历史，
   *  避免重放清空消息区后，进行中的 chunk 污染重放视图（对抗评估 P1-3） */
  private _streaming = false;
  /** 视图重建代数（每次 resolveWebviewView 自增）：供流尾检测「流期间 webview 被折叠/展开
   *  重建过」——重建后新 webview 没有本流的实时投影，落盘完成后须补一次 replaySession 刷全（2026-09-09） */
  private _viewEpoch = 0;
  /**
   * 路径守卫安全审计累计（G6 安全/装配透明，2026-08-23）
   *
   * 由 agent.security.onAudit 订阅累计：total 总审计次数、denied 拒绝次数。
   * audit 事件为内核 SecurityGuard 在路径读/写审批时产出（guardrail 移除后唯一安全信号）。
   */
  private _securityAuditTotal = 0;
  private _securityAuditDenied = 0;
  private _recentSecurityAudits: { type: string; path: string; tool?: string; reason?: string }[] = [];
  /** 安全审计订阅取消函数（幂等管理，防重复绑定） */
  private _securityAuditUnsub: (() => void) | undefined;
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
   * 待发送区排队内容（仅 thinking 态 interject 时写入）
   * UI 层（chatView）据此渲染待发送区预览 + 清空按钮。
   * P2 收敛（Phase 5）：宿主不再维护镜像，每次 post pending_queue_update 时从内核 loop.pendingInterjections 读当前值
   * 清空时机：sessionResumed 事件触发（resume 成功、loop 消费完队列） */
  // NOTE: _pendingQueue 已移除（P2 收敛），SSOT 源头 = agent.getPendingInterjections() → loop.pendingInterjections
  /** 上次推送给 webview 的待发送区长度（2026-09-07 修复：长度变化才 post，SSOT 收敛）
   *  背景：普通插话（thinking 态 interject）不触发 sessionResumed（那是 resume 专有事件），
   *  队列消费后无「空通知」→ 待发送区弹窗残留。统一经 syncPendingQueue 长度变化检测，
   *  让「队列变空」这个真理源变化总能被推送到 webview（消费后必有后续 chunk 触发同步）。 */
  private _lastPendingQueueLen = 0;
  /**
   * 最近一次在途主动提问（questionPending 事件透出，2026-09-08）
   *
   * 运行时渲染同构（SSOT：运行时 qa 行 = 重放 qa 行）：handleResume 发 user(kind='question-answer')
   * 消息时把本次提问原文/候选透出给 webview——重放路径本就随轮带 question（G26），运行时补齐后
   * 两端同构渲染「问→你答」回顾行（提问明文持久在对话流，对齐 TraeWork 展示）。
   * 清空时机：resume 回答提交后（只消费一次）。
   */
  private _lastPendingQuestions: { slot: string; question: string; options?: string[]; allowCustom?: boolean }[] = [];
  /**
   * ask 提问等待超时计时器（2026-09-08 超时保底）：onPendingQuestion / 流尾兜底提问渲染时
   * 启动（覆写式），用户回答/补充消费提问时清除；到点未答 → handleAskTimeout 自动续跑。
   * 生命周期仅限「存在未答提问」窗口——不随 consumeFlow finally 清（ask 暂停后流已结束但等待仍活）。
   */
  private _askTimeout: ReturnType<typeof setTimeout> | undefined;
  /**
   * 待处理写入确认请求（H0）
   *
   * 内核触发写入确认时，host 创建 requestId + pending Promise，向 webview 推送
   * write_confirm_request 审批卡；用户确认/拒绝后 webview 回传 write_confirm_answer，
   * host resolve 对应 pending Promise，回调内核 confirmationHandler。
   * 超时或 webview 不可达时自动拒绝（fail-closed）。
   */
  private _pendingWriteConfirmations = new Map<string, { resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  /**
   * 会话视图加载器（round-based 模式专用，可选）
   *
   * 注入后支持加载 round-based 会话的历史消息。
   * 未注入时仅支持 legacy 模式（向后兼容）。
   */
  private _viewLoader: WorkspaceSessionViewLoader | undefined;
  /**
   * 过程事件落盘目标（Round 存储，v1.5 单文件内聚）
   *
   * 由 extension 注入（与 viewLoader 同一 WorkspaceRoundStore 单例）。
   * 流结束后「读 Round → 附加 processEvents → save」，生命周期随 Round 原子一致
   * （删 round 即删事件、分叉即共享、截断即覆盖）。
   */
  private _eventLogRoundStore: IRoundStore | undefined;
  /** 当前激活 Provider 的显示名（meta 事件 llm 字段来源，随 pushProviders 刷新，SSOT 与模型下拉同源） */
  private _activeProviderDisplayName = '';
  /**
   * 过程事件 seq 全局计数器（2026-09-09 step 原子落盘新增）。
   * 原为 consumeFlow 内局部 seq（每流重置，跨流 seq 冲突）——step 检查点需按 seq 幂等合并增量，
   * 改为实例级单调递增，保证事件 seq 全局唯一，power 幂等去重与保序追加。
   */
  private _processSeq = 0;

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
    // 初始会话：最近活跃会话（SSOT：listSessionMetas 按 updatedAt 降序，[0] 即最近）；
    // 无任何历史会话时不自动创建——新建会话唯一入口为标题条「＋」
    //（2026-08-29 剪枝：移除旧「今天-main」按天归档兜底，杜绝跨天游离出新会话的残留）
    this._currentSessionId = this.sessionStore.listSessionMetas()[0]?.sessionId ?? '';
    // 跟随当前活动编辑器：实时注入「当前打开文档」为对话上下文（2026-08-17 A 层）
    // 原 docContext 仅在 memora.open 命令路径注入一次快照，点活动栏图标打开面板完全
    // 不注入 → Agent 看不到当前文档（bug 根因）。此处持续跟随 activeTextEditor，
    // 任何打开方式（点图标/命令/首次就绪）都生效，切换文档自动更新。
    // 监听生命周期：面板关闭（onDidDispose）释放，面板重建（resolveWebviewView）幂等重注册，
    // 避免折叠/展开反复重建时全局监听泄漏（vscode.window 为全局事件，不随 webview 自动释放）。
    this.ensureEditorTracking();
  }

  /**
   * 注册/重注册活动编辑器追踪监听（幂等：先释放旧订阅再注册，防止重复监听累积）
   */
  private ensureEditorTracking(): void {
    this._editorSub?.dispose();
    this._editorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this._docContext = snapshotDocContext(editor);
    });
    this._docContext = snapshotDocContext(vscode.window.activeTextEditor);
  }

  /**
   * 注入会话视图加载器（用于 round-based 模式会话的历史加载）
   *
   * @param viewLoader 工作区会话视图加载器实例
   */
  public setViewLoader(viewLoader: WorkspaceSessionViewLoader): void {
    this._viewLoader = viewLoader;
  }

  /**
   * 注入过程事件落盘目标（Round 存储，v1.5）
   *
   * @param roundStore 工作区 Round 存储实例（extension 与 sessionStore/viewLoader 共享同一单例）
   */
  public setRoundStore(roundStore: IRoundStore): void {
    this._eventLogRoundStore = roundStore;
  }

  /** 注入 Agent 懒装配工厂（由 extension.ts 提供 getOrCreateAgent） */
  public setAgentFactory(getAgent: (projectPath: string) => Promise<Agent>): void {
    this._getAgent = getAgent;
  }

  /** 由 extension 在装配 Agent 后注入（open 命令路径），同时绑定会话级可观测事件 */
  public setAgent(agent: Agent): void {
    this._agent = agent;
    // 换 agent = 投影源切换（SSOT）：清空待发送区长度投影缓存，防旧 agent 队列长度残留
    // 导致 syncPendingQueue 长度未变误判不推送（新 agent 首 chunk 同步必触发一次推送）
    this._lastPendingQueueLen = 0;
    // 与 ensureAgent 懒装配路径保持一致：注入即绑定，确保事件通知两条路径都生效
    // （bindAgentNoticeEvents 内部先 off 再 on，幂等，折叠展开重复注入不重复注册）
    this.bindAgentNoticeEvents();
    // G6：绑定路径守卫安全审计订阅（幂等，先取消旧订阅再绑新）
    this.bindSecurityAudit();
    // H0：绑定写入确认回调（confirmWrites=true 时触发，默认 fail-closed）
    this.bindWriteConfirmation();
    // 装配注入后统一补推（时序竞态修复，2026-08-15）：
    // webview ready 时 agent 可能尚未装配，replaySession 的 chat_role_pack / pushRolePacks
    // 会因 _agent 为空而跳过推送 → 输入区角色选择器永久缺失。此处装配完成即补推一次，
    // 面板未就绪时 post 静默忽略（_view 为空），由 replaySession 兜底再推。
    // 历史会话占用补推等「装配后补推」也已收口在 refreshAfterAssemble 内，
    // 本方法不再另推一份（否则懒装配路径漏推）。
    this.refreshAfterAssemble();
  }

  /** 推送三源技能清单到 chatView（composer 动态下拉 SSOT：与设置面板共用 listVisibleSkills） */
  private pushSkillList(): void {
    const agent = this._agent;
    if (!agent || !this._configDir) return;
    this.post({
      type: 'skills_loaded',
      skills: listVisibleSkills({
        agent,
        configDir: this._configDir,
        userSkillsDir: this._userSkillsDir ?? '',
      }),
    });
  }

  /**
   * 重推技能清单（供 extension 在「技能启停」配置变更 / 手动重载后调用，SKILL-S3b 2026-09-22）
   *
   * 存在理由：`skills_loaded` 是本面板技能下拉 + chip 的数据源，而两件触发事由**都发生在本面板之外**
   * ——① `memora.disabledSkills` 配置变更；② `memora.reloadSkills` 命令重扫技能池（清单本身会变）。
   * 无本入口时二者都不刷新 ⇒ 下拉「已禁用」标注停留在旧快照、新增技能不出现。
   *
   * 安全：面板未打开时 `post` 静默忽略（`_view` 为空，见 `post` 注释）；agent 未装配时
   * `pushSkillList` 内已有 guard 直接返回 —— 两条路径均不抛，调用方无需 try。
   */
  public refreshSkillList(): void {
    this.pushSkillList();
  }

  /**
   * 角色包内部名 → UI 展示名（SSOT，2026-08-15 演进）
   *
   * 从内核 RolePackManager.listMeta() 反查 manifest.displayName（与工具名中文化
   * 同一体验原则）。displayName 缺省时回退内部名（name）——显示名单一来源 =
   * `displayName ?? name`，替代原 UI 层硬编码 `rolePackDisplayName` 映射。
   *
   * @param rolePack 角色包内部名（如 '白话方案设计师'）
   * @returns UI 展示名（displayName 或回退 name）
   */
  private roleDisplayName(rolePack: string): string {
    const meta = this._agent?.rolePackManager?.listMeta().find((m) => m.name === rolePack);
    return meta?.displayName ?? rolePack;
  }

  /**
   * 获取当前 activePack 的 team 快照（供 chat_role_pack 协议消息携带，可选字段）。
   * SSOT：从内核 rolePackManager.getActiveTeam() 读，不绕过内核直碰 globalState。
   * 宿主 UI 消费端据此决定是否渲染"小组会议启动"图标。
   *
   * @returns team 对象（组长 + 组员数组，组员已截断超限过滤）；无队伍/非组长时 undefined
   */
  private getActiveTeamForProtocol(): { leader: string; members: string[] } | undefined {
    const team = this._agent?.rolePackManager?.getActiveTeam();
    if (!team || team.members.length === 0) return undefined;
    // spread 只读数组为可变引用（protocol.ts team.members 已声明 readonly，post 透传不修改）
    return { leader: team.leader, members: [...team.members] };
  }

  /**
   * Phase 4 E2：推送工具权限徽章（角色切换后能力面随之变化）
   *
   * 从内核 RolePackManager.getActive() 读取当前角色包的 capabilities 与 toolMode，
   * 映射为可读标签（如 file:read → 只读、web:search → 联网），推送给 webview 渲染徽章。
   * 能力面标签映射为中文（简单映射，避免前端硬编码）。
   * 新增策略指示器（strategyHint）：提供只读模式/审批模式/温度分组等关键策略提示。
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

    // 提取策略指示器：从内核完整策略中提炼 UI 友好的摘要
    const strategy = active.strategy;
    // 温度分组：基于 temperature 值动态计算
    const temp = strategy.act?.temperature ?? 0.7;
    const tempGroup = temp >= 0.8 ? 'high' : temp <= 0.4 ? 'low' : 'mid';
    // 推理模式：基于 multiStepReasoning 字段
    const reasoningMode = strategy.act?.multiStepReasoning;

    const strategyHint = {
      toolReadonly: strategy.act?.toolReadonly,
      tempGroup: tempGroup as 'high' | 'mid' | 'low',
      reasoningMode: reasoningMode as 'auto' | 'manual' | undefined,
      summaryFocus: strategy.prepare?.summaryFocus,
      outputLimit: strategy.act?.outputLimit,
    };

    this.post({ type: 'capability_badge', toolMode, capabilities: labels, strategyHint });
  }

  /**
   * 设置当前激活角色包（由 extension 装配时注入）
   *
   * 对话面板为通用宿主，定位由内置角色包承载；角色包名在就绪回放时推送给
   * webview 的 AI 消息头部标签 + 空状态标题（角色切换入口已独立到「角色」视图，2026-08-17）。
   *
   * @param rolePack 角色包内部名（如 '白话方案设计师'）
   */
  public setRolePack(rolePack: string): void {
    this._activeRolePack = rolePack;
    // 视图已就绪时立即推送（而非等待下次 replaySession），保证角色选择器即时刷新；
    // 视图未就绪时由 replaySession 兜底（就绪回放时读取 _activeRolePack 推送）。
    if (this._view) {
      this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(rolePack), traits: this.getActiveTraits(), team: this.getActiveTeamForProtocol() });
    }
  }

  /**
   * 角色包组（会议名单）热更新通知：settingsPanel 保存/删除队伍后调。
   * 不改变当前角色，只重推一次 chat_role_pack（带最新 team 字段）让 chatView 刷新 team 图标。
   * 启动缺口兜底：若 activePack 就是保存/删除的组长 → team 图标立即显隐；
   * 非组长改队不影响 chatView（activePack 不是组长时本来就不显示 team 图标）。
   */
  public refreshActiveRolePackForTeam(): void {
    if (!this._view || !this._activeRolePack) return;
    this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(this._activeRolePack), traits: this.getActiveTraits(), team: this.getActiveTeamForProtocol() });
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
    // 面板重建（折叠/展开）时幂等重注册编辑器追踪（先释放旧订阅），保证监听存活
    this.ensureEditorTracking();
    // 视图重建代数自增：本次流若跨重建，流尾据此补移植（见 _viewEpoch 注释）
    this._viewEpoch += 1;
    // 折叠/展开（对话卡 ↔ 设置卡切换、侧边栏收起再展开）会触发 resolve 重建 HTML。
    // 走「ready 回放」这一确定性机制：重建后 webview 脚本就绪发 ready，extension 再回放
    // 已落盘会话，保证数据不丢（2026-09-09：正在运行的 turn 由 replaySession 的
    // resumeRunningTurn 补推恢复，见 replaySession()；不设 retainContextWhenHidden——
    // 官方语义：隐藏期间 webview 脚本挂起、无法接收消息，运行时现场本就不保真，
    // 交由「设备重建 + 运行中兜底重放」统一恢复，避免两套机制漂移）。
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

    // 视图被销毁（折叠/关闭）时清理引用，避免向已销毁 webview postMessage；
    // 同时释放全局编辑器监听（vscode.window 事件不随 webview 自动释放）
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) this._view = undefined;
      this._editorSub?.dispose();
      this._editorSub = null;
    });

    // 处理来自 webview 的用户输入
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'ready') {
        // webview 脚本就绪后才回放会话（历史 + Provider 列表）。回放前置（T1，2026-09-09）：
        // ① 等 Agent 装配完成（在途即等待，见 ensureAgent 可等待化）② 打捞升级崩溃残留轮为
        // 正常 stop turn——保证升级轮随本次回放一次性投递，不与 _viewEpoch 折叠重建回放双发（T3）
        void this.handleWebviewReady();
      } else if (msg.type === 'send' && msg.text.trim()) {
        void this.handleSend(msg.text.trim(), msg.skillName);
      } else if (msg.type === 'open_config') {
        // UX-1 空态引导按钮：跳转大模型配置（复用既有 configureModel 命令，单一入口）
        void vscode.commands.executeCommand('memora.configureModel');
      } else if (msg.type === 'clarify_answer' && msg.text.trim()) {
        void this.handleResume(msg.text.trim());
      } else if (msg.type === 'clarify_answers' && msg.answers.length > 0) {
        // P2 多 ask 聚合回答（2026-09-22）：answers 与提问按序一对一，全部答完一次性投递
        void this.handleResume(msg.answers);
      } else if (msg.type === 'new_session') {
        // 标题条「＋」新建会话 → 切入空会话，旧会话归档进历史（2026-08-17 会话管理重构）
        void this.newSessionFromCommand();
      } else if (msg.type === 'fork_session') {
        // AI 回复底部「分叉」按钮 → 从指定 Round 位置分叉新会话
        void this.forkCurrentSession(msg.roundId);
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
      } else if (msg.type === 'stop') {
        // 停止生成：中断当前流式输出（mvp-scope 打断能力）
        this.handleStop();
      } else if (msg.type === 'pause') {
        // Phase 4：暂停生成：调 agent.requestPause()（step 边界软暂停）暂停当前流
        this.handlePause();
      } else if (msg.type === 'clear_pending_queue') {
        // Phase 4 收敛（T1 修复 + P2 收敛）：全清内核 queue + 从内核读当前值渲染
        //  之前宿主手动维护镜像双写（易出错），收敛为内核 clearPendingInterjections 原子操作 + getter 读
        const cleared = this._agent?.clearPendingInterjections() ?? 0;
        if (cleared > 0) {
          this.post({ type: 'notice', level: 'info', message: `已清空 ${cleared} 条待发送内容` });
        }
        this.syncPendingQueue();
      } else if (msg.type === 'remove_pending_item') {
        // Phase 4：删除单条 interject（待发送区某条的独立 × 按钮）
        // P2 收敛：不再维护宿主镜像，内核 removePendingInterject 内部已做越界检查，
        // 宿主直接调内核 + 从内核读当前值渲染（SSOT 源头 = loop.pendingInterjections）
        this._agent?.removePendingInterject(msg.index);
        this.syncPendingQueue();
      } else if (msg.type === 'resume') {
        // Phase 4：恢复生成：调 agent.resumeExecution() 续跑
        void this.handleResumeFromPause();
      } else if (msg.type === 'polish_input') {
        // H5 文本润色（输入框入口，2026-08-27）：调 agent.polish(text) 润色输入框内容，
        // 回执 polish_input_result（无 msgId——输入框润色不回写单条消息）
        void this.handlePolishInput(msg.text);
      } else if (msg.type === 'write_confirm_answer') {
        // H0 写入审批卡回传：用户确认/拒绝写入操作
        const pending = this._pendingWriteConfirmations.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingWriteConfirmations.delete(msg.requestId);
          pending.resolve(msg.approved);
        }
      }
    });
  }

  /**
   * 确保 Agent 已装配：若尚未装配则通过工厂懒装配一次
   *
   * 用户可能直接点活动栏面板图标打开（未执行 open 命令），此时 agent 从未装配，
   * 会导致发送无反应。此方法在打开面板时自动装配，失败时给出明确提示。
   *
   * 可等待性（T1，2026-09-09）：装配进行中再次调用会 await 在途 Promise（_agentReady），
   * 而非早退——保证 'ready' 流程可在首次回放前拿到 Agent（崩溃恢复打捞的前置）。
   */
  private async ensureAgent(): Promise<void> {
    // Agent 已注入（open 命令路径先装配）：仍兜底首次无会话自动创建（幂等，仅面板打开触发）
    if (this._agent) {
      this._agentReady ??= Promise.resolve();
      void this.ensureInitialSession();
      return;
    }
    // 首次触发装配并缓存 Promise（等待中的调用方 await 同一实例；失败内部消化不抛出）
    if (!this._agentReady) {
      this._agentReady = this.performAgentAssembly();
    }
    await this._agentReady;
  }

  /** Agent 懒装配实际执行体（ensureAgent 分离：Promise 缓存 + 一次性执行） */
  private async performAgentAssembly(): Promise<void> {
    if (this._agentResolving || !this._getAgent) return;
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
      // G6：绑定路径守卫安全审计订阅（幂等）
      this.bindSecurityAudit();
      // H0：绑定写入确认回调（confirmWrites=true 时触发）
      this.bindWriteConfirmation();
      // 装配完成后统一补推（与 setAgent 路径共用同一收口点）：
      // ready 时 agent 可能尚未装配 / _activeRolePack 未设置，
      // 装配完成即补推，避免输入区角色选择器永久缺失；面板未就绪时 post 静默，
      // 由 replaySession 兜底。
      this.refreshAfterAssemble();
      // 首次启动兜底：装配成功后若无任何会话记录，自动创建首个会话（用户可直接输入）
      void this.ensureInitialSession();
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

  /** contextCompressed：LLM 主动压缩上下文（第二级压缩，与内核自动截断区分） */
  private readonly onContextCompressed = (info: { target: string; replacedCount: number; summaryLength: number }): void => {
    const targetText = info.target === 'earliest_round' ? '最早轮次摘要' : '最大工具结果摘要';
    this.post({
      type: 'notice',
      level: 'info',
      message: `上下文已压缩：${targetText}，替换 ${info.replacedCount} 条消息，摘要 ${info.summaryLength} token`,
    });
  };

  /** conflictDetected 事件已随内核记忆关系图谱收敛移除（2026-08-14） */

  /** archiveFailed：记忆归档失败（内核 stage 现为 'session' 会话归档阶段；洞察层已移除，无 'insight' 阶段） */
  private readonly onArchiveFailed = (info: { stage: string; message: string }): void => {
    this.post({ type: 'notice', level: 'info', message: `记忆归档失败（${info.stage}）：${info.message}` });
  };


  // ─── H2 高价值事件（2026-08-23 第二轮生长） ───

  /**
   * inputTooLarge：装配前输入预算判负（剩余 token 不足以支撑至少一轮正文）
   *
   * 内核 ContextPreparer 在装配前检测输入是否超出预算，触发此事件时
   * 通常意味着直接把大文件内容粘到了对话里，LLM 会因上下文不足报错。
   * 展示 hint（如「建议用 read_file 分段读取」）给用户降级路径。
   */
  private readonly onInputTooLarge = (info: {
    inputLength: number;
    remainingTokens: number;
    hint: string;
  }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `输入过大（${info.inputLength} 字符），剩余预算不足。${info.hint}`,
    });
  };

  /**
   * goalDriftDetected：会话目标漂移检测（相似度低于阈值）
   *
   * 内核 GoalConsistencyChecker 在每轮对话后检测当前目标与初始目标的相似度，
   * 触发此事件时说明会话可能已偏离用户初衷。推送给 webview 展示确认交互。
   */
  private readonly onGoalDriftDetected = (info: {
    sessionId: string;
    mainGoal: string;
    newGoal: string;
    similarity: number;
    level: 'same' | 'confirm' | 'drift';
    constraints: string[];
    goalChangeSeq: number;
  }): void => {
    this.post({
      type: 'goal_drift_detected',
      mainGoal: info.mainGoal,
      newGoal: info.newGoal,
      similarity: info.similarity,
      level: info.level,
      constraints: info.constraints,
    });
  };

  /**
   * sessionForked：会话分叉成功（内核 SessionManager.forkSession 完成后触发）
   *
   * 补充通知路径：host 当前在 forkCurrentSession() 中直接处理分叉结果（同步切换+回放），
   * 此事件监听作为安全网——任何未来不经过 forkCurrentSession 的分叉路径都能获得一致反馈。
   */
  private readonly onSessionForked = (info: {
    from: string;
    to: string;
    roundCount: number;
  }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `已分叉新会话「${info.to}」（${info.roundCount} 个问答闭环）`,
    });
  };

  /**
   * dedupCompleted：L1 工具调用去重完成（连续重复工具调用被自动优化）
   *
   * 内核 Assembler 在 L1 层检测到连续多次相同工具+参数时自动去重，
   * 完成后 emit 此事件让宿主透明化这一自动优化行为。
   */
  private readonly onDedupCompleted = (info: {
    deduplicatedCount: number;
    demotedIds: string[];
  }): void => {
    if (info.deduplicatedCount > 0) {
      this.post({
        type: 'notice',
        level: 'info',
        message: `已自动优化 ${info.deduplicatedCount} 次重复工具调用`,
      });
    }
  };

  // ─── H2 低价值事件（状态冗余确认） ───

  /** sessionPaused：对话被暂停（状态可视化补充） */
  private readonly onSessionPaused = (info: {
    reason: string;
    source: string;
    sessionId?: string;
  }): void => {
    this.post({ type: 'notice', level: 'info', message: `对话已暂停（${info.reason}）` });
  };

  /** sessionResumed：对话恢复执行（状态反馈 + 清空待发送区） */
  private readonly onSessionResumed = (_info: { sessionId?: string }): void => {
    this.post({ type: 'notice', level: 'info', message: '对话已恢复执行' });
    // Phase 4：resume 成功 → loop 消费完 pendingInterjections → 从内核读当前值通知 webview
    // P2 收敛：不再维护宿主镜像，SSOT 源头 = loop.pendingInterjections；
    // 2026-09-07：改走 syncPendingQueue 统一长度变化检测（普通插话不触发本事件，由 step 边界后 chunk 补同步）
    this.syncPendingQueue();
  };

  /** sessionRecovered：对话异常恢复完成（自动恢复反馈） */
  private readonly onSessionRecovered = (_info: { sessionId?: string }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: '对话已从异常中恢复，继续执行',
    });
  };

  /**
   * sessionTitleUpdated：会话标题被 LLM 自动更新（SSOT 同步）
   *
   * 当 SessionNamer 完成标题生成后，Agent 发射此事件。
   * 宿主检查是否为当前会话，若是则推送 session_title 到 webview 刷新顶部标题。
   * 这确保了"对话记录已更新，但顶部未同步"的问题得到解决。
   */
  private readonly onSessionTitleUpdated = (info: {
    sessionId: string;
    title: string;
  }): void => {
    // 仅当更新的是当前会话时才推送（其他会话的标题更新不影响当前 UI）
    if (info.sessionId === this._currentSessionId) {
      this.post({ type: 'session_title', title: info.title });
    }
  };

  /**
   * rolePackSwitched：角色包切换（内核 emit：手动切换 activate / 检查点恢复激活）
   *
   * 三层对齐断点 A1：内核在手动切换或恢复激活角色包时
   * emit rolePackSwitched，此处转发为现有 chat_role_pack 协议消息（复用，不新增类型），webview 即时刷新。
   *
   * Phase 4 E2：同步推送 capability_badge —— 工具权限徽章，展示当前角色的工具模式与能力列表。
   */
  private readonly onRolePackSwitched = (info: { from: string | null; to: string }): void => {
    // SSOT：从同一 rolePackSwitched 事件维护内部激活角色状态，
    // 使其与内核 rolePackManager.activeName 一致，成为 replaySession 的单一真相源。
    // 此前仅 post 给当时可能已被 dispose 的 webview（被静默忽略），未更新 _activeRolePack
    // → 用户从「角色」视图切换后聚焦对话（chat 视图重解析），ensureAgent 因 _agent 已存在
    // 提前返回、refreshAfterAssemble 不再跑 → replaySession 读到陈旧 _activeRolePack
    // → 徽章显示旧角色（与设置视图不一致）。设置视图靠 activateRole 显式 loadRoles 才更新，
    // 两视图真相源分叉即 SSOT 违反。现由同一事件驱动状态，重解析即推正确角色。
    this._activeRolePack = info.to;
    // 仅转发切换后的角色显示名（to），触发角色选择器 + AI 消息标签同步（视图存活时）
    this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(info.to), traits: this.getActiveTraits(), team: this.getActiveTeamForProtocol() });
    // Phase 4 E2：同步推送工具权限徽章（角色切换后能力面随之变化）
    this.postCapabilityBadge();
    // 角色切换后「启用角色包」技能源变化 → 刷新技能清单（composer 动态下拉与设置面板同步，SSOT）
    this.pushSkillList();
    // 角色包底盘占用随切换实时反映到输入区圆环（内核已在切换时重算 setRolePackBaseTokens，
    // 此处直接推当前占用快照即可，不重算、不依赖跑 prepare——ADR-030「切角色包即刷新占用」）
    this.postContextOccupancy();
  };

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
   * rolePackSwitchLocked：角色包切换被**限流锁定**时提示用户（补全 silent failure——用户在
   * 角色视图点「设为当前」触达限流阈值后，此前点击无任何反馈）。
   *
   * 触发面：内核 activate() 仅在**触发锁定**的那一次切换发射本事件（该次切换成功）；
   * 被锁期间的后续切换直接返回 false 且不发射，其提示由 settingsPanel.activateRole 经
   * getRolePackSwitchLockStatus() 分支补发。
   */
  private readonly onRolePackSwitchLocked = (info: { reason: string; lockedSeconds: number }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `角色包切换被锁定：${info.reason}，${info.lockedSeconds} 秒后再试`,
    });
  };

  /**
   * memoryRecalled：LLM 查询记忆库命中 N 条相关记忆（纯工具化后语义，§2.4 保留改语义定案）
   *
   * 纯感知增强——用户不知道 LLM 查了哪些历史/笔记，补一个 info 级提示条。
   * 自动注入退役后唯一触发位 = search_memories 工具命中（assembler 接线）；
   * 对齐内核 builtinToolHandlers.searchMemories 命中点。
   * （原「warmRecall 恢复例外 / checkpointRestoreCoordinator warm recall」触发位随跨重启
   * 恢复链退役，2026-09-10 减法。）
   */
  private readonly onMemoryRecalled = (info: { count: number; query: string }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `LLM 查询记忆命中 ${info.count} 条`,
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
    // P1 后续波：低扰信息（截断/压缩/归档失败）→ info 级提示条
    a.off('contextTruncated', this.onContextTruncated);
    a.on('contextTruncated', this.onContextTruncated);
    // G3：LLM 主动压缩事件订阅（与 contextTruncated 的内核自动截断区分）
    a.off('contextCompressed', this.onContextCompressed);
    a.on('contextCompressed', this.onContextCompressed);
    a.off('archiveFailed', this.onArchiveFailed);
    a.on('archiveFailed', this.onArchiveFailed);
    // A1（alignment-iteration.md）：角色包切换 → UI 角色选择器实时对齐（内核粘性切换/显式激活）
    a.off('rolePackSwitched', this.onRolePackSwitched);
    a.on('rolePackSwitched', this.onRolePackSwitched);
    // G2/G3：项目切换 + 工作投影生成事件 → info 级提示条
    a.off('projectSwitched', this.onProjectSwitched);
    a.on('projectSwitched', this.onProjectSwitched);
    a.off('workProjectionGenerated', this.onWorkProjectionGenerated);
    a.on('workProjectionGenerated', this.onWorkProjectionGenerated);
    // G4：后台事件 → info 级提示条（调试可观测性）
    a.off('configReloaded', this.onConfigReloaded);
    a.on('configReloaded', this.onConfigReloaded);
    a.off('archiveModeChanged', this.onArchiveModeChanged);
    a.on('archiveModeChanged', this.onArchiveModeChanged);
    // G2/G3：角色包切换锁定事件（P0 补全 rolesView 点设为当前被锁时的 silent failure）
    a.off('rolePackSwitchLocked', this.onRolePackSwitchLocked);
    a.on('rolePackSwitchLocked', this.onRolePackSwitchLocked);
    // memoryRecalled：LLM 回答前召回 N 条记忆 → info 级感知提示
    a.off('memoryRecalled', this.onMemoryRecalled);
    a.on('memoryRecalled', this.onMemoryRecalled);
    // H2 高价值事件：输入过大预警 + 目标漂移检测
    a.off('inputTooLarge', this.onInputTooLarge);
    a.on('inputTooLarge', this.onInputTooLarge);
    a.off('goalDriftDetected', this.onGoalDriftDetected);
    a.on('goalDriftDetected', this.onGoalDriftDetected);
    // H2 中价值事件：分叉完成 + 去重完成 + 槽位澄清
    a.off('sessionForked', this.onSessionForked);
    a.on('sessionForked', this.onSessionForked);
    a.off('dedupCompleted', this.onDedupCompleted);
    a.on('dedupCompleted', this.onDedupCompleted);
    // H2 低价值事件：会话状态冗余确认
    a.off('sessionPaused', this.onSessionPaused);
    a.on('sessionPaused', this.onSessionPaused);
    a.off('sessionResumed', this.onSessionResumed);
    a.on('sessionResumed', this.onSessionResumed);
    a.off('sessionRecovered', this.onSessionRecovered);
    a.on('sessionRecovered', this.onSessionRecovered);
    // SSOT 会话标题同步：LLM 自动生成标题后，刷新 webview 顶部标题
    a.off('sessionTitleUpdated', this.onSessionTitleUpdated);
    a.on('sessionTitleUpdated', this.onSessionTitleUpdated);
  }

  /**
   * 绑定路径守卫安全审计订阅（G6 安全/装配透明）
   *
   * 订阅 agent.security.onAudit（内核 SecurityGuard 在路径读/写审批时产出审计事件），
   * 累计 total/denied 计数 + 保留最近若干条供可观测折叠区展示。幂等：先取消旧订阅再绑新。
   */
  private bindSecurityAudit(): void {
    if (this._securityAuditUnsub) {
      this._securityAuditUnsub();
      this._securityAuditUnsub = undefined;
    }
    const guard = this._agent?.security;
    if (!guard) return;
    // 回调累积计数 + 保底最近 3 条（duck-type 匹配内核 AuditEvent，避免强依赖内部类型）
    this._securityAuditUnsub = guard.onAudit((event) => {
      const type = (event as { type?: string }).type ?? 'audit';
      const path = (event as { path?: string }).path ?? '';
      const tool = (event as { tool?: string }).tool;
      // G11：透出内核拒绝原因（pathGuard path-deny 含 reason 如「命中黑名单」「路径越界」）；
      // 此前仅取 type/path/tool 丢弃 reason，导致用户看到「拒绝」却不知为何。
      const reason = (event as { reason?: string }).reason;
      this._securityAuditTotal += 1;
      if (type === 'path-deny' || type === 'write-decline') {
        this._securityAuditDenied += 1;
      }
      // 路径取 basename 防折叠区冗长（可读且不泄露完整目录结构）
      const base = path.split(/[\\/]/).pop() ?? path;
      this._recentSecurityAudits.push({ type, path: base, tool, reason });
      if (this._recentSecurityAudits.length > 3) {
        this._recentSecurityAudits.shift();
      }
    });
  }

  /**
   * H0：绑定写入确认回调（安全增强可选项，confirmWrites=true 时触发）
   *
   * 默认 fail-closed：未启用 confirmWrites 时，内核直接 auto-approve 不触发回调；
   * 启用后通过 webview 审批卡（write_confirm_request/write_confirm_answer）交互，
   * 用户确认放行、拒绝则阻断写入。webview 不可达或超时自动拒绝（fail-closed）。
   */
  private bindWriteConfirmation(): void {
    const agent = this._agent;
    const guard = agent?.security;
    if (!guard) return;
    // 注入确认回调（幂等：onWriteConfirmation 内部覆盖赋值，无重复注册风险）
    const handler: WriteConfirmationRequest = async (info) => {
      // 生成唯一请求 ID，用于匹配 write_confirm_answer
      const requestId = `wc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const fileName = info.targetPath.split(/[\\/]/).pop() ?? info.targetPath;
      // 工具中文名走 toolNameMap 单一真源（2026-09-19 收口）：原此处自带 toolMap，四键中
      // edit_file / create_file / append_file 为**幽灵键**（内核 builtinTools 零存在——唯一
      // 写入工具是 write_file），且 write_file 另起异名「写文件」（toolNameMap = 「写入文件」）
      // → 同工具双中文名。改为复用公开入口，内核工具更名/新增时不再有第二处需同步。
      const toolLabel = getToolDisplayName(info.tool);
      // 超时保护：30 秒无响应自动拒绝（fail-closed）
      const timeoutMs = 30000;
      return new Promise<boolean>((resolve) => {
        // 设置超时 timer
        const timer = setTimeout(() => {
          this._pendingWriteConfirmations.delete(requestId);
          resolve(false); // 超时视为拒绝
          this.post({ type: 'notice', level: 'error', message: `写入确认超时（${toolLabel} ${fileName}），已自动拒绝` });
        }, timeoutMs);

        // 存储 pending 回调
        this._pendingWriteConfirmations.set(requestId, { resolve, timer });

        // 推送审批请求到 webview
        this.post({
          type: 'write_confirm_request',
          requestId,
          targetPath: info.targetPath,
          tool: info.tool,
          description: info.description || `${toolLabel}：${fileName}`,
          permission: info.permission,
          beforeContent: info.beforeContent ?? null,
          afterContent: info.afterContent,
        });
      });
    };
    guard.onWriteConfirmation(handler);
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
    // 运行时守卫（SSOT：与 newSession/switchToSession 同源 _streaming，禁止运行中改会话结构）
    if (this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '生成中，请稍候再删除问答' });
      return;
    }
    // 破坏性操作：确认不可恢复（与「清空对话」同强度确认）
    const choice = await vscode.window.showWarningMessage(
      `确定删除该问答及之后的所有对话？此操作不可恢复。`,
      { modal: true },
      '删除',
    );
    if (choice !== '删除') return;
    try {
      // sessionId 格式契约 SSOT：内核 splitSessionId 拆解（session 名可含连字符）
      const { date, session } = splitSessionId(this._currentSessionId);
      const result = this.sessionStore.truncateFrom(date, session, ts);
      // ⑥ 联动（2026-08-29）：被回收问答闭环（引用归零）的轮次摘要软删进回收站；
      // 会话级摘要（SessionMeta.summary/keyTopics）不联动——会话本身仍在
      if (result.ok) this.softDeleteSessionMemories(result.removedIds);
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
        title: getSessionDisplayName(m),
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
    // 运行时守卫（SSOT：与 newSession/switchToSession 同源 _streaming，禁止运行中改会话结构）
    if (this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '生成中，请稍候再删除会话' });
      return;
    }
    const meta = this.sessionStore.getSessionMeta(sessionId);
    const title = getSessionDisplayName(meta) || sessionId;
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
      // ⑥ 联动（2026-08-29）：整删会话 → 被回收 Round（引用归零）的轮次摘要软删进回收站
      // （脱钩溯源，可恢复为独立记忆）。分叉共享轮由 deleteSession 返回值天然排除——
      // 不影响仍在使用的关联会话记忆。会话级路标存于 SessionMeta，随本调用一并删除。
      const removedIds = this.sessionStore.deleteSession(sessionId);
      void this.softDeleteSessionMemories(removedIds);
      // UX-3：删除成功给用户可见反馈，与「当前会话无法删除」提示对称
      this.post({ type: 'notice', level: 'info', message: '会话已删除' });
    } catch (err) {
      // 删除失败不阻塞（重推列表仍可用），但需记录 + 给用户可见提示（SSOT 不藏错）
      console.warn('Memora 删除会话记录失败', err);
      this.post({ type: 'notice', level: 'error', message: '删除会话失败，请稍后重试' });
    }
    this.pushSessionList();
  }

  /**
   * 随问答闭环物理删除联动软删记忆摘要（⑥，2026-08-29）。
   *
   * 触发语义：Round 引用归 0 被物理回收 → 该轮 round-summary 软删。软删除走现有回收站
   * （deletedAt），恢复后为无溯源独立记忆（脱钩在删除时完成）。
   *
   * 会话级摘要不在此列：它不进记忆库，而存于 SessionMeta（summary/keyTopics），
   * 随 deleteSession 一并删除，无需联动（2026-08-30 收敛）。
   * 降级优先：Agent 未就绪 / 记忆操作异常不阻塞删除主流程。
   *
   * @param removedIds 被物理删除的 Round ID 列表（可空）
   */
  private softDeleteSessionMemories(removedIds: string[]): void {
    if (removedIds.length === 0) return;
    const memory = this._agent?.memory;
    if (!memory) return; // Agent 未就绪：降级跳过（记忆遗留不影响会话删除主流程）
    try {
      memory.softDeleteRoundSummaries(removedIds);
    } catch (err) {
      // 联动失败仅记录：记忆软删属后台治理，不阻断会话删除（SSOT 不藏错）
      console.warn('Memora 联动软删会话记忆失败（降级：记忆遗留，可在记忆治理页手动处理）', err);
    }
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
    // 生成唯一会话名（字母前缀，避免与数字日期混淆；标题层才是用户可读身份）
    await this.createSession(`${formatDateKey(new Date())}-s${Date.now().toString(36)}`);
  }

  /**
   * 切入指定会话（新建/首次自动创建共用）：调内核 switchToSession + 更新当前会话 + 回放
   *
   * @param sessionId 目标会话 id（date-name 格式）
   * @returns 是否切入成功
   */
  private async createSession(sessionId: string): Promise<boolean> {
    const agent = await this.getAgentOrWarn();
    if (!agent) return false;
    if (!agent.sessionManager) {
      this.post({ type: 'notice', level: 'error', message: 'Memora：会话管理未就绪，请稍候再试' });
      return false;
    }
    try {
      await agent.sessionManager.switchToSession(sessionId);
      this._currentSessionId = sessionId;
      this.replayCurrentSession();
      return true;
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 首次启动兜底：无任何会话记录时自动创建首个会话，用户可直接输入（免手动点「＋」）。
   * 仅空态触发（_currentSessionId 为空 = 从未有过会话），有历史/已创建后不再自动创建（幂等）。
   */
  private async ensureInitialSession(): Promise<void> {
    if (this._currentSessionId || this._streaming) return;
    await this.createSession(`${formatDateKey(new Date())}-s${Date.now().toString(36)}`);
  }

  /**
   * 分叉当前会话（AI 回复底部「分叉」按钮触发，B3 会话生命周期补齐，2026-08-22）
   *
   * 薄壳消费内核 forkSession()：把当前对话复制为新分支并切入（工作记忆同步到新分支）。
   * fork 不分叉记忆——记忆索引全局共享，仅对话历史分叉；空会话/对话繁忙由内核拒绝，
   * host 兜底转错误通知。
   */
  public async forkCurrentSession(roundId?: string): Promise<void> {
    if (this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '生成中，请稍候再分叉会话' });
      return;
    }
    const agent = await this.getAgentOrWarn();
    if (!agent) return;

    try {
      // 获取当前会话的最后一个 roundId 作为默认分叉点（SSOT：走 getRoundIds 真源，SessionMeta 无 roundIds）
      const sessionRoundIds = this.sessionStore.getRoundIds(this._currentSessionId);
      const forkRoundId = roundId ?? sessionRoundIds[sessionRoundIds.length - 1];

      if (!forkRoundId) {
        this.post({ type: 'notice', level: 'info', message: '当前会话无可分叉的问答闭环' });
        return;
      }

      // round-based 分叉：从指定 Round 位置创建新会话
      const { newSession, roundCount } = agent.forkSession(forkRoundId);
      this._currentSessionId = `${formatDateKey(new Date())}-${newSession}`;
      this.replayCurrentSession();
      this.post({
        type: 'notice',
        level: 'info',
        message: `已从第 ${roundCount} 个问答闭环节点分叉新会话「${newSession}」`,
      });
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  public async renameCurrentSession(): Promise<void> {
    // 运行时守卫（SSOT：与 newSession/switchToSession 同源 _streaming，禁止运行中改会话结构）
    if (this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '生成中，请稍候再重命名会话' });
      return;
    }
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

  /** 清空 webview 消息区并重放当前会话历史 + 刷新会话标题 + 推送历史会话占用 */
  private replayCurrentSession(): void {
    this.post({ type: 'clear_ok' });
    this.replayHistory();
    this.post({ type: 'session_title', title: this.currentSessionTitle() });
    // 历史会话占用：切会话后圆环即时展示该会话真实占用（而非空态 0%），
    // 与对话记录对齐；对话层从持久化消息重算，记忆层历史会话无法预测故如实置 0
    this.postHistoryOccupancy();
  }

  /**
   * 推送历史会话上下文占用（轻量版，ADR-030 增补）
   *
   * 切到历史会话（含首次启动回放）时调用：圆环从「空态 0%」纠正为「该会话真实占用」——
   *   对话层  = 持久化消息经内核 estimateTokensMessages 求和（与运行时 prepare 同口径）
   *   角色包  = 内核当前激活角色包底盘占用（system prompt 总体 token，装配/切换即确定，
   *             冷启动也有真实值，不再降级为 0；见 context.rolePackBaseTokens）
   *   输入锚点= 0（历史会话无当前输入）
   * 组装复用内核 estimateOccupancy（SSOT 单点，free 收敛口径与运行时 prepare 一致）。
   * 异步仅用于读取当前 Provider 窗口（listMasked），失败静默（圆环维持 chat_providers 空态）。
   */
  private async postHistoryOccupancy(): Promise<void> {
    const agent = this._agent;
    if (!agent) return;
    try {
      // 窗口容量：当前选中 LLM 的上下文上限（SSOT：与 pushProviders 同源 resolveContextWindow）
      const providers = await this._providerStore.listMasked();
      const activeName = this._providerStore.getActiveName();
      const active = providers.find((p) => p.name === activeName);
      const totalTokens = resolveContextWindow(active?.contextWindow);
      // 对话消息序列：round-based（viewLoader）或 legacy 扁平路径统一提取
      const history = this.collectHistoryMessages();
      const dialogueTokens = estimateTokensMessages(history);
      // 角色包固定开销：优先取内核当前激活角色包底盘占用（装配/切换即确定，冷启动也有真实值）；
      // 该指标暂无时回退 occupancy 旧值（兼容极端时序），再回退 0。
      const ctx = agent.getMetrics().context;
      const rolePackBaseTokens =
        ctx.rolePackBaseTokens ?? ctx.occupancy?.rolePackBaseTokens ?? 0;
      const occ = estimateOccupancy({
        totalTokens,
        rolePackBaseTokens,
        dialogueTokens,
        // 计数标准：以用户输入条数计（一个问答闭环=1，残缺回答如实记录），与内核 dialogueCount 口径一致（SSOT）
        dialogueCount: history.filter((m) => m.role === 'user').length,
        inputAnchorTokens: 0,
      });
      this.post({ type: 'context_occupancy', occupancy: occ });
    } catch {
      // 读取 Provider 失败不阻塞会话切换（圆环维持空态，非关键路径）
    }
  }

  /**
   * 提取当前会话全部消息序列（统一 round-based / legacy 两路径，供占用重算）。
   *
   * 与 replayHistory 的展示路径同源：round-based 走 viewLoader 按轮取正文，
   * legacy 走 sessionStore.loadMessages。两路径归一为 {role, content}[]。
   */
  private collectHistoryMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (this._viewLoader) {
      // 会话无轮次记录（新建/空会话）→ 直接返回空，避免触发 loadView「会话不存在」噪音
      // 守卫直用完整 sessionId（getRoundIds 以 sessionId 为键，无需 parse 拼回——parse 再拼回是恒等变换）
      if (this.sessionStore.getRoundIds(this._currentSessionId).length === 0) {
        return msgs;
      }
      const rounds = this.loadRoundBasedHistory();
      for (const r of rounds) {
        if (r.user) msgs.push({ role: 'user', content: r.user.content });
        if (r.assistant) msgs.push({ role: 'assistant', content: r.assistant.content });
      }
      return msgs;
    }
    const history = this.loadMessagesHistory();
    return history.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * 重放会话消息（round-based 交织 / legacy 扁平，统一入口，v1.5）
   *
   * round-based 模式按轮交织发送：正文与过程事件同源同轮（§3.7 时序：user →
   * meta → 其余 replay_events → assistant），webview 与运行时共用同一渲染函数。
   * 读取失败不阻塞面板展示（SSOT 不藏错，避免「历史空白」静默吞因）。
   */
  private replayHistory(): void {
    // 会话管理纯度：无当前会话（初始空态）→ 清空消息区并返回，不进入任何会话回放路径
    if (!this._currentSessionId) {
      this.post({ type: 'clear_ok' });
      return;
    }
    try {
      if (this._viewLoader) {
        this.sendRoundView(this.loadRoundBasedHistory());
        return;
      }
      const history = this.loadMessagesHistory();
      for (const m of history) {
        this.post({ type: m.role, text: m.content, ts: m.ts });
      }
    } catch (err) {
      console.warn('Memora 加载会话历史失败', err);
      // UX-2：历史加载失败给用户可见提示，避免「历史空白」静默（SSOT 不藏错）
      this.post({
        type: 'notice',
        level: 'error',
        message: '加载会话历史失败，可尝试切换会话重试',
      });
    }
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
   * webview ready 处理：等 Agent 装配 + 崩溃残留轮打捞升级 → 再回放会话（T1，2026-09-09）。
   *
   * 回放前置理由：升级后的中断轮须随首次回放（roundIds 已含）一次性投递，避免新增第二条
   * 回放通道（否则与 _viewEpoch 折叠重建回放产生双重复放——T3 互斥目标）。
   */
  private async handleWebviewReady(): Promise<void> {
    try {
      // ① 等 Agent 装配完成（在途即等待；失败内部消化为错误提示，不抛出）
      await this.ensureAgent();
      // ② 打捞升级崩溃残留轮（once-guard；无当前会话/无 Agent 时跳过，等待下次触发再试）
      await this.upgradeInterruptedRounds();
    } catch (err) {
      console.warn('Memora 崩溃恢复打捞升级失败（不阻断历史回放）', err);
    }
    // ③ 回放会话历史（历史 + Provider 列表；升级轮已入 roundIds，随本次回放按普通 turn 投递）
    this.replaySession();
    // 角色 handoff 预填补发：视图解析后 webview 监听器已就绪，安全投递
    if (this._pendingPrefill !== undefined) {
      this.post({ type: 'prefill_input', text: this._pendingPrefill });
      this._pendingPrefill = undefined;
    }
  }

  /**
   * 崩溃残留轮打捞 → 升级为正常 stop turn 并入当前会话（T1，2026-09-09）。
   *
   * 语义定案（step-atomic-persistence.md §一·五）：中断轮 = 正常 turn（等同用户点「停止」）——
   * 可删、入会话 roundIds、作后续上下文，**不是**半成品草稿/孤儿。打捞口
   * `IRoundStore.listInterruptedRecent` 只负责「找到」，本方法完成「升级登记」：
   *   文本派生：seq 升序拼接叙事件（narrate）内容作为恢复的助手文本；无叙述（工具阶段崩溃）
   *   则不写 assistantMessage，仍按 stop 语义收场——内核 `agentHistory.appendInterrupted` 支撑。
   * 幂等/时序：
   *   once-guard（_salvageUpgraded）+ 内核 appendInterrupted 防重 → 升级轮不二次登记、不被
   *   _viewEpoch 折叠重建回放与崩溃恢复重复投递（T3）；升级后轮 complete + refCount>0，
   *   GC 按普通 turn 生命周期处理（随会话删除，T2）。
   * 失败降级：打捞/升级失败仅记日志，不阻断历史回放；未升级轮保持 pending，由 GC 兜底回收。
   */
  private async upgradeInterruptedRounds(): Promise<void> {
    if (this._salvageUpgraded) return;
    const store = this._eventLogRoundStore;
    const agent = this._agent;
    // 前置不足（无当前会话 / 无 Round 存储 / Agent 未就绪）→ 本次不置 guard，等待下次触发再试
    if (!this._currentSessionId || !store || !agent?.agentHistory) return;
    this._salvageUpgraded = true;
    try {
      // date 过滤沿用当前会话日期（崩溃窗口宿主只持当前会话日期，取舍记于设计文档 §八 T2）
      const sessionDate = this._currentSessionId.slice(0, 10);
      // 可选接口（IRoundStore.listInterruptedRecent?）：未实现时跳过打捞（防御性降级）
      const interrupted = store.listInterruptedRecent?.(sessionDate) ?? [];
      if (interrupted.length === 0) return;
      // 按 createdAt 升序登记（保序入 roundIds，恢复后对话时序正确）
      const ordered = [...interrupted].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const round of ordered) {
        // 文本派生：seq 升序拼接 narrate 内容（运行期过程叙述 = 部分助手文本）
        const content = (round.processEvents ?? [])
          .filter((e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate')
          .sort((a, b) => a.seq - b.seq)
          .map((e) => e.payload.content)
          .join('');
        await agent.agentHistory.appendInterrupted(round.id, { content });
      }
      console.info(`Memora 已恢复 ${ordered.length} 个中断轮为普通会话回合`);
    } catch (err) {
      console.warn('Memora 中断轮升级恢复失败（不影响历史回放；未恢复轮由 GC 兜底）', err);
    }
  }

  /**
   * 回放当前会话（历史消息 + 历史日期列表 + Skill + Provider）
   *
   * 仅在 webview 发来 ready（脚本监听器已注册）后调用，避免 postMessage
   * 在监听器就绪前到达而被丢弃（折叠/展开重建 HTML 时尤其明显）。
   */
  private replaySession(): void {
    if (!this._view) return;
    // 恢复当前会话历史消息（ADR-024：只回放 _currentSessionId；round-based 按轮交织重放，v1.5）
    this.replayHistory();
    // 运行中兜底（2026-09-09）：折叠期间 agent 在扩展侧继续跑，重建时若仍有活动流，
    // 补推 thinking 态让 webview 显示运行中（输入禁用 + 停止/暂停按钮），后续 chunk
    // 照常流式追加；本流落盘后的全量回放由 consumeFlow 流尾 _viewEpoch 比对触发。
    if (this._streaming) {
      this.post({ type: 'status', state: 'thinking' });
    }
    // 推送历史加载完成信号 → webview 收到后强制滚到底部（不走吸底逻辑）
    // 解决多条历史消息 rAF 节流导致滚动位置不正确的问题
    this.post({ type: 'history_loaded' });
    // 推送当前会话标题 → webview 顶部展示（主动可见，便于识别当前会话）。
    // 无当前会话（初始空态）→ 推送引导文案而非「新会话 HH:MM」占位，避免误认存在会话
    this.post({
      type: 'session_title',
      title: this._currentSessionId ? this.currentSessionTitle() : '暂无会话（点击上方「＋」新建）',
    });
    // 推送当前激活角色包 → 输入区角色选择器 + AI 消息标签（主动可见）。
    // 即使没有激活的角色包也推送，让 webview 正确处理状态
    if (this._activeRolePack) {
      this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(this._activeRolePack), traits: this.getActiveTraits(), team: this.getActiveTeamForProtocol() });
    } else {
      // 无激活角色包：推送空信息，让 webview 清除角色标签
      this.post({ type: 'chat_role_pack', rolePack: '', traits: undefined });
    }
    // 推送 Provider 列表到 webview（底部模型下拉框）
    void this.pushProviders();
    // A3（alignment-iteration.md）：推送角色包列表到输入区切换下拉
    this.pushRolePacks();
    // Phase 4 E2：补推工具权限徽章（replaySession 时角色信息已就绪）
    this.postCapabilityBadge();
    // 视图重解析时补推三源技能清单（与 refreshAfterAssemble 输出同构，
    // 避免 agent 已装配时 ensureAgent 提前返回导致技能下拉为空）
    this.pushSkillList();
    // 历史会话占用（轻量版）：首次启动回放即推真实占用（而非空态 0%）。
    // _agent 未装配完成时本调用静默跳过，由装配后收口点 refreshAfterAssemble 兜底再推
    // （两条装配入口——memora.open 命令与懒装配——都经该收口点，不漏路径）。
    this.postHistoryOccupancy();
    // P3（2026-09-22）：重放补推任务表看板——replaySession 只认实时 plan_update 消息，
    // 重开面板时若 turn 进行中（generator 未 close）则 checkpoint.plan 仍在，缺的只是 UI 重放
    // 投递——补推一次让任务表看板恢复（turn 结束后内核 clearPlanOnTurnEnd 已清 plan，见下方收口）。
    // _agent 未装配时 postPlanUpdate 静默跳过。
    this.postPlanUpdate();
  }

  /**
   * 文本润色处理（H5 文本润色入口，输入框版本）
   *
   * 调 agent.polish(text) 调用内核 TextPolishManager 润色输入框内容。
   * 内核已实现 2000 字上限和 15s 超时控制，润色完成后回执 polish_input_result
   * （输入框润色无 msgId 概念——结果整体替换输入框，不按单条消息回写）。
   *
   * @param text 待润色的文本（输入框当前内容）
   */
  private async handlePolishInput(text: string): Promise<void> {
    const agent = await this.getAgentOrWarn();
    if (!agent) {
      this.post({ type: 'polish_input_result', ok: false, message: 'Agent 未就绪' });
      return;
    }
    const polisher = agent.polish;
    if (!polisher) {
      this.post({ type: 'polish_input_result', ok: false, message: '润色服务不可用' });
      return;
    }
    try {
      const result = await polisher.polish(text);
      if (result.changed && result.polished) {
        this.post({ type: 'polish_input_result', ok: true, text: result.polished });
      } else {
        // 文本未变化，直接返回原文
        this.post({ type: 'polish_input_result', ok: true, text });
      }
    } catch (err) {
      this.post({
        type: 'polish_input_result',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
      // limitTokens = 每 Provider 的上下文窗口上限（SSOT：经内核 resolveContextWindow 解析，
      // 用户填的 contextWindow 落回内核默认 120K），供 webview 首轮对话前实时渲染占用条容量
      const list = providers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        contextWindow: p.contextWindow,
        limitTokens: resolveContextWindow(p.contextWindow),
      }));
      // meta 事件 llm 字段同源：活跃 Provider 显示名（SSOT 与模型下拉同一来源）
      this._activeProviderDisplayName = list.find((p) => p.name === activeName)?.displayName ?? activeName ?? '';
      this.post({ type: 'chat_providers', providers: list, activeName });
    } catch {
      // 推送失败不阻塞主流程
    }
  }

  /**
   * 装配完成后统一补推（收口点，时序竞态修复 2026-08-15 / 占用补推收口 2026-09-01）
   *
   * 懒装配路径（直接点活动栏面板图标）：ensureAgent 异步装配，webview ready 时
   * _agent 往往尚未就绪，replaySession 会因 _agent 为空（pushRolePacks）或
   * _activeRolePack 未设置（chat_role_pack，仅 open 命令路径的 setRolePack 会设置）
   * 而跳过推送 → 输入区角色选择器永久缺失。装配完成即补推一次：
   *   1. _activeRolePack 缺省时从 agent 实际激活角色补齐（懒装配路径没有 setRolePack）
   *   2. 补推 chat_role_pack → 角色选择器 / AI 消息标签可见（即使无激活角色也推送，
   *      让 webview 正确处理状态）
   *   3. 补推 chat_role_packs → 角色切换入口数据
   *   4. 补推历史会话占用 → 输入区圆环脱离空态 0%
   *
   * 历史会话占用补推原仅挂在 setAgent，导致懒装配路径（ensureAgent）重启/侧栏打开
   * 面板时圆环恒为 0%。2026-09-01 收口：任何装配后补推都只挂在本方法，
   * 不得在 setAgent / ensureAgent 各钉一份（挂两处必漏对称的另一条路径）。
   * 面板未就绪时 post 静默（_view 为空），由 replaySession 兜底；重复推送幂等。
   *
   * SSOT：本方法是「装配后补推」的唯一入口，setAgent 与 ensureAgent 两条装配路径
   * 都必须经过它。任何新增的装配后补推都挂在本方法内，不在调用方各钉一份——
   * 挂两处必然漏掉对称的另一条路径。
   */
  private refreshAfterAssemble(): void {
    if (!this._agent) return;
    // 懒装配路径从未调用 setRolePack：从 agent 实际激活角色补齐（无角色包时为 undefined）
    if (!this._activeRolePack) {
      // ?? undefined：activeName 可能为 null（内核未激活任何角色包），归一并避免 null 赋值
      this._activeRolePack = this._agent.rolePackManager?.activeName ?? undefined;
    }
    // 角色数据：无论是否有激活角色都推送，让 webview 正确更新 UI 状态
    if (this._view) {
      if (this._activeRolePack) {
        this.post({ type: 'chat_role_pack', rolePack: this.roleDisplayName(this._activeRolePack), traits: this.getActiveTraits(), team: this.getActiveTeamForProtocol() });
      } else {
        // 无激活角色包时推送空信息，让 webview 清除角色标签
        this.post({ type: 'chat_role_pack', rolePack: '', traits: undefined });
      }
    }
    // 角色切换入口数据（webview 收到后自动显示输入区内下拉）
    this.pushRolePacks();
    // Phase 4 E2：装配完成即补推工具权限徽章
    this.postCapabilityBadge();
      // 装配完成统一补推三源技能清单（SSOT 收紧：setAgent 与 ensureAgent 懒装配共用本入口，
      // 角色信息与技能清单同一"装配后刷新"逻辑，杜绝某条路径漏推 → composer 下拉为空）
    this.pushSkillList();
    // 历史会话占用（轻量版）：装配完成即补推——replaySession 时 agent 未装配会静默跳过，
    // 装配后 agent.getMetrics 的 rolePackBaseTokens 方为真实值。
    // 本收口点是 setAgent 与 ensureAgent 懒装配两条入口的共用点：占用补推只在此一处，
    // 不得再在 setAgent / ensureAgent 各推一份（否则必漏懒装配路径）。
    void this.postHistoryOccupancy();
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
   * 获取当前激活角色包的性格特征（traits）
   *
   * 从 RolePackManager.getActive() 读取装配后的 traits，用于 chat_role_pack
   * 协议消息的徽章/顶栏展示。无激活角色或无 traits 时返回 undefined。
   */
  private getActiveTraits(): Record<string, number> | undefined {
    const rpm = this._agent?.rolePackManager;
    if (!rpm) return undefined;
    const assembly = rpm.getActive();
    return assembly?.traits;
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
        // 随模型热切换同步上下文窗口上限（per-LLM contextWindow 唯一真理源；
        // resolveContextWindow 回落内核默认 120K，与装配期口径一致），
        // 让内核预算/截断/占用快照与所选模型窗口对齐
        const active = await this._providerStore.getActive();
        this._agent.setContextWindow(resolveContextWindow(active?.contextWindow));
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
   * 从 sessionStore 恢复当前会话的完整历史（round-based 模式，v1.5 交织重放）
   *
   * 每轮恢复策略：
   *   - user 消息：剥离宿主注入的上下文信封前缀（技能块 + `[当前打磨文档内容]` 文档块，
   *     二者均属宿主注入的当前任务上下文，不属于用户实际输入，仅用于 LLM 上下文，
   *     不应回显 —— 与实时回显发裸 input 对称）。
   *   - assistant 消息：完整内容（避免拼接不完整流；仅 complete 状态恢复）。
   *   - processEvents：该轮过程事件（正文与过程同源同轮，与运行时同一渲染数据源）。
   *   - 内核注入的 `<user_input>` 系统消息跳过（由内核 appendUser 持久化的 user 消息替代）。
   *
   * @returns 按轮分组的重放视图（按完整 round 截断，杜绝半轮不对称）
   */
  private loadRoundBasedHistory(): ReplayRound[] {
    if (!this._viewLoader) {
      // 没有 viewLoader 时返回空数组
      console.warn('Memora：round-based 会话需要 viewLoader，但未注入');
      return [];
    }

    try {
      const view: SessionView = this._viewLoader.loadView(this._currentSessionId);
      const rounds: ReplayRound[] = [];

      // 从 SessionView 中提取消息并按轮分组（正文与过程事件同源同轮，v1.5 单文件内聚）
      for (const round of view.rounds) {
        rounds.push({
          roundId: round.id,
          user: round.userMessage?.content
            ? { content: stripInjectedContextPrefix(round.userMessage.content), ts: round.userMessage.timestamp }
            : undefined,
          // assistant 正文块仅 complete 轮挂载 —— **渲染分流判据，非收场判据**（勿替换为
          // isRoundSettled）。中断轮**可能确有** assistantMessage：`MessageHistory.appendInterrupted`
          // 在「有恢复文本」时才写，运行期走 `orchestrator.act` 的 streamResult.content、崩溃打捞走
          // `upgradeInterruptedRounds` 的 narrate 拼接。不挂正文的真正理由 = **同源去双份**：该文本
          // 与下方 processEvents 平铺区内容相同（narrate 即其唯一来源），再挂一块会重复显示。
          // 「是否计入会话视图 / LLM 历史」的判据是 isRoundSettled（见 roundStore.RoundStatus 文档）。
          assistant:
            round.assistantMessage?.content && round.status === 'complete'
              ? { content: round.assistantMessage.content, ts: round.assistantMessage.timestamp }
              : undefined,
          // 中断轮（status==='interrupted'，2026-09-15）：重放过程独立平铺可见，不进折叠块
          interrupted: round.status === 'interrupted' ? true : undefined,
          // 过程事件从 Round 同文件读取；无 processEvents（纯问答轮/异常轮）为空数组
          processEvents: this._eventLogRoundStore?.getById(round.id)?.processEvents ?? [],
          // 交互输入与前序 assistant 段（TS-9：同一闭环节点内，不分裂新轮）
          interactiveInputs: round.interactiveInputs?.map((i) => ({
            content: i.content,
            ts: i.timestamp,
            kind: i.kind,
            // G26：提问原文/选项随轮落盘透出（question-answer；旧数据缺省）
            ...(i.question ? { question: i.question } : {}),
            ...(i.options && i.options.length > 0 ? { options: i.options } : {}),
          })),
          assistantLog: round.assistantLog?.map((m) => ({
            content: m.content,
            ts: m.timestamp,
          })),
        });
      }

      // 按完整 round 截断（杜绝「正文有、过程无」半轮不对称，v1.5）
      return rounds.slice(-MAX_HISTORY_ROUNDS);
    } catch (err) {
      console.warn('Memora 加载 round-based 会话历史失败', err);
      return [];
    }
  }

  /**
   * 按轮交织发送重放视图（UX-9 闭环可视化，2026-09-03）
   *
   * 每轮：user（带 roundId）→ replay_events（含 meta，整批统一重放）→
   * 前序 assistant 段 + 交互输入按时间升序交织（还原打断点 / 提问点时序）→
   * assistant 最终回答（末段，webview 端以同 roundId 判定「同环续接」标记）。
   * 严禁拆分 meta 走 process_event：process_event(meta) 在 webview 端被当作「运行时新轮开始」，
   * 会调用 prepareFlowShell() 建骨架 assistant 块，导致后续 assistant 正文又 append 第二个块
   * （同一轮出现两条独立消息块的 bug）。replay_events 处理自行从数组提取 meta 设身份，无骨架副作用。
   * 所有 user/assistant 消息均携带 roundId——这是三个新枝（行内打断分条 / 同环续接 /
   * 交互输入挂靠 round-block）的共同底座，纯展示判定，不做内核落库改造。
   *
   * 时序还原说明（A）：打断补充（supplement）插在它打断的那段 AI 正文之后、最终回答之前，
   * 由 webview 渲染为行内打断切分条，语义还原内核 interject() 的 abort→续跑语义（符号定位：内核 loop 的 interject；不写行号——行号无 SSOT）。
   * 交互输入按 ts 升序与前序 assistant 段交织：ts 缺失时保持稳定序（段 → 提问回答 → 补充）。
   */
  private sendRoundView(rounds: ReplayRound[]): void {
    for (const r of rounds) {
      // 主用户输入（roundId 全程携带：同环连线底座，webview 依此重置「续接」判定）
      if (r.user) this.post({ type: 'user', text: r.user.content, ts: r.user.ts, roundId: r.roundId });
      // 整批统一发 replay_events（含 meta）：拆分 meta 走 process_event 会让 webview 端把
      // 该轮当「运行时新轮」触发骨架创建，产生重复消息块（原因见方法注释，勿再拆分）
      if (r.processEvents.length > 0) {
        // interrupted 标志随 replay_events 透出：webview 据此把中断轮过程独立平铺、不进折叠块
        this.post({
          type: 'replay_events',
          roundId: r.roundId,
          events: r.processEvents,
          ...(r.interrupted ? { interrupted: true } : {}),
        });
      }
      // —— 中间段：前序 assistant 段 + 交互输入按时间升序交织（还原真实时序）——
      const middle: {
        kind: 'seg' | 'qa' | 'supp' | 'timeout';
        content: string;
        ts?: string;
        question?: string;
        options?: string[];
      }[] = [
        ...(r.assistantLog ?? []).map((m) => ({ kind: 'seg' as const, content: m.content, ts: m.ts })),
        ...(r.interactiveInputs ?? []).map((i) => {
          // kind 归一：qa=question-answer；supp=supplement；timeout 原样透传（2026-09-08 超时保底，
          // 渲染「未回答」行须携带提问原文，不可并入 supp/qa 丢语义）
          const kind =
            i.kind === 'supplement' ? ('supp' as const) : i.kind === 'timeout' ? ('timeout' as const) : ('qa' as const);
          return {
            kind,
            content: i.content,
            ts: i.ts,
            ...(i.question ? { question: i.question } : {}),
            ...(i.options && i.options.length > 0 ? { options: i.options } : {}),
          };
        }),
      ].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
      for (const item of middle) {
        if (!item.content) continue;
        if (item.kind === 'seg') {
          this.post({ type: 'assistant', text: item.content, ts: item.ts, roundId: r.roundId });
        } else if (item.kind === 'qa' || item.kind === 'timeout') {
          this.post({
            type: 'user',
            text: item.content,
            ts: item.ts,
            roundId: r.roundId,
            kind: item.kind === 'timeout' ? 'timeout' : 'question-answer',
            // G26：回答所对的提问原文/选项随重放消息携带（webview 还原问题块；supp 不携）
            ...(item.question ? { question: item.question } : {}),
            ...(item.options && item.options.length > 0 ? { options: item.options } : {}),
          });
        } else {
          this.post({ type: 'user', text: item.content, ts: item.ts, roundId: r.roundId, kind: 'supplement' });
        }
      }
      // 最终回答（末段）：webview 以同 roundId 判定「同环续接」（B）
      if (r.assistant) {
        this.post({ type: 'assistant', text: r.assistant.content, ts: r.assistant.ts, roundId: r.roundId });
      }
    }
  }

  /**
   * 回退路径：经 ISessionStore.loadMessages 加载（round-based 展开 roundIds→Rounds）
   *
   * 与 loadRoundBasedHistory 语义一致，仅在 viewLoader 未注入时启用。
   */
  private loadMessagesHistory(): { role: 'user' | 'assistant'; content: string; ts?: string; roundId?: string }[] {
    // sessionId 格式契约 SSOT：内核 splitSessionId 拆解
    const { date, session } = splitSessionId(this._currentSessionId);
    const result: { role: 'user' | 'assistant'; content: string; ts?: string; roundId?: string }[] = [];
    const msgs = this.sessionStore.loadMessages(date, session) as {
      role?: string;
      content?: string;
      timestamp?: string;
      roundId?: string;
    }[];
    for (const m of msgs) {
      if (!m.content || m.content.startsWith('<user_input>')) continue;
      result.push({
        role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as
          | 'user'
          | 'assistant',
        content: m.role === 'user' ? stripInjectedContextPrefix(m.content) : m.content,
        ts: m.timestamp,
        roundId: m.roundId,
      });
    }
    // 按时间升序（消息存储顺序可能因多次回放而乱序）
    result.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    // 上限保护：仅回放最近 MAX_HISTORY_MESSAGES 条
    return result.slice(-MAX_HISTORY_MESSAGES);
  }

  /** 当前会话标题（无元数据时回退占位标题，不暴露 sessionId，供 UI 展示） */
  private currentSessionTitle(): string {
    return getSessionDisplayName(this.sessionStore.getSessionMeta(this._currentSessionId)) || defaultSessionTitle();
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }

  /** 处理用户输入：面板上屏 + Agent 流式对话（持久化由内核 appendUser 完成，SSOT 不双写）
   *
   * 插话语义（无缝注入，缺口 B）：生成中用户 Enter 输入补充 → 不中断 loop，调 agent.interject()
   * 排队，内核在下一 step 边界并入为 user 消息继续执行；UI 即时上屏，webview 据此开新助手块。 */
  private async handleSend(input: string, skillName?: string): Promise<void> {
    if (!this._agent) {
      // Agent 未装配（可能仍在懒装配中）：提示用户稍候，而非静默无反应
      void vscode.window.showWarningMessage('Memora：Agent 尚未就绪，请稍候片刻再发送');
      return;
    }
    // 会话管理纯度（2026-08-29 剪枝）：无当前会话（无历史时的初始空态）→ 引导手动
    // 新建，绝不隐式创建会话。新建会话唯一入口 = 标题条「＋」（回归主流，手动唯一）。
    if (!this._currentSessionId) {
      this.post({ type: 'notice', level: 'info', message: '请先点击上方「＋」新建会话再开始对话' });
      return;
    }
    // 无缝插话（Phase 4 收敛，flag 驱动 SSOT）：生成中 Enter 补充 → 不中断 loop，调 agent.interject() 将内容排队，
    //  内核在下一 step 边界统一并入为 user 消息继续执行。不 abort 旧流、不发起新 chat——
    //  正在进行的 runFlow 继续；UI 即时上屏，排序由 webview 在收到下一条 chunk 时开新助手块。
    //  pausePending 窗口（flag=true 但 step 还没跑完）发补充 → interject + 自动 cancelPauseRequest（一行覆盖暂停操作）。
    if (this._streaming && this._abortController) {
      this.post({ type: 'user', text: input, ts: new Date().toISOString(), kind: 'supplement' });
      this._agent.interject(input);
      // 新增：pausePending 期间发补充 → 自动取消暂停（一行改动，覆盖暂停操作）
      // pause_btn_state 消息已删除（UI 本地 toggle），cancelPauseRequest 即可；
      // UI 状态会在下一次 status 切换（如后续新 runFlow thinking）时自动重置
      if (this._agent.isPausePending()) {
        this._agent.cancelPauseRequest();
        // 取消暂停（因补充输入覆盖）→ 同步恢复「暂停」形态
        this.post({ type: 'pause_pending', pending: false });
      }
      // 竞态兜底（2026-09-22，配合 consumeFlow paused 分支 break）：pause 申请已被 step
      // 边界消费（内核已挂起 status='paused'、consumeFlow 的 _streaming 未复位的毫秒窗口）
      // 时入队的 interject 会无 step 边界消费 → 立即 resumeExecution(undefined) 驱动，
      // 补充内容由续跑首个 step 边界 _handleInterrupt 注入（不重复 appendUser）。
      if (this._agent.sessionManager?.status === 'paused') {
        await this.runFlow((signal) => this._agent!.resumeExecution(undefined, signal, 'supplement'));
        return;
      }
      // 新增：通知 webview 待发送区刷新（thinking + 有输入才显示）
      // P2 收敛：不再维护 _pendingQueue 镜像，从内核 queue 读当前值（SSOT 源头）；
      // 2026-09-07：改走 syncPendingQueue 统一长度变化检测（入队/消费/清空/删除/step 边界共用）
      this.syncPendingQueue();
      return;
    }
    // TS-9：暂停态补充输入 → 不发起新 chat() → 走 resumeExecution 路由（保留闭环节点归属，不分裂）
    const now = new Date().toISOString();
    if (this._agent.sessionManager && this._agent.sessionManager.status === 'paused') {
      this.clearAskTimeout(); // 暂停态补充 = 已响应当前等待（含 ask 提问），关闭超时保底
      this.post({ type: 'user', text: input, ts: now, kind: 'supplement' });
      await this.runFlow((signal) => this._agent!.resumeExecution(input, signal, 'supplement'));
      return;
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
    // 用户消息持久化由内核 chat() → appendUser 完成（写入当前会话 _currentSessionId），
    // 此处不再 persist，避免与内核双写同一条消息（SSOT 单一真理源）
    this.post({ type: 'user', text: input, ts: now });

    // 注入选中技能提示（SSOT 收紧，2026-08-25：技能名 → 内核技能正文，替代原前端硬编码 systemPrompt）
    let skillBlock = '';
    if (skillName) {
      try {
        skillBlock = await skillPromptFor(this._agent, skillName);
      } catch {
        skillBlock = '';
      }
      // 响亮失败（SKILL-S2，2026-09-22）：技能被禁用时注入**静默落空**（`skillPromptFor` 按既有
      // 契约返回空串 = 技能不存在，消息照常发出），用户零反馈。此处补上提示 —— 对照主流
      // （Claude Code / WorkBuddy 的 `off` 态）按名调用明确报错。
      // 三个边界不变：① 仍**照常发送**（拒绝发送 = 改发送语义，不在本次范围）；
      // ② 判定走 `isSkillDisabled`（收口到与 `resolveSkill` 同序的真源，非自读配置副本）；
      // ③ `notice` 只进 UI 不喂模型 ⇒ 不侵犯 S4「禁用对 LLM 静默」语义。
      // 前置 `!skillBlock`：仅在**确实发生落空**时报，避免「判定说禁用、实际却注入成功」的假报。
      if (!skillBlock && isSkillDisabled(this._agent, skillName)) {
        this.post({
          type: 'notice',
          level: 'error',
          message: `技能「${skillName}」已禁用，本次未注入（消息已照常发送）。可在设置 → 技能中启用后重试。`,
        });
      }
    }
    // 注入文档上下文（当前任务上下文，不进入记忆召回）。
    // 信封构造与剥离同源收口在 helpers/docContext（技能块在前、文档块在后；无任何块时
    // **不加信封**，不注入「用户请求：」分隔符），回放侧因此可安全以分隔符为界还原用户请求。
    const docBlock = this._docContext ? buildDocContextBlock(this._docContext) : '';
    const chatInput = buildInjectedContextEnvelope([skillBlock, docBlock], input);

    // runFlow 统一管理 AbortController + consumeFlow + 同步抛错兜底
    await this.runFlow((signal) => this._agent!.chat(chatInput, signal));
  }

  /** 启动/重置 ask 等待超时计时器（覆写式；超时保底入口，2026-09-08） */
  private armAskTimeout(): void {
    this.clearAskTimeout();
    if (!ASK_TIMEOUT_MS || ASK_TIMEOUT_MS <= 0) return;
    this._askTimeout = setTimeout(() => {
      void this.handleAskTimeout();
    }, ASK_TIMEOUT_MS);
  }

  /** 清除 ask 等待超时计时器（用户回答/补充消费提问、离开等待态时调用） */
  private clearAskTimeout(): void {
    if (this._askTimeout) {
      clearTimeout(this._askTimeout);
      this._askTimeout = undefined;
    }
  }

  /**
   * ask 提问等待超时（2026-09-08 保底，非打扰通道）：用户未在时限内回答 →
   * ① 渲染「问 + 未回答」交互行（与 qa 同构，question/options 随行透出）；
   * ② cancelAsk 注入 [ASK_ABORTED] 占位 tool result（转存提问快照供落盘）；
   * ③ resumeExecution('timeout') 自动续跑——LLM 看到「用户未回答该提问」自决最优方案。
   * 选项/自由输入仍是唯一主动通道，超时只是保底（用户明确不要「跳过」按钮）。
   */
  private async handleAskTimeout(): Promise<void> {
    if (!this._agent) return;
    this._askTimeout = undefined; // 一次性触发
    if (this._lastPendingQuestions.length === 0) return; // 已被回答/补充消费
    if (this._agent.sessionManager?.status !== 'paused') return; // 已离开暂停（异常/新流）
    const now = new Date().toISOString();
    const pendingQ = this._lastPendingQuestions[0];
    this._lastPendingQuestions = []; // 消费式（与 handleResume 同构）
    this.post({
      type: 'user',
      text: ASK_TIMEOUT_NOTICE, // 镜像内核 orchestrator ASK_TIMEOUT_NOTICE（运行时 = 重放同构）
      ts: now,
      kind: 'timeout',
      ...(pendingQ?.question ? { question: pendingQ.question, options: pendingQ.options } : {}),
    });
    // cancelAsk 先于 resume：注入 [ASK_ABORTED] 占位 + 转存提问快照（runResume timeout 分支取走落盘 question）
    this._agent.cancelAsk();
    await this.runFlow((signal) => this._agent!.resumeExecution(undefined, signal, 'timeout'));
  }

  /**
   * 处理用户对主动提问的回答：answerQuestion 结构化回填 + resumeExecution 续跑
   *  2026-09-04：内核提问收敛为 ask_user 工具——先 answerQuestion 以 tool result 回填
   *  （与 assistant.tool_calls 配对，结构合法），再由 resumeExecution 续跑（回答 text
   *  作为新 user 输入注入并记录交互归属 question-answer，round 不分裂）。
   *  TS-9：回答落盘由内核 runResume 按交互归属写入同闭环节点，宿主不双写。
   *  P2（2026-09-22）：支持 string | string[] —— 多 ask 聚合回答（clarify_answers）传入
   *  数组，answers 与提问按序一对一：逐条 post 透出「你答」交互行 + answerQuestion(answers)
   *  数组回填 + resumeExecution 以 join 全文注入（内核 answerQuestion 原生支持数组）。
   * @param input 单条回答文本 / 多问聚合回答数组
   */
  private async handleResume(input: string | string[]): Promise<void> {
    if (!this._agent) return;
    this.clearAskTimeout(); // 提问被回答：关闭超时保底
    // 竞态守卫（2026-09-08 超时保底引入）：提问已超时自动续跑（RUNNING）或流异常结束 →
    // 迟到回答丢弃——resume 前提 = paused，此处前置防「UI 已渲染你答行却无续跑」的分叉
    if (this._agent.sessionManager?.status !== 'paused') return;
    const answers = Array.isArray(input) ? input.map((a) => a.trim()).filter(Boolean) : [input.trim()];
    if (answers.length === 0) return;
    const now = new Date().toISOString();
    // 回答上屏（折叠块标记；与重放 qa 行同构——question/options 透出，webview 渲染「问→你答」回顾行）；
    // 持久化由内核 resumeExecution → runResume 按交互归属写入同闭环节点，宿主不双写。
    // P2：多问按序逐条透出，question/options 与答案同序配对
    const pendingQs = this._lastPendingQuestions.splice(0); // 消费式：一次提问只透出一次（防跨提问残留串题）
    for (let i = 0; i < answers.length; i++) {
      const pendingQ = pendingQs[i];
      this.post({
        type: 'user',
        text: answers[i],
        ts: now,
        kind: 'question-answer',
        ...(pendingQ?.question ? { question: pendingQ.question, options: pendingQ.options } : {}),
      });
    }
    await this.runFlow((signal) => {
      // ask_user 工具：答案先行回填为 tool 结果（幂等：无在途提问时 no-op 返回 false）。
      // 数组按序一对一回填；join 全文作为持续输入注入（多答合并为一条会话语义）
      this._agent!.answerQuestion(answers);
      return this._agent!.resumeExecution(answers.join('\n'), signal, 'question-answer');
    });
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
  /**
   * 停止生成：用户主动中断执行（Phase 4 暂停/恢复后硬停止对齐）
   *
   * 三种运行态行为：
   *   - thinking（_streaming=true）→ abort() 当前流，内核在下一 await 点退出 yield aborted
   *   - paused（status=paused, _streaming=false）→ 调 agent.discardCurrentCheckpoint 清检查点
   *     （对称语义：pause=想继续；stop=彻底放弃，检查点不应残留）
   * done 态无停止按钮（UI 隐藏）。 */
  private handleStop(): void {
    // thinking 态：已有路径
    if (this._streaming && this._abortController) {
      this._abortController.abort();
      return;
    }
    // paused 态：彻底放弃暂停检查点（对称 pause 语义）
    if (this._agent?.sessionManager?.status === 'paused') {
      // Phase 4 收敛：内核已暴露 discardCurrentCheckpoint，不再靠"下一次 chat() 会重建"隐式清理
      const cleaned = this._agent.discardCurrentCheckpoint();
      this.post({ type: 'status', state: 'done' });
      if (cleaned) {
        this.post({ type: 'notice', level: 'info', message: '已停止，暂停检查点已清理' });
      }
    }
  }

  /**
   * 暂停生成：用户软暂停当前 Agent 执行（Phase 4 暂停/恢复）
   *
   * 调 agent.requestPause() step 边界软暂停（状态机翻 PAUSED 由内核收口，非申请即翻转）；
   * 空闲态（无进行中流）提前拦截给明确提示。
   */
  /**
   * 暂停按钮行为 toggle（宿主层裁决，UI 纯投影）
   *
   * UI 只负责显示 pause（‖）图标，不维护任何本地 toggle 状态——图标永远不变，
   * hidden 由会话状态机驱动（thinking 显示，paused/done 隐藏）。
   * 点击后的行为裁决完全在宿主层，点击即反馈（2026-09-07 收紧）：
   *   - agent.isPausePending()=true → cancelPauseRequest()（反悔）+ 告知已取消
   *   - 否则 requestPause()：
   *      返回 true（运行中入队）→ 告知「暂停申请已发送，将在当前步骤完成后暂停」
   *      返回 false（空闲守卫作废 / 幂等 / paused、error）→ 告知「任务已结束，申请未生效」
   * 不再对 requestPause 返回值保持沉默——「有按钮就有反馈」。
   */
  private handlePause(): void {
    if (!this._agent) return;
    if (this._agent.isPausePending()) {
      this._agent.cancelPauseRequest();
      // 申请已取消 → 通知 webview 恢复「暂停」形态（用户可再点申请）
      this.post({ type: 'pause_pending', pending: false });
      // 点击即反馈：取消申请也要明确告知（2026-09-07 用户要求「有按钮就有反馈」）
      this.post({ type: 'notice', level: 'info', message: '已取消暂停申请（将继续运行）' });
      return;
    }
    const ok = this._agent.requestPause('user-pause', 'user');
    if (ok) {
      // 申请已入队（step 边界未到）→ 提前把按钮切为「继续」形态：申请即暂停，不需等 step 结束
      this.post({ type: 'pause_pending', pending: true });
      // 点击即反馈：申请已入队，step 边界生效（用户知情，不再"点了没反应"）
      this.post({ type: 'notice', level: 'info', message: '暂停申请已发送，将在当前步骤完成后暂停' });
    } else {
      // 作废路径：空闲守卫（任务已结束）/ 幂等 / paused、error 态——统一明确告知
      // （2026-09-07 收紧后空闲不再翻状态机，任务结束的暂停申请直接作废）
      // 申请未生效 → 恢复「暂停」形态
      this.post({ type: 'pause_pending', pending: false });
      this.post({ type: 'notice', level: 'info', message: '当前任务已结束，暂停申请未生效' });
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

  /**
   * 按 seq 幂等合并过程事件（2026-09-09 step 原子落盘·SSOT 单一合并语义）。
   *
   * step 检查点与流尾完成共用本函数，避免两份合并逻辑漂移；靠 seq 全局唯一
   * （_processSeq 单调）天然幂等——step 检查点已写入的增量，流尾重合并不会重复追加，保序。
   *
   * 合并规则（对齐既有 TS-9 / TS-12c）：
   * - 终态净化（TS-12c）：prior 中旧流 aborted/metrics 恒剔除——终局终态恒为末流。
   * - 身份去重（TS-9）：多流续跑（prior 非空）时剔除 incoming 的 meta——身份保留首流，
   *   续跑不重复身份；单流轮（prior 空）保留 meta（现状 else 分支等价）。
   * - 幂等去重：incoming 中 seq 已写入的丢弃（跨流不重叠，seq 全局唯一）。
   *
   * @param prior Round 既有 processEvents（前流/上次检查点产物，可为空）
   * @param incoming 本流当前已累积事件（含刚 emit 的 step_boundary / 末轮 metrics）
   * @returns 合并后数组（不改写存储，落盘由调用方决定）
   */
  private mergeProcessEvents(prior: ProcessEvent[], incoming: ProcessEvent[]): ProcessEvent[] {
    // 终态净化：旧流 aborted/metrics 剔除（终态恒为末流，TS-12c）；单流轮 base 为空故不影响
    const base = prior.filter((e) => e.type !== 'aborted' && e.type !== 'metrics');
    // 身份去重：仅多流续跑（prior 非空）剔 incoming 的 meta，避免重复身份（TS-9）
    const freshIncoming = prior.length > 0 ? incoming.filter((e) => e.type !== 'meta') : incoming;
    // 幂等去重：seq 全局唯一，incoming 中已写入的丢弃；fresh 恒在 base 之后（seq 单调保序）
    const have = new Set(base.map((e) => e.seq));
    const fresh = freshIncoming.filter((e) => !have.has(e.seq));
    return [...base, ...fresh];
  }

  /**
   * step 原子检查点：把当前轮已累积过程落盘到 pending Round（2026-09-09 档2）。
   *
   * 崩溃发生在 appendAssistant 完成前时，过程经此逐步持久化（非等流尾一次性）→
   * 进程被杀只丢当前 step，之前完成 step 的过程在库，重启后经
   * IRoundStore.listInterruptedRecent 打捞 → upgradeInterruptedRounds 升级为正常 stop turn
   * （§一·五：非半成品草稿，T1 收口）。
   * 幂等（seq 全局单调 + mergeProcessEvents），多次检查点/流尾各调无害不重复。
   * fire-and-forget：失败仅记日志，不阻塞展示（对齐 P1 降级语义）。
   *
   * @param roundId 当前 turn roundId（内核 chunk 携带）
   * @param events 该轮当前已累积过程事件（含刚 emit 的边界/metrics）
   */
  private checkpointRound(roundId: string, events: ProcessEvent[]): void {
    const store = this._eventLogRoundStore;
    if (!store || !roundId || events.length === 0) return;
    try {
      const round = store.getById(roundId);
      if (!round) return;
      round.processEvents = this.mergeProcessEvents(round.processEvents ?? [], events);
      store.save(round);
    } catch (err) {
      console.warn('Memora step 原子检查点落盘失败', err);
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
    // TS-O3/TS-O5：提问渲染双源归一——questionPending 事件优先驱动提问 UI，question_pending chunk 作幂等兜底。
    // 内核保证事件先于 chunk 到达（loop 先 onPendingQuestion 回调、后 yield chunk）：事件驱动时清空 chunk 缓存，
    // chunk 仅作「事件监听未就绪/异常」时的兜底渲染源（消除单点事件依赖，问题不丢失）。
    let clarifyEventDriven = false;
    const clarifyChunkQueue: {
      slot: string;
      question: string;
      options?: string[];
      allowCustom?: boolean;
    }[] = [];
    // 监听主动提问事件 → 渲染提问框（含 LLM 声明的候选选项，webview 渲染为可点击按钮）
    const onPendingQuestion = (questions: (
      { slot: string; question: string; options?: string[]; allowCustom?: boolean }[]
    )) => {
      clarifyEventDriven = true;
      clarifyChunkQueue.length = 0; // 事件为准，丢弃可能残留的 chunk 缓存
      this._lastPendingQuestions = questions; // 缓存供 handleResume 透出（运行时 qa 行 question/options 同构）
      this.post({ type: 'need_clarify', questions });
      this.armAskTimeout(); // 超时保底（2026-09-08）：未答 → 自动续跑
    };
    this._agent.on('questionPending', onPendingQuestion);
    // 监听记忆沉淀事件（memoryAdded，非 chunk 通道）→ 与 chunk 同源进过程事件缓冲（v1.5 单源，
    // 渲染/落盘同一份 ProcessEvent）
    const onMemoryAdded = (info: { id: string; source: string; name: string }) => {
      emitEvent('memory_added', { id: info.id, name: info.name, source: info.source });
    };
    this._agent.on('memoryAdded', onMemoryAdded);

    // P0-2：进入生成状态（webview 展示加载动画 + 禁用输入）
    this.post({ type: 'status', state: 'thinking' });
    // 置位生成态：会话切换/新建据此拒绝（P1-3，避免重放与进行中流混血）
    this._streaming = true;
    // 记录流起始视图代数：流尾比对 _viewEpoch 判断「流期间 view 被折叠/展开重建过」
    // （重建后新 webview 无本流实时投影 → 落盘完成须补 replaySession 刷全，2026-09-09）
    const flowViewEpoch = this._viewEpoch;
    // P1：流式第一条 chunk 的时间戳（作为本轮 assistant 回复的时间）
    const firstChunkTs = new Date().toISOString();
    // 流开始时刻与 token 累计快照（metrics 事件需本轮增量：结束减开始）
    const flowStartMs = Date.now();
    const metricsBefore = {
      in: this._agent.getMetrics().llm.totalInputTokens,
      out: this._agent.getMetrics().llm.totalOutputTokens,
      // 未解析工具意图累计基准（2026-09-14）：本流增量 = 终结时累计 - 本基准
      unparsed: this._agent.getMetrics().tools.unparsedToolIntentCount,
    };
    // 过程事件缓冲 + 单形态投影（v1.5 协议纯化）：流式期间攒内存、逐条 post process_event，
    // 流结束按 turn roundId 分组附到各 Round.processEvents 落盘。
    // 分段归属 SSOT：roundId 由内核 chunk 携带（AgentChunk.roundId，2026-09-02），
    // 不再依赖「roundIds 末尾」推断当前轮——一次 chat()（多 turn 任务编排）多 turn 各自独立落盘。
    // step 检查点按 seq 幂等合并增量落盘（seq 实例级单调，见 _processSeq，2026-09-09）。
    const eventsByRound = new Map<string, ProcessEvent[]>();
    let currentRoundKey: string | undefined;
    /** 当前 turn 是否已补 meta 首条（每 turn 段首条身份，角色/模型显示名） */
    let metaEmittedForRound = false;
    const roundMeta = () => {
      const role = this._activeRolePack ? this.roleDisplayName(this._activeRolePack) : 'AI';
      const llm = this._activeProviderDisplayName || this._providerStore.getActiveName() || '';
      return { role, llm };
    };
    /** 构造过程事件：进缓冲（按 turn 分段，落盘真相源）+ 即时投影给 webview（渲染真相源），同一份数据 */
    const emitEvent = (typeKey: ProcessEvent['type'], payload: ProcessEvent['payload']): void => {
      // seq 实例级全局单调（_processSeq）：step 原子检查点按 seq 幂等合并，跨流/跨轮不冲突
      const seq = ++this._processSeq;
      const event = { type: typeKey, seq, ts: new Date().toISOString(), payload } as ProcessEvent;
      // 归属当前 turn 分段（无 roundId 的宿主自造事件归入最近 turn）
      if (currentRoundKey) {
        const list = eventsByRound.get(currentRoundKey) ?? [];
        list.push(event);
        eventsByRound.set(currentRoundKey, list);
      }
      this.post({ type: 'process_event', event });
    };
    // Phase 4：暂停标记——当轮是否收到 paused chunk（软暂停状态）
    let pausedOnPurpose = false;
    // 流首 plan 快照补推标记（2026-09-17，PLAN-UI-1 后续）：prepare 期预置的会议骨架/续会计划
    // 不经 task_table_* 工具调用（无 tool_start/tool_result 事件）→ 若不补推，顶部 #planBar 要等
    // 首次 task_table_update 才出现（turn 大半程不可见）。首 chunk 到达时 prepare 已完成、
    // checkpoint 已就绪 → 补推一次即可（幂等：plan 空则推空消息，无害）。
    let planPushedOnce = false;
    try {
      for await (const chunk of gen) {
        if (!planPushedOnce) {
          planPushedOnce = true;
          this.postPlanUpdate();
        }
        // 待发送区同步（SSOT，2026-09-07 修复弹窗残留）：step 边界推进 = 队列消费的直接信号
        // ——interject 在 _handleInterrupt splice(0) 消费后，本 for-await 必然收到下一个 chunk，
        // 此刻从内核读队列（已变空）→ 长度变化 → post 空 items → webview 隐藏待发送区。
        // 普通插话（thinking 态 interject）不触发 sessionResumed，此处是它的唯一清空时机。
        this.syncPendingQueue();
        // turn 边界检测：roundId 变化 = 新 turn 开始（多 turn 任务编排多 turn 各自独立 roundId）
        if (chunk.roundId && chunk.roundId !== currentRoundKey) {
          currentRoundKey = chunk.roundId;
          metaEmittedForRound = false;
        }
        // 每 turn 段首条补 meta（身份，SSOT 与消息标签同源）；处理当前 chunk 前先补，保证 meta 为段内首条
        if (currentRoundKey && !metaEmittedForRound) {
          metaEmittedForRound = true;
          emitEvent('meta', roundMeta());
        }
        // 提问 chunk（question_pending）：事件优先驱动，chunk 幂等兜底（TS-O3/TS-O5）。
        // 事件已驱动（内核先回调、后 yield chunk）→ 跳过；未驱动 → 攒缓存，流尾统一兜底渲染（避免逐条 post 后者覆盖前者）
        if (chunk.type === 'question_pending') {
          if (!clarifyEventDriven) {
            clarifyChunkQueue.push(...chunk.questions);
          }
          continue;
        }
        if (chunk.type === 'tool_pending') {
          // 工具意图预告（2026-09-17）：LLM 流式生成 tool_call 参数期间（name 成形即上报），
          // 工具尚未执行。瞬态展示轨：**必须 continue、不 emitEvent**（不落盘、不进 eventsByRound、
          // 不吃 seq），roundId 自带在消息上（不依赖 currentRoundKey 变量），webview 据此渲染
          // 「准备中」工具行；后续 tool_start 过程事件按 toolCallId 与该行配对升级。
          this.post({
            type: 'tool_pending',
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            roundId: chunk.roundId,
          });
          continue;
        }
        if (chunk.type === 'aborted') {
          // 用户 stop/插话 → 内核 abort 应答。⚠ 不要 break：break 会触发 async iterator 的
          // return() 提前终止整条 yield* 链（chat → runChat → act → consumeExecutionStream），
          // 导致内核 act() 的中断保存（appendAssistant 半截内容 + roundId 登记）永不执行，
          // 表现为「中断后的问答闭环不落盘」。必须让流自然走完（aborted 是末块，后续无 text）。
          // 中断通知统一由本方法末尾按 controller.signal.aborted 发出。
          emitEvent('aborted', { reason: chunk.reason, ...(chunk.stopReason ? { stopReason: chunk.stopReason } : {}) });
          continue;
        }
        if (chunk.type === 'text' && chunk.content) {
          // 自审查输出（stage='self_review'）→ 过程事件（渲染进折叠区 § 自审查输出，不进正文流）
          if (chunk.stage === 'self_review') {
            emitEvent('text_self_review', { content: chunk.content });
            continue;
          }
          // 主回答正文 → 照常走 chunk 消息（markdown 渲染，属内容轨，不属于过程事件）。
          // roundId 透传（D3 单轨，2026-09-03）：运行时段同为「同环续接」判定提供数据依据，
          // 与重放路径共用「roundId 相等」单一判定源（chunk.roundId 由内核 withRound 携带）
          this.post({ type: 'chunk', content: chunk.content, ts: firstChunkTs, roundId: chunk.roundId });
        } else if (chunk.type === 'tool_start') {
          // 工具调用开始 → 过程事件（webview 渲染 § 工具调用）
          emitEvent('tool_start', { toolCallId: chunk.toolCallId, name: chunk.name, args: chunk.args });
          // H4 任务驱动多步闭环：LLM 调用任务表工具时 → 推送当前计划快照给 webview 渲染任务看板
          // （薄壳装配：仅从 agent.getCheckpoint().plan 提取只读快照，不参与 LLM 执行。
          //  任务看板归 checkpoint 执行态，不进过程事件）
          if (chunk.name === 'task_table_write' || chunk.name === 'task_table_update') {
            this.postPlanUpdate();
          }
        } else if (chunk.type === 'tool_result') {
          // 工具调用结束 → 过程事件（§ 工具调用 完成态；失败计入 metrics.toolFailureCount）
          // 策略拦截（2026-09-02）：blocked 透传，UI 显示「已拦截」而非「成功/失败」
          emitEvent('tool_result', {
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            ok: chunk.ok,
            summary: chunk.summary,
            ...(chunk.blocked ? { blocked: true } : {}),
          });
          // N/M 闪骨架计数（2026-09-17）：tool_start 时读到的 plan 是工具执行前的旧状态
          // （如会议骨架 2 步），工具落定后才是新 plan（如 4 步）——tool_result 补推一次快照，
          // 消除「1/2 → 1/4」的一次性闪烁
          if (chunk.name === 'task_table_write' || chunk.name === 'task_table_update') {
            this.postPlanUpdate();
          }
        } else if (chunk.type === 'selfReview') {
          // 自审查终审开始 → 过程事件（§ 自审查输出 头部）
          emitEvent('self_review', {});
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
          // Agent 暂停（输入待定/step 边界软暂停）→ 转发提示条 + 标记暂停态。
          // ⚠ 必须 break（2026-09-22 实证：暂停后输入补充卡死）：内核 yield paused 后
          // generator 即 return 结束、无后续 chunk；此前不 break 导致 for-await 挂在已结束
          // 的流上，finally 的 _streaming=false 永不执行 → 整个暂停期 _streaming 恒 true，
          // handleSend 因此永远命中「interject 排队」分支——暂停态没有 step 边界消费队列，
          // 补充输入永远卡在待发送区直到用户手动「继续」。break 让 _streaming 及时复位，
          // 暂停态补充正确路由到 resumeExecution(input)（一步即继续，恢复历史行为）。
          this.post({ type: 'paused' });
          pausedOnPurpose = true;
          break;
        } else if (chunk.type === 'thinking') {
          // 思考阶段 → 过程事件（webview 渲染 § 过程轨迹）
          emitEvent('thinking', { phase: chunk.phase });
        } else if (chunk.type === 'narrate') {
          // P2 过程叙述 → 过程事件（webview 渲染 § 过程叙述 折叠行，不进正文流）
          // A1 回抽（2026-09-12）：首轮工具步的叙述曾逐字流式进正文区 → 先发瞬态撤回消息让
          // webview 去掉正文该段，再落 narrate 事件渲染进过程叙述行（顺序：撤正文 → 补过程）。
          // withdrawn 为运行时瞬态（不落盘）；持久化正文已由内核 consumeExecutionStream 扣除。
          if (chunk.withdrawn) {
            this.post({ type: 'narrate_withdraw', text: chunk.withdrawn });
          }
          emitEvent('narrate', { content: chunk.content });
        } else if (chunk.type === 'thought') {
          // 模型思考内容（thought）→ 过程事件（webview 渲染「思考」折叠块，不进正文流）。
          // 落盘前超长截断（SSOT 常量 MAX_THOUGHT_PAYLOAD_LENGTH）：展示侧流式全量，
          // 存储侧受控；重启重放可见（ProcessEvent union 已含 thought 成员；与既有 thinking 相位事件区分）。
          emitEvent('thought', {
            // 常量语义 = 含省略标记的总上限（slice MAX-1 + '…' 恒 ≤ MAX）
            content:
              chunk.content.length > MAX_THOUGHT_PAYLOAD_LENGTH
                ? `${chunk.content.slice(0, MAX_THOUGHT_PAYLOAD_LENGTH - 1)}…`
                : chunk.content,
          });
        } else if (chunk.type === 'step_boundary') {
          // 步级折叠边界（阶段二，2026-09-08）：active 任务表步骤推进 → 落盘 step_boundary 事件。
          // webview 据此把后续过程事件归入对应 step 分组；重放与运行时同一边界（同构）。
          emitEvent('step_boundary', {
            ...(chunk.stepId ? { stepId: chunk.stepId } : {}),
            ...(chunk.title ? { title: chunk.title } : {}),
          });
          // step 原子检查点（2026-09-09 档2）：推进到新 step 即把当前已产过程落盘 pending Round，
          // 崩溃只丢当前 step——之前完成 step 的过程在库，重启可经 listInterruptedRecent 恢复。
          // 幂等（seq 单调 + mergeProcessEvents），与流尾共用同一合并语义（SSOT）。
          if (currentRoundKey) {
            this.checkpointRound(currentRoundKey, eventsByRound.get(currentRoundKey) ?? []);
          }
        } else if (chunk.type === 'error') {
          // 流内错误 → 复用现有 error 协议消息（webview 已有分支，雷-3）。
          // TS-10b：按内核产出的 category 映射友好文案（connection/timeout/unknown），
          // 无 category（普通错误）回退原始 message——语义分类走结构化字段，不做裸前缀/字符串匹配。
          // 映射 SSOT = shared/errorText（原内联 friendlyByCategory 已收敛，见该文件头）。
          this.post({
            type: 'error',
            message: friendlyErrorMessage(chunk.category, chunk.message),
            category: chunk.category,
          });
          // 重放可见性（2026-09-15，LEG-1 缺口②）：error 此前**只 post 不落 processEvents** →
          // 实时有提示条，回看历史却只剩 generic「对话已中断」= 失败原因永久丢失。
          // 落盘存**原始 message + category**（非友好文案）——与 `aborted` 存 reason + stopReason
          // 的既有范式同构：事件是「UI 重建真相源」，文案由展示层每次映射（文案改版对历史同样生效）。
          emitEvent('error', {
            message: chunk.message,
            ...(chunk.category ? { category: chunk.category } : {}),
          });
        }
      }
      // 流尾兜底：本流产生提问 chunk 但事件未驱动（监听未就绪/异常）→ 用 chunk 缓存渲染提问 UI，问题不丢失
      if (!clarifyEventDriven && clarifyChunkQueue.length > 0) {
        this.post({ type: 'need_clarify', questions: clarifyChunkQueue });
        this._lastPendingQuestions = clarifyChunkQueue;
        this.armAskTimeout(); // 兜底渲染同享超时保底（2026-09-08）
      }
      // assistant 消息持久化由内核 appendAssistant 完成（写入当前会话 _currentSessionId），
      // 此处不再 persist，避免与内核双写同一条回复（SSOT 单一真理源）
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this._agent.off('questionPending', onPendingQuestion);
      this._agent.off('memoryAdded', onMemoryAdded);
      // 无论成败均清除生成态（恢复历史切换能力，P1-3）
      this._streaming = false;
      // 清理本轮 AbortController：仅当仍是本轮的 controller（防止下一轮已创建新 controller）
      if (this._abortController === controller) this._abortController = undefined;
    }
    // 结束状态：用户打断（abort() 已置 signal.aborted）→ interrupted（webview 渲染
    // 「已停止」并恢复输入框）；软暂停 → status:paused（按钮切为「继续」）；
    // 正常结束 → done。三者均恢复/切换按钮态，仅提示语义不同。
    // 附带本轮回答归属的 roundId（SSOT：来自 chunk 携带的 turn roundId，非 roundIds 末尾推断）：
    // webview 据此回填消息分叉按钮（任意 LLM 回答可分叉）。
    const latestRoundId = currentRoundKey;
    // 过程事件落盘（v1.5 收敛）：metrics 末条归入最后 turn + 按 turn roundId 分组
    // 写入各自 Round（SSOT：归属来自内核 chunk.roundId，一次 chat() 多 turn 各自独立落盘）。
    // fire-and-forget：失败仅记日志，不阻塞展示（对齐 P1 消息持久化降级语义，SSOT 不藏错）
    if (this._eventLogRoundStore && eventsByRound.size > 0) {
      const metricsNow = this._agent.getMetrics();
      emitEvent('metrics', {
        durationMs: Date.now() - flowStartMs,
        tokenIn: Math.max(0, metricsNow.llm.totalInputTokens - metricsBefore.in),
        tokenOut: Math.max(0, metricsNow.llm.totalOutputTokens - metricsBefore.out),
        // 工具失败计数：与内核口径对齐（策略拦截 blocked 既非成功亦非失败，不计入失败），
        // 语义为本轮增量。内核对应用计数是累计（this.metrics.toolFailureCount），非本轮 diff，不可直接复用。
        toolFailureCount: [...eventsByRound.values()]
          .flat()
          .filter((e) => e.type === 'tool_result' && !e.payload.ok && !e.payload.blocked).length,
        // 本轮未解析文本工具意图增量（2026-09-14）：「想调用工具却未走原生协议」不得显示为成功收尾
        unparsedToolIntentCount: Math.max(
          0,
          this._agent.getMetrics().tools.unparsedToolIntentCount - metricsBefore.unparsed,
        ),
        success: !controller.signal.aborted && !pausedOnPurpose,
      });
      // step 原子检查点（2026-09-09 档2）：流尾最终落盘复用同一合并语义（SSOT）——
      // 与 step_boundary 时的增量检查点共用 mergeProcessEvents，靠 seq 幂等不重复、保序。
      // TS-9 跨流累积 / TS-12c 终态净化已收在 mergeProcessEvents 内，此处不再重复实现。
      for (const [roundId, roundEvents] of eventsByRound) {
        this.checkpointRound(roundId, roundEvents);
      }
    }
    // 流期间 view 被折叠/展开重建过 → 新 webview 未投影本流（隐藏期 chunk/process_event
    // 消息被丢弃），此刻数据已完整落盘，补一次 replaySession 全量回放恢复完整回合——
    // 否则用户切回时只见历史不见本轮运行结果（2026-09-09 缺口修复）
    if (this._viewEpoch !== flowViewEpoch) {
      this.replaySession();
    }
    // plan 快照对齐：generator close 后内核 clearPlanOnTurnEnd 已清 plan（暂停态 guard 不清），
    // 此处推一次快照让 webview 同步——正常/中断 → 空 steps（顶部条收起）；
    // 暂停 → 保留当前 plan（paused 分支前面，plan 还没被清，继续供 resume 消费）
    this.postPlanUpdate();
    if (controller.signal.aborted) {
      this.post({ type: 'interrupted', roundId: latestRoundId });
      this.post({ type: 'status', state: 'done' });
    } else if (pausedOnPurpose) {
      // 软暂停：不推送 done/interrupted，切换为 paused 状态（允许用户继续）
      this.post({ type: 'status', state: 'paused' });
    } else {
      this.post({ type: 'done', roundId: latestRoundId });
      // status:done 延后到摘要完成（或 5s 兜底）——防 done 后立即删除导致孤儿 round-summary
      // 摘要 Promise 的 then/catch 都会 emit roundSummaryGenerated（成功或失败），正常事件很快到达；
      // 5秒兜底足够抗偶发网络抖动，避免 UI 长时间卡在 thinking 态让用户困惑
      const SUMMARY_WAIT_TIMEOUT_MS = 5_000;
      // 局部捕获 agent——函数入口已 guard this._agent，但 setTimeout 闭包内 tsc 不传播 guard，
      // 局部变量让闭包捕获到确定存在的引用（入口 if (!this._agent) return 已保证到此点必有值）
      const agent = this._agent;
      let resolved = false;
      /** 解锁回调：受 _streaming 状态门控，防跨轮竞态（旧轮事件误触冲掉新轮 thinking） */
      const unlockDone = () => {
        if (resolved) return;
        resolved = true;
        // 竞态防护：新轮已开始 → 跳过，让新轮走自己的 done 流程
        if (this._streaming) return;
        this.post({ type: 'status', state: 'done' });
      };
      const timeoutHandle = setTimeout(() => {
        // 超时也手动解绑事件监听，防累积泄漏（.once 只在触发时自动解绑，超时不触发会遗留 handler）
        agent?.off('roundSummaryGenerated', onSummary);
        unlockDone();
      }, SUMMARY_WAIT_TIMEOUT_MS);
      const onSummary = (_info: { roundId: string; success: boolean }) => {
        clearTimeout(timeoutHandle);
        unlockDone();
      };
      agent?.on('roundSummaryGenerated', onSummary);
      // T2 Follow-up 建议：仅正常结束时推送（零 LLM、纯计算；打断/异常不给不完整回复挂建议）
      this.postSuggestions();
    }
    // 本轮流式结束 → 推送活动指标快照（P2：指纹 + 累计指标，默认折叠展示）
    this.postMetrics();
    // ④ 预算可视化：推送上下文占用快照（输入区常驻指示器，脱离 showMetrics 独立常驻）
    this.postContextOccupancy();
  }

  /**
   * 推送任务看板快照（任务驱动多步闭环的最小可视化）
   *
   * 从 agent.getCheckpoint().plan 提取当前计划步骤快照，推给 webview 渲染任务看板。
   * 仅当 plan 非空时推送（空计划不产生看板）。薄壳装配：只读提取，不参与 LLM 执行，
   * 任务表的创建/推进由内核 task_table_write/update 工具完成，宿主仅做可视化消费。
   *
   * 任务节点聚合：额外从 checkpoint.stepLog 提取 planStepId 关联，按步骤分组携带各 step
   * 推进记录（stepLog），webview 展开任务节点时展示该步骤下的推进摘要。
   */
  private postPlanUpdate(): void {
    if (!this._agent) return;
    const checkpoint = this._agent.getCheckpoint();
    // checkpoint 不存在时推空消息让 webview 清看板；plan 为空也推（autoClearPlan 后）
    if (!checkpoint || !checkpoint.plan) {
      this.post({ type: 'plan_update', steps: [] });
      return;
    }
    // plan 为空时也推（turn 结束 autoClearPlan 或 LLM 新任务写入空 plan）
    if (checkpoint.plan.length === 0) {
      this.post({ type: 'plan_update', steps: [] });
      return;
    }
    // 步骤 → 关联 step 推进记录（stepLog 的 planStepId 关联，内核已写入，宿主只读消费）
    const stepsByStep = new Map<string, { planStepId: string; summary: string; completedAt?: number }[]>();
    for (const r of checkpoint.stepLog ?? []) {
      if (!r.planStepId) continue;
      const list = stepsByStep.get(r.planStepId) ?? [];
      list.push({ planStepId: r.planStepId, summary: r.summary, completedAt: r.completedAt });
      stepsByStep.set(r.planStepId, list);
    }
    // 按 order 排序列化（内核 PlanStep 已含 order，防冗余中断序漂移）
    const steps = [...checkpoint.plan]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ id: s.id, description: s.description, status: s.status, order: s.order, stepLog: stepsByStep.get(s.id) ?? [] }));
    this.post({ type: 'plan_update', steps });
  }

  /** 待发送区同步（SSOT 收敛，2026-09-07 修复弹窗残留）：
   *  真理源 = 内核 queue（loop.pendingInterjections），宿主只做「长度变化检测」投影。
   *  历史 bug：清空时机绑定 sessionResumed（resume 专有事件），普通插话（thinking 态 interject）
   *  不触发 → 队列消费后无「空通知」→ webview 待发送区弹窗残留。本方法在调用方（入队/清空/
   *  删除/step 边界后 chunk）统一调用，队列变空必然触发长度变化 → post 空 items → webview 隐藏。 */
  private syncPendingQueue(): void {
    if (!this._agent) return;
    // optional 调用（2026-09-07）：consumeFlow 主循环每 chunk 同步，测试桩可能缺该方法
    // （chatPanelHistory 的 mock agent 不实现 getPendingInterjections）——缺则跳过不阻断流
    const items = this._agent.getPendingInterjections?.() ?? [];
    // 长度未变不重复 post（同一队列状态不刷屏）；入队/消费/清空/删除均改变长度 → 必触发一次
    if (items.length === this._lastPendingQueueLen) return;
    this._lastPendingQueueLen = items.length;
    this.post({ type: 'pending_queue_update', items });
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
    // B9 可观测补齐：提取最近操作流（span 标签序列）供透明面板渲染
    const traces = vscodeTracer.getRecentTraces(20);
    // G6 安全/装配透明：推送路径守卫审计概要（有审计事件才携带）
    const securityAudit =
      this._securityAuditTotal > 0
        ? { total: this._securityAuditTotal, denied: this._securityAuditDenied, recent: [...this._recentSecurityAudits] }
        : undefined;
    this.post({
      type: 'metrics',
      fingerprints: {
        systemPromptHash: fp.systemPromptHash ? fp.systemPromptHash.slice(0, 12) : undefined,
      },
      metrics: {
        llmCallCount: m.llm.callCount,
        toolFailureCount: m.tools.failureCount,
        // 未解析工具意图（2026-09-14 静默失败修复）：累计数与内核口径一致，供诊断面板观察
        unparsedToolIntentCount: m.tools.unparsedToolIntentCount,
        truncationCount: m.context.truncationCount,
        // D（alignment-iteration.md）：补齐 token 用量
        llmTokenIn: m.llm.totalInputTokens,
        llmTokenOut: m.llm.totalOutputTokens,
        // ④（2026-08-29）：透出最近一次装配的上下文预算构成（prepare 计算，指标快照携带）
        ...(m.context.budget ? { budget: m.context.budget } : {}),
      },
      trace: traces,
      ...(securityAudit ? { securityAudit } : {}),
    });
  }

  /**
   * 推送上下文占用快照（④ 预算可视化 · 输入区常驻指示器）
   *
   * 与 postMetrics 不同：本推送**脱离 memora.showMetrics 开关**，每轮流式结束必推，
   * 供输入区常驻渲染「上下文占用比例条 + hover 明细」。数据来自内核
   * AgentMetrics.context.occupancy（prepare 期真实用量），宿主只透传、不重算。
   */
  private postContextOccupancy(): void {
    if (!this._agent) return;
    const ctx = this._agent.getMetrics().context;
    const occ = ctx.occupancy;
    if (!occ) return;
    // 角色包底盘占用可能已在切换时由内核刷新（setRolePackBaseTokens），早于下一轮 prepare；
    // 用最新底盘值覆盖快照中的旧值，使圆环在角色包切换即时反映，无需等到下一轮。
    const freshRolePack = ctx.rolePackBaseTokens;
    if (freshRolePack !== undefined && freshRolePack !== occ.rolePackBaseTokens) {
      this.post({
        type: 'context_occupancy',
        occupancy: estimateOccupancy({
          ...occ,
          rolePackBaseTokens: freshRolePack,
        }),
      });
      return;
    }
    this.post({ type: 'context_occupancy', occupancy: occ });
  }

  /**
   * 推送 Follow-up 建议（2026-08-17，T2：回复后关联推荐）
   *
   * 复用内核 governance.suggest()——零 LLM、纯计算（基于记忆库 accessedAt 时效 + 多样性，
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
      <span class="btn-icon" data-icon="edit"></span>
    </button>
    <span class="session-title-bar__spacer"></span>
    <button id="newSessionBtn" class="session-title-bar__btn" title="新建会话" aria-label="新建会话">
      <span class="btn-icon" data-icon="plus"></span>
    </button>
    <!-- 历史记录下拉（SSOT 剪枝 v2，2026-08-17）：复用 treedd 组件——trigger=历史按钮，
         菜单紧挨按钮下方弹出（无遮罩、轻量），开合/外部关闭/Escape 由 initDropdowns 管理 -->
    <div id="historyDd" class="treedd session-history" data-treedd data-on-select="__historyOnSelect">
      <button id="historyBtn" class="treedd__trigger" title="历史记录" aria-label="历史记录" aria-haspopup="menu">
        <span class="btn-icon" data-icon="history"></span>
      </button>
      <div id="historyMenu" class="treedd__menu" role="menu"></div>
    </div>
  </div>
  <!-- ③ 任务进度常驻条（PLAN-UI-1 单轨，2026-09-17）：与 #messages **同级**的固定插槽——
       #messages 是 overflow-y:auto 滚动容器，插进它内部一滚即消失；默认一行
       N/M + 进度条 + 当前步骤，点击展开锚定浮层看全量。隐藏态由 chatView 控制。 -->
  <div id="planBar" class="plan-bar" hidden>
    <button id="planBarHead" class="plan-bar__head" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="planBarPanel">
      <span id="planBarCount" class="plan-bar__count"></span>
      <span class="plan-bar__progress"><span id="planBarFill" class="plan-bar__fill"></span></span>
      <span id="planBarCurrent" class="plan-bar__current"></span>
      <span id="planBarChevron" class="plan-bar__chevron" aria-hidden="true"></span>
    </button>
    <div id="planBarPanel" class="plan-bar__panel" hidden></div>
  </div>
  <div id="messages">
    <!-- 空状态引导：标题 + 提示 + 示例提问 chips（点击填入输入框，主动引导新用户）。
         标题/提示加 id（P3，2026-08-15 空状态角色化）：由 chatView 随激活角色包动态更新，
         切换角色不产生定位错位；示例 chips 由 chatView 随 showcase 角色动态渲染
         （白话方案设计师展示"种子收敛"引导，其余角色回退通用打磨引导），容器留空由脚本填充。 -->
    <div id="emptyState" class="empty-state" hidden>
      <div id="emptyTitle" class="empty-title">开始打磨你的设计文档</div>
      <div id="emptyHint" class="empty-hint">在下方输入你的想法，或点击示例提问快速开始</div>
      <div id="emptySuggestions" class="empty-suggestions"></div>
    </div>
    <!-- 一键到底（吸收养分：对齐 TRAE App / TraeWork「上滚后回到底部」）：
         用户上滚阅读离开底部时浮现，点击回到最新消息位置；吸底时隐藏 -->
    <button id="scrollToBottomBtn" class="scroll-to-bottom" hidden
      title="回到底部" aria-label="回到底部">
      <span class="btn-icon" data-icon="scroll-bottom"></span>
    </button>
    <!-- 写入审批卡（H0，2026-09-19 补全）：confirmWrites=true 时写文件触发，
         host 推送 write_confirm_request，webview 渲染此卡；用户确认/拒绝回传
         write_confirm_answer。默认隐藏，由脚本按需显示（fail-closed：超时即拒） -->
    <div id="writeConfirmCard" class="write-confirm-card" hidden>
      <div class="write-confirm-card__body">
        <div class="write-confirm-card__head">
          <span class="write-confirm-card__tool" id="writeConfirmTool"></span>
          <span class="write-confirm-card__path" id="writeConfirmPath"></span>
        </div>
        <div class="write-confirm-card__desc" id="writeConfirmDesc"></div>
        <details class="write-confirm-card__diff">
          <summary>查看写入内容</summary>
          <pre id="writeConfirmDiff"></pre>
        </details>
        <div class="write-confirm-card__actions">
          <button id="writeConfirmReject" class="write-confirm-card__btn--reject">拒绝</button>
          <button id="writeConfirmOk" class="write-confirm-card__btn--ok">确认写入</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ③ 活动状态区（P0 错误 / P1 低扰 单条主状态 + P2 指标折叠详情）
       从顶部迁到消息流下方、composer 上方 —— 不再顶置挤占消息区（ui-redesign.md §3.1 C7）。
       原 memoryBar + noticeBar + metricsBox 三条并列收敛为单一通道，SSOT 不互相覆盖 -->
  <div id="activityBar" class="activity-bar" hidden></div>
  <details id="activityDetail" class="activity-detail" hidden>
    <summary>活动详情</summary>
    <div id="activityList" class="activity-list"></div>
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
    <!-- Grok 式：选中 Skill 后在输入框上方以「名称 + × 可移除」chip 展示（chatView renderSkillChip 动态构建）；
         entry 仍是 Row1 的 bolt 图标触发器，此处只呈现已挂载的技能状态，保证透明 + 可控 -->
    <div id="skillChips" class="skill-chip-row" hidden></div>
    <div id="inputWrap">
      <textarea id="input" rows="1" placeholder="在文档上打磨你的想法……（Enter 发送，Shift+Enter 换行）" aria-label="消息输入"></textarea>
      <div id="inputFooter">
        <!-- Row 1 · 一级直面：左侧功能群 + 右侧唯一发送按钮（发送突出化） -->
        <div class="composer-row composer-row--main">
          <!-- 左侧功能群：Skill + 模型选择 + 润色（次级功能，弱化展示） -->
          <div class="composer-left">
            <!-- Skill 选择器：单图标（bolt SVG，图标语言唯一 = icons.ts 柔和线条）胶囊触发器，与模型选择器共用 capsule 变体；选择后作为 system prompt 传给 LLM。
                 Skill 名不常显（节省窄窗横向空间），当前项由菜单内 is-active 高亮 + 触发器 accent 边框 + title 兜底 -->
            ${buildDropdownHtml([], { extraClass: 'skill-picker treedd--capsule', onSelect: '__skillPickerOnSelect', triggerLabel: '<span class="btn-icon" data-icon="bolt"></span>', triggerTitle: '选择 Skill', triggerAriaLabel: '选择 Skill' })}
            <!-- 模型选择器：共用 capsule 变体，名称省略/菜单尺寸由 .model-picker 差异定制 -->
            ${buildDropdownHtml([], { extraClass: 'model-picker treedd--capsule', onSelect: '__modelPickerOnSelect', triggerLabel: '选择模型', triggerTitle: '选择模型', triggerAriaLabel: '选择模型' })}
            <!-- 文本润色按钮：图标化，降低视觉权重 -->
            <button id="polishBtn" class="polish-btn-icon" title="润色输入内容" aria-label="润色">
              <span class="btn-icon" data-icon="edit"></span>
            </button>
          </div>
          <!-- 右侧：主发送按钮（单图标三态：发送↑ / 停止■ / 继续▶，均无文字省空间）
               + 生成中另行暴露「暂停」软控制（Gap A），与「停止」并列、可经「继续」恢复 -->
          <div class="composer-right">
            <!-- 暂停按钮（Gap A）：仅生成中显隐（setStatus 控制 hidden），软暂停当前 Agent 执行。
                 「停止」丢弃本次流、「暂停」落检查点可恢复，二者语义区分、视觉同级弱化展示 -->
            <button id="pauseBtn" class="pause-btn" title="暂停生成" aria-label="暂停生成" hidden>
              <span class="btn-icon" data-icon="pause"></span>
            </button>
            <button id="send" class="send-btn-primary" title="发送 (Enter)" aria-label="发送">
              <span class="send-icon" data-icon="send"></span>
              <span class="stop-icon" data-icon="stop"></span>
              <span class="play-icon" data-icon="play"></span>
            </button>
          </div>
        </div>
        <!-- Row 2 · 状态行：左角色/能力徽章 + 右上下文占用圆环（两端分布；占用属状态信息归本行，
             不干扰 Row 1 主操作；hover/聚焦**向上**弹窗出分层明细文字，避免向下展开挤压面板底部） -->
        <div class="composer-row composer-row--status">
          <div class="composer-status">
            <span id="currentRoleBadge" class="role-badge"></span>
            <span id="currentCapabilityBadge" class="capability-badge" hidden></span>
          </div>
          <!-- 上下文占用圆环：常驻不占行，非噪点；首帧由 chat_providers 渲染所选模型容量上限，
               真实分层占用由首轮后 context_occupancy 覆盖 -->
          <div id="contextOccupancy" class="context-ring" hidden>
            <svg class="context-ring__svg" viewBox="0 0 40 40" aria-hidden="true">
              <circle class="context-ring__track" cx="20" cy="20" r="16" />
              <circle class="context-ring__fill" id="occFill" cx="20" cy="20" r="16" />
            </svg>
            <span class="context-ring__percent" id="occPercent">0%</span>
            <div class="context-ring__tip" id="occTip" role="tooltip"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- 阶段 B（P2-1）：运行时脚本由外部 chatView.js 提供（CSP script-src cspSource 加载） -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
}