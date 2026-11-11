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
 *     角色名在 AI 消息头部标签 + 空状态标题展示（角色切换入口在独立的「角色」视图）。
 *
 * ⚠️ 行数逼近 eslint `max-lines` 上限（2026-11-11 实测本文件 3683 / 基线 4242，余 559）：新增逻辑先外置到
 *    `helpers/` / 独立模块，本文件只留接线。真正贴死的是 `chatView.ts`（4353 / 4353，余 0）——搬迁对象
 *    以台账 `CHATPANEL-MARGIN-1` 为准；行数余额一律现测，不认任何写死的数字（上面两处只是时点快照）。
 */
import * as vscode from 'vscode';

// 本文件通知文案全部走 l10n（切片 2 宿主面本地化，ADR-042）；短引用免 7 字符/处折行租金
const { l10n } = vscode;
import { diffWorkspaceSnapshots } from '../../extension/host/fileChangeTracker.js';
import type { HostSessionStore } from '../../extension/host/sessionStore.js';
import { resolveAttachmentsDir } from '../../extension/host/projectDataDir.js';
import { salvageInterruptedRounds } from '../../extension/host/interruptedSalvage.js';
import { ingestImage } from '../../extension/host/imageIngest.js';
// IMG-8 宿主兜底：三维聚合限额裁决（判据单点 shared/imageTurnLimits，token 走内核 imageTokens）
import { imageTurnRejection } from '../../extension/host/imageTurnGuard.js';
import { userEcho, stampRoundAttachmentUris } from '../../extension/host/attachmentUris.js';
import { ingestImageFiles, pickAndIngestImages } from '../../extension/host/imagePick.js';
import { scanWorkspaceTextFiles } from '../../extension/host/workspaceTextScan.js';
// 图片字节缓存（IMG-2 §5.4.1）：仅类型引用——实例由 extension 创建并注入，本类不构造
import type { ImageCache } from '../../extension/host/imageCache.js';
import * as pinned from '../../extension/host/pinnedContext.js';

// 命令 id 唯一真源 = fileChangeView（与 package.json#contributes.commands 的值同源维护）。
// 对话区常驻条的两个按钮**不自己实现动作**，只 executeCommand 复用已注册命令——
// 与文件内 CodeLens、状态栏 QuickPick、命令面板走同一实现（SSOT，无第二份清理逻辑）。
import {
  CONFIRM_ALL_FILE_CHANGES_COMMAND,
  REVERT_ALL_FILE_CHANGES_COMMAND,
} from '../../extension/host/fileChangeView.js';
import {
  formatDateKey,
  resolveContextWindow,
  estimateOccupancy,
  estimateTokensMessages,
  LOOP_CONSTANTS,
  type Agent,
  type AgentChunk,
  type AgentEventMap,
  type IRoundStore,
  type ImageRef,
  type ProcessEvent,
  type ProcessMetaPayload,
  estimateTokensText,
  // 「这轮算不算跑成功」判据取内核单点（isRoundSuccessful）：宿主不得自写
  // `status === 'complete'`（内核 roundStore.test 的判据单源守卫会拦，见 helpers/occupancyHistory.ts 先例）
  isRoundSuccessful,
} from '@zooique/memora';
// step 检查点落盘（已收场轮取盘上现值、只并事件；能力探测与判据单点外置）
import { checkpointRoundEvents } from './roundEventCheckpoint.js';

/** 插话条数上限提示文案用值：直接消费内核真源（webview 侧无法 import 内核包，
 *  其 shared/constants.ts 同名常量是本值的镜像，由 chatPanelInput 守卫测试锁同值） */
const INTERJECT_LIMIT = LOOP_CONSTANTS.MAX_PENDING_INTERJECTIONS;

/**
 * 目录快照遍历时跳过的目录 → 已随扫描实现整批外置到 `extension/host/workspaceTextScan.ts`
 * （IMG-12 同批腾行）；本处只留降级提示常量——调用方（scriptSnapshots 快照面）仍在本类。
 */

/**
 * 快照超阈值（文件过多 / 总量过大）时的降级提示
 *
 * 写前快照与写后扫描两条路径都会降级到同一句提示——并列字面量必漂移，故抽为单点函数
 * （函数而非常量：`l10n.t` 必须在**调用时刻**取，模块加载期取值会绕过 VS Code 的
 * locale 初始化窗口，且无法被 bundle 覆盖率判据匹配）。
 */
function snapshotOversizeNotice(): string {
  return l10n.t(
    'Too many text files in the workspace; script changes are not tracked automatically. Use git to review the changes.',
  );
}

/** 启动时首选会话被另一窗口占用、已自动让位到最近可用会话的提示（解释「为什么不是上次那个会话」） */
function sessionDisplacedNotice(): string {
  return l10n.t(
    'The session you were on is in use by another window; opened another session instead.',
  );
}

/** 启动时首选会话被占且工作区无其他可用会话、已新建空会话的提示（如实说「新建」而非「另一个」） */
function sessionDisplacedNewNotice(): string {
  return l10n.t(
    'The session you were on is in use by another window; created a new empty session.',
  );
}
import type {
  ChatRef,
  InjectionSegment,
  InjectionSource,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  RoundView,
  TurnState,
  PendingQuestionDto,
  LlmProviderConfig,
} from '../../shared/protocol.js';
// 错误文案映射单一真理源（与 webview 重放渲染共用，防文案双源漂移）
import {
  deriveTurnState,
  mergeLiveRound,
  type PendingLiveRound,
} from '../../shared/turnProjection.js';
import { dedupeRefs } from '../../shared/refKey.js'; // 引用去重判据单点（与 webview 的 addRefs 共用，勿各自实现）
// 插话受理三态的可见文案（INPUT-LIMIT-1 / INTERJECT-PERSIST-1）统一由 windowNotices 提供，
// 面板内不嵌字面量：那里是窗口提示的单一真源（常量形态会在模块求值时定稿语言，故用函数）。

// 会话标题读侧兜底（列表 / 面板标题条 / 占位 meta 三处同一口径）
import { sessionDisplayTitle } from '../../extension/host/sessionTitle.js';
// 历史会话列表投影（store → DTO 纯映射，外置于 max-lines TARGET 文件）
import { buildSessionListMessage } from '../helpers/sessionList.js';
// 会话历史读取（round-based 投影 / legacy 回退）——纯数据逻辑外置，面板只消费结果
import { loadMessagesHistory, loadRoundBasedHistory } from '../helpers/historyLoad.js';
// 草稿会话态（「＋」后、首次发送前的空白页）：红线与降级理由见该模块头注释
import { DraftSessionController } from '../helpers/draftSession.js';
// 过程事件 / 指标段级合并（纯函数，HOST-SPLIT-1 切片自本类外置；三条调用面共用同一语义）
import { mergeProcessEvents } from '../helpers/processEventMerge.js';
// 启动会话归属裁决（首选被另一窗口占用时让位）——判据单点，面板与验收测试共用同一实现
import { claimStartupSession } from '../helpers/sessionStartupClaim.js';
import {
  sessionHeldNotice,
  archiveSessionAction,
  deleteSessionAction,
  restoreSessionAction,
  type SessionHistoryDeps,
} from '../helpers/sessionHistoryActions.js';
// 能力面三态判定的唯一出口（CAP-TRISTATE-1）：本文件只传「域级标签投影」，不自行判 length
import { deriveCapabilityState } from '../helpers/capabilityState.js';
// 输入区徽章的域级短标签（标签投影与三态判定分离，见 capabilityLabels 头注释）
import { capabilityDomainLabel } from '../helpers/capabilityLabels.js';
import { toNoticeText } from '../../extension/host/noticeText.js';
import {
  limitNotice,
  flowError,
  interjectUnsavedNotice,
} from '../../extension/host/windowNotices.js';
import {
  readSessionRolePackName,
  sessionRolePackFallbackNotice,
} from '../../extension/host/sessionRolePack.js'; // 角色包回落判据 / 文案单点
// 用户级「新建会话默认角色包」的单点读口（配置键只在那里被读取；装配链禁止引用）
import { resolveDraftRolePackName } from '../../extension/host/rolePackDefault.js';
// 新建会话角色决策（显式选择 > 全局默认 > 兜底包；校验真源 = 角色包目录编目，见模块头）
import {
  decideNewSessionRolePack,
  newSessionRolePackNotice,
  type RolePackCatalogReader,
} from '../../extension/host/newSessionRolePack.js';
// 引用发送前存在性核实（HOST-CTX-9 发送侧）：解析器复用 refPath（首根 SSOT），不由本文件另写
import { collectMissingFileRefPaths } from '../../extension/host/refProbe.js';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { createProvider } from '../../extension/host/llmConfig.js';
import {
  refreshActiveProvider,
  type ProviderRefreshOutcome,
} from '../../extension/host/providerRefresh.js';
import { createVscodeAttention } from '../../extension/host/vscodeAttention.js';
import { collectOccupancyHistory } from '../helpers/occupancyHistory.js';
import {
  PanelSessionLockFinalizer,
  type PanelSessionIdAccess,
} from '../helpers/panelSessionLockFinalizer.js';
// 任务看板 / 后台任务 / 上下文占用三项快照投影（HOST-SPLIT-1 行数闸门整域外置；
// 面板只注入 getAgent/post/isBackground 三个依赖，缓存留在外置域内）
import { PanelSnapshots } from '../helpers/panelSnapshots.js';
// 角色列表消息投影（聊天页 chat_role_packs / 设置页 roles_loaded 共用构造点，外置控行数）
import { buildChatRolePacks } from '../helpers/rolePackListView.js';
// 会话级流运行态 + 流归属闸（E4 批 1/2）：四项状态按会话命名空间化；后台流 UI 投递整批丢弃
import {
  SessionRuntimeStates,
  BackgroundFlowGate,
  type LiveFlowBuffer,
  type SessionRuntimeState,
} from '../helpers/sessionRuntime.js';
import { vscodeTracer } from '../../extension/host/tracer.js';
// HTML 骨架已外置（纯静态模板，见 chatPanelHtml 模块头）
import { buildHtml } from './chatPanelHtml.js';
// 会话事件出口（B9-D 按 op 组外置；纯「事件 → notice / 投影刷新」映射，见模块头）
import { createChatNoticeOps, type ChatNoticeOps } from './chatNoticeOps.js';
// 引用入口域（B9-D-2 按 op 组外置）：引用打开定位 + @ 提及选择器，见模块头
import { createChatRefOps } from './chatRefOps.js';
// 问答结构破坏性操作域（B9-D-3 按 op 组外置）：delete_turn / regenerate 共用的截断核
import { createChatTurnStructureOps, truncateFailNotice } from './chatTurnStructureOps.js';
// 会话导航域（B9-D-4 按 op 组外置）：分叉 / 改名 / 切换共用「拿锁 → 换显示源 → 回放」
import { createChatSessionNavOps } from './chatSessionNavOps.js';
// 记忆软删域（B9-D-5 按 op 组外置）：单条反馈删除 + 会话删除联动软删，同一套降级口径
import { createChatMemoryOps } from './chatMemoryOps.js';
// 运行控制域（B9-D-6 按 op 组外置）：停止 / 暂停 toggle / 恢复，共用会话级运行态与 ask 协调器
import { createChatRunControlOps } from './chatRunControlOps.js';
import {
  buildDocContextBlock,
  buildGitChangesContextBlock,
  buildInjectedContextEnvelope,
  buildProblemsContextBlock,
  buildRefContextBlock,
} from '../helpers/docContext.js';
// HOST-CTX-4：发送时刻的注入正文采集（problems 诊断 / git-changes 未提交改动）——自本文件拆出
// （贴 max-lines 上限；「每加一个注入源加一个 collectXxxBody」是线性增长域，留此必爆线）
import {
  collectGitChangesBody,
  collectProblemsBody,
} from '../../extension/host/injectionBodies.js';
import {
  isSkillDisabled,
  listVisibleSkills,
  skillPromptFor,
} from '../../extension/host/skillAggregation.js';
import type { WorkspaceSessionViewLoader } from '../../extension/host/sessionViewLoader.js';
// 文件改动追踪接入面（唯一接入点；仅依赖窄接口，不直接依赖渲染实现）
import type { FileChangeSink } from '../../extension/host/fileChangeTracker.js';
// HOST-SPLIT-1 第 1 刀：活动文件跟踪域（自本文件迁出；投递点经构造闭包注入）
import { ActiveFileTracker } from '../../extension/host/activeFileTracker.js';
// HOST-SPLIT-1 第 2 刀：确认队列域（自本文件迁出；注入 getAgent / post 两个依赖）
import { ConfirmCoordinator } from '../../extension/host/confirmCoordinator.js';
// HOST-SPLIT-1 第 4 刀：ask 提问域（自本文件迁出；注入 5 个依赖：getAgent / isAskWaiting /
// getTurnState / post / runFlow——runFlow 是 18 行包装，**不是** consumeFlow 主循环）
import { AskCoordinator } from '../../extension/host/askCoordinator.js';
// 「复制诊断摘要」数据源（自本文件拆出）：chatPanel 只持有环形缓冲，
// 容量上限与格式化同处 hostDiagnostics，避免线性增长域把 max-lines 顶爆（injectionBodies.ts 同例）
import { recordHostDiag, type DiagnosticsData, type HostDiagEntry } from './hostDiagnostics.js';
// 角色包激活态 → 面板的桥（自本文件拆出，守住 max-lines 只降不升）
import { bridgeRolePackActivation } from './rolePackActivationBridge.js';
import { AgentEventScope } from '../../extension/host/agentEventScope.js';
// thought 落盘折叠域（自本文件拆出；纯逻辑 + 长不变量说明，详见真源模块）
import { MAX_THOUGHT_PAYLOAD_LENGTH } from '../../extension/host/thoughtFold.js';

// 判据与快照的真源已迁至 activeFileTracker.ts；此处 re-export **仅为保住既有测试的导入路径**
// （chatPanelHistory.test.ts 直驱这 5 个纯函数）——按规则 §6.2「sugar API 保留、内部委托」。
// ⚠️ 禁在此新增同类纯函数：新判据/新投影一律写进真源模块，再按需在此加 re-export。
export {
  snapshotDocContext,
  readDocBody,
  mustInjectDocBody,
  docInjectReason,
  projectActiveFile,
} from '../../extension/host/activeFileTracker.js';

/**
 * 运行一轮流的「种子」信息——宿主知情、内核不回传的本轮要素。
 *
 * 之所以显式传参而非开实例字段：本轮的 userMessage 只有**调用点**知道（`sendInput` 的输入），
 * 而实例字段有跨轮残留风险（按会话的 `streaming` 这类布尔碎片正是本方案要收口的对象，不该再添一个）。
 * 6 个 `runFlow` 调用点中只有 `chat()` 开新轮需要它（`resumeExecution` 各形态续同一轮、不分裂，
 * 其 userMessage 从落盘历史取）。
 */
interface FlowSeed {
  /**
   * 本轮开轮用户输入（与内核 `appendUser` 落盘内容同源：**含注入信封**，非 UI 上屏的原始文本）。
   *
   * id 用宿主临时值（内核生成的 `msg-{uuid}` 此刻未知）：轮收场落盘后由历史版本整体替换，
   * 与 `toRoundView` 的 `assistantMessage.id = live-{roundId}` 同一范式。
   */
  userMessage?: RoundView['userMessage'];
}

// 本流 live 缓冲形状已随会话级运行态迁至 `helpers/sessionRuntime.ts`（LiveFlowBuffer）。

// 宿主会话存储契约（HostSessionStore）随其实现类定义在 extension/host/sessionStore.ts（本面板贴行数闸门）。

/** 侧边栏视图提供者 */
export class MemoraChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.chat';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** 角色 handoff 预填缓冲：对话视图未就绪时暂存，ready 后补发（消除时序竞态） */
  private _pendingPrefill?: string;
  /** 右键「添加到对话」引用缓冲：对话视图未就绪时暂存，ready 后补发（与 _pendingPrefill 同构） */
  private _pendingRefs?: ChatRef[];
  /**
   * @ 提及 QuickPick 的并发守卫随域外置（见 `chatRefOps.ts` 的 `mentionQuickPickOpen`），
   * 面板不再持有该状态。
   */
  private readonly _refOps = createChatRefOps({
    post: (msg) => this.post(msg),
    pushRefs: (refs) => this.pushRefs(refs),
    hasView: () => Boolean(this._view),
  });
  /**
   * 问答结构破坏性操作域（B9-D-3 外置）：截断核 + 删除问答
   *
   * `sessionStore.truncateFrom` 用闭包**延迟取**（不在字段初始化时捕获实例）——
   * 字段初始化早于构造参数属性的可读保证，直接传 `this.sessionStore` 有拿到 undefined 的窗口。
   */
  private readonly _turnOps = createChatTurnStructureOps({
    post: (msg) => this.post(msg),
    isStreaming: () => this.runtimeFor().streaming,
    getCurrentSessionId: () => this._currentSessionId,
    sessionStore: {
      truncateFrom: (date, session, roundId) =>
        this.sessionStore.truncateFrom(date, session, roundId),
    },
    discardLiveBuffer: () => {
      this.runtimeFor().liveBuffer = undefined;
    },
    softDeleteMemories: (ids) => this.softDeleteSessionMemories(ids),
    replaySession: () => this.replaySession(),
  });
  /**
   * 会话导航域（B9-D-4 外置）：分叉 / 改名 / 切换
   *
   * 全部依赖都是**延迟取的闭包**：本字段的初始化早于 `_lockFinalizer` / `_sessionAgents`
   * 等字段的初始化，构造期捕获实例会拿到 undefined（编译过、运行时崩）。
   */
  private readonly _navOps = createChatSessionNavOps({
    post: (msg) => this.post(msg),
    sessionStore: { getRoundIds: (sessionId) => this.sessionStore.getRoundIds(sessionId) },
    getCurrentSessionId: () => this._currentSessionId,
    setCurrentSessionId: (sessionId) => this.setCurrentSessionId(sessionId),
    clearSessionId: () => this._sessionIdAccess.clearSessionId(),
    currentTitle: () => this.currentSessionTitle(),
    getAgent: () => this._agent,
    getAgentOrWarn: () => this.getAgentOrWarn(),
    agentForSession: (sessionId) => this.agentForSession(sessionId),
    lock: {
      acquire: (sessionId) => this._lockFinalizer.acquire(sessionId),
      holds: (sessionId) => this._lockFinalizer.holds(sessionId),
      releaseOne: (sessionId) => this._lockFinalizer.releaseOne(sessionId),
    },
    sessionAgents: {
      get: (sessionId) => this._sessionAgents.get(sessionId),
      set: (sessionId, agent) => {
        this._sessionAgents.set(sessionId, agent);
      },
      delete: (sessionId) => {
        this._sessionAgents.delete(sessionId);
      },
    },
    rekeyAgent: (from, to) => this._rekeyAgent?.(from, to),
    bindAgent: (agent) => this.bindAgent(agent),
    replaySession: () => this.replaySession(),
    postBackgroundTasks: () => this.postBackgroundTasks('force'),
  });
  /** 记忆软删域（B9-D-5 外置）：单条反馈删除 + 会话删除联动软删（降级口径同一份） */
  private readonly _memoryOps = createChatMemoryOps({
    post: (msg) => this.post(msg),
    getAgent: () => this._agent,
    getAgentOrWarn: () => this.getAgentOrWarn(),
  });
  /** 运行控制域（B9-D-6 外置）：停止 / 暂停 toggle / 恢复（不做相位裁决，裁决在 handleInput） */
  private readonly _runOps = createChatRunControlOps({
    post: (msg) => this.post(msg),
    postTurnUpdate: () => this.postTurnUpdate(),
    runtimeFor: () => this.runtimeFor(),
    askFor: () => this.askFor(),
    getAgent: () => this._agent,
    runFlow: (factory) => this.runFlow(factory),
    syncPendingQueue: (force) => this.syncPendingQueue(force),
    postPendingDiscarded: (items) => this.postPendingDiscarded(items),
  });
  /** 当前**显示会话**的 Agent（`_sessionAgents` 的一份投影；真正的实例归属表在 extension） */
  private _agent: Agent | undefined;
  /**
   * 草稿会话态（「＋」后、首次发送前的空白页）——**只存在于本面板内存**
   *
   * 🔴 草稿不是会话：无 id、不写 sessionStore、不进历史、不占锁、不装配 Agent；
   * 「当前有没有会话」仍只由 `_currentSessionId` 表示（草稿期恒为 ''），本控制器只标记
   * 「这个空值态是用户主动新建的空白页」，不是第二份会话状态。红线全文与角色切换降级
   * 理由见 `helpers/draftSession.ts` 模块头。
   */
  private readonly _draft: DraftSessionController;
  /**
   * 本面板已绑定的会话实例（sessionId → Agent）
   *
   * ⚠️ 这是**登记表的本地投影**，不是第二个真源：写入点只有 `agentForSession`（一律先经
   * extension 的 `AgentRegistry`），本表只用于「按会话同步取已绑定实例」（ask 超时回执、
   * 后台流控制面）。复用/在途/装配仍全归登记表；实例被回收时必须同步删除本表项。
   */
  private readonly _sessionAgents = new Map<string, Agent>();
  /** 配置热刷新未生效标记（IMG-5 顺延槽）：真源已变但换实例失败（唯一预期 = `assertNotBusy`）；消费点 = `handleInput` 的 `send` 前置补做。 */
  private _providerStale = false;
  /** 系统内置配置目录 + 用户技能目录 + 项目级技能目录（extension 注入，composer 清单来源判定） */
  private _configDir: string | undefined;
  private _userSkillsDir: string | undefined;
  private _projectSkillsDir: string | undefined;

  /** 注入技能聚合所需目录（composer 动态技能下拉与设置面板同一清单来源） */
  public setSkillDirs(configDir: string, userSkillsDir: string, projectSkillsDir?: string): void {
    this._configDir = configDir;
    this._userSkillsDir = userSkillsDir;
    this._projectSkillsDir = projectSkillsDir;
  }
  /** 角色包目录编目（宿主注入；建会话校验默认包用，冷启动无实例时同样可读） */
  private _readRolePackCatalog?: RolePackCatalogReader;
  public setRolePackCatalog(reader: RolePackCatalogReader): void {
    this._readRolePackCatalog = reader;
  }
  /** 大模型配置存储（用于底部模型下拉框 + 切换） */
  private readonly _providerStore: ProviderStore;
  /** Agent 懒装配工厂（由 extension 注入：入参 = 工作区 + **目标会话**；实现 = 登记表取/建） */
  private _getAgent: ((projectPath: string, sessionId: string) => Promise<Agent>) | undefined;
  /** 实例回收回调（extension 注入：登记表 unregister + close；删除会话时调用） */
  private _releaseAgent: ((sessionId: string) => Promise<void>) | undefined;
  /** 实例改键回调（extension 注入：分叉后同一实例改挂新会话键，登记表键不得漂移） */
  private _rekeyAgent: ((from: string, to: string) => void) | undefined;
  /**
   * Agent 装配 Promise：缓存「在途装配」供等待，而非仅布尔标记——
   * 否则 'ready' 在装配进行中调用 ensureAgent() 会早退，崩溃恢复打捞（依赖 agent.agentHistory）
   * 与首次回放产生时序竞态。装配失败在内部消化（resolves 而非 rejects），等待方不抛。
   */
  private _agentReady: Promise<void> | null = null;
  /** 崩溃残留轮升级为 stop turn 是否已执行：每面板实例一次；
   *  升级后轮已 complete，listInterruptedRecent 不再命中，重复执行无意义 */
  private _salvageUpgraded = false;
  /** 当前激活角色包（**会话 Agent 真实值的投影**：bindAgent 强制重读，不再由外部写入） */
  private _activeRolePack: string | undefined;
  /**
   * 已弹过「角色包回落」提示的会话（进程内去重，不落盘）：每会话每进程只弹一次，
   * 差异改由角色徽章常驻显示（`chat_role_packs.unavailableName`）
   */
  private readonly _rolePackFallbackNotified = new Set<string>();
  /**
   * 当前活跃会话标识（YYYY-MM-DD-sessionName 会话标题层）
   *
   * 当前会话是用户在会话列表中选择/新建的会话（不固定为当天 main）。写入内核与回放展示均
   * 以本会话为准（单一真理源），无跨天合并视图。
   */
  private _currentSessionId: string;
  /** 会话级流运行态表（E4 批 1/2）：四项按 sessionId 命名空间化，见 {@link SessionRuntimeStates} */
  private readonly _runtime = new SessionRuntimeStates();
  /** 流归属会话闸（E4 批 2）：后台流的 UI 投递与单份投影缓存整批丢弃，判据见 {@link BackgroundFlowGate} */
  private readonly _flowGate = new BackgroundFlowGate();
  /** 会话锁收尾器：销毁 / 重开 / 流收场 / 握手销毁的唯一收口（B1） */
  private readonly _lockFinalizer: PanelSessionLockFinalizer;
  /**
   * 当前会话 id 的读写面：收尾器与本类回滚共用同一份清空写点
   * （sessionWritePointGuard 要求「清空」在源码中恰好 1 处；回滚也必须走这里）
   */
  private readonly _sessionIdAccess: PanelSessionIdAccess = {
    getSessionId: () => this._currentSessionId,
    clearSessionId: () => {
      this._currentSessionId = '';
    },
  };
  /** 视图重建代数（每次 resolveWebviewView 自增）：供流尾检测「流期间 webview 被折叠/展开
   *  重建过」——重建后新 webview 没有本流的实时投影，落盘完成后须补一次 replaySession 刷全。 */
  private _viewEpoch = 0;
  /**
   * 路径守卫安全审计累计（安全/装配透明）
   *
   * 由 agent.security.onAudit 订阅累计：total 总审计次数、denied 拒绝次数。
   * audit 事件为内核 SecurityGuard 在路径读/写审批时产出（路径守卫是当前唯一安全信号）。
   */
  private _securityAuditTotal = 0;
  private _securityAuditDenied = 0;
  private _recentSecurityAudits: { type: string; path: string; tool?: string; reason?: string }[] =
    [];
  /** 安全审计订阅取消函数（幂等管理，防重复绑定） */
  private _securityAuditUnsub: (() => void) | undefined;
  /**
   * 会话级可观测事件的订阅作用域（E5：面板 × 所属 Agent 实例）
   *
   * 所有 `agent.on(...)` 统一经 `bindAgentNoticeEvents` 装订进来；面板销毁/换实例时
   * `dispose()` 一次性解绑，避免监听器滞留（作用域自身保证只碰本面板那台实例）。
   */
  private readonly _noticeEventScope = new AgentEventScope();
  /** 上次推送给 webview 的待发送区长度（长度变化才 post）；`undefined` = 从未投影过
   *  （agent 刚装配 / webview 重建）。与「已投影为空」是两种状态——折叠成 0 会让
   *  「从未投影过 + 清空到空」（如 resume 恢复后直接清）被长度守卫误拦，丢弃信号失去成对快照帧。
   *  背景：普通插话（thinking 态 interject）不触发 sessionResumed（resume 专有事件），
   *  队列消费后无「空通知」→ 待发送区弹窗残留；统一经 syncPendingQueue 长度变化检测，
   *  让「队列变空」这一真理源变化总能被推送（消费后必有后续 chunk 触发同步）。 */
  private _lastPendingQueueLen: number | undefined = undefined;
  /**
   * 任务看板 / 后台任务 / 上下文占用三项快照投影（外置域，HOST-SPLIT-1 行数闸门）
   *
   * 本域自己持有两份推送缓存（后台任务签名 / 用户收起偏好），面板不再持有——
   * 见 `helpers/panelSnapshots.ts` 头注（会话归属纪律：写缓存前先问 isBackground）。
   */
  private readonly _snapshots = new PanelSnapshots({
    getAgent: () => this._agent,
    post: (msg) => this.post(msg),
    isBackground: () => this.isBackgroundFlow(),
    // 收起偏好 / 去重签名的会话维度键：taskId 是每实例序号（bg-1 在两个会话重复）
    getSessionId: () => this._currentSessionId,
    // 后台任务状态标签的词形（SSOT-OWNERSHIP-1：展示文案归宿主，不再取内核表）
    l10n: vscode.l10n,
  });
  /** 最近 webview 错误上报（复制诊断命令消费；容量/格式化归 hostDiagnostics 模块） */
  private readonly _recentHostDiags: HostDiagEntry[] = [];
  /**
   * 会话事件出口（B9-D 按 op 组外置，真源见 `chatNoticeOps.ts`）
   *
   * **注入而非继承**：处理器只经 11 个窄接口读写面板状态（`post` / 投影刷新 / 激活角色的
   * 读写），不反向持有 provider 实例——与 `_confirm` / `_activeFile` 同范式。
   * 引用必须**构造期一次性稳定**：装订表按引用做 `off`→`on` 幂等，每次取新对象会让解绑失效。
   */
  private readonly _notice: ChatNoticeOps = createChatNoticeOps({
    post: (msg) => this.post(msg),
    postTurnUpdate: () => this.postTurnUpdate(),
    postActiveRolePack: (name) => this.postActiveRolePack(name),
    postCapabilityBadge: () => this.postCapabilityBadge(),
    pushSkillList: () => this.pushSkillList(),
    postContextOccupancy: () => this.postContextOccupancy(),
    pushSessionList: () => this.pushSessionList(),
    pushArchiveModeRuntime: () => this.pushArchiveModeRuntime(),
    getCurrentSessionId: () => this._currentSessionId,
    getActiveRolePack: () => this._activeRolePack,
    setActiveRolePack: (name) => {
      this._activeRolePack = name;
    },
  });
  /**
   * 当前 turn 状态（单一路由判据的 SSOT）：由 `postTurnUpdate` 写回（与推给 webview 的
   * `turn_update.state` 同一对象），`handleInput` 据此路由四条内核入口。提问原文从
   * `_turnState.waiting.questions` 读，无独立生命周期、不做消费式 splice 镜像。
   */
  private _turnState: TurnState = { phase: 'idle' };
  /**
   * 会话视图加载器（round-based 模式专用，可选）
   *
   * 注入后支持加载 round-based 会话的历史消息。
   * 未注入时仅支持 legacy 模式（向后兼容）。
   */
  private _viewLoader: WorkspaceSessionViewLoader | undefined;
  /**
   * 过程事件落盘目标（Round 单文件内聚存储）
   *
   * 由 extension 注入（与 viewLoader 同一 WorkspaceRoundStore 单例）。
   * 流结束后「读 Round → 附加 processEvents → save」，生命周期随 Round 原子一致
   * （删 round 即删事件、分叉即共享、截断即覆盖）。
   */
  private _eventLogRoundStore: IRoundStore | undefined;
  /**
   * 文件改动追踪接入面（extension 注入；可选）
   *
   * consumeFlow 的 tool_start / tool_result 两分支喂给它——这是**唯一**接入点
   * （见 docs/方案-文件改动diff可视化-20260926.md §3.2）。未注入时功能静默关闭。
   */
  private _fileChangeSink: FileChangeSink | undefined;
  /** 脚本类工具（opaque 写）执行前 workspace 文本快照：键 = toolCallId → 路径→内容 */
  private readonly scriptSnapshots = new Map<string, Map<string, string> | null>();
  /** 未确认改动路径清单的取值函数（由 extension 注入；真源 = 宿主 FileChangeView） */
  private _fileChangesProvider: (() => string[]) | undefined;
  /** 当前激活 Provider 的显示名（meta 事件 llm 字段来源，随 pushProviders 刷新，SSOT 与模型下拉同源） */
  private _activeProviderDisplayName = '';
  /**
   * 过程事件 seq 全局计数器：实例级单调递增，保证事件 seq 全局唯一，
   * 供幂等去重与保序追加（step 检查点按 seq 幂等合并增量；若为每流局部 seq 会跨流冲突）。
   */
  private _processSeq = 0;

  /**
   * 活动文件跟踪器（HOST-SPLIT-1 第 1 刀迁出域，真源见 `extension/host/activeFileTracker.ts`）
   *
   * **注入而非继承**：tracker 要往 webview 推 `active_file`，而投递单点是本类的 `post`。
   * 经构造闭包把 `post` 交给 tracker——不引入新的依赖方向，也不让 tracker 反向持有
   * provider 实例（否则域与宿主互相持有，销毁顺序成隐患）。
   *
   * 该域的「附加开关」是**会话级**用户意图（provider 实例存活期内有效，重开面板复位为开），
   * 故随 tracker 实例共存亡；它也是注入判据的上游闸门——关掉 ⇒ 连快照都不取，
   * 不存在「关了还偷偷挂指针」的中间态。归宿主持有的理由：注入事实只发生在宿主
   * （webview 拿不到编辑器），开关若放 webview，面板一重建就丢。
   */
  private readonly _activeFile = new ActiveFileTracker({
    post: (msg) => this.post(msg),
  });

  /**
   * 交互提醒（HOST-ATTN-1）：VS Code 失焦/最小化时发系统 toast，把用户叫回来
   * （确认卡 / ask / 轮完成）。判据与文案在 `attentionNotice.ts`（零 vscode 依赖）。
   *
   * **无参构造**：判据只看窗口聚焦态——有焦点时承接面是面板内按钮（审批卡 / ask 卡 /
   * 文件改动条），不再叠 workbench 通知（用户要求收敛，2026-10-22）。
   *
   * 🔴 **必须声明在 `_confirm` 之前**：类字段按声明顺序初始化，`_confirm` 的依赖闭包里引用了
   * `this._attention`；虽然该闭包要到「卡推出」时才执行（构造期不读），但把被依赖者放前面
   * 才能让「构造期不得调用」这条隐含前提变成结构事实，而不是时序巧合。
   */
  private readonly _attention = createVscodeAttention();

  /**
   * 确认请求协调器（HOST-SPLIT-1 第 2 刀迁出域，真源见 `extension/host/confirmCoordinator.ts`）
   *
   * **注入而非继承**：协调器要往 webview 推 write_confirm_request 审批卡，且需读**最新** agent
   * （`setAgent` 会替换 `_agent` ⇒ 注入 getter 委托，**禁构造时快照**——快照会让重新绑定时
   * 绑到旧 agent 的 security 守卫上，确认回调静默失活）。
   *
   * 依赖经构造闭包交给协调器——不引入新的依赖方向，也不让协调器反向持有 provider 实例
   * （否则域与宿主互相持有，销毁顺序成隐患）。
   */
  private readonly _confirm = new ConfirmCoordinator({
    getAgent: () => this._agent,
    post: (msg) => this.post(msg),
    onConfirmShown: (info) => this._attention.onConfirmShown({ requestId: info.requestId }),
    // 待处理确认数变化（含后台会话入队）⇒ 重算列表标识与入口角标
    onPendingChanged: () => this.refreshSessionActivity(),
  });

  /**
   * ask 提问域协调器：按会话持有（在途提问快照 + 超时计时器都是会话级状态，
   * 两个会话的提问不得互相覆盖）。依赖注入形状与迁出时逐字相同，唯一差异 = `runFlow`
   * 绑定到该协调器所属会话（见 `askFor`）。
   */
  private readonly _asks = new Map<string, AskCoordinator>();

  /**
   * 最近一次推给 webview 的活跃度快照（JSON 串，用于「无变化不重发」去重）
   *
   * undefined = 从未推过：视图重建后必须**强制**补推（新 webview 内存里没有旧快照）。
   */
  private _lastSessionActivity: string | undefined;

  /**
   * @param extensionUri 插件扩展根 URI（用于 webview 本地资源加载 localResourceRoots）
   * @param sessionStore 会话存储（用于持久化/恢复对话历史）
   * @param providerStore 大模型配置存储（用于底部模型下拉框）
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStore: HostSessionStore,
    providerStore: ProviderStore,
    /** 工作区根（extension.ts 单点传入，本类不自算——防回退规则出第二真源）；附件目录由此推导 */
    private readonly workspacePath: string,
    private readonly imageCache?: ImageCache, // 图片字节缓存（extension 单例；回放前预读窗口内附件）
  ) {
    this._providerStore = providerStore;
    // 初始会话 = **上次停留的会话**（导航指针），不可用时退回最近写入的会话；
    // 无历史不自动创建（新建唯一入口为标题条「＋」）。
    // 存在性校验与回退序全在 store.getInitialSessionId（SESSION-RESUME-1 判据单点），本处只消费结果。
    this._currentSessionId = this.sessionStore.getInitialSessionId();
    // 无历史会话 ⇒ 启动即草稿：干净空白页，首次真正发送才建会话（有历史则回放上次停留会话）
    this._draft = new DraftSessionController(
      {
        post: (msg) => this.post(msg),
        clearSessionId: () => this._sessionIdAccess.clearSessionId(),
        setConfirmForeground: (id) => this._confirm.setForeground(id),
        pushSessionList: () => this.pushSessionList(),
        refreshActivity: () => this.refreshSessionActivity(),
        createSession: (id, rolePackName) => this.createSession(id, rolePackName),
        // 草稿未选角色时的「即将生效」角色 = 用户级默认；未设置则内核兜底契约包
        getDefaultRolePackName: resolveDraftRolePackName,
      },
      !this._currentSessionId,
    );
    this._lockFinalizer = new PanelSessionLockFinalizer(this.sessionStore, this._sessionIdAccess);
    // 文档上下文不在此处预取（发送时实时读活动编辑器，见 snapshotDocContext）。
    // 曾用 onDidChangeActiveTextEditor 缓存——盖不住「同一文件被编辑」，脏态停在「打开时干净」⇒ 每轮拿磁盘旧版当真相（P0 撒谎源）。
  }

  /**
   * 取某会话的流运行态（缺省 = 当前会话）：同会话恒同一对象（引用相等），跨会话互不可见。
   * 批 1 调用方均为当前会话；批 2 起流内代码传显式 sessionId（防「流在 A、已切到 B」写错记录）。
   */
  private runtimeFor(sessionId: string = this._currentSessionId): SessionRuntimeState {
    return this._runtime.get(sessionId);
  }

  /**
   * 取某会话的 ask 协调器（缺省 = 当前会话；懒建）。
   * 批 2 起依赖必须按 sessionId 取：超时回调/停止收场发生在**面板显示可能在别的会话**时，
   * 读 `this._agent` / 直接 `post` 会把 A 的现场写到 B 的界面（跨会话串台）。
   */
  private askFor(sessionId: string = this._currentSessionId): AskCoordinator {
    let coordinator = this._asks.get(sessionId);
    if (!coordinator) {
      coordinator = new AskCoordinator({
        // 该会话自己的实例（不是面板当前显示实例）；`this._agent` 兜底**仅**服务直接
        // 构造面板的测试（本地投影表未填充），生产由 agentForSession 保证表必命中
        getAgent: () => this._sessionAgents.get(sessionId) ?? this._agent,
        // 投递按会话归属门控：超时计时器回调不在流上下文（ALS 取不到），必须显式判会话；
        // 丢弃不丢内容——切回该会话时由 replay 从落盘历史重建
        post: (msg) => {
          if (sessionId !== this._currentSessionId) return;
          this.post(msg);
        },
        // 续跑的是该会话自己的流：显式传 sessionId，避免超时回调落到切换后的当前会话
        runFlow: (factory) => this.runFlow(factory, undefined, sessionId),
        // 在途提问变化（写入 / 回答 / 超时 / 停止）⇒ 重算待处理标识（后台会话同样亮起）
        onPendingChanged: () => this.refreshSessionActivity(),
      });
      this._asks.set(sessionId, coordinator);
    }
    return coordinator;
  }

  /**
   * 引用 chip 点击 → 在编辑器打开并定位（`open_ref`，W→E 分支）
   *
   * 职责（路径判据 / 越界守卫 / 失败态 / 行号 clamp）已整段外置到 `chatRefOps.ts`
   * （B9-D-2），本处只转发意图；协议 `open_ref` 的注释仍是语义 SSOT。
   */
  private async openRefInEditor(ref: ChatRef): Promise<void> {
    await this._refOps.openRefInEditor(ref);
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
   * 注入过程事件落盘目标（Round 存储）
   *
   * @param roundStore 工作区 Round 存储实例（extension 与 sessionStore/viewLoader 共享同一单例）
   */
  public setRoundStore(roundStore: IRoundStore): void {
    this._eventLogRoundStore = roundStore;
  }

  /** 注入文件改动接入面（由 extension 装配；tool_start/tool_result 唯一入口） */
  public setFileChangeSink(sink: FileChangeSink): void {
    this._fileChangeSink = sink;
  }

  /**
   * 注入「未确认改动清单」取值函数（由 extension 装配，真源 = FileChangeView）
   *
   * 对话区常驻条**不自维护计数副本**——渲染只认宿主推来的 `file_changes` 快照；
   * 本取值函数用于 webview ready 回放时的**补推**（防「只推变化 ⇒ 面板重开条消失」的时间面漏面）。
   */
  public setFileChangesProvider(provider: () => string[]): void {
    this._fileChangesProvider = provider;
  }

  /** 推送未确认改动快照给对话区常驻条（count = 0 时 webview 自行隐藏该条） */
  public pushFileChanges(): void {
    const files = this._fileChangesProvider?.() ?? [];
    this.post({ type: 'file_changes', count: files.length, files });
  }

  /** 注入 Agent 懒装配工厂（由 extension.ts 提供「会话 → 登记表实例」的取用面） */
  public setAgentFactory(
    getAgent: (projectPath: string, sessionId: string) => Promise<Agent>,
  ): void {
    this._getAgent = getAgent;
  }

  /** 注入实例回收回调（删除会话时：登记表 unregister + close；E4 批 2） */
  public setAgentReleaser(release: (sessionId: string) => Promise<void>): void {
    this._releaseAgent = release;
  }

  /** 注入实例改键回调（分叉后：同一实例从旧会话键改挂新会话键；E4 批 2） */
  public setAgentRekeyer(rekey: (from: string, to: string) => void): void {
    this._rekeyAgent = rekey;
  }

  /** 由 extension 在装配 Agent 后注入（open 命令路径），同时绑定会话级可观测事件 */
  public setAgent(agent: Agent): void {
    // 记入本地投影表（键 = 面板当前会话）；真正归属仍由 extension 登记表持有
    if (this._currentSessionId) this._sessionAgents.set(this._currentSessionId, agent);
    this.bindAgent(agent);
  }

  /** 当前显示会话标识（extension 解析「命令作用于哪个会话」的唯一读取口） */
  public getCurrentSessionId(): string {
    return this._currentSessionId;
  }

  /**
   * 是否处于草稿态（**给 extension / 设置面板**：草稿期不得装配 Agent、不得写会话 meta）
   *
   * 草稿期「当前会话不存在」不能只靠 `getCurrentSessionId() === ''` 判断——命令路径会退回
   * `getInitialSessionId()`（上一个停留会话），拿它装配/写 meta 就作用到了错误的会话上。
   */
  public isDraftSession(): boolean {
    return this.isDraft;
  }

  /**
   * 草稿判据（**单一真源**）：标记为草稿 **且** 当前确实没有会话 id
   *
   * 二者缺一即非草稿：任何路径（含测试直注私有态）一旦写入 `_currentSessionId`，
   * 草稿即自动失效——避免「标记还在、会话已经有了」的双态。
   */
  private get isDraft(): boolean {
    return this._draft.isDraft && !this._currentSessionId;
  }

  /** 当前显示会话的 Agent（同步；未装配时 undefined ⇒ 调用方须 fail-closed，不得无校验直写） */
  public getCurrentAgent(): Agent | undefined {
    return this._agent;
  }

  /**
   * 把实例绑定为「当前显示会话」的投影源（换会话 / 换实例的唯一收口）
   *
   * 重置投影缓存 + 重绑事件/守卫/确认回调 + 装配后补推。`AgentEventScope.bindTo`
   * 内部先解绑上一台，故换会话不会滞留旧实例监听（幂等，重复绑定安全）。
   */
  private bindAgent(agent: Agent): void {
    this._agent = agent;
    // 角色包随显示会话走（方案 A）：投影必须强制重读，不能「仅空时补齐」（否则 name 与 traits 跨会话错配）
    this._activeRolePack = agent.rolePackManager?.activeName ?? undefined;
    // 解析不到不许静默：会话文件写了 X 而内核实际激活 Y ⇒ 落一条可见 notice（判据/文案单点外置）
    const fallbackNotice = sessionRolePackFallbackNotice(
      this.sessionStore,
      this._currentSessionId,
      this._activeRolePack,
    );
    // 每会话每进程只弹一次（反复弹窗会盖住新消息）；差异由徽章常驻显示（见 pushRolePacks）
    if (fallbackNotice) {
      const key = this._currentSessionId;
      if (!key || !this._rolePackFallbackNotified.has(key)) {
        if (key) this._rolePackFallbackNotified.add(key);
        this.post(fallbackNotice);
      }
    }
    // 换 agent = 投影源切换（SSOT）：重置队列长度缓存，防旧会话残留致「长度未变」误判不推送（新 agent 首 sync 必推）
    this._lastPendingQueueLen = undefined;
    // 与 ensureAgent 懒装配路径同收口：注入即绑定（bindAgentNoticeEvents 内部先 off 再 on，幂等）
    this.bindAgentNoticeEvents();
    // 绑定路径守卫安全审计订阅（幂等，先取消旧订阅再绑新）
    this.bindSecurityAudit();
    // 确认队列随显示会话切换：先更新前台（切走会话收卡 / 切入会话补推卡），再绑回调——
    // 顺序不可换：`bindWriteConfirmation` 的 sugar 按 `_foreground` 取会话，先切后绑才不会
    // 把新会话的回调绑到旧会话的队列上
    this._confirm.setForeground(this._currentSessionId);
    // 绑定确认回调（命令/脚本执行确认 + guest 写入；owner 写文件已直接落盘，默认 fail-closed）
    this.bindWriteConfirmation();
    // 装配完成后重算活跃度：切换会话会改变角标口径（当前显示会话的待处理不计入角标）
    this.refreshSessionActivity();
    // 装配后统一补推（时序竞态：ready 时 agent 可能未装配 ⇒ 徽章/角色列表会永久缺失）；
    // 唯一收口 = refreshAfterAssemble，本方法不另推一份（否则懒装配路径漏推）。
    this.refreshAfterAssemble();
  }

  /**
   * 启动对齐：宿主持有的当前会话（_currentSessionId）与内核 current 不一致时切到一致。
   *
   * 根因（2026-10-13 实测「启动后立即分叉报『当前会话不存在』，切一次会话即恢复」）：
   * - 宿主 chatPanel 构造即把 `_currentSessionId` 指向最近活跃会话（UI 启动回放它）；
   * - 内核 MessageHistory 的惰性初值却是 `${todayDate()}-main`（meta 要首轮对话才建）；
   * - 启动即分叉 ⇒ 内核查**自己** current 的 meta（不存在）→ 报错。同根因的更深伤害：启动后
   *   第一条消息的 Round 会挂到内核的 `-main`，与 UI 显示的会话错位——对齐修的是这一类，
   *   不只分叉一个症状。
   *
   * 对齐点选 refreshAfterAssemble：它是 setAgent（open 命令）与 ensureAgent（活动栏图标/面板
   * 恢复的懒装配）两条装配路径的唯一共用收口点，装配完成即调，早于任何用户交互
   * （「不得各钉一份」的完整论证见该方法 JSDoc）。switchToSession 的「切身份」段
   * （switchSession）在首个 await **之前** 同步完成——void 调用返回时 current 已切，无竞态窗口。
   *
   * 判据「不一致才切」：同会话重入（面板折叠重开的重复 setAgent）直接跳过——幂等无副作用，
   * 也避开对话繁忙时 switchToSession 的 busy 守卫误报。判据不可得（桩缺方法 / history
   * 未初始化返回 null）时同样跳过：不猜、不切，真实 SessionManager 恒有该读取口。
   *
   * 失败必须可见（notice）：静默则退回「启动即错位」的原症状。
   */
  private async alignKernelSession(agent: Agent): Promise<void> {
    const target = this._currentSessionId;
    const sm = agent.sessionManager;
    if (!target || !sm) return;
    let kernelCurrent: string | null = null;
    try {
      const info = sm.getCurrentSessionInfo();
      kernelCurrent = info ? `${info.date}-${info.session}` : null;
    } catch {
      kernelCurrent = null;
    }
    if (kernelCurrent === null || kernelCurrent === target) return;
    try {
      await sm.switchToSession(target);
    } catch (err) {
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Failed to align the startup session: {0}', toNoticeText(err)),
      });
    }
  }

  /** 推送三源技能清单到 chatView（composer 动态下拉 SSOT：与设置面板共用 listVisibleSkills） */
  private pushSkillList(): void {
    const agent = this._agent;
    if (!agent || !this._configDir) return;
    // 顺带回种钉住技能名（只有 name，不带 DTO）：显示态由同批 skills 现查（禁用优先）
    const pinnedName = pinned.pinnedNameOfStore(this.sessionStore, this._currentSessionId);
    this.post({
      type: 'skills_loaded',
      skills: listVisibleSkills({
        agent,
        configDir: this._configDir,
        userSkillsDir: this._userSkillsDir ?? '',
        projectSkillsDir: this._projectSkillsDir,
      }),
      ...(pinnedName ? { pinnedSkillName: pinnedName } : {}),
    });
  }

  /**
   * 重推技能清单（供 extension 在「技能启停」配置变更 / 手动重载后调用）
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
   * 角色包内部名 → UI 展示名（SSOT）
   *
   * 从内核 RolePackManager.listMeta() 反查 manifest.displayName（与工具名中文化
   * 同一体验原则）。displayName 缺省时回退内部名（name）——显示名单一来源 =
   * `displayName ?? name`，UI 层不另立硬编码映射。
   *
   * @param rolePack 角色包内部名（如 '白话方案设计师'）
   * @returns UI 展示名（displayName 或回退 name）
   */
  private roleDisplayName(rolePack: string): string {
    const meta = this._agent?.rolePackManager?.listMeta().find((m) => m.name === rolePack);
    return meta?.displayName ?? rolePack;
  }

  /**
   * meta 取证包（关键调用参数快照）：role/llm 身份 + 本轮调用参数面（窗口 / 输出上限 /
   * 推理深度 / 适配器形态）——真机异常轮自带取参数面，免截图、口问即可离线破案。
   * ⚠️ 参数面记的是**生效值**而非用户配置值：输出上限由内核 `buildChatOptions` 在 per-LLM
   * 配置与角色包策略 `act.outputLimit` 间取更小值（宿主不重算），只记配置面会把「我配了 64K」当成
   * 「真的发了 64K」——真机排雷已因此得出过错误结论（详见 tasks/审查-空响应根因排雷与优化方案-20260929.md）。
   * @param providerConfig 流首取的激活 Provider 配置快照（仅作为 agent 未装配时的回落来源）
   */
  private buildRoundMeta(providerConfig: LlmProviderConfig | undefined): ProcessMetaPayload {
    const role = this._activeRolePack ? this.roleDisplayName(this._activeRolePack) : 'AI';
    const llm = this._activeProviderDisplayName || this._providerStore.getActiveName() || '';
    // reasoning_effort 转达口径（流首**配置面**快照）：仅策略键 multiStepReasoning='manual' 发 'low'，
    // 其余不发送（缺省不入包）。⚠️ 非「实际发送面」——llmCaller 的 truncatedRetry 可在运行时置入
    // 'low'（截断换策略，T2），流首快照天然不可见；实际发送面以截断救回计数（truncationRecoveryCount）
    // 佐证。providerKind 当前唯一适配器形态（内核工厂只产 OpenAI 兼容）
    const reasoningMode =
      this._agent?.rolePackManager?.getActive()?.strategy.act?.multiStepReasoning;
    return {
      role,
      llm,
      contextWindow: providerConfig
        ? resolveContextWindow(providerConfig.contextWindow)
        : undefined,
      // 输出上限记**生效值**（内核 buildChatOptions 裁决后的实际请求值）：per-LLM 配置与角色包
      // act.outputLimit 取更小值，故配置值不能代表已发出去的值；agent 未装配时回落配置面。
      maxTokens: this._agent?.getEffectiveMaxTokens() ?? providerConfig?.maxTokens,
      reasoningEffort: reasoningMode === 'manual' ? 'low' : undefined,
      providerKind: 'openai-compatible',
    };
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
   * 推送工具权限徽章（角色切换后能力面随之变化）
   *
   * 从内核 RolePackManager.getActive() 读取当前角色包的 capabilities 与 toolMode，
   * 映射为可读标签（如 file:read → 只读、web:search → 联网），推送给 webview 渲染徽章。
   * 能力面标签映射为中文（简单映射，避免前端硬编码）。
   * 策略指示器（strategyHint）：提供只读模式/审批模式/温度分组等关键策略提示。
   */
  private postCapabilityBadge(): void {
    const agent = this._agent;
    if (!agent) return;
    const active = agent.rolePackManager?.getActive();
    if (!active) return;
    const toolMode = active.strategy.act?.toolMode ?? 'allow';
    // 三态判定走 host 唯一出口 `deriveCapabilityState`（未声明 / 显式空 / 白名单各为一支），
    // 本文件只提供**域级短标签投影**（输入区徽章比角色卡更紧凑），不在此重算 length——
    // 显示层再判一次就会与内核语义漂移（CAP-TRISTATE-1 的真机缺陷正是这样产生的）。
    const capabilityState = deriveCapabilityState(active.capabilities, capabilityDomainLabel);

    const strategy = active.strategy;
    const temp = strategy.act?.temperature ?? 0.7;
    const tempGroup = temp >= 0.8 ? 'high' : temp <= 0.4 ? 'low' : 'mid';
    const reasoningMode = strategy.act?.multiStepReasoning;

    const strategyHint = {
      toolReadonly: strategy.act?.toolReadonly,
      tempGroup: tempGroup as 'high' | 'mid' | 'low',
      reasoningMode: reasoningMode as 'auto' | 'manual' | undefined,
      summaryFocus: strategy.prepare?.summaryFocus,
      outputLimit: strategy.act?.outputLimit,
    };

    this.post({ type: 'capability_badge', toolMode, capabilityState, strategyHint });
  }

  /**
   * 投影一条 `chat_role_pack`（角色徽章 / 选择器当前项的**唯一上屏点**）
   *
   * ⚠ 展示名只能经 `roleDisplayName` 反查内核 listMeta（外部写一份 = 双源谎报）；差异提示走 fallback 口径。
   *
   * @param name 角色包名（undefined / 空串 = 无激活角色，投空名让 webview 清标签）
   */
  private postActiveRolePack(name: string | undefined): void {
    if (!name) {
      this.post({ type: 'chat_role_pack', rolePack: '', traits: undefined });
      return;
    }
    this.post({
      type: 'chat_role_pack',
      rolePack: this.roleDisplayName(name),
      traits: this.getActiveTraits(),
      team: this.getActiveTeamForProtocol(),
    });
  }

  /**
   * 角色包组（会议名单）热更新通知：settingsPanel 保存/删除队伍后调。
   * 不改变当前角色，只重推一次 chat_role_pack（带最新 team 字段）让 chatView 刷新 team 图标。
   * 兜底：activePack 即保存/删除的组长 → team 图标立即显隐；非组长改队本就不显示。
   */
  public refreshActiveRolePackForTeam(): void {
    if (!this._view || !this._activeRolePack) return;
    this.postActiveRolePack(this._activeRolePack);
  }

  /**
   * 角色 handoff 预填：将提示文案填入对话输入框（不自动发送，用户可编辑后回车）
   *
   * 对话视图已就绪 → 立即投递；未就绪（用户从设置面板首次带入对话）→ 缓冲到
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

  /**
   * 右键「添加到对话」：推送文件/目录引用到对话输入盒上方气泡行
   *
   * 对话视图已就绪 → 立即投递；未就绪（用户从资源管理器首次带入对话）→ 缓冲到
   * _pendingRefs，待 webview ready 后由 handleWebviewReady 补发，避免 postMessage
   * 在 webview 脚本监听器注册前丢失（与 prefillInput 同构）。
   */
  public pushRefs(refs: ChatRef[]): void {
    if (this._view) {
      this.post({ type: 'addRef', refs });
    } else {
      // 合并缓冲（多次右键累积，不覆盖）——去重走共享判据（含行区间，见 shared/refKey.ts）：
      // 同文件不同选区是两条引用，按 path 去重会让第二次操作静默失效。
      this._pendingRefs = dedupeRefs([...(this._pendingRefs ?? []), ...refs]);
    }
  }

  /**
   * HOST-CTX-1：@ 提及的文件选择器（输入框键入 @ 触发，W→E `mention_open`）
   *
   * 语义红线与三个 SSOT 归属、截断告知、in-flight 守卫、焦点归还全部随域外置到
   * `chatRefOps.ts`（B9-D-2）。本处只留一个公开转发口：webview 分发与宿主单测
   * （`chatPanelMention.test.ts`）都经它驱动，**不要**在面板里再写第二份列表/守卫逻辑。
   */
  public async openMentionQuickPick(): Promise<void> {
    await this._refOps.openMentionQuickPick();
  }

  /** 诊断数据（复制诊断命令消费；格式化与脱敏归 hostDiagnostics 模块） */
  getDiagnosticData(): DiagnosticsData {
    return { recentHostDiags: this._recentHostDiags, agentMetrics: this._agent?.getMetrics() };
  }

  /**
   * webview → 扩展的消息分发（HOST-CTX-12：自 onDidReceiveMessage 匿名回调摘出）
   *
   * 摘出的理由：原先整条链挤在匿名回调里、**零可测入口**——任何新消息类型与兜底分支都
   * 无从单测（本次 else 兜底就是加上之后才发现「有守卫却验证不了」）。现与 handleInput /
   * handleWebviewReady / setActiveFileAttach 同构，测试经 provider.handleWebviewMessage
   * 直接驱动。转发时 this 不变：链内零闭包变量依赖（只用 this.* 与 msg.*，不碰 webviewView）。
   */
  private handleWebviewMessage(msg: WebviewToExtensionMessage): void {
    if (msg.type === 'ready') {
      // webview 脚本就绪后才回放会话（历史 + Provider 列表）。前置 = 等 Agent 装配完成（在途即等）
      // + 打捞升级崩溃残留轮为 stop turn（保证升级轮随本回放一次性投递、不与 _viewEpoch 重建回放双发）
      void this.handleWebviewReady();
    } else if (msg.type === 'host_diag') {
      // webview 错误边界上报（T1）：日志留痕 + 诊断缓冲同点写入（不驱动 UI 状态）
      recordHostDiag(this._recentHostDiags, {
        at: new Date().toISOString(),
        source: msg.source,
        message: msg.message,
        stack: msg.stack,
      });
    } else if (msg.type === 'input') {
      // 输入统一入口：宿主按当前 turn 相位单一路由，错位输入丢弃并落宿主日志留痕
      void this.handleInput(msg);
    } else if (msg.type === 'open_settings_tab') {
      // 设置面板选项卡导航（空态引导 → 大模型 / 角色徽章 → 角色；只导航——切换执行仍走各视图单路径）。
      // **不维护「tab → 命令名」映射表**：那是第二真源，加一页要补一行且 protocol 得同步放宽。tab 直投命令。
      void vscode.commands.executeCommand('memora.openSettings', msg.tab);
    } else if (msg.type === 'open_setting') {
      // 指标空态指引「在设置中开启」：只做导航，配置读写真源 = VS Code 原生设置
      // （对话面板不写配置；键名由 webview 传入，本分支不复制键名清单）
      void vscode.commands.executeCommand('workbench.action.openSettings', msg.key);
    } else if (msg.type === 'open_ref') {
      // 引用 chip 点击：在编辑器打开并定位到行区间——「我到底加了哪几行」的直接答案
      // （1-based → 0-based 逆转换等定位细节归 openRefInEditor 单点，webview 只上报意图）
      void this.openRefInEditor(msg.ref);
    } else if (msg.type === 'mention_open') {
      // HOST-CTX-1：@ → 文件 QuickPick（多选）。列表真源 / 排除语义 / 首根 fail-closed /
      // 焦点归还全部归 openMentionQuickPick 单点（见其 JSDoc），本处只转发意图。
      void this.openMentionQuickPick();
    } else if (msg.type === 'set_active_file_attach') {
      // 当前文件 chip 的 ✕ / 关闭态点击：改会话级开关，回推投影（webview 以回推为准）
      this._activeFile.setActiveFileAttach(msg.enabled);
    } else if (msg.type === 'new_session') {
      // 标题条「＋」新建会话 → 切入空会话，旧会话归档进历史
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
    } else if (msg.type === 'archive_session') {
      // 历史浮层「移入留存」→ 仅改显示分组，不动数据（与删除是两种不同强度的动作）
      void this.handleArchiveSession(msg.sessionId);
    } else if (msg.type === 'restore_session') {
      // 留存区条目「移回」→ 同上的逆操作
      void this.handleRestoreSession(msg.sessionId);
    } else if (msg.type === 'rename_request') {
      // 标题条改名笔 → 弹 InputBox 输入新标题写入元数据
      void this.renameCurrentSession();
    } else if (msg.type === 'delete_turn') {
      // 删除单个问答闭环（轮容器底栏 / 右键菜单触发）：确认不可恢复后截断该轮及之后所有
      void this._turnOps.deleteTurnFrom(msg.roundId);
    } else if (msg.type === 'chat_set_provider') {
      void this.handleSetProvider(msg.name);
    } else if (msg.type === 'stop') {
      // 停止生成：中断当前流式输出（mvp-scope 打断能力）
      // 异步：paused 态需内核收场（appendInterrupted 落盘）后再回状态，失败不阻塞面板
      void this.handleStop();
    } else if (msg.type === 'pause') {
      // 暂停生成：调 agent.requestPause()（step 边界软暂停）暂停当前流
      this.handlePause();
    } else if (msg.type === 'clear_pending_queue') {
      // 清理由内核 clearPendingInterjections 原子操作 + getter 读，宿主不维护镜像副本
      //  （坑：手动镜像双写易出错）
      // 先读后清：丢弃信号需要被丢条目文本（webview diff 据此分流「消失 = 丢弃不上屏」）
      const before = this._agent?.getPendingInterjections?.() ?? [];
      const cleared = this._agent?.clearPendingInterjections() ?? 0;
      if (cleared > 0) {
        this.post({
          type: 'notice',
          level: 'info',
          message: l10n.t('Cleared {0} pending message(s)', cleared),
        });
        this.postPendingDiscarded(before);
      }
      this.syncPendingQueue();
    } else if (msg.type === 'remove_pending_item') {
      // 删除单条 interject（待发送区某条的独立 × 按钮）：
      // 内核 removePendingInterject 内部已做越界检查，宿主直接调内核 +
      // 从内核读当前值渲染（SSOT 源头 = loop.pendingInterjections）
      // 先读后删：按 index 取被删文本，删除成功才发丢弃信号（失败 = 队列未变，零信号）
      const before = this._agent?.getPendingInterjections?.() ?? [];
      const removed = before[msg.index];
      const ok = this._agent?.removePendingInterject(msg.index) ?? false;
      if (ok && removed !== undefined) {
        this.postPendingDiscarded([removed]);
      }
      this.syncPendingQueue();
    } else if (msg.type === 'polish_input') {
      // 文本润色（输入框入口）：调 agent.polish(text) 润色输入框内容，
      // 回执 polish_input_result（无 msgId——输入框润色不回写单条消息）
      void this.handlePolishInput(msg.text);
    } else if (msg.type === 'write_confirm_answer') {
      // 写入审批卡回传：用户确认/拒绝写入操作
      // （HOST-SPLIT-1 第 2 刀：应答处理整体迁至协调器 `answer`——顺序保持
      //   resolve → 决策留痕 → 终结+泵下一条，见 confirmCoordinator.ts 的 JSDoc）
      this._confirm.answer(msg.requestId, msg.approved);
    } else if (msg.type === 'confirm_all_file_changes') {
      // 对话区常驻条「全部确认」：复用已注册命令（纯内存清理，零风险，无需二次确认）
      void vscode.commands.executeCommand(CONFIRM_ALL_FILE_CHANGES_COMMAND);
    } else if (msg.type === 'revert_all_file_changes') {
      // 对话区常驻条「全部回退」：命令内部含模态二次确认（破坏性操作，勿绕过）
      void vscode.commands.executeCommand(REVERT_ALL_FILE_CHANGES_COMMAND);
    } else if (msg.type === 'background_kill') {
      // 两种语义共用一个通道（方案 §5.2.4）：`terminate` 真终止进程 / `dismiss` 仅收起这一行。
      // 缺省按 terminate（兼容旧 webview 发出的无 reason 消息）。
      if (msg.reason === 'dismiss') {
        this.dismissBackgroundTask(msg.taskId);
      } else {
        this.killBackgroundTask(msg.taskId);
      }
    } else if (msg.type === 'memory_delete') {
      // 记忆反馈删除（HOST-S3-3）：命中行 ✕ → 模态确认后软删（回收站可恢复），
      // 应答 memory_deleted 驱动 webview 摘除；取消确认不推送（settingsPanel 同款契约）
      void this.deleteMemory(msg.id);
    } else if (msg.type === 'image_ingest') {
      // 采集即写盘（IMG-2 Q1）+ 落盘即入字节缓存（断点A）：落盘点在 host/imageIngest，失败三态一律回执
      const img = this.imagePanelDeps();
      void ingestImage(this.workspacePath, msg, img.post, img.toWebviewUri, img.warmCache, img.t);
    } else if (msg.type === 'image_pick_request') {
      // 图片拾取（Q3）：无 paths = 开框拾取（按钮 / 命令面板）；有 paths = 拖入 URI 报送（IMG-13）
      // 或右键真图（IMG-12）直入同一摄取面。URI→fsPath 换算收在宿主（webview 零 vscode API）
      this.pickAndAttachImages(msg.paths?.map((u) => vscode.Uri.parse(u).fsPath));
    } else {
      // 未知消息类型（HOST-CTX-12）：**不静默丢弃**。正常不可能到达——两侧编译自同一份
      // protocol.ts；一旦出现 = webview 脚本与宿主**不是同一版本**（最常见：改 src 后重编译
      // 了 dist 却没重启扩展宿主——webview 脚本从磁盘读是新的，本 switch 活在宿主进程内存
      // 是旧的 ⇒ 表现为「某功能凭空消失、零反馈」）。落宿主日志供排查，**不驱动 UI、不弹
      // 提示**——也可能是无害的旧版本残留消息，用户无感知能力，不该被打断。
      console.warn(
        'Unknown webview message',
        (msg as { type: string }).type,
        'host not restarted?',
      );
    }
  }

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // 重开自愈（B1）：销毁时已清空会话 id，按真源重新派生（拿锁在 ready 握手）。
    // 草稿态必须跳过：重开视图若按 `getInitialSessionId()` 派生，会把草稿悄悄退回上一个会话
    if (!this._currentSessionId && !this.isDraft) {
      this._currentSessionId = this.sessionStore.getInitialSessionId();
    }
    this._lockFinalizer.onResolve();
    // 视图重建代数自增：本次流若跨重建，流尾据此补移植（见 _viewEpoch 注释）
    this._viewEpoch += 1;
    // 活动文件显示订阅随视图装配：面板折叠/展开会重建 webview，必须重注册并补推一次
    // （vscode.window 事件是全局的，不随 webview 自动释放，见 onDidDispose）
    this._activeFile.ensureActiveFileTracking();
    // 折叠/展开触发 resolve 重建 HTML：走「ready 回放」——重建后脚本就绪发 ready，extension
    // 回放已落盘会话（运行中 turn 由 replaySession.resumeRunningTurn 补推）；不设
    // retainContextWhenHidden：官方语义隐藏期脚本挂起、现场不保真，交「设备重建 + 运行中
    // 兜底重放」统一恢复，避免两套机制漂移。外部脚本：localResourceRoots 指向 dist/webview
    // 供 asWebviewUri 解析（CSP script-src 'self'）
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        // IMG-2 K3：attachments 磁盘预览（与 CSP img-src 放行成对，理由真源见 htmlShell buildHtmlHead jsdoc）
        vscode.Uri.file(resolveAttachmentsDir(this.workspacePath)),
      ],
    };

    // 仅设置 HTML（不在就绪前回放，避免消息在脚本监听器注册前丢失）
    this.render();

    // 打开面板即确保 Agent 装配（不依赖先执行 open 命令），避免发送无反应
    void this.ensureAgent();

    // 视图被销毁（折叠/关闭）时清理引用，避免向已销毁 webview postMessage；
    // 同时释放活动文件显示订阅（vscode.window 事件不随 webview 自动释放）。
    // 开关态 `_attachActiveFile` **不重置**：它是会话级用户意图，折叠一次不该被悄悄改回开。
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) this._view = undefined;
      this._activeFile.disposeActiveFileTracking();
      // E5：面板销毁时解绑本面板在所属 Agent 上的全部会话级订阅（A 事件不再流向已销毁面板；
      // 共享 Agent 不因面板生命周期而累积监听器）。
      this.unbindAgentNoticeEvents();
      // 安全审计订阅同属 agent.security 上的长期监听：一并释放，重新装配时由
      // bindSecurityAudit 幂等重绑。
      this._securityAuditUnsub?.();
      this._securityAuditUnsub = undefined;
      // 批 3：按持有集逐个放锁（流中会话挂起，收场后归还）；**不注销、不 close** 任何实例
      // （实例归登记表所有，视图折叠/重开不得让旧会话的活实例变成 use-after-close）
      this._lockFinalizer.onDispose((id) => this.runtimeFor(id).streaming);
    });

    // 消息分发入口（HOST-CTX-12）：整条 if-else 链已摘为 private handleWebviewMessage，此处只
    // 转调。链上 120+ 分支原先挤在匿名回调里、零可测入口（「判据对、接线没接上」同族：新消息
    // 类型与兜底分支都无从单测）——摘出后与 handleInput 等同构、可单测。
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      this.handleWebviewMessage(msg);
    });
  }

  /**
   * 确保 Agent 已装配：若尚未装配则通过工厂懒装配一次
   *
   * 用户可能直接点活动栏面板图标打开（未执行 open 命令），此时 agent 从未装配，
   * 会导致发送无反应。此方法在打开面板时自动装配，失败时给出明确提示。
   *
   * 可等待性：装配进行中再次调用会 await 在途 Promise（_agentReady），
   * 而非早退——保证 'ready' 流程可在首次回放前拿到 Agent（崩溃恢复打捞的前置）。
   */
  private async ensureAgent(): Promise<void> {
    // 草稿态不装配 Agent（红线）：草稿没有会话 id，装配只能绑到错误的会话上
    if (this.isDraft) return;
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

  /**
   * 配置变更后的入口（HOST-BUG-1 补全初始化 + IMG-5 已装配实例刷新）。由 extension.ts 的
   * onDidChangeConfiguration 在 `memora.providers` / `memora.activeProvider` 变更时调用：
   *   - **已装配** → **不重建 agent**（会打断会话），只失效派生副本：按钮态按真源重推 + 能力位
   *     换新实例；有轮在跑时置 stale 顺延。**IMG-5 补的就是这一支**（旧实现此处直接 return，
   *     于是「已勾选 supportsVision 但 agent 仍持旧能力位」只能靠 Reload 解除）；
   *   - 装配在途 → 不制造并行装配；面板未打开 → 留给 resolveWebviewView 的 ensureAgent。
   * 失败态可重试由 performAgentAssembly 的 catch 重置 _agentReady 保证（失败后 _agentReady=null ⇒ 真正重启装配，而非 await 僵尸 Promise）。
   */
  public async retryAgentAssembly(): Promise<void> {
    if (this._agent) {
      await this.applyActiveProviderRefresh();
      return;
    }
    if (this._agentReady !== null || !this._view) return;
    await this.ensureAgent();
  }

  /** Agent 懒装配实际执行体（ensureAgent 分离：Promise 缓存 + 一次性执行） */
  private async performAgentAssembly(): Promise<void> {
    if (!this._getAgent) return;
    // 草稿不装配 Agent（红线）：没有会话 id 就没有可绑定的会话，装配出来只能绑到别处去
    if (this.isDraft) return;
    try {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Memora: open a workspace first'));
        return;
      }
      // 会话先于实例：无会话 ⇒ 直接进草稿（不造 id、不拿锁）
      const sessionId = await this.ensureSessionForAssembly();
      if (!sessionId) {
        this._draft.enter();
        return;
      }
      const agent = await this.agentForSession(sessionId);
      // 绑定显示源（事件/守卫/确认 + 装配后补推的唯一收口）
      this.bindAgent(agent);
      // 首次启动兜底：装配成功后若无任何会话记录，进入草稿态（不再自动建空会话）
      void this.ensureInitialSession();
    } catch (err) {
      const msg = toNoticeText(err);
      void vscode.window.showErrorMessage(vscode.l10n.t('Memora assembly failed: {0}', msg));
      // HOST-BUG-1：失败必须重置 Promise 缓存——否则 _agentReady 成「已 settle 但
      // _agent 仍 null」的僵尸，后续 ensureAgent 永远 await 它、永不重试。
      // 对齐 `AgentRegistry` 的「失败不入表、下次可重试」契约（宿主侧不再持有 Promise 缓存）。
      this._agentReady = null;
    }
  }

  /** 首次装配时确保有会话 id：无会话 ⇒ 返回 ''（**不再自动造会话**，草稿由控制器承载） */
  private async ensureSessionForAssembly(): Promise<string> {
    // 不再无会话即造 id：面板打开/启动时造会话 = 空会话记录（2026-11-07 用户拍板废弃该行为）
    return this._currentSessionId;
  }

  // ─── 会话事件出口（B9-D 按 op 组外置） ───
  // 内核会话级 / 后台事件 → notice 与派生投影刷新，整域在 `chatNoticeOps.ts`
  // （纯「事件 → 输出」映射，依赖面 = 11 个窄接口；文案与 l10n 键也归那里）。
  // 本类只负责：拿到稳定引用、按事件名装订、解绑。

  /**
   * 记忆反馈删除（HOST-S3-3）—— 实现已按 op 组外置到 `chatMemoryOps.ts`（B9-D-5）；
   * 本处只留转发口（webview 分发与既有白盒测试继续按原入口驱动）。
   */
  private async deleteMemory(id: string): Promise<void> {
    await this._memoryOps.deleteMemory(id);
  }

  /**
   * 绑定会话级可观测事件（E5：订阅源 = **本面板持有的那台 Agent 实例**）
   *
   * 绑定路径：`AgentEventScope.bindTo(this._agent, binder)` —— 作用域只碰传入的实例，
   * 不做全局转发；换实例/面板销毁时由 `dispose()` 统一解绑（见 webviewView.onDidDispose）。
   * binder 内每个事件仍先 `off` 再 `on`（同一面板重复绑定幂等），并返回解绑闭包。
   */
  private bindAgentNoticeEvents(): void {
    if (!this._agent) return;
    const a = this._agent;
    // 处理器集合的稳定引用（外置域，见 `chatNoticeOps.ts`）：装订表内只读一次，不重复取
    const notice = this._notice;
    this._noticeEventScope.bindTo(a, (agent) => {
      // 每条订阅的解绑闭包：与「事件名 + handler 引用」一一对应，作用域统一释放
      const unsubscribers: Array<() => void> = [];
      /** 注册一对 off→on（幂等），并把解绑闭包收进作用域 */
      const on = <K extends keyof AgentEventMap>(
        event: K,
        handler: (payload: AgentEventMap[K]) => void,
      ): void => {
        agent.off(event, handler);
        agent.on(event, handler);
        unsubscribers.push(() => agent.off(event, handler));
      };
      on('sessionError', notice.onSessionError);
      on('sessionResumeFailed', notice.onSessionResumeFailed);
      on('sessionResumeBlocked', notice.onSessionResumeBlocked);
      on('sessionPauseTimedOut', notice.onSessionPauseTimedOut);
      // 低扰信息（截断/压缩/归档失败）→ info 级提示条
      on('contextTruncated', notice.onContextTruncated);
      // LLM 主动压缩事件订阅（与 contextTruncated 的内核自动截断区分）
      on('contextCompressed', notice.onContextCompressed);
      on('archiveFailed', notice.onArchiveFailed);
      // 会话归档写入成功（内核异步归档完成后发）→ 重拉会话列表：历史条目摘要/keyTopics
      // 即时更新，否则条目停留在切走时的快照、悬停 tooltip 恒空
      on('sessionArchived', notice.onSessionArchived);
      // 角色包切换 → UI 角色选择器实时对齐（内核粘性切换/显式激活）
      on('rolePackSwitched', notice.onRolePackSwitched);
      // 后台任务自然终态 → 推 UI 快照（脱管后 turn 已结束：周期性推送点（step_boundary /
      // background_report）都已过、也没有 kill 动作，覆盖不到「任务自然跑完」⇒ 条会一直
      // 显示假活跃的「运行中」。主动 kill 不发本事件。见方案文档 §5.2.2）
      on('backgroundTaskSettled', this._snapshots.onTaskSettled);
      // 项目切换：projectSwitched 事件随内核 PR-SWITCH-1 一并删除（多项目改为宿主各建一个
      // Agent 实例，内核不再切换项目）⇒ 此处原订阅为僵尸（永不触发），已移除。
      on('workProjectionGenerated', notice.onWorkProjectionGenerated);
      // 后台事件 → info 级提示条（调试可观测性）
      on('configReloaded', notice.onConfigReloaded);
      on('archiveModeChanged', notice.onArchiveModeChanged);
      // 角色包切换锁定事件（补全 rolesView 点设为当前被锁时的 silent failure）
      on('rolePackSwitchLocked', notice.onRolePackSwitchLocked);
      // memoryRecalled：LLM 回答前召回 N 条记忆 → info 级感知提示
      on('memoryRecalled', notice.onMemoryRecalled);
      // 高价值事件：输入过大预警
      on('inputTooLarge', notice.onInputTooLarge);
      // 中价值事件：分叉完成 + 去重完成 + 槽位澄清
      on('sessionForked', notice.onSessionForked);
      // 删后注记（2026-10-18 · 5.0.0）：曾订阅内核 `dedupCompleted` 弹 notice，该事件随内核
      // 治理链退役（GOVERNANCE-SRC-1）一并拆除——留着就是僵尸订阅（永不发射 ⇒ 静态检查恒过）。
      // 勿加回；内核 `AgentEventMap` 已无此键。
      // 低价值事件：会话状态冗余确认
      on('sessionPaused', notice.onSessionPaused);
      on('sessionResumed', notice.onSessionResumed);
      on('sessionRecovered', notice.onSessionRecovered);
      // SSOT 会话标题同步：LLM 自动生成标题后，刷新 webview 顶部标题
      on('sessionTitleUpdated', notice.onSessionTitleUpdated);
      return unsubscribers;
    });
    // 角色包**激活态**变更（含删激活包后的兜底回退）→ 复用同一条 UI 更新路径；防双发在处理器内
    bridgeRolePackActivation(a.rolePacks, this._notice.onRolePackSwitched);
  }

  /** 解绑本面板在所属 Agent 上的全部会话级订阅（幂等；面板销毁/换实例时调用） */
  private unbindAgentNoticeEvents(): void {
    this._noticeEventScope.dispose();
  }

  /**
   * 绑定路径守卫安全审计订阅（安全/装配透明）
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
      // 透出内核拒绝原因（pathGuard path-deny 含 reason 如「命中黑名单」「路径越界」）；
      // 丢弃 reason 则用户只看到「拒绝」却不知为何。
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
   * 绑定确认回调（`SecurityGuard.onWriteConfirmation` 唯一注入口）—— **sugar 委托**
   *
   * HOST-SPLIT-1 第 2 刀：实现已迁至 `extension/host/confirmCoordinator.ts`
   * （`ConfirmCoordinator.bindWriteConfirmation`）。此处保留同名薄委托——按规则 §6.2
   * 「原接口名保留作 sugar、内部委托、调用方零改动」：调用方 = `setAgent` / `ensureAgent`
   * 两条装配路径 + `chatPanelDecision.test.ts` 的驱动入口，**均零改动**。
   *
   * ⚠️ 禁在此加确认队列逻辑：新判据一律写进协调器真源。
   */
  private bindWriteConfirmation(): void {
    this._confirm.bindWriteConfirmation();
  }

  // ─── 问答结构破坏性操作（B9-D-3 按 op 组外置） ───
  // 截断核（delete_turn / regenerate 共用：运行时守卫 → 确认 → store 截断 → 现场作废 →
  // 联动软删 → 重放）整段在 `chatTurnStructureOps.ts`；两处入口只经 `_turnOps` 调用，
  // **不得**在此复写第二份截断逻辑。

  /**
   * 推送历史会话列表（对 session_list 的应答）
   *
   * 只返回非当前会话（设计收敛：当前会话不进历史记录），按 updatedAt 降序，
   * 供 webview 渲染历史模态浮层。无历史时 sessions 为空数组（webview 显示空态）。
   */
  private pushSessionList(): void {
    // 投影口径（非当前会话 / 降序 / 单数据源 + 前端过滤）见 helpers/sessionList 头注释
    this.post(buildSessionListMessage(this.sessionStore, this._currentSessionId, vscode.l10n));
  }

  /** 历史运维动作的依赖注入（单一构建点：新增动作只在此挂依赖，不在各处散开） */
  private historyDeps(): SessionHistoryDeps {
    return {
      store: this.sessionStore,
      // 按**目标会话**判（批 2：后台会话可独立跑流；只判当前会话会放行对后台流会话的删除/归档）
      isStreaming: (sessionId?: string) => this.runtimeFor(sessionId).streaming,
      // 判「本面板是否已为该会话长持锁」而非「是否当前会话」：切走的旧会话仍有活实例写盘
      isLockHeld: (sessionId) => this._lockFinalizer.holds(sessionId),
      currentSessionId: () => this._currentSessionId,
      notify: (level, message) => this.post({ type: 'notice', level, message }),
      pushList: () => this.pushSessionList(),
      softDeleteMemories: (removedIds) => this.softDeleteSessionMemories(removedIds),
      archiveMode: () => {
        // 走「先取局部再判空」而非直接对 _agent 用可选链调用：
        // 可选链调用会被 agent 强制依赖面守卫记成**严格形态**（新增严格依赖须先登记并补替身）
        const agent = this._agent;
        return agent ? agent.getArchiveMode() : undefined;
      },
      // Agent 未装配 ⇒ 抛错由 triggerManualArchive 兜成可见 notice（与改前同文案）
      requestArchive: async (date, session) => {
        const agent = this._agent;
        if (!agent) throw new Error(l10n.t('Memora: Agent is not ready; retry shortly'));
        await agent.archiveSession(date, session, { skipIfUnchanged: true });
      },
    };
  }

  /** 删除会话（薄包装：实现外置在 `helpers/sessionHistoryActions`，测试按方法名直达） */
  private async handleDeleteSession(sessionId: string): Promise<void> {
    await deleteSessionAction(this.historyDeps(), sessionId);
    // E4 批 2：删除成功（会话元数据已不存在）⇒ 回收该会话实例（登记表 unregister + close），
    // 否则后面对同 id 的取用会拿到「挂在已删会话上」的活实例（写盘无归属）
    if (this.sessionStore.getSessionMeta(sessionId)) return; // 用户取消 / 锁占用 / 失败：实例保留
    this._sessionAgents.delete(sessionId);
    await this._releaseAgent?.(sessionId);
    this._lockFinalizer.releaseOne(sessionId); // 批 3：实例 close 之后才归还长锁（不放长锁见 oneShotLock）
    // 会话级僵尸清理（E4 批 3）：ask 协调器 / 确认队列 / 流运行态三处都按会话持有内存态，
    // 不随会话元数据删除消失 ⇒ 已删会话会永久留在活跃度遍历面（角标误亮、超时计时器照烧）。
    const ask = this._asks.get(sessionId);
    if (ask) {
      // 先摘登记再清在途：clearPending 会触发 onPendingChanged 重算活跃度，
      // 此时已不在遍历面，不会把已删会话短暂算进待处理
      this._asks.delete(sessionId);
      ask.clearAskTimeout(); // 停掉 30 分钟超时（否则到点会对已删会话续跑）
      ask.clearPending();
    }
    this._confirm.disposeSession(sessionId);
    this._runtime.delete(sessionId);
    this._snapshots.deleteSession(sessionId); // 任务条「收起态」桶随会话一起消失（防僵尸 id 长期驻留）
    this._rolePackFallbackNotified.delete(sessionId); // 回落提示去重键同生命周期收口
    this.refreshSessionActivity(); // 摘除后立即重推快照（角标 / 列表标识随之熄灭）
  }

  /** 移入留存区（薄包装：实现在 `helpers/sessionHistoryActions`） */
  private handleArchiveSession(sessionId: string): Promise<void> {
    return archiveSessionAction(this.historyDeps(), sessionId);
  }

  /** 移回近期列表（薄包装：实现在 `helpers/sessionHistoryActions`） */
  private handleRestoreSession(sessionId: string): Promise<void> {
    return restoreSessionAction(this.historyDeps(), sessionId);
  }

  /**
   * 推送归档模式**运行时**真值给 chat webview（`chat_archive_mode`）
   *
   * 与设置面板的 `archive_mode_status`（**持久偏好**）刻意分开：偏好保存后运行时可能顺延
   * 未生效（内核 busy 拒切 → 轮终补执行），按钮文案若读偏好会在顺延窗口内说谎。
   *
   * 真源 = `agent.getArchiveMode()`（宿主不维护镜像副本）。Agent 未装配时**不推送**——
   * 运行时真值此刻不存在，推送任何值都是编造（webview 维持初值 'full' = 内核缺省）。
   */
  private pushArchiveModeRuntime(): void {
    const agent = this._agent;
    if (!agent) return;
    this.post({ type: 'chat_archive_mode', mode: agent.getArchiveMode() });
  }

  /**
   * 随问答闭环物理删除联动软删记忆摘要（实现见 `chatMemoryOps.ts`：降级优先，不阻断主流程）
   *
   * 会话级摘要不在此列：它不进记忆库，而存于 SessionMeta（summary/keyTopics），
   * 随 deleteSession 一并删除，无需联动。
   */
  private softDeleteSessionMemories(removedIds: string[]): void {
    this._memoryOps.softDeleteSessionMemories(removedIds);
  }

  /** 进入草稿态（标题条「＋」/ 无会话启动兜底）：展示面归零，不产生会话状态 */
  public async newSessionFromCommand(): Promise<void> {
    this._draft.enter();
  }

  /**
   * 草稿期角色选择（设置页「设为当前」在草稿态的唯一写点）：只写草稿内存，不装配、不写 meta；
   * 落盘在 `createSession` 随会话 meta 一次写入。非草稿调用无效（真实会话仍走 `agent.switchRolePack`）。
   */
  public setDraftRolePack(name: string): void {
    if (!this._draft.isDraft) return;
    this._draft.selectRolePack(name);
  }

  /** 草稿期当前角色名（undefined = 未选 ⇒ 设置页显示内核兜底包；真实会话返回 undefined） */
  public getDraftRolePackName(): string | undefined {
    return this._draft.isDraft ? this._draft.rolePackName : undefined;
  }

  /** 会话导航唯一写点：内存字段 + 「上次停留」指针必须成对更新
   * （只赋值不落盘 = 复现 SESSION-RESUME-1：切过去看历史、重启跳回别处，且症状静默）。 */
  private setCurrentSessionId(sessionId: string): void {
    this._currentSessionId = sessionId;
    // 有会话 id ⇒ 必然已离开草稿（唯一退出写点）
    this._draft.exit();
    this.sessionStore.setLastActiveSession(sessionId);
  }

  /**
   * 切入指定会话（新建/首次自动创建共用）：**先拿锁 → 切宿主当前会话 → 按会话取/建实例 → 回放**
   *
   * E4 批 2 起各会话有自己的 Agent 实例：此处不再调 `switchToSession` 改单实例身份，
   * 而是「取该会话的实例并绑定为显示源」（实例装配时已在核内核侧切到该会话）。
   *
   * @param sessionId 目标会话 id（date-name 格式）
   * @returns 是否切入成功
   */
  private async createSession(sessionId: string, rolePackName?: string): Promise<boolean> {
    // 新会话 id 由时间戳/随机后缀生成，跨进程不会撞；拿锁只为让后续写盘有归属
    if (!(await this._lockFinalizer.acquire(sessionId))) {
      this.post({ type: 'notice', level: 'info', message: sessionHeldNotice() });
      return false;
    }
    const previous = this._currentSessionId;
    try {
      // 先切宿主当前会话：装配会由登记表在核内核侧切到该会话（无需再改单实例身份）
      this.setCurrentSessionId(sessionId);
      // 角色来源：草稿显式选择 > 用户级默认 > 兜底包；校验真源 = 角色包目录编目（冷启动亦可读）
      const roleDecision = await decideNewSessionRolePack(rolePackName, this._readRolePackCatalog);
      // 角色名的**唯一落盘点**（必须早于装配：装配经 readSessionRolePackName 读回）；未选/失效不写
      if (roleDecision.rolePackName) {
        this.sessionStore.updateSessionMeta(sessionId, {
          activeRolePackName: roleDecision.rolePackName,
        });
      }
      const agent = await this.agentForSession(sessionId);
      this.bindAgent(agent);
      // 默认包失效 / 无法校验：meta 未写 ⇒ 既有「原角色包」提示不会触发，用独立文案如实告知
      const roleNotice = newSessionRolePackNotice(roleDecision, agent.rolePackManager?.activeName);
      if (roleNotice) this.post(roleNotice);
      this.replaySession();
      // 会话视图入口（新建）：任务条按「显示会话」投影，必须显式 force（不赌后续事件到来，否则串台）
      this.postBackgroundTasks('force');
      return true;
    } catch (err) {
      // 没切成就把新锁还回去，并把显示源退回旧会话（旧实例仍在本地投影表里，直接重绑）
      this._lockFinalizer.releaseOne(sessionId);
      this._sessionAgents.delete(sessionId);
      if (previous) {
        this.setCurrentSessionId(previous);
        const previousAgent = this._sessionAgents.get(previous);
        if (previousAgent) this.bindAgent(previousAgent);
      } else {
        // 无旧会话可退：经收尾器同一清空写点归零（守卫要求源码仅一处清空赋值）
        this._sessionIdAccess.clearSessionId();
      }
      this.post({
        type: 'notice',
        level: 'error',
        message: toNoticeText(err),
      });
      return false;
    }
  }

  /**
   * 首次启动兜底：无任何会话记录 → **进入草稿态**（不再自动建会话）
   *
   * 旧行为「装配成功即造空会话」正是空会话记录的来源；新行为下用户看到干净空白页，
   * 第一次发送才落会话（见 `DraftSessionController.flush`）。已创建/已草稿不触发。
   */
  private async ensureInitialSession(): Promise<void> {
    if (this._currentSessionId || this.isDraft) return;
    this._draft.enter();
  }

  /**
   * 取（或建）指定会话的 Agent 实例，并把结果记入本地投影表
   *
   * **唯一写入点**：先查本地投影表（同步可复用），未命中则经 extension 的 `AgentRegistry`
   * 取/建（复用、在途去重、装配都在那里）。本方法**不绑定显示源**——是否绑定由调用方决定
   * （后台会话也要能取到实例，但不能抢走显示）。
   *
   * @param sessionId 目标会话标识
   */
  private async agentForSession(sessionId: string): Promise<Agent> {
    if (!this._getAgent) throw new Error(l10n.t('Memora: Agent factory is not injected'));
    const cached = this._sessionAgents.get(sessionId);
    if (cached) return cached;
    const agent = await this._getAgent(this.workspacePath, sessionId);
    this._sessionAgents.set(sessionId, agent);
    // 装配即绑定确认回调（按会话）：后台会话的确认请求也必须能入队并标待处理；
    // 若只在「绑定显示源」时绑，后台实例的守卫回调永远是空的 ⇒ 确认永远不触发（静默挂起）
    this._confirm.bindSession(sessionId, agent);
    return agent;
  }

  /**
   * 分叉当前会话（AI 回复底部「分叉」按钮触发）
   *
   * 实现已按 op 组外置到 `chatSessionNavOps.ts`（B9-D-4）；本处只留公开转发口
   * （webview 消息分发与既有白盒测试仍按原入口驱动）。
   */
  public async forkCurrentSession(roundId?: string): Promise<void> {
    await this._navOps.forkCurrentSession(roundId);
  }

  /** 改名当前会话（实现见 `chatSessionNavOps.ts`：只改元数据、不改会话结构） */
  public async renameCurrentSession(): Promise<void> {
    await this._navOps.renameCurrentSession();
  }

  /** 切换到指定会话（实现见 `chatSessionNavOps.ts`：取/建实例 → 绑定显示源 → 回放） */
  public async switchToSession(sessionId: string): Promise<void> {
    await this._navOps.switchToSession(sessionId);
  }

  /** 确保 Agent 已装配（未装配时返回 undefined 并提示） */
  private async getAgentOrWarn(): Promise<Agent | undefined> {
    if (this._agent) return this._agent;
    await this.ensureAgent();
    if (!this._agent) {
      void vscode.window.showWarningMessage(l10n.t('Memora: Agent is not ready; retry shortly'));
      return undefined;
    }
    return this._agent;
  }

  /**
   * 推送历史会话上下文占用（轻量版）
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
      const history = collectOccupancyHistory(
        !!this._viewLoader,
        () => loadRoundBasedHistory(this._viewLoader, this.sessionStore, this._currentSessionId),
        () => loadMessagesHistory(this.sessionStore, this._currentSessionId),
      );
      const dialogueTokens = estimateTokensMessages(history);
      // 角色包固定开销：优先取内核当前激活角色包底盘占用（装配/切换即确定，冷启动也有真实值）；
      // 该指标暂无时回退 occupancy 旧值（兼容极端时序），再回退 0。
      const ctx = agent.getMetrics().context;
      const rolePackBaseTokens = ctx.rolePackBaseTokens ?? ctx.occupancy?.rolePackBaseTokens ?? 0;
      const occ = estimateOccupancy({
        totalTokens,
        rolePackBaseTokens,
        // 历史会话重算无动态 system 注入（持久化历史只含 user+assistant）→ 显式 0
        dynamicSystemTokens: 0,
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
   * 重放会话消息（round-based 单条 turn_update 承载 rounds / legacy 扁平回退）
   *
   * round-based 唯一路径：整轮 rounds 由 `postTurnUpdate(undefined, true)` **单条投递**，
   * webview 端 `renderReplayFromRounds` 整批重建，不发 user / replay_events / assistant
   * 消息风暴（重放正文统一走 rounds，webview 与运行时共用同一渲染函数）。
   * 回放前做**会话加载期预读**（IMG-2 §5.4.1）：窗口内附件字节读盘填缓存，失败不阻断。
   * 读取失败不阻塞面板展示（SSOT 不藏错，避免「历史空白」静默吞因）。
   */
  private replayHistory(): void {
    // 会话管理纯度：无当前会话（初始空态）→ 清空消息区并返回，不进入任何会话回放路径
    if (!this._currentSessionId) {
      this.post({ type: 'clear_ok' });
      return;
    }
    // 会话加载期预读（IMG-2 §5.4.1）：窗口内附件字节同步读盘填缓存，供 formatMessages 同步命中
    this.imageCache?.preloadSession(this._viewLoader, this.workspacePath, this._currentSessionId);
    try {
      if (this._viewLoader) {
        // round-based：单条 turn_update 承载全量 rounds。replay:true 标记「整批重放」——
        // webview 据此整批重建，与运行时每步投影（replay 缺省）区分，杜绝 settle 重绘重复。
        // live 并入：本流仍在跑/暂停中时（缓冲未清），未落盘的流式正文 + 增量过程事件
        // 经 buildLiveTurnFromBuffer 并入投影，原位替换落盘半残快照——单条消息即完整恢复，
        // 不新增第二条重放通道（杜绝与流尾 _viewEpoch 比对重放的双通道漂移）。
        this.postTurnUpdate(this.buildLiveTurnFromBuffer(), true);
        return;
      }
      // legacy 扁平回退（viewLoader 未注入时）：重放正文统一走 round-based rounds，
      // 此路径仅回放 user 消息。
      const history = loadMessagesHistory(this.sessionStore, this._currentSessionId);
      for (const m of history) {
        if (m.role === 'user') {
          this.post({ type: 'user', text: m.content, ts: m.ts, roundId: m.roundId });
        }
      }
    } catch (err) {
      console.warn('Memora failed to load session history', err);
      // 历史加载失败给用户可见提示，避免「历史空白」静默（SSOT 不藏错）
      this.post({
        type: 'notice',
        level: 'error',
        message: l10n.t('Failed to load session history; try switching sessions and retry'),
      });
    }
  }

  /** 仅渲染 HTML 骨架（历史/Provider 在 webview 就绪后经 replaySession 回放）；
   *  脚本由外部 chatView.js 提供（经 asWebviewUri 引用） */
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
   * webview ready 处理：等 Agent 装配 + 崩溃残留轮打捞升级 → 再回放会话。
   *
   * 回放前置理由：升级后的中断轮须随首次回放（roundIds 已含）一次性投递，避免新增第二条
   * 回放通道（否则与 _viewEpoch 折叠重建回放产生双重复放）。
   */
  private async handleWebviewReady(): Promise<void> {
    // 草稿态（webview 重建，面板对象存活）：只重建草稿页。
    // 不能走启动归属裁决——它按「无当前会话」会退回/新建会话，那会在草稿期落记录。
    if (this.isDraft) {
      this.replaySession();
      this.refreshSessionActivity(true);
      return;
    }
    try {
      // ① 等 Agent 装配完成（在途即等待；失败内部消化为错误提示，不抛出）
      await this.ensureAgent();
      // ①.5 跨进程会话归属：两窗口同时恢复到最后活跃会话时，本窗口让位（防静默覆盖）
      await this.claimInitialSessionOwnership();
      // ② 打捞升级崩溃残留轮（once-guard；无当前会话/无 Agent 时跳过，等待下次触发再试）
      await this.upgradeInterruptedRounds();
    } catch (err) {
      console.warn('Memora 崩溃恢复打捞升级失败（不阻断历史回放）', err);
    }
    // ③ 回放会话历史（历史 + Provider 列表；升级轮已入 roundIds，随本次回放按普通 turn 投递）
    this.replaySession();
    // ④ 文件改动常驻条补推：该条只在「改动集变化」时推送，面板重开/回放时必须补一次——
    //    否则关掉面板再打开，常驻条凭空消失（项目里踩过四次的「时间面」漏面）。
    this.pushFileChanges();
    // ⑤ 后台任务条补推：与 ④ 同型的时间面漏面——本条平时只由推送事件点驱动（五个点的
    //    枚举见 postBackgroundTasks 注释，唯一真源不在此复制），面板重开时新 webview 从未
    //    收到过该消息 ⇒ 条凭空消失，而进程还在跑、用户看不到也砍不掉。
    //    **必须走 'force' 绕签名去重**（签名跨重建残留）。
    this.postBackgroundTasks('force');
    // ⑥ 归档模式运行时真值补推：与 ④⑤ 同型的时间面漏面——该值平时只由 archiveModeChanged
    //    事件驱动（切换才推），面板重开时新 webview 从未收到 ⇒ 留存按钮文案退回初值 'full'，
    //    在 manual 模式下会漏说「顺带归档」这一层（用户点了才发现多做了事）。
    this.pushArchiveModeRuntime();
    // ⑦ 活动文件 chip 补推：与 ④⑤⑥ 同型的时间面漏面——投影平时只由编辑器事件驱动，
    //    面板重开时新 webview 从未收到 ⇒ chip 凭空消失（用户失去「本轮带了什么」的唯一入口）。
    //    **必须 force**：去重基线跨重建残留，不绕就会把首推吞掉。
    this._activeFile.pushActiveFile(true);
    // ⑧ 会话活跃度快照补推（同上：新 webview 无旧快照 ⇒ 「运行中/待处理」标识全部消失）。
    //    必须先对齐前台会话：启动让位路径（claimInitialSessionOwnership）会改 _currentSessionId
    //    但不走 bindAgent，不同步会让确认卡推到旧会话名下。
    this._confirm.setForeground(this._currentSessionId);
    this.refreshSessionActivity(true);
    // 在途审批卡重推：视图重建不终结请求，但新 webview 没有旧卡 ⇒ 不重推就永远无法作答
    // （后台会话切回来时由 setForeground 补推，这里只管「重建时仍停在前台」的那张）
    this._confirm.repostForeground();
    // ⑨ 结构写窗口锁回放（#13）：webview 折叠/展开会重建 HTML，新 webview 锁态回到初值
    //    「可用」；若此刻仍处于写盘窗口（流在跑 / 会话已挂起），截断 / 分叉会被错误放开。
    //    status 只驱动结构锁这一层，导航态不在此处（其可用性由 turn_update 单写点派生）。
    this.replayStructureWriteLock();
    // 角色 handoff 预填补发：视图解析后 webview 监听器已就绪，安全投递
    if (this._pendingPrefill !== undefined) {
      this.post({ type: 'prefill_input', text: this._pendingPrefill });
      this._pendingPrefill = undefined;
    }
    if (this._pendingRefs !== undefined) {
      this.post({ type: 'addRef', refs: this._pendingRefs });
      this._pendingRefs = undefined;
    }
  }

  /**
   * 启动会话归属裁决（跨进程）：两个窗口同时恢复到最后活跃会话时，本窗口让位
   *
   * 判据单点 = `webview/helpers/sessionStartupClaim`（面板与验收测试共用同一实现，
   * 避免「测试测的是另一份循环」）。让位顺序：首选 → 最近写入的非留存会话 →
   * 全被占则新建空会话（窗口始终可用，绝不让整窗卡死）。
   */
  private async claimInitialSessionOwnership(): Promise<void> {
    const preferred = this._currentSessionId;
    // 空态（从未有过会话）：交给 ensureInitialSession 新建，createSession 内含拿锁
    if (!preferred) return;
    const claim = await claimStartupSession(preferred, {
      acquire: (id) => this._lockFinalizer.acquire(id),
      fallbackCandidates: () =>
        this.sessionStore
          .listSessionMetas()
          .filter((m) => m.sessionId !== preferred && !this.sessionStore.isArchived(m.sessionId))
          .map((m) => m.sessionId),
    });
    // 握手期间面板被销毁：补归还刚落到的锁并中止后续让位
    if (this._lockFinalizer.abandonIfDisposed(claim.sessionId)) return;
    if (!claim.displaced) return; // 首选归属本进程：单窗口常态
    if (claim.sessionId) {
      const manager = this._agent?.sessionManager;
      if (manager) {
        try {
          await manager.switchToSession(claim.sessionId);
          this.setCurrentSessionId(claim.sessionId);
        } catch (err) {
          // 让位切换失败：把刚落到的锁还回去，改建新会话（不留在「无锁的旧会话」上）
          console.warn('Memora 启动让位切换失败，改建新会话', err);
          this._lockFinalizer.releaseOne(claim.sessionId);
        }
      } else {
        this._lockFinalizer.releaseOne(claim.sessionId);
      }
    }
    if (this._currentSessionId === preferred) {
      // 候选全被占 / 让位失败 ⇒ 新建（新 id 无冲突）
      const created = await this.createSession(
        `${formatDateKey(new Date())}-s${Date.now().toString(36)}`,
      );
      // 新建失败：createSession 已推送错误通知，此处不再补一句「已新建」的假话
      if (created) {
        this.post({ type: 'notice', level: 'info', message: sessionDisplacedNewNotice() });
      }
      return;
    }
    // 成功让位到既有会话
    this.post({ type: 'notice', level: 'info', message: sessionDisplacedNotice() });
  }

  /**
   * 崩溃残留轮打捞 → 升级为正常 stop turn 并入当前会话。
   *
   * 语义定案（见 step-atomic-persistence.md）：中断轮 = 正常 turn（等同用户点「停止」）——
   * 可删、入会话 roundIds、作后续上下文，**不是**半成品草稿/孤儿。
   * 分工：打捞→派生→收场在 `extension/host/interruptedSalvage`（跨重启 e2e 消费同一份），
   * 本方法只管视图生命周期（once-guard / 会话日期取值 / 失败降级）——不在视图层重述业务口径。
   * 幂等/时序：
   *   once-guard（_salvageUpgraded）+ 内核 appendInterrupted 防重 → 升级轮不二次登记、不被
   *   _viewEpoch 折叠重建回放与崩溃恢复重复投递；升级后轮 complete，
   *   GC 按普通 turn 生命周期处理（随会话删除）。
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
      // date 过滤沿用当前会话日期（崩溃窗口宿主只持当前会话日期）
      const sessionDate = this._currentSessionId.slice(0, 10);
      // 打捞→派生→收场的业务实现外置（interruptedSalvage）：跨重启 e2e 与本处消费同一份，
      // 避免 e2e 验的是复制品而非生产路径。视图层只管 once-guard 与失败降级。
      const upgraded = await salvageInterruptedRounds({
        store,
        history: agent.agentHistory,
        sessionDate,
      });
      if (upgraded > 0) console.info(`Memora 已恢复 ${upgraded} 个中断轮为普通会话回合`);
    } catch (err) {
      console.warn('Memora 中断轮升级恢复失败（不影响历史回放；未恢复轮由 GC 兜底）', err);
    }
  }

  /**
   * 重建显示层（唯一入口）：清空消息区 + 回放当前会话 + 全部随会话推送清单
   *
   * 覆盖两条触发面：webview ready（脚本监听器已注册，避免 postMessage 丢失）；
   * 宿主侧会话切换（切会话 / 新建 / 分叉 / 截断）。两处**同一份**推送清单——
   * 曾拆成「重建当前会话」/「重建指定会话」两套入口，清单各自演化必漂移（漏推看板/占用）。
   */
  private replaySession(): void {
    if (!this._view) return;
    // 草稿态（webview 重载但面板对象存活）→ 重建**草稿页**：不读 store、不投影任何会话内容。
    // 面板销毁/进程重启后草稿不在（只存在面板内存），此处只服务「刷新 webview」这一种情形。
    if (this.isDraft) {
      this._draft.replay(true);
      return;
    }
    // 清空消息区：切换会话时旧会话 DOM 必须先清（turn_update(replay) 自身也会复位，此处是显式前置）
    this.post({ type: 'clear_ok' });
    // 恢复当前会话历史消息（只回放 _currentSessionId；round-based 按轮交织重放）。
    // 运行中/暂停中的本流轮由 replayHistory 内 buildLiveTurnFromBuffer 并入同一条
    // turn_update（replay:true），webview 收到即整批重建 + 骨架状态一步到位；后续
    // chunk/process_event 照常流式追加。不再补推无 live 数据的骨架投影（旧实现 rounds
    // 缺本流内容，正是「切界面回来只见运行中空转、内容全空白」的根因）。
    this.replayHistory();
    // 推送历史加载完成信号 → webview 强制滚到底（不走吸底逻辑；解决多条历史 rAF 节流滚动错位）
    this.post({ type: 'history_loaded' });
    // 推送当前会话标题 → webview 顶部展示（主动可见，便于识别当前会话）。
    // 无当前会话（初始空态）→ 推送引导文案而非「新会话 HH:MM」占位，避免误认存在会话
    this.post({
      type: 'session_title',
      title: this._currentSessionId
        ? this.currentSessionTitle()
        : l10n.t('No session yet (click + above to create one)'),
    });
    // 推送当前激活角色包 → 输入区角色选择器 + AI 消息标签（主动可见）。
    // 即使没有激活的角色包也推送，让 webview 正确处理状态
    this.postActiveRolePack(this._activeRolePack);
    void this.pushProviders();
    this.pushRolePacks();
    // 补推工具权限徽章（replaySession 时角色信息已就绪）
    this.postCapabilityBadge();
    // 视图重解析时补推三源技能清单（与 refreshAfterAssemble 输出同构，
    // 避免 agent 已装配时 ensureAgent 提前返回导致技能下拉为空）
    // 顺序约束：必须晚于上面的 clear_ok —— webview 收到 clear_ok 会清空技能 chip，
    // 本推送里的 pinnedSkillName 才是回种帧；颠倒即静默丢钉住技能
    // （守卫用例见 `__tests__/chatPanelHistory.test.ts`「切会话回种：clear_ok 先于…」）。
    this.pushSkillList();
    // 会话级钉住回种（0.9.0）：clear_ok 已清空 composer，此处按本会话元数据回种钉住引用（失效投影 missing）
    void pinned.pushPinnedRefsTo(this.sessionStore, this._currentSessionId, (m) => this.post(m));
    // 历史会话占用（轻量版）：首次启动回放即推真实占用（而非空态 0%）。
    // _agent 未装配完成时本调用静默跳过，由装配后收口点 refreshAfterAssemble 兜底再推
    // （两条装配入口——memora.open 命令与懒装配——都经该收口点，不漏路径）。
    this.postHistoryOccupancy();
    // 重放补推任务表看板——replaySession 只认实时 plan_update 消息，重开面板时若 turn 进行中
    //（generator 未 close）则 checkpoint.plan 仍在，缺的只是 UI 重放投递——补推一次让任务表
    // 看板恢复（turn 结束后内核 clearPlanOnTurnEnd 清 plan）。_agent 未装配时 postPlanUpdate 静默跳过。
    this.postPlanUpdate();
  }

  /**
   * 结构写窗口锁回放（#13：webview 折叠/展开重建后锁态丢失）
   *
   * 只补「截断 / 分叉 / 右键菜单」这一层，判据与流内 status 推送同源、不新造锁态快照：
   * 流在跑（`runtimeFor().streaming`，与 consumeFlow 同生命周期）→ thinking；
   * 否则已挂起（`sessionManager.status === 'paused'`，与 deriveTurnState 同一入参）→ paused。
   * 两者都不成立 ⇒ **不发**：新 webview 的结构锁初值即「可用」，补一条 done 只会多做
   * 焦点恢复 / 呼吸点清理，且违背「锁已解除后重建必须可用」。
   * 导航（历史 / 新建 / 切换）不在本层：其可用态由 turn_update 单写点派生，status 不触碰它。
   */
  private replayStructureWriteLock(): void {
    const state =
      this.runtimeFor().streaming === true
        ? 'thinking'
        : this._agent?.sessionManager?.status === 'paused'
          ? 'paused'
          : undefined;
    if (state) this.post({ type: 'status', state });
  }

  /**
   * 文本润色处理（输入框版本）
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
      this.post({
        type: 'polish_input_result',
        ok: false,
        message: l10n.t('Memora: Agent is not ready; retry shortly'),
      });
      return;
    }
    const polisher = agent.polish;
    if (!polisher) {
      this.post({
        type: 'polish_input_result',
        ok: false,
        message: l10n.t('Polish service unavailable'),
      });
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
        message: toNoticeText(err),
      });
    }
  }

  /** 落盘文件 → webview 可加载 URL；视图未解析/已销毁返回 undefined（宁可无预览也不给假地址） */
  private readonly toWebviewUri = (file: string): string | undefined =>
    this._view?.webview.asWebviewUri(vscode.Uri.file(file)).toString();

  /**
   * 图片管线共用面板依赖（回执 post / 预览 URL / 字节缓存预热 + 面板闸与引导文案）。
   * 粘贴（image_ingest）/ 拾取对话框（Q3）/ 右键真图（IMG-12）三入口共用——
   * 三闭包各写一份 = 断点A 预热或预览口径改一处漏两处的漂移温床。
   */
  private imagePanelDeps() {
    return {
      hasPanel: this._view !== undefined,
      projectPath: this.workspacePath,
      post: (m: ExtensionToWebviewMessage) => this.post(m),
      toWebviewUri: (f: string) => this.toWebviewUri(f),
      warmCache: (ref: ImageRef) => this.imageCache?.preload(ref, this.workspacePath),
      notifyPanelUnavailable: () =>
        void vscode.window.showInformationMessage(l10n.t('Open the Memora chat view first')),
      // 文案翻译器：宿主唯一本地化器；imageIngest / imagePick 为零 vscode 依赖模块，
      // 只能由本处注入（缺省恒等 = 单测拿英文源键）
      t: (key: string, ...args: string[]) => l10n.t(key, ...args),
    };
  }

  /** 图片添加入口：无参 = 开拾取对话框（Q3 按钮与命令面板）；有参 = 右键真图直入共享摄取面（IMG-12）。面板未解析不开框不落盘（G9 同族孤儿），编排归 host/imagePick.ts */
  public pickAndAttachImages(paths?: readonly string[]): void {
    void (paths
      ? ingestImageFiles(this.imagePanelDeps(), paths)
      : pickAndIngestImages({
          ...this.imagePanelDeps(),
          picker: async (opts) => (await vscode.window.showOpenDialog(opts))?.map((u) => u.fsPath),
        }));
  }

  /** 推送 Provider 列表到 webview（render / 切换 Provider 后调用，异步读取配置） */
  private async pushProviders(): Promise<void> {
    try {
      const providers = await this._providerStore.listMasked();
      const activeName = this._providerStore.getActiveName();
      // limitTokens = 每 Provider 的上下文窗口上限（SSOT：经内核 resolveContextWindow 解析，
      // 用户填的 contextWindow 落回内核默认窗口），供 webview 首轮对话前实时渲染占用条容量
      const list = providers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        contextWindow: p.contextWindow,
        limitTokens: resolveContextWindow(p.contextWindow),
        // 视觉能力投影（Q3 按钮置灰判据 SSOT = DTO supportsVision，webview 不存第二份能力位）
        vision: p.supportsVision === true,
      }));
      // meta 事件 llm 字段同源：活跃 Provider 显示名（SSOT 与模型下拉同一来源）
      this._activeProviderDisplayName =
        list.find((p) => p.name === activeName)?.displayName ?? activeName ?? '';
      this.post({ type: 'chat_providers', providers: list, activeName });
    } catch {
      // 推送失败不阻塞主流程
    }
  }

  /**
   * 装配完成后统一收口（会话对齐 + 时序竞态补推 + 占用补推，单一入口）
   *
   * 懒装配路径（直接点活动栏面板图标）：ensureAgent 异步装配，webview ready 时 _agent 往往
   * 尚未就绪，replaySession 会因 _agent 为空（pushRolePacks）或 `_activeRolePack` 未就绪
   * （chat_role_pack）而跳过推送 → 输入区角色选择器永久缺失。装配完成即补推：
   * ① 启动会话对齐（见 alignKernelSession）；② 角色名由 bindAgent 按当前会话投影（方案 A），
   * 本方法只推送不补值；③ 补推 chat_role_pack（角色选择器 / AI 消息标签可见，即使
   * 无激活角色也推送）；④ 补推 chat_role_packs（角色切换入口数据）；⑤ 补推历史会话占用
   * （输入区圆环脱离空态 0%）。
   *
   * **SSOT：本方法是「装配后动作」的唯一入口**——setAgent 与 ensureAgent 两条装配路径都必须
   * 经过它；任何新增的装配后动作都挂在本方法内，不在调用方各钉一份（挂两处必然漏掉对称的
   * 另一条路径）。历史伤害（2026-10-13 实测）：占用补推若只挂 setAgent，懒装配路径重启/侧栏
   * 打开面板时圆环恒为 0%；会话对齐若只挂 setAgent，内核 current 停在惰性初值 today-main
   * ⇒ 启动即分叉报「当前会话不存在」。面板未就绪时 post 静默（_view 为空），由 replaySession
   * 兜底；重复推送幂等。
   */
  private refreshAfterAssemble(): void {
    if (!this._agent) return;
    // 启动会话对齐（装配即校正内核 current；幂等：同会话重入直接跳过，见方法注释清单 1）
    void this.alignKernelSession(this._agent);
    // 角色名已在 bindAgent 按当前 agent 投影（方案 A，SSOT = rolePackManager.activeName）；
    // 本方法不再「空则补齐」——那种写法会让旧会话的角色名在切会话后滞留。

    // 角色数据：无论是否有激活角色都推送，让 webview 正确更新 UI 状态
    if (this._view) this.postActiveRolePack(this._activeRolePack);
    // 角色切换入口数据（webview 收到后自动显示输入区内下拉）
    this.pushRolePacks();
    // 装配完成即补推工具权限徽章
    this.postCapabilityBadge();
    // 装配完成统一补推三源技能清单（SSOT 收紧：setAgent 与 ensureAgent 懒装配共用本入口，
    // 角色信息与技能清单同一"装配后刷新"逻辑，杜绝某条路径漏推 → composer 下拉为空）
    this.pushSkillList();
    // 历史会话占用（轻量版）：装配完成即补推——replaySession 时 agent 未装配会静默跳过，
    // 装配后 agent.getMetrics 的 rolePackBaseTokens 方为真实值。本收口点是 setAgent 与
    // ensureAgent 懒装配两条入口的共用点，占用补推只在此一处（不得各推一份，否则必漏懒装配路径）。
    void this.postHistoryOccupancy();
    // 任务看板同属会话级投影：装配即按 checkpoint 补推快照——切换会话走 bindAgent→本收口，
    // 若只等实时 plan_update 事件，切到「进行中/暂停」的会话会看不到看板（既有推送点复用，不新开通道）
    this.postPlanUpdate();
  }

  /**
   * 推送角色包列表到 webview（输入区角色切换下拉）：载荷构造外置在 `helpers/rolePackListView.ts`
   * （本文件贴 max-lines 只降不升基线，纯投影不占行数）。
   */
  private pushRolePacks(): void {
    this.post(
      buildChatRolePacks(
        this._agent?.rolePackManager,
        readSessionRolePackName(this.sessionStore, this._currentSessionId),
      ),
    );
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
   * 处理用户切换激活 Provider（底部模型下拉框）：持久化激活态 + 热生效，未生效则回滚并提示。
   * ⚠️ 回滚只属于本路径（用户点在 UI 上，回滚后可重试）；配置保存路径**不回滚**——那边配置
   * 已落盘，回滚等于丢用户输入，只置 stale 顺延。两者刻意不同，勿统一。
   *
   * @param name 用户选中的 Provider 别名
   */
  private async handleSetProvider(name: string): Promise<void> {
    // 备份当前激活名，切换失败时回滚（保持 UI 与真实生效状态一致）
    const prev = this._providerStore.getActiveName();
    const r = await this._providerStore.setActive(name);
    if (!r.ok) return;
    const outcome = await this.applyActiveProviderRefresh();
    if (outcome.applied) return;
    // 未生效 ⇒ 回滚激活态 + 错误提示（不误导用户）。prev 存在 → 还原原激活 Provider；
    // prev 为 undefined（原本无激活、靠 env 装配，见 llmConfig 回退路径）→ 清空激活态，
    // 否则 UI 显示新 provider 已激活但 agent 仍用 env，造成功能↔UI 不一致。
    // 回滚写失败不掩盖原始错误：并入同一条回执，避免「界面停在错状态却无人知晓」。
    const rollback = prev
      ? await this._providerStore.setActive(prev)
      : await this._providerStore.clearActive();
    await this.pushProviders();
    // 回滚后真源=prev：补推恢复 prev 口径占用（applyActiveProviderRefresh 里补推的是新口径，
    // 此处旧容量 chat_providers 会再触空态渲染，不补推则空态滞留）
    void this.postHistoryOccupancy();
    this.post({
      type: 'notice',
      level: 'error',
      message: rollback.ok
        ? toNoticeText(outcome.error)
        : l10n.t(
            '{0} (also failed to roll back the active provider: {1})',
            toNoticeText(outcome.error),
            rollback.message ?? l10n.t('reason not recorded'),
          ),
    });
  }

  /** 真源配置变更 → 已装配实例与其投影跟上（IMG-5 热生效的唯一实现；编排与完整论证见
   * `host/providerRefresh.ts`，此处只注入宿主能力并记顺延标记）。 */
  private async applyActiveProviderRefresh(): Promise<ProviderRefreshOutcome> {
    const outcome = await refreshActiveProvider({
      getAgent: () => this._agent,
      getActiveConfig: async () => {
        const a = await this._providerStore.getActive();
        return a ? { contextWindow: a.contextWindow, maxTokens: a.maxTokens } : undefined;
      },
      buildProvider: () =>
        createProvider(this._providerStore, process.env, this.imageCache?.resolver),
      pushProviders: () => this.pushProviders(),
    });
    this._providerStale = !outcome.applied;
    if (!outcome.applied) {
      console.warn(`Memora 配置热刷新未生效（${outcome.reason}），留待下次发送前补做`);
    }
    // 热刷新所有出口都重推 chat_providers，上限变化 ⇒ webview 圆环渲染空态（全 0 滞留）；
    // 补推历史占用恢复真实态（幂等，与切会话/装配收口同一单点 postHistoryOccupancy）
    void this.postHistoryOccupancy();
    return outcome;
  }

  /** 当前会话标题（无元数据时回退占位标题，不暴露 sessionId，供 UI 展示） */
  private currentSessionTitle(): string {
    // 占位标题的时间取**会话创建时刻**（不是读取时刻）：同一会话每次刷新必须显示同一时间，
    // 否则标题时间随刷新跳动，用户只会当 bug（真机实锤「新会话 08:06」）。
    return sessionDisplayTitle(
      this._currentSessionId,
      this.sessionStore.getSessionMeta(this._currentSessionId),
      vscode.l10n,
    );
  }

  /**
   * 当前执行栈是否属于「后台流」（判据与理由见 {@link BackgroundFlowGate}）
   *
   * ⚠️ 消费面必须逐个投影 helper 早退，不能只挡 `post()` 出口（单份缓存被后台写脏不会有测试红）。
   */
  private isBackgroundFlow(): boolean {
    return this._flowGate.isBackground(this._currentSessionId);
  }

  /** 向 webview 发送消息（后台流的投递一律丢弃：判据见 `isBackgroundFlow`） */
  private post(msg: ExtensionToWebviewMessage): void {
    if (this.isBackgroundFlow()) return;
    void this._view?.webview.postMessage(msg);
  }

  /**
   * 重算并推送「会话活跃度快照」（列表条目标识 + 历史入口角标的唯一数据源）
   *
   * 遍历面 = 已装配实例（`_sessionAgents`）+ 已建 ask 协调器（`_asks`）+ 当前会话——
   * **不遍历 registry**：实例上没有可用的「运行中」判据（`Agent.isBusy` 是 chat 锁，
   * 180s 自动释放而流仍在续跑，拿它当运行态会在长工具循环中途误报「没在跑」）；
   * 也**不遍历全部历史会话**：读侧不应为没跑过的会话建运行态记录（`peek` 不建记录）。
   *
   * @param force true = 忽略去重强制重发（视图重建 / webview ready 时必须：新 webview 内存无旧快照）
   */
  private refreshSessionActivity(force = false): void {
    const ids = new Set<string>(this._sessionAgents.keys());
    for (const sessionId of this._asks.keys()) ids.add(sessionId);
    if (this._currentSessionId) ids.add(this._currentSessionId);
    const runningIds = [...ids].filter((id) => this._runtime.peek(id)?.streaming === true);
    const pendingIds = [...ids].filter((id) => {
      const askPending = (this._asks.get(id)?.pendingQuestions().length ?? 0) > 0;
      return askPending || this._confirm.pendingCount(id) > 0;
    });
    const snapshot: ExtensionToWebviewMessage = {
      type: 'session_activity',
      runningIds,
      pendingIds,
      // 角标只数「别的会话」：当前显示会话的待处理已在屏上可见，再计数就是重复提示
      badgeCount: pendingIds.filter((id) => id !== this._currentSessionId).length,
    };
    const serialized = JSON.stringify(snapshot);
    if (!force && serialized === this._lastSessionActivity) return;
    this._lastSessionActivity = serialized;
    // 刻意绕过 `post()` 的后台闸：本条是**跨会话的全局信号**，不属于任何正在跑的流的界面投影；
    // 若被丢弃，「后台会话等到提问 ⇒ 入口角标亮」这条判据永远不可能成立。
    void this._view?.webview.postMessage(snapshot);
  }

  /**
   * 推送 turn 投影（状态/轮次单通道，不再有独立状态消息）。
   *
   * `rounds` = 落盘历史 + 运行时当前轮（`live: true`）。当前轮按 id **原位替换**历史同名轮
   * （live 版本更完整：含尚未落盘的流式正文与增量过程事件），不产生重复条目；收场落盘后由历史版本接管。
   * 合并规则见 `mergeLiveRound`——取不到 `userMessage` 的轮**整轮不并入**（半残数据不投）。
   * `state` 由 `deriveTurnState` 单点折叠，不多条状态消息各自驱动一角。
   *
   * @param live 运行时当前轮快照（由 `consumeFlow` 流内局部数据构造、显式传入；
   *        不传 = rounds 只含落盘历史。刻意不做实例字段，避免跨轮残留）
   * @param replay true = 会话重放快照（webview 整批重建 rounds）；缺省 = 运行时每步投影
   *        （rounds 仅作骨架/重建备用，webview 不整批渲染——杜绝 settle 时对已运行时渲染的轮重绘重复）
   */
  private postTurnUpdate(live?: PendingLiveRound, replay = false): void {
    // 后台上投一律丢弃（`_turnState` 是宿主单份、只描述当前显示会话，见 isBackgroundFlow）
    if (!this._view || this.isBackgroundFlow()) return;
    const history = this._viewLoader
      ? loadRoundBasedHistory(this._viewLoader, this.sessionStore, this._currentSessionId)
      : [];
    const merged = mergeLiveRound(history, live);
    // 附件预览 URL 盖在**合并之后**：live 轮的 userMessage 来自上行 seed（只有 ref，没有 URL）
    const rounds = stampRoundAttachmentUris(merged, this.workspacePath, this.toWebviewUri);
    const last = rounds[rounds.length - 1];
    const questions = this.askFor().pendingQuestions();
    // 派生结果写回宿主唯一状态——handleInput 的 ask 相位路由读它；
    // ask 域超时的提问原文**不读这里**（去相位化，ADR-044 决策 4：域内 `_pending` 才是真源，
    // 本投影由它派生）。
    this._turnState = deriveTurnState({
      streaming: this.runtimeFor().streaming,
      paused: this._agent?.sessionManager?.status === 'paused',
      pausePending: this._agent?.isPausePending() ?? false,
      pendingQuestions: questions.length > 0 ? questions : undefined,
      liveRoundId: live?.roundId,
      lastRound: last ? { id: last.id, status: last.status } : undefined,
    });
    this.post({
      type: 'turn_update',
      rounds,
      state: this._turnState,
      // replay 标记——true = 会话重放快照（webview 整批重建 rounds），缺省 = 运行时投影
      replay,
      // pendingQueue 承接待发送区渲染载荷（渲染真源）。
      // 直接读内核 interject 队列快照（SSOT 源头 loop.pendingInterjections，宿主不持镜像）；
      // 仅当队列长度变化时由 syncPendingQueue 守卫触发本方法，避免无谓重投影。
      pendingQueue: this._agent?.getPendingInterjections?.() ?? [],
    });
  }

  /**
   * 从本流 live 缓冲构造运行时当前轮快照（ready 握手重放专用）
   *
   * 重建重放通道把本流未落盘内容（流式正文 + 增量过程事件）并入 turn_update 投影：
   * mergeLiveRound 按 roundId 原位替换落盘半残快照，单点消除「切界面回来本流内容全空白」。
   * 过程事件与落盘历史 **seq 幂等合并**（mergeProcessEvents）——resume 续跑流的缓冲只含
   * 续跑段，直接替换会丢暂停前 checkpoint 事件；合并后 live 版本恒 ≥ 历史版本，替换零丢失。
   * 三重护栏：
   *   ① 无缓冲（无流在跑/已收场清除）→ undefined，退化为纯历史重放（行为与旧版一致）；
   *   ② 会话护栏：缓冲归属会话 ≠ 当前会话（切走再切回旧会话）→ 不投影，防跨会话污染；
   *   ③ roundId 分界：当前 turn 尚无 chunk（roundId 未知）→ 无可投影轮。
   * userMessage 取 seed（chat 开新轮）；resume 续跑轮缺省，由 mergeLiveRound 从落盘历史补，
   * 两边都拿不到则整轮不并入（半残数据不投，与 postTurnUpdate 同一取舍）。
   */
  private buildLiveTurnFromBuffer(): PendingLiveRound | undefined {
    const buf = this.runtimeFor().liveBuffer;
    if (!buf || buf.sessionId !== this._currentSessionId) return undefined;
    const roundId = buf.currentRoundKey;
    if (!roundId) return undefined;
    // 落盘历史（step 边界 checkpoint 的部分事件）∪ 缓冲增量（seq 幂等去重保序）
    const prior = this._eventLogRoundStore?.getById(roundId)?.processEvents ?? [];
    const buffered = buf.eventsByRound.get(roundId) ?? [];
    const merged = prior.length > 0 ? mergeProcessEvents(prior, buffered) : buffered;
    return {
      roundId,
      userMessage: buf.seedUserMessage,
      processEvents: merged.length > 0 ? merged : undefined,
      streamingText: buf.textByRound.get(roundId),
    };
  }

  /**
   * 输入统一入口
   *
   * send / clarify_answer / clarify_answers / resume 合一为统一 input 消息
   * （见 shared/protocol.ts 的 input 注释）。按 `_turnState.phase` 单一路由——每个相位
   * 都有明确归宿，无独立 per-handler 竞态守卫：
   *   - send：sendInput（相位 → chat / interject / 带文本续跑）；
   *   - answer：仅 waiting(ask) 生效 → answerInput；错位（迟到回答）丢弃并落宿主日志留痕；
   *   - resume：仅 waiting(pause) 生效 → resumeInput；错位丢弃并落宿主日志留痕。
   * 错位语义与单 handler 守卫等义（ask 超时自动续跑后的迟到回答不污染进行中的轮）。
   * 留痕仅是观测（对用户仍静默），不改变路由裁决——排障时在扩展宿主日志查丢弃事实。
   *
   * @param msg 统一输入（kind 为用户意图，结果级分类由路由时定）
   */
  // ⚠️ 入参类型**必须**从协议联合里 Extract，不得内联复述字段（HOST-CTX-4 落地时发现）：
  // 内联副本 = 第二真理源，协议新增字段时此处**静默不转发**（无编译错、无测试红，
  // 表现就是「webview 发了、宿主没收到」）——与 CTX-12「未知消息静默丢弃」同族。
  private async handleInput(
    msg: Extract<WebviewToExtensionMessage, { type: 'input' }>,
  ): Promise<void> {
    // 会话级钉住（0.9.0）：锁/解锁/移除是动作 ⇒ 动作即落盘，必须在草稿/Agent 守卫之前受理
    if (msg.kind === 'pin') {
      pinned.writePinnedItems(this.sessionStore, this._currentSessionId, msg);
      return;
    }
    // 草稿态：**只有「真正发送内容」才创建会话**（唯一落点，见 DraftSessionController.flush）。
    // 必须放在 `_agent` / `_currentSessionId` 两道守卫之前——草稿本来就没有 Agent、没有 id。
    // 空文本不建会话；草稿里没有可答的提问/可续跑的流，其余意图一律忽略。
    if (this.isDraft) {
      if (msg.kind !== 'send' || !(msg.text?.trim() ?? '')) return;
      if (!(await this._draft.flush())) return;
    }
    if (!this._agent) {
      // Agent 未装配（可能仍在懒装配中）：提示用户稍候，而非静默无反应（与 ensureAgent 同键）
      void vscode.window.showWarningMessage(l10n.t('Memora: Agent is not ready; retry shortly'));
      return;
    }
    // 会话管理纯度：无当前会话（无历史时的初始空态）→ 引导手动
    // 新建，绝不隐式创建会话。新建会话唯一入口 = 标题条「＋」（回归主流，手动唯一）。
    if (!this._currentSessionId) {
      this.post({
        type: 'notice',
        level: 'info',
        message: l10n.t('Click + above to create a session before chatting'),
      });
      return;
    }
    switch (msg.kind) {
      case 'send': {
        const text = msg.text?.trim() ?? '';
        if (!text) return;
        // IMG-5 顺延补做：上一轮已收场 ⇒ 新 turn 起点是唯一必然可用的安全点。补做仍失败**不拦
        // 发送**：一级门禁会给可见文案（含「改用支持图片的模型」指引），比静默吞掉或卡输入更诚实。
        if (this._providerStale) await this.applyActiveProviderRefresh();
        await this.sendInput(text, msg.skillName, msg.refs, msg.injections, msg.attachments);
        // 草稿期已锁清单补落（sendInput 已把草稿 flush 成会话，此刻才有元数据载体）
        if (msg.skillPinned === true || msg.refs?.some((r) => r.pinned === true))
          pinned.writePinnedItems(this.sessionStore, this._currentSessionId, msg);
        return;
      }
      case 'answer': {
        // 🔴 位次不变量（ASK-PARTIAL-ANSWER-1）：`answers` 与提问**等长同序**，空串 = 该题未答。
        // 旧写法 `.filter(Boolean)` 把未答位压掉 ⇒ 其后答案整体前移 ⇒ 内核按位回填时
        // 「答第 2 题的文本」落到第 1 题头上。压缩位次即错位，故此处只 trim、不过滤。
        const answers = (msg.answers ?? []).map((a) => a.trim());
        if (answers.length === 0 || answers.every((a) => a === '')) return;
        // 错位（迟到回答：提问已超时自动续跑 / 流异常结束）→ 丢弃，不污染进行中的轮。
        // 留痕（T2 观测）：对用户仍静默，但「答了没反应」的排障线索必须在日志可查
        if (!this.isAskWaiting()) {
          const reason = 'reason' in this._turnState ? this._turnState.reason : '—';
          console.warn('错位回答已丢弃', this._turnState.phase, reason, answers.length);
          return;
        }
        // 边界校验（判据与真相源均在 ask 域）：题数不等 ⇒ 两侧对批次认知已分叉，
        // 继续按位回填必错位；拒收留痕，不写坏盘面。
        const count = this.askFor().checkAnswerCount(answers);
        if (!count.ok) {
          console.warn(
            `Memora: answer count does not match question count (${count.got} != ${count.expected}); rejected`,
          );
          this.post({
            type: 'notice',
            level: 'error',
            message: l10n.t(
              'The answers do not match the current questions ({0} answers / {1} questions); please answer again',
              count.got,
              count.expected,
            ),
          });
          return;
        }
        await this.answerInput(answers);
        return;
      }
      case 'resume':
        // 错位（非暂停态收到继续）→ 丢弃并留痕。按钮语义已在 waiting(ask) 空输入时不宣告
        // 纯续跑（deriveButtonSemantics 死键不渲染），正常操作流不可达此守卫——只兜
        // 跨消息竞态残留（如提问超时续跑后迟到的 resume），保留「不污染进行中的轮」语义
        if (!this.isPauseWaiting()) {
          const reason = 'reason' in this._turnState ? this._turnState.reason : '—';
          console.warn(`Memora：错位续跑已丢弃（当前相位=${this._turnState.phase}/${reason}）`);
          return;
        }
        await this.resumeInput();
        return;
      case 'regenerate': {
        // COPY-2 右键「重新生成」：缺锚 = 不完整意图丢弃（webview 入口禁用已是第一道
        // 守卫，此处双保险）。截断与 delete_turn 同核（truncateTurnCore）+ 同强度 modal
        // 确认——重新生成的破坏性等同删除（截断不可逆），确认不豁免。重发文本 = 截断
        // 起点 Round 的 user 原文（store 随轮落盘真源，webview 只传锚不传文本）；
        // 附件不重发：图片随轮落盘、截断即随轮回收（语义如实：重新生成 = 文本重开）。
        const anchor = msg.roundId?.trim() ?? '';
        if (!anchor) return;
        const outcome = await this._turnOps.truncateTurnCore(
          anchor,
          l10n.t(
            'Regenerating deletes this turn and all later turns, then resends the original text. This cannot be undone.',
          ),
          l10n.t('Regenerate'),
        );
        if (!outcome.ok) {
          // busy 已在核内提示、cancel 是用户主动 → 均静默；miss / error 必须可见否则等于失灵
          if (outcome.reason === 'miss' || outcome.reason === 'error') {
            this.post({ type: 'notice', level: 'info', message: truncateFailNotice() });
          }
          return;
        }
        const text = outcome.userText?.trim() ?? '';
        if (!text) {
          // 锚点轮无 user 原文（异常态）→ 如实提示，不静默吞
          this.post({
            type: 'notice',
            level: 'info',
            message: l10n.t('Could not retrieve the original prompt text; nothing was regenerated'),
          });
          return;
        }
        await this.sendInput(text, undefined, undefined, undefined, undefined);
        return;
      }
    }
  }

  /** 是否处于等待主动提问回答的相位（waiting/ask） */
  private isAskWaiting(): boolean {
    return this._turnState.phase === 'waiting' && this._turnState.reason === 'ask';
  }

  /** 是否处于等待暂停恢复的相位（waiting/pause，含 pausePending 在途申请） */
  private isPauseWaiting(): boolean {
    return this._turnState.phase === 'waiting' && this._turnState.reason === 'pause';
  }

  /**
   * send 意图：按 turn 相位路由到内核 chat / interject / 带文本续跑（判据统一为相位）
   *
   * 插话语义（无缝注入）：生成中用户 Enter 输入补充 → 不中断 loop，调 agent.interject()
   * 排队，内核在下一 step 边界并入为 user 消息继续执行；UI 即时上屏，webview 据此开新助手块。
   * 流式插话分支以 `runtime.streaming && runtime.abortController` 为判据——pausePending 窗口（相位已转
   * waiting 但 step 未结束、流未复位）与纯运行中同走此分支，行为不变；暂停态带文本续跑分支
   * 判据为 `isPauseWaiting() || isAskWaiting()`（相位蕴含
   * status，且区分 ask/pause 两形态由 handleInput 的 kind 分流，此处仅需「暂停可续」为真）。
   */
  private async sendInput(
    input: string,
    skillName?: string,
    refs?: ChatRef[],
    injections?: Exclude<InjectionSource, 'active-file'>[],
    attachments?: ImageRef[],
  ): Promise<void> {
    // 防御守卫（单一路由下 handleInput 已前置检查 Agent 就绪；此处局部收窄供 TS 控制流使用，
    // 属性访问不受方法间守卫影响，需非空局部变量）
    const agent = this._agent;
    if (!agent) return;
    // 图片只随**新轮**发出（D13）+ IMG-8 三维限额兜底（同判据 shared/imageTurnLimits）：
    // 续接通道（插话/回答/暂停补充）内核不收 attachments ⇒ 整条拒发；新轮查张数/总字节/token。
    // webview 已前置拦（保留输入框），此处防竞态漏网；拒收必须可见（webview 清框后才 post，
    // 静默丢整条 = 背刺）。窗口从 providerStore 真源取（不信 webview 传值）。
    if (attachments?.length) {
      if (this.runtimeFor().streaming || this.isAskWaiting() || this.isPauseWaiting()) {
        void vscode.window.showWarningMessage(l10n.t('Memora: images go with a new message'));
        return;
      }
      const cfg = await this._providerStore.getActive();
      const reason = imageTurnRejection(
        attachments,
        cfg ? resolveContextWindow(cfg.contextWindow) : undefined,
      );
      if (reason)
        return void vscode.window.showWarningMessage(vscode.l10n.t('Memora: {0}', reason));
    }
    // 无缝插话（SSOT）：生成中 Enter 补充 → agent.interject() 排队，内核下一 step 边界并入为
    // user 消息续跑（不 abort 旧流、不新开 chat）；pausePending 窗口发补充 = interject + 取消暂停。
    if (this.runtimeFor().streaming && this.runtimeFor().abortController) {
      // 三态裁决真源在内核：'rejected-limit' 零入队零落盘（须提示）；'queued-unpersisted'=已生效但历史未写（勿诱导重发，重发即双执行）
      const outcome = await agent.interject(input);
      if (outcome === 'rejected-limit')
        return void vscode.window.showWarningMessage(limitNotice(INTERJECT_LIMIT));
      if (outcome === 'queued-unpersisted')
        this.post({ type: 'error', message: interjectUnsavedNotice(), category: 'unknown' });
      // 上屏时机 = 消费时刻（吸收时上屏）：排队中 ≠ 已说出，入队成功**不再**即时 post type:'user'
      // （退役设计：变异加回 `this.post({type:'user',…})` 即 chatPanelInterject「入队不 post」红）。
      // 排队期唯一呈现 = 待发送区；内核消费落盘后队列快照减少 → webview diff 上屏「你补充」行。
      if (agent.isPausePending()) {
        agent.cancelPauseRequest();
        // 暂停覆盖取消由 turn_update 补推（骨架回 running）
        this.postTurnUpdate();
      }
      // 竞态兜底（配合 consumeFlow paused 分支 break）：pause 已被 step 边界消费、而运行态
      // 未复位的毫秒窗口内入队的 interject 无 step 边界可消费 ⇒ 立即 resume 驱动它被注入。
      if (agent.sessionManager?.status === 'paused') {
        await this.runFlow((signal) => agent.resumeExecution(undefined, signal, 'supplement'));
        return;
      }
      // 待发送区刷新：从内核 queue 读当前值（SSOT 源头，不维护镜像）
      this.syncPendingQueue();
      return;
    }
    // ask 等待期：composer 的单条文本不是合法答题载荷——内核 answerQuestion 按序一对一，
    // 单条只能配第 1 题、其余题落 [ASK_ABORTED]；一条文本也无法定位到具体哪一题。
    // 故拒收（不改写成 answer、不发起新轮）：答题唯一入口 = 内联提问卡（逐题承载 askCallId）。
    // webview sendMessage 已同判据前置拦截，此处为宿主兜底（旧 bundle / 竞态漏网）。
    if (this.isAskWaiting()) {
      void vscode.window.showWarningMessage(l10n.t('Memora: answer the question card above'));
      return;
    }
    // 暂停态补充输入（waiting/pause，相位判据）→ 不发起新 chat()
    // → 走 resumeExecution 路由（保留闭环节点归属，不分裂）
    const now = new Date().toISOString();
    if (this.isPauseWaiting()) {
      this.askFor().clearAskTimeout(); // 暂停态补充 = 已响应当前等待，关闭超时保底
      this.post({ type: 'user', text: input, ts: now, kind: 'supplement' });
      await this.runFlow((signal) => agent.resumeExecution(input, signal, 'supplement'));
      return;
    }
    // 确保 Agent 对齐到当前会话：用户可能打开面板后直接发送，未显式
    // 切换会话。若 Agent 内部会话与 _currentSessionId 不一致，先 switchToSession 对齐，
    // 否则内核 appendUser 会写入错误会话。会话一致时跳过（不重复加载工作记忆）。
    const sessionManager = agent.sessionManager;
    if (sessionManager) {
      const info = sessionManager.getCurrentSessionInfo();
      if (info && `${info.date}-${info.session}` !== this._currentSessionId) {
        try {
          await sessionManager.switchToSession(this._currentSessionId);
        } catch (err) {
          this.post({
            type: 'notice',
            level: 'error',
            message: toNoticeText(err),
          });
          return;
        }
      }
    }
    // 用户消息持久化由内核 chat() → appendUser 完成（写入当前会话 _currentSessionId），
    // 此处不再 persist，避免与内核双写同一条消息（SSOT 单一真理源）。
    this.post(userEcho(input, now, attachments, this.workspacePath, (f) => this.toWebviewUri(f)));

    // 注入选中技能提示（SSOT：技能名 → 内核技能正文，前端不硬编码 systemPrompt）
    let skillBlock = '';
    if (skillName) {
      try {
        skillBlock = await skillPromptFor(agent, skillName);
      } catch {
        skillBlock = '';
      }
      // 响亮失败：技能被禁用时注入**静默落空**（`skillPromptFor` 按既有契约返回空串 = 技能不存在，
      // 消息照常发出），用户零反馈。此处补上提示 —— 对照主流（Claude Code / WorkBuddy 的 `off` 态）
      // 按名调用明确报错。三个边界不变：① 仍**照常发送**（拒绝发送 = 改发送语义，不属本护栏范围）；
      // ② 判定走 `isSkillDisabled`（收口到与 `resolveSkill` 同序的真源，非自读配置副本）；
      // ③ `notice` 只进 UI 不喂模型 ⇒ 不侵犯「禁用对 LLM 静默」语义。
      // 前置 `!skillBlock`：仅在**确实发生落空**时报，避免「判定说禁用、实际却注入成功」的假报。
      if (!skillBlock && isSkillDisabled(agent, skillName)) {
        this.post({
          type: 'notice',
          level: 'error',
          message: l10n.t(
            'Skill "{0}" is disabled and was not injected (the message was still sent). Enable it in Settings > Skills and retry.',
            skillName,
          ),
        });
      }
    }
    // 文档上下文：**发送时实时读**活动编辑器（不缓存，理由见 snapshotDocContext）。取数单点 = `resolveActiveFile`
    // （含开关闸门）：判据 `mustInjectDocBody`（引用模式 HOST-CTX-0，磁盘是真相时只给指针）与 chip 投影**同源**，不允许各算一遍：
    //   脏 / 未命名 / 工作区外 → 注入正文（磁盘不是真相，指针会让模型读错）；
    //   干净态 → 不注入正文，活动文件作为**一行指针**并入下面引用块（模型按需 read_file）；
    //   开关关掉 → 连快照都不取（指针与正文一并消失）。
    // 信封构造与剥离同源收口在 helpers/docContext（技能块在前、文档块在后；无任何块时
    // **不加信封**，不注入「用户请求：」分隔符），回放侧因此可安全以分隔符为界还原用户请求。
    // withBody=true：只有本轮真要注入时，正文才由 resolveActiveFile 惰性读取（见其 JSDoc）
    const activeFile = this._activeFile.resolveActiveFile(true);
    const injectDoc = activeFile.inject;
    const docBlock = injectDoc ? buildDocContextBlock(activeFile.body) : '';
    // 引用块（右键「添加到对话」）：仅挂路径与形态，不注入内容（内容由模型按需 read_file）；
    // 干净态活动文件在此并成指针行（同 path 已有引用则不重复）
    //
    // 发送前存在性核实（HOST-CTX-9 发送侧）：引用自添加后可能已被删 / 改名——失效者在块内
    // 降级为「裸指针 + 标记」，避免给模型一条注定失败的 read_file 指令。基准根与
    // `openRefInEditor` / 内核 read_file cwd **同源**（恒取首根）；解析器复用 refPath（无第二真理源）。
    // 目录引用与「当前打开文件」指针行不核实（见 refProbe 边界说明）。
    const missingFileRefPaths = await collectMissingFileRefPaths(
      refs ?? [],
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      async (absPath) => vscode.workspace.fs.stat(vscode.Uri.file(absPath)),
    );
    const refsBlock = buildRefContextBlock(
      refs ?? [],
      injectDoc ? undefined : activeFile.snap?.relativePath,
      missingFileRefPaths,
    );
    // 注入型上下文（HOST-CTX-4 ④）：**发送时刻**采集。挂载只记通道标记（webview 组合态），
    // 宿主此刻才 getDiagnostics() / 跑只读 git ⇒ 模型拿到的是最新一份；零诊断 / 零改动时
    // 采集器返回「事实行」而非空串（用户挂了标签就有权知道「确实没有」——静默空块 =
    // 静默失败族）。
    const problemsMounted = injections?.includes('problems') ?? false;
    const problemsBlock = problemsMounted
      ? buildProblemsContextBlock(await collectProblemsBody())
      : '';
    const gitMounted = injections?.includes('git-changes') ?? false;
    const gitBlock = gitMounted
      ? buildGitChangesContextBlock(
          await collectGitChangesBody(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
        )
      : '';
    // 块序：技能 / 文档 / 诊断 / git 改动（注入内容在前）→ 引用（指针在后）。剥离侧以
    // 「最后一个成对块闭标签」为锚点，顺序不影响正确性，但注入块与指针块分组便于人读。
    const chatInput = buildInjectedContextEnvelope(
      [skillBlock, docBlock, problemsBlock, gitBlock, refsBlock],
      input,
    );
    // 本轮注入汇总（HOST-CTX-4 ②）：**唯一真源** = 按源分项 + 合计。活动文件的 token 数
    // 原长在 ActiveFileProjection 的私有字段上（CTX-6②），注入源一多就是并列腐化且违反
    // 硬约束②「同一处呈现」⇒ 统一迁到此处，活动文件降为其中一个分项。
    // 估算口径仍 = 内核 estimateTokensText（宿主自估即第二真理源）；total 恒等于分项之和
    // （webview 不得再算一遍——两个口径必然漂移）。
    const segments: InjectionSegment[] = [
      injectDoc
        ? { source: 'active-file', injected: true, tokens: estimateTokensText(docBlock) }
        : { source: 'active-file', injected: false },
    ];
    if (problemsMounted) {
      segments.push({
        source: 'problems',
        injected: true,
        tokens: estimateTokensText(problemsBlock),
      });
    }
    if (gitMounted) {
      segments.push({
        source: 'git-changes',
        injected: true,
        tokens: estimateTokensText(gitBlock),
      });
    }
    const total = segments.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
    // 先发汇总、再回推活动文件投影：chip 徽记读的是汇总里 active-file 分项，两条跨帧到达时
    // 先渲染成「无数字」再补上会闪一帧（同批发 + 顺序在先即无此窗口）。
    this.post({ type: 'injection_summary', summary: { segments, total } });
    // 用**本轮实际消费的那份快照**回推 chip：抹平「chip 显示的是切换瞬间的文件、
    // 真正发出去却是另一个」的窗口（force 绕去重——同状态也要让用户看到这一轮确实带了）。
    this._activeFile.postActiveFile(activeFile.projection, true);

    // runFlow 统一管理 AbortController + consumeFlow + 同步抛错兜底
    // seed：开轮用户文本交给 live 轮投影。只放**上屏裸输入**——注入信封仅进 `chatInput`（内核
    // appendUser 落盘原文）；历史重放读的是 `stripInjectedContextPrefix(落盘原文)`，两者必须同值。
    await this.runFlow((signal) => this._agent!.chat(chatInput, signal, attachments), {
      userMessage: {
        id: `live-user-${now}`,
        role: 'user',
        content: input,
        timestamp: now,
        // 图片随行（IMG-2）：live 投影必须与重放读到的落盘版本同形，否则同一轮两种 user 内容
        ...(attachments ? { attachments } : {}),
      },
    });
  }

  /**
   * answer 意图：处理用户对主动提问的回答——answerQuestion 结构化回填 + resumeExecution 续跑
   *  内核提问由 ask_user 工具承载——先 answerQuestion 以 tool result 回填
   *  （与 assistant.tool_calls 配对，结构合法），再由 resumeExecution 续跑（回答 text
   *  作为新 user 输入注入并记录交互归属 question-answer，round 不分裂）。
   *  回答落盘由内核 runResume 按交互归属写入同闭环节点，宿主不双写。
   *  多 ask 聚合回答（clarify_answers）传入数组，answers 与提问按序
   *  一对一：逐条 post 透出「你答」交互行 + answerQuestion(answers) 数组回填 +
   *  resumeExecution 以 join 全文注入（内核 answerQuestion 原生支持数组）。
   *  守卫（Agent 就绪/会话存在）与错位拦截收归 handleInput 相位路由
   *  （单一判据），提问原文读 turn_update 投影（`_turnState.waiting.questions`
   *  单点真源，ask 域的在途提问仅事件写入源，非消费式 splice）。
   * @param answers 归一后的回答数组（单问=单元素，answer 意图恒数组）
   */
  private async answerInput(answers: string[]): Promise<void> {
    // 本方法只服务当前会话的提问（路由守卫保证「有在途提问」才进来），故取当前会话协调器
    const ask = this.askFor();
    ask.clearAskTimeout(); // 提问被回答：关闭超时保底
    // 作答上屏外置到 ask 域单点（`postAnswerRows`）：逐题按有无答案分派 question-answer /
    // unanswered，屏上 N 条与内核 `runResume` 逐题落盘同构（题目该域自取；迟到回答已在路由层丢弃）。
    ask.postAnswerRows(answers);
    // ⚠️ 顺序不可调换：上屏要读 `_pending`（题目来自该域），清空必须在**其后**——
    // 先清后 post 会让每题都拿不到 question/options，屏上只剩一行干瘪的「你答」。
    ask.clearPending();
    await this.runFlow((signal) => {
      // 按位一对一：空串位由内核归一为「该题未答」（`[ASK_ABORTED]` 占位 + 盘上 unanswered 行），
      // 故不得压缩位次；join 全文作持续输入注入（空答案不参与，避免空行噪声）。
      // 持久化由 `resumeExecution → runResume` 按交互归属写入同闭环节点，宿主不双写。
      this._agent!.answerQuestion(answers);
      return this._agent!.resumeExecution(
        answers.filter((a) => a.trim()).join('\n'),
        signal,
        'question-answer',
      );
    });
  }

  /**
   * 运行一轮 Agent 流（chat / resumeExecution 的统一入口）
   *
   * 统一承载「新建 AbortController + consumeFlow + catch 清理」样板（见 coding-convention 规则），
   * sendInput / answerInput 不各写一份。内部新建本轮 controller（上一轮已在 consumeFlow
   * finally 清理），以 factory 注入 signal 供内核流使用；同步抛错（如 chatLock
   * busy）时兜底给出可见错误——因从未进入 thinking 状态，输入框
   * 未被禁用，无需再补发 status done。
   *
   * @param seed 本轮运行时种子：`chat()` 路径传开轮用户输入；`resumeExecution` 各形态
   *        不传（续同一轮、不分裂，其 userMessage 由落盘历史提供）。透传给 `consumeFlow` 的 live 轮投影。
   * @param sessionId 本流归属会话（缺省 = 当前会话）：ask 超时续跑等后台入口必须显式传入，
   *        否则流状态会写到切换后的另一个会话记录上。
   */
  private async runFlow(
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
    seed?: FlowSeed,
    sessionId: string = this._currentSessionId,
  ): Promise<void> {
    // 取本会话的运行态记录（不是「当前会话」——两者在后台续跑时可能已不同）
    const runtime = this.runtimeFor(sessionId);
    const controller = new AbortController();
    runtime.abortController = controller;
    try {
      // 流归属会话写进 ALS：本流后续一切 UI 投递的去留由 `isBackgroundFlow()` 判定
      // （用户在流中切走 → A 仍属于后台流，不得改写 B 的界面与宿主单份投影）
      runtime.currentFlow = this._flowGate.run(sessionId, () =>
        this.consumeFlow(factory(controller.signal), controller, seed, sessionId),
      );
      await runtime.currentFlow;
    } catch (err) {
      // 同步抛错路径：清理 controller，避免 AbortController 泄漏
      runtime.abortController = undefined;
      // 留痕**无条件**：后台流异常若静默吞掉，用户切回时只看到「跑完了却什么都没有」；
      // 前台流同样值得一条日志（投递去留交给 post 的后台闸，本处不再判前后台——行为层零分支）
      console.warn(`Memora 会话流异常（${sessionId}）`, err);
      this.post({ type: 'error', message: toNoticeText(err) });
    }
  }

  /**
   * 停止生成 —— 实现已按 op 组外置到 `chatRunControlOps.ts`（B9-D-6）
   *
   * 三种运行态（thinking / paused / done）的分支与「paused 必须以中断收场」的理由都在
   * 该模块内（ADR-044 决策 3）；本处只留转发口。
   */
  private async handleStop(): Promise<void> {
    await this._runOps.handleStop();
  }

  /**
   * 插话丢弃信号唯一发点（吸收时上屏机制的宿主侧一半）
   *
   * 载荷 = 被丢条目文本（**先读后丢**模式取得，发点不自己再查队列——丢弃与读值必须
   * 原子相邻，否则竞态窗口内队列变化会发错内容）。
   * 调用契约：发本信号后**必须**紧跟 syncPendingQueue（推新快照）——webview 丢弃缓冲
   * 按「信号帧 → 快照帧」成对消耗，只发信号不推快照会让缓冲残留、误吞后续消费条目。
   */
  private postPendingDiscarded(items: readonly string[]): void {
    if (items.length === 0) return;
    this.post({ type: 'pending_discarded', items: [...items] });
  }

  /**
   * 暂停按钮 toggle —— 实现已按 op 组外置到 `chatRunControlOps.ts`（B9-D-6）
   *
   * 「申请 / 取消 / 作废」三路的点击反馈与 turn_update 补推都在该模块内；本处只留转发口。
   */
  private handlePause(): void {
    this._runOps.handlePause();
  }

  /**
   * 从暂停恢复 —— 实现已按 op 组外置到 `chatRunControlOps.ts`（B9-D-6）
   *
   * 复用 runFlow + agent.resumeExecution，与「回答主动提问」同构；相位裁决在 `handleInput`。
   */
  private async resumeInput(): Promise<void> {
    await this._runOps.resumeInput();
  }

  /** 过程事件 / 指标段级合并已外置为纯函数模块（HOST-SPLIT-1 切片）：见 helpers/processEventMerge.ts */

  /**
   * step 原子检查点：把当前轮已累积过程落盘到 pending Round。
   *
   * 崩溃发生在 appendAssistant 完成前时，过程经此逐步持久化（非等流尾一次性）→
   * 进程被杀只丢当前 step，之前完成 step 的过程在库，重启后经
   * IRoundStore.listInterruptedRecent 打捞 → upgradeInterruptedRounds 升级为正常 stop turn
   * （中断轮非半成品草稿，见 step-atomic-persistence.md）。
   * 幂等（seq 全局单调 + mergeProcessEvents），多次检查点/流尾各调无害不重复。
   * fire-and-forget：失败仅记日志，不阻塞展示（降级语义）。
   *
   * @param roundId 当前 turn roundId（内核 chunk 携带）
   * @param events 该轮当前已累积过程事件（含刚 emit 的边界/metrics）
   */
  private checkpointRound(roundId: string, events: ProcessEvent[]): void {
    // 判据与正文来源单点外置（已收场轮取盘上现值、只并事件；见 roundEventCheckpoint）
    checkpointRoundEvents(this._eventLogRoundStore, roundId, events);
  }

  /** 消费 Agent 流：转发 text chunk，监听主动提问事件，透出运行状态，支持用户打断
   *  @param gen Agent 流（chat / resumeExecution）
   *  @param controller 本轮 AbortController：stop / 插话经 abort() 中断流；
   *         finally 中与本轮 controller 比对后清理（避免误清下一轮的 controller）
   *  @param seed 本轮运行时种子：开轮用户输入，供 `postTurnUpdate` 投影 live 轮
   *  @param sessionId 本流归属会话（由 `runFlow` 显式传入）：流状态一律读写该会话的记录，
   *         不读 `_currentSessionId`——后台续跑期间用户可能已切到别的会话。
   *         缺省 = 当前会话（仅供既有测试/直驱路径保持旧语义）。
   */
  private async consumeFlow(
    gen: AsyncGenerator<AgentChunk, void, unknown>,
    controller: AbortController,
    seed: FlowSeed | undefined,
    sessionId: string = this._currentSessionId,
  ): Promise<void> {
    // 本流归属实例：优先按会话取（不是 `this._agent` ——用户在流中切到 B 后，this._agent 已指向 B，
    // 用它读 metrics / 解绑监听就是「A 的流失控面」被 B 改坏）。
    // `this._agent` 兜底**仅**服务直接驱动 consumeFlow 的测试（此时本地投影表未填充）；
    // 生产不可达：`runFlow` 的调用方都先经 `agentForSession` 取实例（表必命中）。
    const agent = this._sessionAgents.get(sessionId) ?? this._agent;
    if (!agent) return;
    // 本流归属会话的运行态与 ask 协调器（一次性取出，闭包内一律用它们，防误用「当前会话」）
    const runtime = this.runtimeFor(sessionId);
    const ask = this.askFor(sessionId);
    // 提问渲染双源归一——questionPending 事件优先驱动提问 UI，question_pending chunk 作幂等兜底。
    // 内核保证事件先于 chunk 到达（loop 先 onPendingQuestion 回调、后 yield chunk）：事件驱动时清空 chunk 缓存，
    // chunk 仅作「事件监听未就绪/异常」时的兜底渲染源（消除单点事件依赖，问题不丢失）。
    let clarifyEventDriven = false;
    // ADR-043：两处提问形状一律引用协议 `PendingQuestionDto`（不再手写并列字段清单）。
    // 真收益 = 消除**类型层并列形状**：消费面读的 `TurnState.waiting.questions` 本就是
    // PendingQuestionDto[]，内核 emit 的对象原样透传 ⇒ 手写形状**不会丢运行时值**（字段一直在），
    // 但内核加/改字段时编译器无从报警，漂移只靠人眼。故改引用类型是防漂移，不是修缺陷
    // （口径见 ADR-043 §修正一，勿沿用「吞掉字段」的旧措辞）。
    const clarifyChunkQueue: PendingQuestionDto[] = [];
    // 监听主动提问事件 → 渲染提问框（含 LLM 声明的候选选项，webview 渲染为可点击按钮）
    const onPendingQuestion = (questions: PendingQuestionDto[]) => {
      clarifyEventDriven = true;
      clarifyChunkQueue.length = 0; // 事件为准，丢弃可能残留的 chunk 缓存
      ask.setPending(questions); // 事件写入源头（overwrite 全量写；派生见 postTurnUpdate，消费见 answerInput）
      // 提问这一刻立即补推 turn_update——问答卡渲染真源 = turn_update.state（waiting/ask）。
      // 此刻内核尚未 yield paused chunk（sessionStatus≈running），但 deriveTurnState 判据
      // 是「questions 非空即 ask」，故本投影即派生 waiting(ask)，即时渲染，不延迟。
      this.postTurnUpdate();
      ask.armAskTimeout(); // 超时保底：未答 → 自动续跑
      this._attention.onAskWaiting({ question: questions[0]?.question ?? '' }); // 交互提醒（事件写入源）
    };
    agent.on('questionPending', onPendingQuestion);
    // 监听记忆沉淀事件（memoryAdded，非 chunk 通道）→ 与 chunk 同源进过程事件缓冲（单源，
    // 渲染/落盘同一份 ProcessEvent）。content 5.0.0 起携带（可选 = 跨 dist 契约），
    // webview「已沉淀」提示按用户心智显示内容（缺失回退 name）。
    const onMemoryAdded = (info: {
      id: string;
      source: string;
      name: string;
      content?: string;
    }) => {
      emitEvent('memory_added', {
        id: info.id,
        name: info.name,
        source: info.source,
        ...(info.content !== undefined ? { content: info.content } : {}),
      });
    };
    agent.on('memoryAdded', onMemoryAdded);

    // 进入生成状态（webview 据 status 开呼吸点；输入框**不禁用**——运行中输入即插话）
    this.post({ type: 'status', state: 'thinking' });
    // 置位生成态：供插话路由、截断类结构动作与会话删除/归档的 streaming 守卫消费；
    // **不**拒绝会话导航（流中切换 / 新建自 E4 批 2 起由宿主放开）
    runtime.streaming = true;
    // 列表标识「运行中」随置位亮起（本条跨会话推送，后台 ALS 上下文也不得丢弃）
    this.refreshSessionActivity();
    this.postTurnUpdate();
    // 记录流起始视图代数：流尾比对 _viewEpoch 判断「流期间 view 被折叠/展开重建过」
    // （重建后新 webview 无本流实时投影 → 落盘完成须补 replaySession 刷全）
    const flowViewEpoch = this._viewEpoch;
    // 流式第一条 chunk 的时间戳（作为本轮 assistant 回复的时间）
    const firstChunkTs = new Date().toISOString();
    // 流开始时刻与 token 累计快照（metrics 事件需本轮增量：结束减开始）
    const flowStartMs = Date.now();
    const metricsBefore = {
      in: agent.getMetrics().llm.totalInputTokens,
      out: agent.getMetrics().llm.totalOutputTokens,
      // 未解析工具意图累计基准：本流增量 = 终结时累计 - 本基准
      unparsed: agent.getMetrics().tools.unparsedToolIntentCount,
      // 空响应兜底累计基准：同 unparsed 口径（内核计数器累计，流尾取 diff 得本轮增量）
      emptyResp: agent.getMetrics().llm.emptyResponseCount,
      // 截断救回累计基准：同上口径（换策略重试救回的观测面，验证 T2 真机效力靠它）
      truncRecover: agent.getMetrics().llm.truncationRecoveryCount,
    };
    // 过程事件缓冲 + 单形态投影：流式期间攒内存、逐条 post process_event，流结束按 turn roundId
    // 分组附到各 Round.processEvents 落盘。分段归属 SSOT：roundId 由内核 chunk 携带（AgentChunk.roundId），
    // 不依赖「roundIds 末尾」推断当前轮——一次 chat()（多 turn 任务编排）多 turn 各自独立落盘；
    // step 检查点按 seq 幂等合并增量（seq 实例级单调，见 _processSeq）。缓冲同时挂会话级运行态
    // （runtime.liveBuffer）：webview 重建后的 ready 握手重放据此读本流未落盘内容（流式正文不落盘、
    // 过程事件仅 step 边界增量 checkpoint）；收场末尾清除（身份比对），防跨轮残留。
    const liveBuffer: LiveFlowBuffer = {
      sessionId,
      eventsByRound: new Map<string, ProcessEvent[]>(),
      textByRound: new Map<string, string>(),
      seedUserMessage: seed?.userMessage,
    };
    runtime.liveBuffer = liveBuffer;
    // 局部别名保持闭包引用简洁（emitEvent / 正文分桶沿用原名）
    const eventsByRound = liveBuffer.eventsByRound;
    // 流式正文按 turn 分段累积：与 eventsByRound **同构分桶**（同一 currentRoundKey
    // 归属判据），供 live 轮投影把正文投为末段 assistantMessage。多 turn 编排各自独立成桶。
    const textByRound = liveBuffer.textByRound;
    /** 当前 turn 是否已补 meta 首条（每 turn 段首条身份 + 关键调用参数包） */
    let metaEmittedForRound = false;
    // meta 取证包：流首取一次激活 Provider 配置快照（本轮生效值），每 turn 首条 meta 携带
    const providerConfig = await this._providerStore.getActive();
    const roundMeta = () => this.buildRoundMeta(providerConfig);
    /** 构造过程事件：进缓冲（按 turn 分段，落盘真相源）+ 即时投影给 webview（渲染真相源），同一份数据 */
    const emitEvent = (typeKey: ProcessEvent['type'], payload: ProcessEvent['payload']): void => {
      // seq 实例级全局单调（_processSeq）：step 原子检查点按 seq 幂等合并，跨流/跨轮不冲突
      const seq = ++this._processSeq;
      const event = { type: typeKey, seq, ts: new Date().toISOString(), payload } as ProcessEvent;
      // 归属当前 turn 分段：**有**归轮键 ⇒ 进缓冲（切会话重建的真相源，与即时投影同一份数据）；
      // **无**归轮键 ⇒ 只即时投影、不进缓冲。无键 = 本流还没出现过任何带 roundId 的 chunk
      // （轮身份在 prepare 入口就已确定，正常路径下不会落到这里）——此时没有「最近 turn」可归属，
      // 强行缓冲会造出无主分桶、重放时错挂到别的轮上。二态行为由
      // `chatPanelHistory.test.ts`「无归轮键的宿主自造事件只即时投影、不进缓冲」钉住。
      if (liveBuffer.currentRoundKey) {
        const list = eventsByRound.get(liveBuffer.currentRoundKey) ?? [];
        list.push(event);
        eventsByRound.set(liveBuffer.currentRoundKey, list);
      }
      this.post({ type: 'process_event', event });
    };
    // 暂停标记——当轮是否收到 paused chunk（软暂停状态）
    let pausedOnPurpose = false;
    // 流首 plan 快照补推标记：prepare 期预置的会议骨架/续会计划
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
        // 待发送区同步（SSOT，防弹窗残留）：step 边界推进 = 队列消费的直接信号
        // ——interject 在 _handleInterrupt splice(0) 消费后，本 for-await 必然收到下一个 chunk，
        // 此刻从内核读队列（已变空）→ 长度变化 → post 空 items → webview 隐藏待发送区。
        // 普通插话（thinking 态 interject）不触发 sessionResumed，此处是它的唯一清空时机。
        this.syncPendingQueue();
        // turn 边界检测：roundId 变化 = 新 turn 开始（多 turn 任务编排多 turn 各自独立 roundId）
        if (chunk.roundId && chunk.roundId !== liveBuffer.currentRoundKey) {
          liveBuffer.currentRoundKey = chunk.roundId;
          metaEmittedForRound = false;
        }
        // 每 turn 段首条补 meta（身份，SSOT 与消息标签同源）；处理当前 chunk 前先补，保证 meta 为段内首条
        if (liveBuffer.currentRoundKey && !metaEmittedForRound) {
          metaEmittedForRound = true;
          emitEvent('meta', roundMeta());
        }
        // 提问 chunk（question_pending）：事件优先驱动，chunk 幂等兜底。
        // 事件已驱动（内核先回调、后 yield chunk）→ 跳过；未驱动 → 攒缓存，流尾统一兜底渲染（避免逐条 post 后者覆盖前者）
        if (chunk.type === 'question_pending') {
          if (!clarifyEventDriven) {
            clarifyChunkQueue.push(...chunk.questions);
          }
          continue;
        }
        if (chunk.type === 'tool_pending') {
          // 工具意图预告：LLM 流式生成 tool_call 参数期间（name 成形即上报），
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
          emitEvent('aborted', {
            reason: chunk.reason,
            ...(chunk.stopReason ? { stopReason: chunk.stopReason } : {}),
          });
          continue;
        }
        if (chunk.type === 'text' && chunk.content) {
          // 自审查输出（stage='self_review'）→ 过程事件（渲染进自审查折叠区，不进正文流）
          if (chunk.stage === 'self_review') {
            emitEvent('text_self_review', { content: chunk.content });
            continue;
          }
          // 主回答正文 → 照常走 chunk 消息（markdown 渲染，属内容轨，不属于过程事件）。
          // roundId 透传：运行时段同为「同环续接」判定提供数据依据，
          // 与重放路径共用「roundId 相等」单一判定源（chunk.roundId 由内核 withRound 携带）
          // 同一份正文按 turn 分桶累积（live 轮投影用）。归属判据与 emitEvent 完全同源
          // （同一 currentRoundKey），不另立判据；自审查输出已在上方 continue 分流，不会误入正文。
          if (liveBuffer.currentRoundKey) {
            textByRound.set(
              liveBuffer.currentRoundKey,
              (textByRound.get(liveBuffer.currentRoundKey) ?? '') + chunk.content,
            );
          }
          this.post({
            type: 'chunk',
            content: chunk.content,
            ts: firstChunkTs,
            roundId: chunk.roundId,
          });
        } else if (chunk.type === 'tool_start') {
          // 工具调用开始 → 过程事件（webview 渲染工具调用折叠区）
          emitEvent('tool_start', {
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            args: chunk.args,
            stepIndex: chunk.stepIndex,
          });
          // 文件改动追踪：写前快照（此刻磁盘仍是旧内容）
          // diskWrite 声明随事件透传——tracker 据此判定（自定义写工具与内置工具同源，不再靠静态名集）
          this._fileChangeSink?.noteToolStart({
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            args: chunk.args,
            ...(chunk.diskWrite ? { diskWrite: chunk.diskWrite } : {}),
          });
          // 脚本类（opaque 写）工具：写前扫一次 workspace 快照，供执行后 diff（路径运行时才可知）
          // 唯一判据 = tool_start 上报的 diskWrite 声明（内核写序闸同一真源）；无该字段 = 不改盘
          if (chunk.diskWrite === 'opaque') {
            this.scriptSnapshots.set(chunk.toolCallId, scanWorkspaceTextFiles());
          }
          // 任务驱动多步闭环：LLM 调用任务表工具时 → 推送当前计划快照给 webview 渲染任务看板
          // （薄壳装配：仅从 agent.getCheckpoint().plan 提取只读快照，不参与 LLM 执行。
          //  任务看板归 checkpoint 执行态，不进过程事件）
          if (chunk.name === 'task_table_write' || chunk.name === 'task_table_update') {
            this.postPlanUpdate();
          }
        } else if (chunk.type === 'tool_result') {
          // 工具调用结束 → 过程事件（工具调用完成态；失败计入 metrics.toolFailureCount）
          // 策略拦截：blocked 透传，UI 显示「已拦截」而非「成功/失败」
          emitEvent('tool_result', {
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            ok: chunk.ok,
            summary: chunk.summary,
            ...(chunk.blocked ? { blocked: true } : {}),
          });
          // 文件改动追踪：写后合并（按文件路径；blocked/失败自动丢弃）
          this._fileChangeSink?.noteToolResult({
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            ok: chunk.ok,
            blocked: chunk.blocked,
          });
          // 脚本类（opaque 写）工具：写后扫快照 → diff → 喂改动追踪（blocked/失败不追踪）
          // 判据 = 写前登记（tool_start 已按 diskWrite 声明判定并落 scriptSnapshots），此处**不重判工具名**
          // ——写前/写后共用同一份判据，自定义 opaque 工具自动对称覆盖；
          // 无 diskWrite 字段的事件不兜底静态名集：宿主与内核 dist 同代由 verify:dist-contract 保证
          if (this.scriptSnapshots.has(chunk.toolCallId)) {
            // ?? null：has 为真时 get 必有值，此处只为收窄类型（消除 undefined，null = 写前扫描已降级）
            const before = this.scriptSnapshots.get(chunk.toolCallId) ?? null;
            this.scriptSnapshots.delete(chunk.toolCallId);
            if (before !== null && chunk.ok && !chunk.blocked) {
              const after = scanWorkspaceTextFiles();
              if (after === null) {
                // 写后扫描超阈值：与写前降级同一条提示，不做内容 diff
                this.post({ type: 'notice', level: 'info', message: snapshotOversizeNotice() });
              } else {
                this._fileChangeSink?.noteExternalMutations(diffWorkspaceSnapshots(before, after));
              }
            } else if (chunk.ok && !chunk.blocked) {
              // 写前快照为 null（已超阈值降级）：写后不再扫描，直接提示用户用 git 核对
              this.post({ type: 'notice', level: 'info', message: snapshotOversizeNotice() });
            }
          }
          // N/M 闪骨架：tool_start 时读到的 plan 是工具执行前的旧状态
          // （如会议骨架 2 个任务项），工具落定后才是新 plan（如 4 个任务项）——tool_result 补推一次快照，
          // 消除「1/2 → 1/4」的一次性闪烁
          if (chunk.name === 'task_table_write' || chunk.name === 'task_table_update') {
            this.postPlanUpdate();
          }
        } else if (chunk.type === 'selfReview') {
          // 自审查终审开始 → 过程事件（自审查折叠区头部）
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
          // ⚠ 必须 break（不 break 则暂停后补充输入卡死）：内核 yield paused 后
          // generator 即 return 结束、无后续 chunk；不 break 会使 for-await 挂在已结束
          // 的流上，finally 的 runtime.streaming=false 永不执行 → 整个暂停期该会话 streaming 恒 true，
          // sendInput 因此永远命中「interject 排队」分支——暂停态没有 step 边界消费队列，
          // 补充输入永远卡在待发送区直到用户手动「继续」。break 让运行态 streaming 及时复位，
          // 暂停态补充正确路由到 resumeExecution(input)（一步即继续）。
          this.post({ type: 'paused' });
          pausedOnPurpose = true;
          break;
        } else if (chunk.type === 'thinking') {
          // 思考阶段 → 过程事件（webview 渲染过程轨迹折叠区）
          emitEvent('thinking', { phase: chunk.phase });
        } else if (chunk.type === 'narrate') {
          // 过程叙述 → 过程事件（webview 渲染过程叙述折叠行，不进正文流）
          // 叙述回抽：首轮工具步的叙述会逐字流式进正文区 → 先发瞬态撤回消息让
          // webview 去掉正文该段，再落 narrate 事件渲染进过程叙述行（顺序：撤正文 → 补过程，
          // 与 protocol narrate_withdraw 同款处理）。
          // withdrawn 为运行时瞬态（不落盘）；持久化正文由内核 consumeExecutionStream 扣除。
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
            // step 归属随内容透传落盘（webview「一个 step 一个思考折叠块」的归桶键）
            stepIndex: chunk.stepIndex,
          });
        } else if (chunk.type === 'plan_item_boundary') {
          // 任务项级折叠边界：active 任务项推进 → 落盘 plan_item_boundary 事件。
          // webview 据此把后续过程事件归入对应任务项分组；重放与运行时同一边界（同构）。
          // ⚠ 仅渲染分组依据（无任务表不产）；**不是落盘时机**——落盘时机唯一 = step_boundary
          // （本处不落盘，否则无任务表的长工具循环零增量落盘）。
          emitEvent('plan_item_boundary', {
            ...(chunk.planItemId ? { planItemId: chunk.planItemId } : {}),
            ...(chunk.title ? { title: chunk.title } : {}),
          });
        } else if (chunk.type === 'plan_snapshot') {
          // 任务表收尾快照（turn 收尾清空 plan 前内核产出）→ 落盘 plan_snapshot 事件。
          // 重放恢复「任务项完成态」的唯一结构化真源（历史回看绿勾）；实时态由 plan_update
          // 承载（本 chunk 无需 post webview——收到即流尾，finalize 重建自落盘事件消费）。
          emitEvent('plan_snapshot', { items: chunk.items });
        } else if (chunk.type === 'background_report') {
          // 后台任务收尾报告（内核 turn 终态对存活后台进程脱管后产出，ADR-036；无存活进程不产）
          // → 落盘 + 投影。与 plan_snapshot 同型：收到即流尾，webview 实时仅入缓冲，
          // finalize/重放经 renderRoundBlock「后台任务收尾」小节单点消费渲染。
          emitEvent('background_report', { content: chunk.content });
          // 收尾报告是后台任务状态的批量变化点 → 同步推一次快照（浮层据此转为全终态）
          this.postBackgroundTasks();
        } else if (chunk.type === 'step_boundary') {
          // 迭代边界：一次 LLM 迭代（含其工具执行）结束 → 增量落盘当前 pending Round。
          // 落盘时机 SSOT：全场景唯一时机（有/无任务表、有/无工具全覆盖），与流尾共用 mergeProcessEvents
          // 同一合并语义（seq 幂等）。顺序契约：内核保证 plan_item_boundary 先于本 chunk → 本轮落盘快照已含
          // 该任务项折叠边界，崩溃重放不错位。瞬态信号：不 emitEvent（不进 processEvents、不吃 seq）。
          if (liveBuffer.currentRoundKey) {
            this.checkpointRound(
              liveBuffer.currentRoundKey,
              eventsByRound.get(liveBuffer.currentRoundKey) ?? [],
            );
          }
          // 瞬态透传：webview 据落盘点注销未升级的「（准备中）」预告行（本步工具宿命已定，
          // 截断批/重试孤儿的 tool_start 永不到达）——生命周期契约见 dropStalePendingToolRows
          this.post({ type: 'step_boundary' });
          // 后台任务「刚启动」的唯一推送点（方案 §2.4）：step 含一次 LLM 迭代 + 其工具执行，
          // 后台命令必在某 step 内启动 ⇒ 边界到达时快照已含它（内建签名去重，无任务时零推送）
          this.postBackgroundTasks();
        } else if (chunk.type === 'error') {
          // 流内错误 → 复用现有 error 协议消息（webview 已有分支）。
          // 按内核产出的 category 映射友好文案（connection/timeout/unknown），
          // 无 category（普通错误）回退原始 message——语义分类走结构化字段，不做裸前缀/字符串匹配。
          // 映射 SSOT = windowNotices.flowError（窗口提示本地化）；webview 重放路仍用 shared/errorText（切片 4 统一两路）
          const friendly = flowError(chunk.category, chunk.message);
          this.post({ type: 'error', message: friendly, category: chunk.category });
          // 后台流（用户已切到其他会话）时 post 被流归属闸整批丢弃 ⇒ 这条明确失败永远看不到；
          // 明确失败必须到达用户：后台时改走既有全局通知（零新增协议，切回前也能看到）。
          if (this.isBackgroundFlow()) void vscode.window.showWarningMessage(friendly);
          // 重放可见性：error 必须落 processEvents（不能只 post）——只 post 则实时有提示条，
          // 回看历史只剩 generic「对话已中断」，失败原因永久丢失。
          // 落盘存**原始 message + category**（非友好文案）——与 `aborted` 存 reason + stopReason
          // 同构：事件是「UI 重建真相源」，文案由展示层每次映射（文案改版对历史同样生效）。
          emitEvent('error', {
            message: chunk.message,
            ...(chunk.category ? { category: chunk.category } : {}),
          });
        }
      }
      // 流尾兜底：本流产生提问 chunk 但事件未驱动（监听未就绪/异常）→ 用 chunk 缓存装载提问，问题不丢失。
      // 兜底渲染同样靠 turn_update.state——先写提问（postTurnUpdate
      // 投影真源）再补推 turn_update（等待 ask 渲染）。
      if (!clarifyEventDriven && clarifyChunkQueue.length > 0) {
        ask.setPending(clarifyChunkQueue);
        this.postTurnUpdate();
        ask.armAskTimeout(); // 兜底渲染同享超时保底
        this._attention.onAskWaiting({ question: clarifyChunkQueue[0]?.question ?? '' }); // 交互提醒（兜底写入源）
      }
      // assistant 消息持久化由内核 appendAssistant 完成（写入当前会话 _currentSessionId），
      // 此处不再 persist，避免与内核双写同一条回复（SSOT 单一真理源）
    } catch (err) {
      // 留痕**无条件**：后台流的错误投递会被投影闸挡掉，若连日志也只写后台，
      // 「后台跑挂了」对用户与日志双重静默；前台流同样值得一条日志（投递去留交给 post 的闸）
      console.warn('Memora 会话流内错误', err);
      this.post({ type: 'error', message: toNoticeText(err) });
    } finally {
      agent.off('questionPending', onPendingQuestion);
      agent.off('memoryAdded', onMemoryAdded);
      // 无论成败均清除生成态（恢复历史切换能力）——写本流归属会话的记录
      runtime.streaming = false;
      // 列表标识「运行中」随复位熄灭（跨会话推送，不受后台投递闸影响）
      this.refreshSessionActivity();
      // live 缓冲退场（实例字段；流尾收场逻辑全用局部 liveBuffer，不受影响）。
      // ⚠ 软暂停不清：内核 paused = 保留现场待续跑、**不 appendAssistant**——半截正文只在
      // 缓冲（textByRound），清了则暂停中切界面重建 = 半截回答丢失；保留到 resume 新流覆盖
      // 或最终收场（续跑流缓冲只含续跑段，暂停前正文随旧缓冲覆盖丢失，历史亦无——内核续跑
      // 收场 appendAssistant 落盘全量自愈，渲染面由 buildLiveTurnFromBuffer 并入落盘事件兜底）。
      // 放 finally（非收场流水末）：收场任一步抛错不再跳过清除（异常路径泄漏防线）。
      if (!pausedOnPurpose && runtime.liveBuffer === liveBuffer) runtime.liveBuffer = undefined;
      // 清理本轮 AbortController：仅当仍是本轮的 controller（防止下一轮已创建新 controller）
      if (runtime.abortController === controller) runtime.abortController = undefined;
    }
    // 结束状态：用户打断（abort() 已置 signal.aborted）→ interrupted（webview 渲染
    // 「已停止」并恢复输入框）；软暂停 → status:paused（按钮切为「继续」）；
    // 正常结束 → done。三者均恢复/切换按钮态，仅提示语义不同。
    // 附带本轮回答归属的 roundId（SSOT：来自 chunk 携带的 turn roundId，非 roundIds 末尾推断）：
    // webview 据此回填消息分叉按钮（任意 LLM 回答可分叉）。
    const latestRoundId = liveBuffer.currentRoundKey;
    // 运行时当前轮快照：供 turn_update 投影 live 轮，三处收场共用同一份构造。
    // userMessage 取 seed（仅 chat 路径有）；resume 路径缺省，由 mergeLiveRound 从落盘历史补，
    // 两边都拿不到则整轮不并入。interactiveInputs 不含（补充/回答发生在别的 handler，
    // 未在流内累积）：它的 UI 展示由 post 消息即时上屏覆盖，落盘后历史版本自会带全，
    // 故运行时缺此字段不构成「半残轮」。
    const liveTurn: PendingLiveRound | undefined = latestRoundId
      ? {
          roundId: latestRoundId,
          userMessage: seed?.userMessage,
          processEvents: eventsByRound.get(latestRoundId),
          streamingText: textByRound.get(latestRoundId),
        }
      : undefined;
    // 过程事件落盘：metrics 末条归入最后 turn + 按 turn roundId 分组写入各自 Round
    //（SSOT：归属来自内核 chunk.roundId）。fire-and-forget：失败仅记日志不阻塞展示（SSOT 不藏错）
    // 本轮收场信息读盘面（SSOT：与内核共享同一 WorkspaceRoundStore；内核收场写盘在 chat()
    // 返回前 await 无时序窗口）：evidence 补渲归因；status=roundStatus 投影兼供 metrics 判据。
    const settledRound = latestRoundId
      ? this._eventLogRoundStore?.getById(latestRoundId)
      : undefined;
    if (this._eventLogRoundStore && eventsByRound.size > 0) {
      // success 兜底口径（进程内旧口径 = 未 abort 且非软暂停）：只在盘面缺失时使用，且只在本块内
      // 计较——metrics 不发射时它压根不是判据。盘面缺失（存储缺轮 / GC 竞态）若不兜底就静默判失败
      // = 把好轮标成失败（与 TERMINUS-SSOT-1 消灭的「误标」同族，反方向）；故留痕、不隐瞒。
      const fallbackSuccess = !controller.signal.aborted && !pausedOnPurpose;
      if (!settledRound && latestRoundId) {
        console.warn('Memora metrics.success 盘面缺失回合，退回进程内口径', latestRoundId);
      }
      const metricsNow = agent.getMetrics();
      emitEvent('metrics', {
        durationMs: Date.now() - flowStartMs,
        tokenIn: Math.max(0, metricsNow.llm.totalInputTokens - metricsBefore.in),
        tokenOut: Math.max(0, metricsNow.llm.totalOutputTokens - metricsBefore.out),
        // 工具失败计数：与内核口径对齐（策略拦截 blocked 既非成功亦非失败，不计入失败），
        // 语义为本轮增量。内核对应用计数是累计（this.metrics.toolFailureCount），非本轮 diff，不可直接复用。
        toolFailureCount: [...eventsByRound.values()]
          .flat()
          .filter((e) => e.type === 'tool_result' && !e.payload.ok && !e.payload.blocked).length,
        // 本轮未解析文本工具意图增量：「想调用工具却未走原生协议」不得显示为成功收尾
        unparsedToolIntentCount: Math.max(
          0,
          agent.getMetrics().tools.unparsedToolIntentCount - metricsBefore.unparsed,
        ),
        // 空响应兜底增量：正文是兜底文案而非模型产出——同族诚实信号，展示层合成「不算成功收尾」
        emptyResponseCount: Math.max(
          0,
          metricsNow.llm.emptyResponseCount - metricsBefore.emptyResp,
        ),
        // 截断救回增量：曾截断但换策略重试救回——正文是真实产出（不影响成功收尾），仅观测留痕
        truncationRecoveryCount: Math.max(
          0,
          agent.getMetrics().llm.truncationRecoveryCount - metricsBefore.truncRecover,
        ),
        // success 口径改盘面投影（TERMINUS-SSOT-1）：盘面成功才算出成功（判据 = 内核
        // isRoundSuccessful 单点，宿主不自写比较）；盘面缺失时退回进程内口径
        // （见 fallbackSuccess 声明处），不让「无值」静默等价于「失败」。
        success: settledRound ? isRoundSuccessful(settledRound.status) : fallbackSuccess,
      });
      // 流尾最终落盘复用同一合并语义（SSOT）——
      // 与 step_boundary 时的增量检查点共用 mergeProcessEvents，靠 seq 幂等不重复、保序；
      // 跨流身份去重 / 终态净化均在 mergeProcessEvents 内，此处不重复实现。
      for (const [roundId, roundEvents] of eventsByRound) {
        this.checkpointRound(roundId, roundEvents);
      }
    }
    // 流期间 view 重建过 → 新 webview 未投影本流（隐藏期消息被丢弃），数据已完整落盘 →
    // 补一次 replaySession 全量回放恢复完整回合
    if (this._viewEpoch !== flowViewEpoch) {
      this.replaySession();
    }
    // plan 快照对齐：generator close 后内核 clearPlanOnTurnEnd 已清 plan（暂停态 guard 不清），
    // 此处推一次快照让 webview 同步——正常/中断 → 空 items（顶部条收起）；
    // 暂停 → 保留当前 plan（paused 分支前面，plan 还没被清，继续供 resume 消费）
    this.postPlanUpdate();
    if (controller.signal.aborted) {
      this.post({ type: 'interrupted', roundId: latestRoundId, evidence: settledRound?.evidence });
      this.post({ type: 'status', state: 'done' });
      this.postTurnUpdate(liveTurn);
    } else if (pausedOnPurpose) {
      // 软暂停：不推送 done/interrupted，切换为 paused 状态（允许用户继续）
      this.post({ type: 'status', state: 'paused' });
      this.postTurnUpdate(liveTurn);
    } else {
      this.post({
        type: 'done',
        roundId: latestRoundId,
        evidence: settledRound?.evidence,
        roundStatus: settledRound?.status,
      });
      this.postTurnUpdate(liveTurn);
      // 交互提醒（完成）：仅正常收场分支——用户停/软暂停都不是「任务完成」。
      if (latestRoundId) this._attention.onRoundSettled({ roundId: latestRoundId });
      // status:done 延后到摘要完成（或 5s 兜底）——防 done 后立即删除导致孤儿 round-summary
      // 摘要 Promise 的 then/catch 都会 emit roundSummaryGenerated（成功或失败），正常事件很快到达；
      // 5秒兜底足够抗偶发网络抖动，避免 UI 长时间卡在 thinking 态让用户困惑
      const SUMMARY_WAIT_TIMEOUT_MS = 5_000;
      // 本流归属实例已在上方捕获（`const agent`）——闭包内直接复用，不读 this._agent
      // （用户切走后 this._agent 已是另一会话的实例，读它即串台）
      let resolved = false;
      /** 解锁回调：受本会话 streaming 状态门控，防跨轮竞态（旧轮事件误触冲掉新轮 thinking） */
      const unlockDone = () => {
        if (resolved) return;
        resolved = true;
        // 竞态防护：本流归属会话的新轮已开始 → 跳过，让新轮走自己的 done 流程
        if (runtime.streaming) return;
        // 会话归属防护：摘要回调在流上下文之外触发，用户可能已切走——
        // 此时该 done 属于 A，投给 B 会把 B 的相位误置为完成（切回 A 时 replay 自会对齐）
        if (sessionId !== this._currentSessionId) return;
        this.post({ type: 'status', state: 'done' });
      };
      const timeoutHandle = setTimeout(() => {
        // 超时也手动解绑事件监听，防累积泄漏（.once 只在触发时自动解绑，超时不触发会遗留 handler）
        agent.off('roundSummaryGenerated', onSummary);
        unlockDone();
      }, SUMMARY_WAIT_TIMEOUT_MS);
      const onSummary = (info: { roundId: string; success: boolean }): void => {
        clearTimeout(timeoutHandle);
        // 与 setTimeout 分支对称解绑：本回调经 agent.on 注册（非 .once），只在
        // 事件触发路径上解绑是不够的——每轮正常收到事件都会遗留一个 handler 累积。
        agent.off('roundSummaryGenerated', onSummary);
        // 摘要失败可观测出口：内核 runSummary 的三条失败路径（异步 reject / 同步 catch）
        // 都发 success:false，此处此前只拿它解锁 UI 定时器、直接丢弃该字段 ⇒
        // 摘要失败在 metrics/事件/记忆库四面皆不可见（「静默失败 = 假阴性」）。
        // 走本文件既有的错误级 notice 单通道（见「会话异常可观测出口」节），
        // 不新增日志路径、不新增协议字段、不改内核。
        if (!info.success) {
          // 摘要失败可观测：事件回调不在流上下文（ALS 取不到），故显式判会话归属——
          // 后台会话的摘要失败不乱弹到当前界面上，但仍**留痕**（不静默吞掉失败）
          if (sessionId === this._currentSessionId) {
            this.post({
              type: 'notice',
              level: 'error',
              message: l10n.t(
                'Failed to generate the memory summary for this turn; its content will not be persisted automatically (the conversation itself is unaffected)',
              ),
            });
          } else {
            console.warn('Memora background session memory summary failed', sessionId);
          }
        }
        unlockDone();
      };
      agent.on('roundSummaryGenerated', onSummary);
      // 删后注记（2026-10-18 · 5.0.0）：此处曾在轮次正常收尾时推送 Follow-up 建议
      // （governance.suggest() → 'suggestions' 协议）。该连锁随内核治理链整链退役同步拆除。
    }
    // 本轮流式结束 → 推送活动指标快照（指纹 + 累计指标，默认折叠展示）
    this.postMetrics();
    // 预算可视化：推送上下文占用快照（输入区常驻指示器，脱离 showMetrics 独立常驻）
    this.postContextOccupancy();
    // 面板在流期间被销毁过：全部落盘写完才归还会话锁（本方法最末）
    this._lockFinalizer.onStreamEnd(sessionId);
  }

  /** 任务看板快照（实现见 `helpers/panelSnapshots.ts` 的 `postPlan`，本处只留调用点名称） */
  private postPlanUpdate(): void {
    this._snapshots.postPlan();
  }

  /**
   * 推送后台任务快照
   *
   * 实现与判据已整体外置到 `helpers/panelSnapshots.ts`（`PanelSnapshots.pushTasks`）——
   * 本文件不留第二份口径，面板侧只保留同名薄包装供既有消息分派按方法名直达。
   */
  private postBackgroundTasks(mode: 'dedup' | 'force' = 'dedup'): void {
    this._snapshots.pushTasks(mode);
  }

  /** 收起后台任务终态行（实现见 `PanelSnapshots.dismiss`） */
  private dismissBackgroundTask(taskId: string): void {
    this._snapshots.dismiss(taskId);
  }

  /** 终止后台任务（实现见 `PanelSnapshots.kill`） */
  private killBackgroundTask(taskId: string): void {
    this._snapshots.kill(taskId);
  }

  /** 上下文占用快照（实现见 `PanelSnapshots.postOccupancy`） */
  private postContextOccupancy(): void {
    this._snapshots.postOccupancy();
  }

  /** 待发送区同步守卫：
   *  真理源 = 内核 queue（loop.pendingInterjections），宿主只做「长度变化检测」。
   *  队列长度变化 → 触发 `postTurnUpdate()`（其内部读内核队列快照 → `turn_update.pendingQueue`），
   *  不单发 `pending_queue_update`（统一走 turn_update 单通道）。
   *  清空时机不能只绑 sessionResumed（那是 resume 专有事件，普通插话不触发 →
   *  队列消费后无「空通知」→ 待发送区弹窗残留）；本守卫由调用方（入队/清空/删除/step 边界后 chunk）
   *  统一调用，队列变空必然触发长度变化 → post 空 pendingQueue → webview 隐藏。 */
  private syncPendingQueue(force = false): void {
    // 后台流不触碰 `_lastPendingQueueLen`（宿主单份缓存）：写入即让当前会话的「长度未变」
    // 判据失真，表现为待发送区该刷新时不刷新（该形态无测试会红）
    if (!this._agent || this.isBackgroundFlow()) return;
    // optional 调用：consumeFlow 主循环每 chunk 同步，测试桩可能缺该方法
    // （chatPanelHistory 的 mock agent 不实现 getPendingInterjections）——缺则跳过不阻断流
    const items = this._agent.getPendingInterjections?.() ?? [];
    // 长度未变不重复投影（同一队列状态不刷屏）；入队/消费/清空/删除均改变长度 → 必触发一次。
    // `undefined`（从未投影过）恒不等于任何长度 → 首次 sync 恒推，覆盖「resume 恢复队列后
    // 直接清空」等从未投影场景——丢弃信号的成对快照帧不因长度恰好归零而丢失。
    // `force`：停止路径必须**无条件**重投影相位（队列长度未变时也要推），见 handleStop 尾注。
    if (!force && items.length === this._lastPendingQueueLen) return;
    this._lastPendingQueueLen = items.length;
    // 不单发 pending_queue_update，由 turn_update.pendingQueue 统一承载
    // （此处不必传 live——待发送区是 turn 级展示，历史轮足够定位渲染输入）。
    this.postTurnUpdate();
  }

  /**
   * 推送活动指标快照（透明面板 + 指纹可见）
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
    if (!this._agent || this.isBackgroundFlow()) return;
    // 深度隐藏开关：默认 false（普通用户零噪音），调试可观测性时开启
    const show = vscode.workspace.getConfiguration('memora').get<boolean>('showMetrics', false);
    if (!show) return;
    const fp = vscodeTracer.getLatestFingerprints();
    const m = this._agent.getMetrics();
    // 提取最近操作流（span 标签序列）供透明面板渲染
    const traces = vscodeTracer.getRecentTraces(20);
    // 安全/装配透明：推送路径守卫审计概要（有审计事件才携带）
    const securityAudit =
      this._securityAuditTotal > 0
        ? {
            total: this._securityAuditTotal,
            denied: this._securityAuditDenied,
            recent: [...this._recentSecurityAudits],
          }
        : undefined;
    this.post({
      type: 'metrics',
      fingerprints: {
        systemPromptHash: fp.systemPromptHash ? fp.systemPromptHash.slice(0, 12) : undefined,
      },
      metrics: {
        llmCallCount: m.llm.callCount,
        toolFailureCount: m.tools.failureCount,
        // 未解析工具意图：累计数与内核口径一致，供诊断面板观察
        unparsedToolIntentCount: m.tools.unparsedToolIntentCount,
        truncationCount: m.context.truncationCount,
        // token 用量
        llmTokenIn: m.llm.totalInputTokens,
        llmTokenOut: m.llm.totalOutputTokens,
        // 透出最近一次装配的上下文预算构成（prepare 计算，指标快照携带）
        ...(m.context.budget ? { budget: m.context.budget } : {}),
      },
      trace: traces,
      ...(securityAudit ? { securityAudit } : {}),
    });
  }
}
