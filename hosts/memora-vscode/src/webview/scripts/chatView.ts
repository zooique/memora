/**
 * chatView — 对话面板 webview 运行时脚本
 *
 * 以工厂函数 createChatView 接收依赖（acquireVsCodeApi / window）并初始化全部交互。
 * 消除全局污染（window.__xxx 全局回调 → 模块 import + 显式回调映射），
 * 同时具备可测性（依赖注入，可传入 mock window/jsdom）。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/chatView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src 'self'）。
 */
import type {
  ActiveFileProjection,
  ChatRef,
  ExtensionToWebviewMessage,
  InjectionSegment,
  InjectionSource,
  InjectionSummary,
  PendingQuestionDto,
  RoundView,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
// 引用身份键与去重判据：**必须**与宿主缓冲共用同一实现——同文件不同选区是两条引用，
// 若各自按 path 判等，chip 的锁 / 移除会误伤同 path 的另一条（见 shared/refKey.ts）。
import { dedupeRefs, formatRefRange, normalizeRefRange, refKeyOf } from '../../shared/refKey.js';
// 中断轮复制源 = 过程叙述按序拼接：单点在 shared（宿主崩溃打捞派生消费同一份，禁各写一遍）
import { deriveNarrateText } from '../../shared/narrateText.js';
// 注入源命名 / 信封标记单一真源（HOST-CTX-4 第 1 笔 SSOT 化）：chip 可见名、回执分项名、
// @ 下拉 label、信封块头同读一处——曾四处并列写字面量，「短名双写」已付过一次代价。
import {
  INJECTION_SEGMENT_LABELS,
  MOUNTABLE_INJECTION_META,
  type MountableInjectionSource,
} from '../../shared/injectionSourceMeta.js';
// ProcessEvent 纯类型导入（ProcessThinkingPhase 随 phaseLabel 迁 helpers/processEventText）：仅编译期用，esbuild 剥离，不引入运行时依赖
import type { ProcessEvent } from '@zooique/memora';
// 错误文案映射单一真理源（与 Node 侧 chatPanel 实时提示条共用，防文案双源漂移）
// 输入长度上限（INPUT-LIMIT-1）：值真源 = shared/constants.ts，两侧输入口同源消费
import {
  MAX_ASK_ANSWER_CHARS,
  MAX_INPUT_CHARS,
  MAX_PENDING_INTERJECTIONS,
} from '../../shared/constants.js';
import { bindSingleTrackRow, syncRowEdges } from '../helpers/chipRow.js';
import { createQuoteDraft } from '../helpers/quoteDraft.js';
import { createClampUserBubble } from '../helpers/userBubble.js';
import { createImageCapture } from '../helpers/imageCapture.js';
import { renderAttachmentStrip, type UserAttachmentView } from '../helpers/attachmentStrip.js';
import { fmtTime } from '../helpers/fmtTime.js';
import { copyText, installSelectionCopyGuard } from '../helpers/selectionClipboard.js';
import { fmtTokens } from '../helpers/fmtTokens.js';
import {
  forceScrollToBottom,
  followIfPinned,
  jumpToBottom,
  scrollToBottom,
  trackScroll,
} from '../helpers/scrollToBottom.js';
import { renderMarkdown } from '../helpers/renderMarkdown.js';
import { getToolDisplayName } from '../helpers/toolNameMap.js';
import {
  countReviews,
  fmtDuration,
  isPlanItemBoundaryEvent,
  phaseLabel,
  toDateKey,
  toolActionLabel,
  toolStartNames,
  toolSummaryText,
} from '../helpers/processEventText.js';
// 会话大纲导航条（HOST-NAV-1）：逻辑收口于 helpers/roundNav.ts（SSOT），本文件只接线
import { createRoundNav } from '../helpers/roundNav.js';
// 骨架（会话控件）语义派生纯函数层：矩阵与状态容器在 turnUiState.ts，
// 本文件只做「取数 → 派生 → 施加」；容器写入只走 skeletonFromTurnState（真源 = turn_update.state）
import {
  deriveButtonSemantics,
  deriveSessionUiState,
  skeletonFromTurnState,
  type ButtonSemantics,
  type SkeletonState,
} from '../helpers/turnUiState.js';
import { initDropdowns } from '../components/dropdown.js';
import { initContextMenu } from '../components/contextMenu.js';
// 右键菜单项表（数据面外置：8 条 when/run 长在视图函数体里会与 prettier / max-lines 顶牛）
import { createContextMenuItems } from '../components/contextMenuItems.js';
// 轮级动作底栏（ACTIONS-SSOT-1）：底栏呈现 + 锚点读取收口于 roundFooterView，
// 动作文案/判据/执行收口于 components/roundActions；chatView 只接线与锁态刷新
import {
  buildRoundGroupFooter,
  refreshRoundActionButtons,
  settleRoundGroupFooter,
} from './roundFooterView.js';
import { createCodeBlockEnhancer } from './codeBlockView.js';
import { applyIcon, createIcon, getIconSvg, populateIcons } from './icons.js';
import { createSanitizer } from '../helpers/sanitizer.js';
// 计划常驻条（任务看板）：渲染与状态收口于 planBarView（HOST-SPLIT-1 chatView 首刀）
import { createPlanBarView } from './planBarView.js';
import { insertBeforeBody } from '../helpers/insertBeforeBody.js';
import { setCursorStatus, setTerminus, type CursorStatus } from '../helpers/statusAttrs.js';
import {
  buildMemoryHitsEvidenceResolver,
  buildSearchEvidenceResolver,
  findRunningTool,
  groupThoughtBuckets,
  groupToolBatches,
  planItemStatesFromEvents,
  stopReasonLabel,
  thoughtLabel,
  type MemoryHitEntry,
} from '../helpers/processFlowModel.js';
import { createMemoryHitsBlock } from './memoryHitsBlock.js';
import {
  appendInterruptedRow,
  createProcessFlowCells,
  insertPlanItemInOrder,
  updateToolRowState,
  visibleInputTs,
} from './processFlowCells.js';
import { createPickerView } from './pickerView.js';
import { createQaRowView } from './qaRowView.js';
import { createEmptyStateView } from './emptyStateView.js';
import { createRoleBadgeView } from './roleBadgeView.js';
import { createToolRowView } from './toolRowView.js';
// 历史菜单（会话记录/留存区）：渲染与分组状态收口于 historyMenuView（HOST-SPLIT-1 chatView 第 2 刀）
import { createHistoryMenuView } from './historyMenuView.js';
// 上下文占用（圆环/构成条/明细）：渲染与防误清零状态收口于 contextOccupancyView（HOST-SPLIT-1 chatView 第 3 刀）
import { createContextOccupancyView } from './contextOccupancyView.js';
// 活动抽屉（活动条/时间线/指标/未读位）：渲染与未读判定收口于 activityDrawerView（HOST-SPLIT-1 chatView 第 4 刀）
import { createActivityDrawerView } from './activityDrawerView.js';
// dock 浮层放置机制（UI-TOAST-1：活动条浮层化的搬移/类同步；判据与裁决仍在本文件）
import { isToastHead, placeDockHead, toastLoopSkip } from '../helpers/dockToast.js';
import { createStatusBarsView } from './statusBarsView.js';

/** chatView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface ChatViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象（脚本在浏览器环境运行） */
  window: Window;
}

/**
 * 初始化对话面板 webview 交互
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createChatView({ acquireVsCodeApi, window }: ChatViewDeps): { dispose(): void } {
  const document = window.document;
  const vscode = acquireVsCodeApi();

  // 在 webview（浏览器）环境构造消毒器：createSanitizer 是 DOMPurify 构造的唯一真源
  // （sanitizer.ts）。DOMPurify 依赖浏览器 window，在 Node 环境可达的模块顶层构造会抛
  // ReferenceError，故只能在 createChatView（webview 唯一初始化入口）内绑定一次。
  // 渲染函数 renderMarkdown 通过注入 sanitize 回调使用，职责分离：渲染逻辑纯函数化。
  const sanitize = createSanitizer(window);

  // 代码块增强工厂（CHATVIEW-SLIM-3 后续腾行批：域外置 scripts/codeBlockView.ts，
  // COPY-2 行数账同批腾行）。const 须在首个调用点（流式渲染链）之前实例化。
  const codeBlockEnhancer = createCodeBlockEnhancer({ document, copyText });

  // 统一图标填充：将 HTML 中 data-icon 属性的元素替换为 Trae 风格 SVG 图标
  populateIcons(document.body);

  const messages = document.getElementById('messages') as HTMLElement;
  const emptyState = document.getElementById('emptyState') as HTMLElement;
  // 空状态标题/提示（空状态角色化）：随激活角色包动态生成，切换角色不产生定位错位
  const emptyTitle = document.getElementById('emptyTitle') as HTMLElement;
  const emptyHint = document.getElementById('emptyHint') as HTMLElement;
  // 空状态示例提问容器（showcase 角色特化引导）：由脚本按激活角色动态填充
  const emptySuggestions = document.getElementById('emptySuggestions') as HTMLElement;
  // 会话标题条——顶部展示当前会话标题，
  // 主动可见识别当前会话；左侧改名笔、右侧新建「＋」+ 历史下拉（会话导航全量收敛于此）
  const sessionTitleText = document.getElementById('sessionTitleText') as HTMLElement;
  const renameSessionBtn = document.getElementById('renameSessionBtn') as HTMLButtonElement;
  const newSessionBtn = document.getElementById('newSessionBtn') as HTMLButtonElement;
  // 历史记录下拉：复用 treedd 组件（trigger=历史按钮），
  // 菜单容器为渲染目标，开合/外部关闭/Escape 由 initDropdowns 管理（无遮罩、轻量）
  const historyBtn = document.getElementById('historyBtn') as HTMLButtonElement;
  const historyMenu = document.getElementById('historyMenu') as HTMLElement;
  // 历史浮层分组切换器（会话记录 / 留存区）：与条目容器同级，不受条目重建影响
  const historyTabRecent = document.getElementById('historyTabRecent') as HTMLButtonElement;
  const historyTabArchived = document.getElementById('historyTabArchived') as HTMLButtonElement;
  const historyArchivedCount = document.getElementById('historyArchivedCount') as HTMLElement;
  // FD-3-A 元数据搜索框（标题 / 主题 / 摘要）：独立于 #historyMenu，重建条目不影响本框
  const historySearch = document.getElementById('historySearch') as HTMLInputElement;
  const input = document.getElementById('input') as HTMLTextAreaElement;
  const send = document.getElementById('send') as HTMLButtonElement;
  // 暂停按钮（Gap A：用户主动暂停入口，仅生成中可见，与「停止」并列的软暂停控制）
  const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement | null;
  // 润色按钮（输入框旁，对当前输入内容进行润色）
  const polishBtn = document.getElementById('polishBtn') as HTMLButtonElement | null;
  // 上传图片按钮（常驻，D27）：绑定/置灰态归 imageCapture（Q3），这里只递元素
  const imageAttachBtn = document.getElementById('imageAttachBtn') as HTMLButtonElement | null;
  // Skill 选择器（输入框旁，选择后作为提示词传给 LLM）
  const skillPicker = document.querySelector<HTMLElement>('.skill-picker');
  const skillPickerMenu = skillPicker
    ? skillPicker.querySelector<HTMLElement>('.treedd__menu')
    : null;
  const skillPickerTrigger = skillPicker
    ? skillPicker.querySelector<HTMLElement>('.treedd__trigger')
    : null;
  // 附件行（选择态行）：输入盒内、文字上方展示当前已选 Skill（名称 + × 可移除）
  const skillChipRow = document.getElementById('skillChips') as HTMLElement | null;
  // pinned = 常驻锁（发送后是否保留）：skill 默认 true = 锁预开常驻，保持既有「发送不消失」行为；
  // ref 默认 false = 发送即清（现状）。两类 chip 共用这一个属性，不另建 pinned 数组（SSOT：
  // 钉住集与上下文集同源，杜绝两处漂移）。pinned 纯 UI 状态，不进协议/内核。
  let currentSkill: { name: string; disabled?: boolean; pinned: boolean } | null = null;
  // 引用行（右键「添加到对话」挂的文件/目录，与 skillChipRow 同构复用样式；file/folder 二态）
  const refChipRow = document.getElementById('refChips') as HTMLElement | null;
  // 引用回复快照草稿（COPY-2 形态优化）：文本快照 ≠ 文件指针，消费链独立（发送时展开引用块），
  // 状态单点在工厂；chip 渲染编排归 renderAttachmentRow（refChipRow 全清重绘单点）
  const quoteDraft = createQuoteDraft({ document, onRemove: () => renderAttachmentRow() });
  // 长输入气泡折叠（外置 helpers/userBubble.ts，COPY-2 行数账同批腾行）；吸底滚动绑定消息容器
  const clampUserBubble = createClampUserBubble({
    document,
    scrollToBottom: () => scrollToBottom(messages),
  }).clamp;
  // 图片附件行（粘贴 / 拖入采集的 chip；D28：与引用 chip 同构、只显示文件名不做缩略图）
  const imageChipRow = document.getElementById('imageChips') as HTMLElement | null;
  let currentRefs: {
    path: string;
    kind: 'file' | 'folder';
    /** 行区间（1-based 闭区间，宿主已转换；整文件引用时缺省） */
    range?: { start: number; end: number };
    pinned: boolean;
  }[] = [];
  /**
   * 活动文件投影（宿主推送，**纯显示**）：当前打开文件会不会进本轮上下文
   *
   * ⚠️ 只渲染，不据此推断注入——判据与投影同源在宿主（`chatPanel.resolveActiveFile`），
   * webview 侧任何「看 chip 状态猜要不要读文件」的写法都是第二真理源。
   * 初值 `none`：宿主 ready 后必推一次（`handleWebviewReady` ⑦），故无需前端猜。
   */
  let activeFile: ActiveFileProjection = { kind: 'none' };
  /**
   * 本轮挂载的**注入型**上下文来源（HOST-CTX-4）
   *
   * 与 `currentRefs` 的关键差别（④ 采集时机）：引用挂载即定值，注入类是**瞬态数据**——
   * 这里只记「用户要哪几个通道」的标记，**宿主收到 send 后在发送时刻才取数**
   * （`getDiagnostics()`），保证模型看到的是最新一份。宿主不镜像这份状态（无第二真理源）。
   *
   * 生命周期（③）：**发送后无条件清**，且**没有 🔒 常驻锁**——常驻意味着「每轮都悄悄塞一份
   * 诊断进信封」，与硬约束④「不泛化」直接冲突；要再用就重新挂（一次点击）。
   */
  let currentInjections: Exclude<InjectionSource, 'active-file'>[] = [];
  /**
   * 圆环 hover 卡片底部「本轮注入」回执行（HOST-CTX-4 ② 的呈现落点；发送后一次性回执）
   *
   * 2026-10-21 由状态行徽记迁入（真机反馈）：状态行是稳定身份徽章（角色 / 能力）的行，
   * 一枚随挂载忽隐忽现的数字 pill 混在其中突兀；而它是**预算归因数**，与圆环同属预算域——
   * 圆环「常驻一瞥 + hover 精确」，回执归「精确」层，分项明细同屏可见（不再藏 title）。
   * ⚠️ 圆环本体在选中 Provider 前 hidden ⇒ 回执行同理不显示：无「当前模型窗口」可依托时，
   * 预算数没有可证参照（迁移前徽记在状态行恒可见，此差异有意接受）。
   */
  const injectionReceipt = document.getElementById('occInjection') as HTMLElement | null;
  /**
   * 活动文件 chip 徽记上的本轮注入量（`injection_summary` 里 active-file 分项的投影）
   *
   * ⚠️ 两段式（预备 → 认领）不是冗余：`injection_summary` 与 `active_file` 同批发且汇总
   * 在先，收到汇总时本轮投影还没到 ⇒ 只能先预备；紧随其后的投影推送来认领，数字才归位。
   * 认领后常驻到下一轮发送 / 复位（chip 期内可能因删引用重渲染多次，不能消费即焚）。
   * 中途推送（编辑器切换等，不带汇总）的投影 ⇒ 认领落空、清零：**不把上一轮的数字按到
   * 新文件 chip 上**——数字错配比不显示更坏（CTX-6② 归因的意义正在于「这轮贵在哪」可信）。
   */
  let pendingActiveFileTokens: number | undefined;
  let activeFileTokens: number | undefined;
  // 活动状态条（瞬态单条：error/info 通知，info 2500ms / error 8000ms 自动撤）
  const activityBar = document.getElementById('activityBar') as HTMLElement;
  // 状态抽屉（C1，2026-10-05）：静态骨架，入口 chip + 下拉体 panel（内含控件段 controls
  // 与时间段 #activityDetail）。#activityDetail 是纯静态容器（列表/指标各有元素引用），
  // 脚本无需持有它——不参与任何搬运与显隐，可见性纯粹随 #dockPanel.hidden。
  const dockChip = document.getElementById('dockChip') as HTMLButtonElement | null;
  const dockPanel = document.getElementById('dockPanel') as HTMLElement | null;
  const dockControls = document.getElementById('dockControls') as HTMLElement | null;
  const toastSlot = document.getElementById('activityToastSlot') as HTMLElement | null;
  const inputBar = document.getElementById('inputBar') as HTMLElement;
  const inputWrap = document.getElementById('inputWrap') as HTMLElement | null;
  const clarifyBar = document.getElementById('clarifyBar') as HTMLElement;
  const clarifyText = document.getElementById('clarifyText') as HTMLElement;
  const clarifyOptions = document.getElementById('clarifyOptions') as HTMLElement;
  const clarifyInput = document.getElementById('clarifyInput') as HTMLInputElement;
  // INPUT-LIMIT-1：输入长度上限在**输入框阶段**生效（原生 maxLength，超出部分进不了
  // 输入框，所见即所发）；分档 = 主输入长档 / clarify 回答短档（ask-inline 每题输入框
  // 在 renderAskInline 创建处同源设限）。程序化赋值（润色回填等）不受 maxLength 约束，
  // 属可接受残留（输入源本身已截，输出同量级）。
  input.maxLength = MAX_INPUT_CHARS;
  clarifyInput.maxLength = MAX_ASK_ANSWER_CHARS;
  // 写入审批卡：confirmWrites=true 时写文件触发，渲染审批卡
  // 供用户确认/拒绝；回传 write_confirm_answer（fail-closed：host CONFIRM_TIMEOUT_MS
  // = 30 分钟超时即自动拒绝，末 60 秒面板显倒计时）
  const writeConfirmCard = document.getElementById('writeConfirmCard') as HTMLElement | null;
  const writeConfirmTool = document.getElementById('writeConfirmTool') as HTMLElement | null;
  const writeConfirmPath = document.getElementById('writeConfirmPath') as HTMLElement | null;
  const writeConfirmDesc = document.getElementById('writeConfirmDesc') as HTMLElement | null;
  const writeConfirmDiff = document.getElementById('writeConfirmDiff') as HTMLElement | null;
  const writeConfirmOk = document.getElementById('writeConfirmOk') as HTMLButtonElement | null;
  const writeConfirmReject = document.getElementById(
    'writeConfirmReject',
  ) as HTMLButtonElement | null;
  const writeConfirmCountdown = document.getElementById(
    'writeConfirmCountdown',
  ) as HTMLElement | null;
  const writeConfirmHint = document.getElementById('writeConfirmHint') as HTMLElement | null;
  let pendingWriteConfirmRequestId: string | null = null;
  /**
   * 等待态标记（2026-10-05 P5 落地 A）：用户已裁决、卡等宿主推下一条的过渡态。
   *
   * 🔴 为何需要它（消解 F1 重复提交 + 闪烁）：
   * 原实现点击后**同步** closeWriteConfirmCard()，而下一条 write_confirm_request 由宿主
   * **异步**推 ⇒ ①两帧空档 = 用户实测的闪烁；②队列无下一条时，卡片会带着已裁决的旧内容
   * 滞留，用户再点一次 → 宿主 pending 已 delete ⇒ 第二个 answer 静默丢弃（点了没反应）。
   * 等待态把「点了 → 下一张」显式化：按钮 disabled（防重复）+ 卡片降透明度（明示过渡）。
   *
   * 🔴 显隐真源仍在宿主（确认协调器 `ConfirmCoordinator` 的收卡逻辑）：本状态只改**按钮可用性与提示**，
   * 绝不开关卡片——否则又回到「两个显隐写入点」（双源）。
   */
  let writeConfirmAwaitingNext = false;
  const clarifySend = document.getElementById('clarifySend') as HTMLButtonElement;
  // 当前角色显示名（AI 消息头部标签 + 空状态标题共用；由 chat_role_pack 填充）
  let currentRoleName = '';
  // 当前模型名（AI 消息头部标签显示；由模型选择变化时更新）
  let currentModelName = '';
  // 当前角色性格特征（traits，可选；由 chat_role_pack 填充，供徽章/顶栏展示）
  let currentRoleTraits: Record<string, number> | undefined;
  // 底部模型下拉框（用 extraClass=model-picker 修饰）
  const modelPicker = document.querySelector<HTMLElement>('.model-picker');
  const modelPickerMenu = modelPicker
    ? modelPicker.querySelector<HTMLElement>('.treedd__menu')
    : null;
  const modelPickerTrigger = modelPicker
    ? modelPicker.querySelector<HTMLElement>('.treedd__trigger')
    : null;

  // 当前角色徽章（输入区状态行，展示角色名让用户感知当前定位）。
  // 可点跳转：点击 → open_settings_tab(roles) → host 打开设置面板「角色」选项卡（导航单点；切换执行仍走角色视图
  // 「设为当前」→ roles_set_active → agent.switchRolePack 单路径，本徽章不承载切换逻辑）。
  const roleBadge = document.getElementById('currentRoleBadge') as HTMLButtonElement | null;
  // 工具权限徽章（输入区角色徽章旁，展示工具模式与能力列表）
  const capabilityBadge = document.getElementById('currentCapabilityBadge') as HTMLElement | null;
  // 当前角色队伍快照（小组会议启动图标用；由 chat_role_pack.team 填充）
  let currentActiveTeam: { leader: string; members: readonly string[] } | null = null;
  // 小组会议启动图标单例（懒创建，同计划常驻条的惰性单例范式（planBarView 模块））：身份即本引用。
  // 不得改用字符串键（getElementById/querySelector）复查找回——创建键与查找键一旦不一致
  // 就会每次推送各新建一个，表现为重复图标（SSOT：单例身份只有这一个声明）。
  let teamMeetingIcon: HTMLElement | null = null;

  // 流式锚点（SSOT）：当前正在流式接收的 assistant 消息元素。
  // 追加目标用「不变锚点」而非 messages 最后一个元素——工具卡片/其他节点插入
  // 不会改变锚点，避免一次回复（含工具调用）被拆成多条消息。
  let activeAssistantEl: HTMLElement | null = null;
  // 暂停块锚点（resume 原位续接）：pause 时记录当前流式 assistant 块；
  // 无输入 continue 的首个 text chunk 若同闭环（roundId 相等）→ 复用该块原位续写，
  // 而非 beginStreaming 新建第 2 个 assistant 块（否则视觉上成为「一次输入、两个独立 LLM 回答」）。
  let pausedAssistantEl: HTMLElement | null = null;

  // 流式状态（Markdown 渲染 + 光标）：
  //   streamingActive — 是否正在接收本轮流式（首个 chunk 置 true，done/interrupted 复位）；
  //   streamingRaw — 本轮流式累积的原始文本（流结束后一次性渲染 Markdown + 供复制）。
  // 用独立状态而非复用 activeAssistantEl：区分「流式进行中」（需光标 + 结束时渲染）
  // 与「一次性 assistant 消息」（历史回放，直接渲染 Markdown）。
  let streamingActive = false;
  let streamingRaw = '';

  // 问答闭环可视化（纯展示层）：
  //   lastAssistantRoundId — 上一个 assistant 块的 roundId（同轮结构归位唯一依据：chunk 到达时判骨架留原容器 /
  //                          新轮建新容器）。宿主透传 chunk.roundId，运行时与重放统一走「roundId 相等」判定，无独立时序标志。
  //   resumePending        — 问答/补充续跑期待：交互输入（qa/supplement）或内联提问提交后置位，下一个 process_event
  //                          meta 消费为「同闭环续跑的 meta」而非新轮——保留 currentEvents 与 round-block 锚点
  //                          （折叠留在闭环首块），避免 resume 二次 runFlow 的 meta 被当新轮重置出第二个运行时折叠。
  let lastAssistantRoundId: string | undefined;
  let resumePending = false;
  /** 运行时/重放同环容器：同 roundId 的 AI 段收进 .round-group，
   *  操作上移容器级 footer（复制整链/分叉/删除）；user 主输入在容器外，与 AI 作答单元分离 */
  let roundGroupEl: HTMLElement | null = null;

  // 当前 Provider 列表（由 chat_providers 消息填充）；limitTokens = 宿主经内核
  // resolveContextWindow 解析的上下文窗口上限（用户 per-LLM 配置值，未配置回落内核默认）
  interface ChatProviderItem {
    name: string;
    displayName: string;
    contextWindow?: number;
    limitTokens: number;
    /** 该 Provider 是否声明视觉能力（宿主 DTO supportsVision 的投影，Q3 上传按钮置灰判据） */
    vision?: boolean;
  }
  let currentProviders: ChatProviderItem[] = [];
  let currentActive: string | undefined;
  /** 激活 Provider 查找单点（find 模式第 4 处收口：模型名 / 置灰态 / IMG-8 预检共用） */
  function findActiveProvider(): ChatProviderItem | undefined {
    return currentProviders.find((p) => p.name === currentActive);
  }

  // 计划常驻条（任务看板，单轨呈现）：渲染、缓存与开合态收口于 planBarView
  // （HOST-SPLIT-1 chatView 首刀）。三条设计约束（≥3 常驻门槛与内核判定无关 / 缓存保持
  // 「最近一次非空 plan」/ 浮层懒构建）随域迁移至该模块头，此处不再重述。
  // ⚠️ `#planBar` 是 `#messages` 的**同级**节点，不得插进滚动容器内部（一滚即滚出视野）。
  // 数据源仍为 plan_update 协议消息（webview 只消费不写，零新增协议字段）。
  const planBar = createPlanBarView({ document });
  // 过程流单元格与记忆命中块（CHATVIEW-SLIM-2 第 5 刀）：零状态 DOM 构造，deps 注入
  const memoryHitsBlock = createMemoryHitsBlock({ document, vscode });
  const cells = createProcessFlowCells({ document, memoryHits: memoryHitsBlock });
  // 下拉选择器与问答回顾行（CHATVIEW-SLIM-3 首刀）：零状态 DOM 构造，deps 注入
  const pickerView = createPickerView({ document });
  const qaRowView = createQaRowView({ document });
  // 角色徽章行（CHATVIEW-SLIM-3 第三刀）：零状态 DOM 构造，deps 注入两个徽章节点
  const roleBadgeView = createRoleBadgeView({ document, roleBadge, capabilityBadge });
  // 空状态呈现域（空态外置）：开关 / 角色化文案 / 示例 chips / 未配置模型引导
  const emptyStateView = createEmptyStateView({
    document,
    emptyState,
    emptyTitle,
    emptyHint,
    emptySuggestions,
    messages,
    postMessage: (msg) => vscode.postMessage(msg as WebviewToExtensionMessage),
  });

  // StatusDock 挂载条域容器（待发送 / 文件改动 / 后台任务三条件，第 6 刀外置，见 statusBarsView.ts）
  const statusBars = createStatusBarsView({
    document,
    inputBar,
    setDockActive,
    registerDockEntry,
    appendInteractiveInput,
    postMessage: (msg) => vscode.postMessage(msg as WebviewToExtensionMessage),
  });

  // 当前角色包列表（由 chat_role_packs 消息填充；description 供空状态提示副文案）。
  // 角色切换在独立「角色」视图，本面板仅消费角色名用于展示，不承载切换。
  let currentRolePacks: { name: string; displayName: string; description?: string }[] = [];

  // ─── 过程事件（ProcessEvent）渲染（单形态）──────────────
  // 渲染真理源 = 当前轮 events[]（currentEvents）：运行时 process_event 增量与重放
  // turn_update（replay:true）RoundView.processEvents 整批都汇入同一数组，由 renderRoundBlock
  // 统一渲染（SSOT：无第二套卡片 DOM）。
  // round-block 挂在本轮首个 assistant 块上（插话产生的后续同 roundId 块不挂）。

  /** 本轮过程事件缓冲（渲染唯一真相源，运行时与重放同源） */
  let currentEvents: ProcessEvent[] = [];
  /**
   * 实时任务项状态累加（webview 侧运行态真源）：plan_item_boundary 置 active /
   * plan_update 与 plan_snapshot 全量重建。renderProcessFlow 增量刷新尾部统一投影——
   * 调和两个时序问题：① 组由内容事件（narrate/tool）触发创建，boundary 先到时组尚未建，
   * 「到达瞬间置图标」会丢；② plan_update 宣告 done 后，后续内容事件若「从事件序推导」
   * 会把绿勾抹回 active。finalize 后由 renderRoundBlock 的 planItemStatesFromEvents
   * 接管（事件序推导，语义与实时累加同源）。新轮 meta 重建时清空（与 currentEvents 同点）。
   */
  let livePlanStates = new Map<string, string>();
  /** 本轮身份（meta 事件写入）：该轮 AI 消息挂的角色/模型标签（与会话级 chat_role_pack 分离） */
  let currentRoundMeta: { role: string; llm: string } | undefined;
  /** 当前轮 round-block 容器（挂在本轮首个 assistant 块；null = 正文块尚未创建） */
  let roundBlockEl: HTMLDetailsElement | null = null;
  /** round-block 已挂载的 assistant 块（重放去重判定：roundId 首次出现才挂） */
  let roundBlockHostEl: HTMLElement | null = null;

  /**
   * 本轮记忆命中·**按调用分组**（MEM-EVENT-2 落位收口）：toolCallId → (记忆 id → 命中项)。
   *
   * 归属判据单一真源 = 内核 memoryRecalled.toolCallId（源自 tool_call 唯一 ID），宿主不猜、
   * 不按 query 文本或行序配对。一块 = 一次 search_memories 调用，块内按 id 去重（同一次
   * 调用里重复命中同一记忆只列一次）；跨调用不去重（各调用各自的事实，不互相吞并）。
   * 消费面两处共用同一模型：① 实时 `toolRowView.attachMemoryHits` 增量挂载；
   * ② finalize/中断重建时 `renderToolRow` 经 resolver 回填（DOM 全量重建后明细不丢）。
   * 实时专属：重放轨（processEvents）无此事件 ⇒ 重放历史轮不渲染（诚实降级，本次迁移不变）。
   * 新轮 meta / 复位清空（与 currentEvents 同点）；已成轮的明细随该轮 DOM 固定。
   */
  const currentMemoryHitsByCall = new Map<string, Map<string, MemoryHitEntry>>();
  /**
   * 本轮记忆命中·**无配对对象的兜底聚合**（id → 命中项）：一轮合并为一行「本轮参考了 N 条记忆」。
   *
   * 仅在「无 toolCallId（老内核 / 直调）」或「配对目标工具行尚未在 DOM」时承接数据——
   * 宁可退回旧落位也不丢信息（不带伤）。有配对键且行就绪的数据**不进这里**，避免同一批
   * 命中同时出现在工具块和轮次行两处（双写 = 用户看到重复）。
   */
  const currentMemoryHits = new Map<string, MemoryHitEntry>(); // Map 原地清空（clear），引用不换
  /** 兜底命中行 DOM 引用（聚合更新复用同一元素，防重复插入） */
  let memoryHitsEl: HTMLDetailsElement | null = null;
  /** 运行时过程平铺容器：运行时**无 round-block 大折叠壳**——
   *  过程（narrate 冒号行 / 工具折叠行 / 思考状态）按任务项时序平铺此容器（挂 label 与
   *  body 之间，透明无边框）；done/interrupted 时 finalize 全量重建 round-block 并移除本容器。
   *  任务表例外：有 plan_item_boundary 时，平铺内容归入对应「任务项 N · 标题」折叠块（任务收纳）。 */
  let flowEl: HTMLElement | null = null;
  /** 流式骨架块（TTFT 前即时反馈，吸收 Claude Code #81659 / 骨架屏最佳实践）
   *
   * meta 到达即创建「AI 回复骨架」：标签（角色·模型）+ round-block 运行状态，
   * 首 token 到达前用户即可见「谁在回答 + 正在做什么」；首个 text chunk 复用此块，
   * 不新建第二条消息（正文流入同一块）。
   */
  let flowShellEl: HTMLElement | null = null;
  // 一键到底按钮：用户上滚阅读时浮现，点击回到底部
  const scrollToBottomBtn = document.getElementById('scrollToBottomBtn') as HTMLButtonElement;
  // 会话大纲导航条（HOST-NAV-1）：右缘按轮锚点（外壳 #roundNav 静态骨架，条列动态构建）。
  // sync/refresh 的挂点在下方 MutationObserver rAF 拍子与 scroll 监听——与吸底同一通道同一节拍
  const roundNavController = createRoundNav(
    messages,
    document.getElementById('roundNav') as HTMLElement,
  );
  // 工具行动作面（定位 / 注销预告行 / 记忆命中挂载）：只读消费 currentMemoryHitsByCall
  const toolRow = createToolRowView({
    messages,
    memoryHits: memoryHitsBlock,
    memoryHitsByCall: currentMemoryHitsByCall,
  });
  // 消息区滚动监听：更新吸底状态 + 一键到底按钮显隐 + 大纲条当前轮高亮
  messages.addEventListener('scroll', () => {
    const atBottom = trackScroll(messages);
    scrollToBottomBtn.hidden = atBottom;
    roundNavController.refresh();
  });
  // 内容高度变更自动吸底：MutationObserver 统一订阅消息区任意高度变更（展开/收起折叠块、
  // 工具流式增删、长气泡展开、中断轮重建……），rAF 去抖后 delegate 到 followIfPinned——
  // 闭合「高度变化不派发 scroll 事件 → 吸底标记与实际位置脱节」整类缺口，逻辑仍收口于
  // helpers/scrollToBottom.ts（SSOT），此处只做接线（不复制吸底逻辑、不碰 DOM 模板）。
  // 大纲条全量重建挂同一拍子（HOST-NAV-1）：结构变更（轮次增删）后重建条列——
  // 与渲染同源（不在各渲染路径埋点），签名比对防流式期每帧重建（roundNav.ts 内部裁决）。
  let followRaf = 0;
  function scheduleFollow(): void {
    if (followRaf) return;
    const win = messages.ownerDocument.defaultView;
    if (!win) return;
    followRaf = win.requestAnimationFrame(() => {
      followRaf = 0;
      scrollToBottomBtn.hidden = followIfPinned(messages);
      roundNavController.sync();
    });
  }
  const followObserver = new MutationObserver(scheduleFollow);
  followObserver.observe(messages, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'class', 'style', 'hidden'],
  });
  // 一键到底点击：滚到底 + 按实际结果重算吸底标记并据此显隐按钮。
  // 滚动实现收口于 helpers/scrollToBottom.ts 的 jumpToBottom（SSOT）——此处不裸写
  // scrollTop、不复制吸底逻辑。语义要点（勿改回裸写）：不预设 sticky，按滚动后的实际
  // 几何重算；显式调用点保证不依赖「scrollTop 变化会派发 scroll 事件」这一不确定行为。
  scrollToBottomBtn.addEventListener('click', () => {
    scrollToBottomBtn.hidden = jumpToBottom(messages);
  });
  // 日期分隔线：跨天合并视图在日期交界插入分组
  let lastShownDate: string | undefined;

  /**
   * 创建流式骨架块（meta 到达即调用，TTFT 前即时反馈）
   *
   * 骨架 = 空正文的 assistant 块（label 已用本轮身份 currentRoundMeta）+ round-block（运行状态）。
   * 首个 text chunk 到达时由正文流复用此块，不新建第二条消息（见 chunk 分支）。
   */
  function prepareFlowShell(opts?: { mountAfter?: HTMLElement }): void {
    // 清理异常路径可能残留的旧骨架（正常路径下 meta 每次新轮都会先清除引用）
    flowShellEl?.remove();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    // 身份标签直连角色名——运行时补充/问答有独立交互条目行分隔，不存在同轮多段，
    // 骨架空转至 done 时即为普通轮（无续接视觉残留，运行时形态与重放一致）。
    // 流式未完成：容器底栏以 is-pending 隐藏（建栏时传 pending=true），定稿后由
    // settleRoundFooter 显形。骨架此刻无 roundId（meta 不带），roundId 由首个 chunk
    // 到达时回填（dataset + 归位判定）
    buildAssistantShell(div, new Date().toISOString());
    activeAssistantEl = div;
    streamBodyRendered = false;
    // 挂载点：交互续跑插到交互行之后（保持 [块A]→[问/答]→[块B] 顺序）；新轮骨架落消息流尾
    if (opts?.mountAfter?.parentNode) opts.mountAfter.after(div);
    else messages.appendChild(div);
    flowShellEl = div;
    // 挂载运行时过程平铺容器（meta 已在 currentEvents 首条）：过程按任务项时序平铺（无大折叠壳）
    renderProcessFlow(currentEvents);
    // 骨架期暂存条目迁移：骨架建立（flowEl 就绪）后，把 meta 前补充/回答
    // 的 fallback 条目从消息流尾归位进过程容器（按 ts 重排序），消除「补充选项卡贴输入框下方」错位
    flushSkeletonPendingItems();
    scrollToBottom(messages);
    emptyStateView.update();
  }

  /**
   * 确保当前轮**过程平铺容器**存在（运行时）
   *
   * 常规挂载规则与 ensureRoundBlock 同源（label 之后、正文 body 之前——「过程在上 · 报告在下」），
   * 挂在当前 assistant 块（activeAssistantEl）上。`orphan` 模式：当前仅服务 `tool_pending` 兜底
   * （renderPendingToolRow——运行时平铺容器恰缺时把「准备中」行挂消息流尾，防丢预告；
   * 重放中断轮不走孤儿平铺，走孤儿折叠宿主 renderInterruptedRound）。
   *
   * @param opts.orphan 是否以孤儿模式挂载（无 assistant host 时挂消息流尾）
   * @param opts.roundId 所属轮 ID（孤儿模式记录 data-round-id，防跨轮串扰；常规模式非必需）
   * @returns 平铺容器（无 host 且非孤儿、或无过程事件时返回 null）
   */
  function ensureProcessFlow(opts?: { orphan?: boolean; roundId?: string }): HTMLElement | null {
    if (flowEl && flowEl.isConnected) return flowEl;
    const host = activeAssistantEl;
    const orphan = !!opts?.orphan;
    if ((!host && !orphan) || currentEvents.length === 0) return null;
    // 既有容器（含随骨架壳拆离而游离的）重挂复用：行身份与用户展开态随容器存活；
    // 整树重建会把已展开的折叠块归零收起。复用恒属同一 turn——新轮/清空路径已显式
    // `flowEl = null`（resetForNewClosedLoop / resetChatView / finalizeRound）。
    const flow = flowEl ?? document.createElement('div');
    flow.className = 'process-flow';
    if (!host) {
      // 孤儿模式：本轮无 assistant 块 → 平铺容器挂消息流尾 + 记录所属轮（防跨轮串扰）
      if (opts?.roundId) flow.dataset.roundId = opts.roundId;
      messages.appendChild(flow);
      flowEl = flow;
      return flow;
    }
    // 常规：插入点 .msg-ai-label 之后、.msg-body（报告正文）之前
    const label = host.querySelector(':scope > .msg-ai-label');
    const msgBody = host.querySelector(':scope > .msg-body');
    if (msgBody) {
      host.insertBefore(flow, msgBody);
    } else if (label) {
      label.after(flow);
    } else {
      host.prepend(flow);
    }
    flowEl = flow;
    return flow;
  }

  /**
   * 确保当前轮 round-block（任务过程折叠区）容器存在并挂在本轮首个 assistant 块上
   *
   * 挂载规则（插话场景）：同一 roundId 可能对应多个 assistant 块（生成中插话），
   * round-block 只挂首个——roundBlockHostEl 记录已挂载宿主，host 变更（新轮次）才重建。
   * 挂载位置：身份标签之后、报告正文（.msg-body）之前——任务过程在上、报告在下。
   *
   * @returns 存在则返回 round-block 容器；正文块未创建（meta 已到）时返回 null
   */
  function ensureRoundBlock(): HTMLDetailsElement | null {
    if (roundBlockEl && roundBlockEl.isConnected) return roundBlockEl;
    const host = activeAssistantEl;
    // 无过程事件（纯问答轮 / 无 processEvents 的老数据）不产生空块；无助手块也暂不挂载
    if (!host || roundBlockHostEl === host || currentEvents.length === 0) return null;
    // 移除旧的（如上一轮残留），再挂到当前 assistant 块标签之后、正文之前
    roundBlockEl?.remove();
    const rb = document.createElement('details');
    rb.className = 'round-block';
    rb.open = false;
    const summary = document.createElement('summary');
    summary.className = 'round-block__summary';
    rb.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'round-block__details';
    rb.appendChild(body);
    // 挂载点：报告正文（.msg-body）之前——「过程在上 · 报告在下」，锚点语义详见 insertBeforeBody
    insertBeforeBody(host, rb);
    roundBlockEl = rb;
    roundBlockHostEl = host;
    return rb;
  }

  /**
   * 工具意图预告行：LLM 流式生成 tool_call 参数期间提前渲染的「准备中」行。
   *
   * 与 renderToolRow 同构（summary = 工具名 + 状态），但参数未成形——无叙述生成、无 seq：
   * append 到 process-flow 流尾（流式期间"新的在最下"语义正确，finalize/重放全量重建时
   * 天然消失，不落盘不占 seq）。tool_start 到达后经 renderProcessFlow 升级路径转执行态。
   *
   * @param pending 工具意图预告消息（toolCallId 可能为空串——provider 未发 id 的降级）
   */
  function renderPendingToolRow(
    pending: Extract<ExtensionToWebviewMessage, { type: 'tool_pending' }>,
  ): void {
    const flow = ensureProcessFlow({ orphan: true, roundId: pending.roundId ?? undefined });
    if (!flow) return;
    // 幂等：同工具已渲染（含升级后的正式行）不重复创建；无 id（降级）时按 name 去重
    const selector = pending.toolCallId
      ? `.round-block__tool[data-tool-call-id="${pending.toolCallId}"]`
      : `.round-block__tool[data-tool-pending-name="${pending.name}"]`;
    if (flow.querySelector(selector)) return;
    const row = document.createElement('details');
    row.className = 'round-block__tool is-tool-pending';
    if (pending.toolCallId) row.dataset.toolCallId = pending.toolCallId;
    else row.dataset.toolPendingName = pending.name;
    row.open = true; // 准备中默认展开——让「正在准备工具」直接可见
    const summary = document.createElement('summary');
    summary.className = 'round-block__tool-name';
    // 工具类型标：与 renderToolRow 同构（升级转执行态不重建 DOM，icon 随行保留）
    const iconSpan = document.createElement('span');
    iconSpan.className = 'round-block__type-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = getIconSvg('tool', 12, 12); // 静态 SVG，无外部输入
    const labelSpan = document.createElement('span');
    labelSpan.className = 'round-block__tool-label';
    // 参数未成形，无法生成行动叙述 → 直显中文显示名（与 toolActionLabel 兜底同源：toolNameMap）
    labelSpan.textContent = getToolDisplayName(pending.name);
    const statusSpan = document.createElement('span');
    statusSpan.className = 'round-block__tool-status';
    statusSpan.textContent = ' (准备中)';
    summary.append(iconSpan, labelSpan, statusSpan);
    row.appendChild(summary);
    flow.appendChild(row);
  }

  /**
   * 渲染当前轮 round-block（任务过程折叠区）——过程事件唯一投影，运行时与重放共用。
   *
   * SSOT 单一容器：思考相位 + 工具调用 + 召回/已沉淀/自审查/执行指标全部收敛于此，
   * 报告正文（.msg-body）保持干净连续不被工具切碎。
   * - 进行中（finalize=false）：折叠区自动展开，实时相位行 + 工具行增量追加（任务过程实时可见）
   * - 完成（finalize=true）：折叠区自动收起，只留摘要（工具×N · 耗时），全量小节供展开查阅
   *
   * 形态甲：finalize 全量重建从**合并流**渲染——processEvents 行 + 运行时输入
   * 条目（interactiveInputs）按统一时间键（ts）归位到对应任务项分组；运行时输入不搬家、
   * 不追加末尾，位置唯一确定（修复「QA 位置飘忽」根因）。
   *
   * @param events    当前轮全部过程事件
   * @param finalize  是否为本轮收尾
   * @param interactiveInputs 运行时输入缓存（finalize 传；重放路径 QA 经 appendInteractiveInput
   *                          增量插入 round-block，不重复渲染）
   * @param evidence  本轮裁决证据（重放路径传 RoundView.evidence；运行时收场经 done 消息透传；
   *                  web_search 归因与 memory_hits 明细两条证据面都从它取。证据轮末才落盘）
   * @param liveMemoryHits 实时命中模型（仅 `finalizeRound` 传 currentMemoryHitsByCall）：
   *                  比证据**更新**（含本轮删除反馈），故优先于证据；重放/中断重建不传，
   *                  由 evidence 的 memory_hits 变体独立供数（MEM-EVENT-3）。
   * @param interrupted 中断轮置真——该轮正文随中断丢弃，过程收起后屏上只剩折叠条、内容零可见。
   *                    展开态因此从「是否收场」补一条「有无正文兜底」（见下方 rb.open 单点）。
   *                    交互行容器**不**随之分叉：恒在详情区，与完成轮同构（单一容器）。
   */
  function renderRoundBlock(
    events: ProcessEvent[],
    finalize: boolean,
    interactiveInputs?: RuntimeInteractiveInput[],
    evidence?: RoundView['evidence'],
    liveMemoryHits?: Map<string, Map<string, MemoryHitEntry>>,
    interrupted = false,
  ): void {
    // 每次重建都现建解析器（闭包持消费游标）：同一轮多次重放各自从头消费，结果确定不累积
    const resolveSearchEvidence = buildSearchEvidenceResolver(evidence);
    // 命中明细两条源：实时模型（收场时最新）> 证据副本（重放唯一源）。同源同键（toolCallId），
    // 一份渲染——不按来源分叉出两种形态（`??` 是唯一裁决点，勿在别处再判一次）。
    const byEvidence = buildMemoryHitsEvidenceResolver(evidence);
    const resolveMemoryHits = (toolCallId: string): Map<string, MemoryHitEntry> | undefined =>
      liveMemoryHits?.get(toolCallId) ?? byEvidence.get(toolCallId);
    const rb = ensureRoundBlock();
    if (!rb) return; // 正文块未创建（meta 先到）：挂载推迟到正文块出现时再补一次（beginStreaming）
    // summary：统计摘要（计数 + 耗时）
    const summary = rb.querySelector('.round-block__summary') as HTMLElement;
    if (summary) {
      // 重置前先清掉旧 stats span 的 baseStats 缓存（textContent 清空会移除子节点，
      // 残留 dataset 会让 refresh 拼接旧基准——每次重建重设一半，幂等）
      const oldStats = summary.querySelector<HTMLElement>('.round-block__stats');
      if (oldStats) delete oldStats.dataset.baseStats;
      summary.textContent = '';
      const dot = document.createElement('span');
      dot.className = 'round-block__dot';
      dot.setAttribute('aria-hidden', 'true');
      summary.appendChild(dot);
      const reviews = countReviews(events);
      const parts: string[] = [];
      // 工具叙述句（唯一形成点 toolSummaryText，与工具批标题同源）：按工具显示名小计，
      // 收起态也能看懂"它做了什么"；不可辨识的工具不进句，仅计入总数
      const toolSentence = toolSummaryText(toolStartNames(events));
      if (toolSentence) parts.push(toolSentence);
      if (reviews > 0) parts.push(`审查 ${reviews} 次`);
      const metrics = events.find(
        (e): e is Extract<ProcessEvent, { type: 'metrics' }> => e.type === 'metrics',
      );
      if (metrics) parts.unshift(`耗时 ${fmtDuration(metrics.payload.durationMs)}`);
      const label = document.createElement('span');
      label.className = 'round-block__stats';
      label.textContent = parts.length > 0 ? parts.join(' · ') : '任务过程';
      summary.appendChild(label);
      rb.classList.toggle('is-running', !finalize);
    }
    // round-block 任务项标签——如果有 active 任务项，在 summary 上方显示"📍 执行任务项 N: xxx"
    // 从计划栏只读快照读（plan_update 消息写入缓存，零新增协议）；每次重建保证始终正确
    const existingTag = rb.querySelector(':scope .round-block__plan-tag') as HTMLElement | null;
    const planItems = planBar.getItems();
    if (planItems.length > 0) {
      const activePlanItem = planItems.find((s) => s.status === 'active');
      if (activePlanItem) {
        const brief =
          activePlanItem.description.length > 36
            ? `${activePlanItem.description.slice(0, 36)}…`
            : activePlanItem.description;
        const tagText = `执行任务项 ${activePlanItem.order + 1}: ${brief}`;
        if (existingTag) {
          // 只改文本节点：图标节点保持稳定，且 brief 源自 LLM → 必须走 textContent（防注入）
          const textEl = existingTag.querySelector('.round-block__plan-tag__text');
          if (textEl) textEl.textContent = tagText;
        } else {
          const tag = document.createElement('div');
          tag.className = 'round-block__plan-tag';
          const tagIcon = document.createElement('span');
          tagIcon.className = 'round-block__plan-tag__icon';
          tagIcon.setAttribute('aria-hidden', 'true');
          tagIcon.innerHTML = getIconSvg('target', 11, 11); // 静态 SVG，无外部输入
          tag.appendChild(tagIcon);
          const tagLabel = document.createElement('span');
          tagLabel.className = 'round-block__plan-tag__text';
          tagLabel.textContent = tagText;
          tag.appendChild(tagLabel);
          rb.prepend(tag);
        }
      } else if (existingTag) {
        // 无 active 任务项（全部 done 或 pending）→ 移除标签
        existingTag.remove();
      }
    } else if (existingTag) {
      // 计划缓存为空 → 移除旧标签
      existingTag.remove();
    }
    // 展开态三态判据（本处为唯一裁决点）：
    //   进行中 → 展开（任务过程实时可见）
    //   完成   → 收起（只留摘要，报告干净）
    //   中断   → 展开（正文随中断丢弃，收起后该轮内容零可见；交互行也在详情区内）
    rb.open = !finalize || interrupted;
    const details = rb.querySelector('.round-block__details') as HTMLElement;
    if (!details) return;
    // renderRoundBlock 仅 finalize（done/interrupted/重放）调用，
    // 运行时交由 renderProcessFlow（process-flow 平铺）承载。
    // ── 完成（finalize=true）：全量渲染所有小节（展开供查阅） ──
    // 实时相位行是进行中专属（details 直接子元素，非小节），收尾先移除
    details.querySelector('.round-block__phase')?.remove();
    // 全量重建前清理增量产物：section（轨迹/召回等）、narrate、tool、thought、任务项容器等增量元素，避免重复渲染。
    // 形态甲：运行时输入条目**快照保留**（重放 seg 消息触发的重建跨轮保留已插入 QA，
    // 重建后按 ts 重插归位——否则任务项分组清理会连根拔起 QA 致重放丢失）。
    const existingInputs = Array.from(details.querySelectorAll<HTMLElement>('.round-block__input'));
    details
      .querySelectorAll(
        '.round-block__section, .round-block__narrate, .round-block__tool, .round-block__tool-batch, .round-block__thought, .round-block__plan-item',
      )
      .forEach((el) => el.remove());
    // § 过程叙述 + 工具调用（扁平化：narrate 与 tool 按 seq 平铺；有 plan_item_boundary 时归入任务项折叠块）
    const narrates = events
      .filter((e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate')
      .sort((a, b) => a.seq - b.seq);
    for (const n of narrates) {
      const { host } = cells.planItemContainerFor(details, events, n.ts, n.seq);
      insertPlanItemInOrder(host, cells.createNarrateRow(n), n.ts);
    }
    // § 工具批（toolBatch）：相邻连续工具合并为批块——分组判据单一真源 groupToolBatches
    // （三渲染上下文共用：此处 finalize 重建 / renderProcessFlow 流式 / pending 行升级，禁内联三份）。
    // 单工具批 = 行即批（data-tool-batch 挂行、不包裹）——视觉等价现状、零回归；
    // 多工具批 = 批块（块标题 = 轮收尾摘要同款工具叙述句），失败/被拒留段内、块级标红（口径②）。
    // 断面 ts 取「已在 DOM 的快照条目 + 本次待插的 interactiveInputs」（BATCH-SPLIT-1：卡片须切开前后两段工具）
    const batches = groupToolBatches(
      events,
      visibleInputTs(
        details,
        (interactiveInputs ?? []).map((q) => q.ts),
      ),
    );
    for (const batch of batches) {
      const multi = batch.entries.length > 1;
      // 归组定位与逐条插入同锚（段内首个 tool_start 的 ts/seq）——批块不越任务项边界
      const { host } = cells.planItemContainerFor(details, events, batch.anchorTs, batch.segId);
      if (!multi) {
        const row = cells.renderToolRow(
          batch.entries[0]!.start,
          events,
          resolveSearchEvidence,
          resolveMemoryHits,
        );
        // 行即批：批容器 key（段 id）挂行自身（口径③：批 key = 段 id，非 toolCallId）
        row.dataset.toolBatch = String(batch.segId);
        insertPlanItemInOrder(host, row, batch.anchorTs);
        continue;
      }
      const block = cells.createToolBatchBlock(batch, false);
      const body = block.querySelector('.round-block__tool-batch-body') as HTMLElement;
      for (const entry of batch.entries)
        body.appendChild(
          cells.renderToolRow(entry.start, events, resolveSearchEvidence, resolveMemoryHits),
        );
      insertPlanItemInOrder(host, block, batch.anchorTs);
    }
    // § 思考（per-step 聚合折叠块）：**一个 step 一个折叠块**（同 step 碎片原样连续拼接，
    // 不同 step 各自独立），按各自最早 seq 与 narrate/tool 平铺（finalize 默认收起）；
    // 有任务表时随 anchor 归入任务项分组（边界切组语义不变）。
    const thoughtBuckets = groupThoughtBuckets(events);
    for (const b of thoughtBuckets) {
      const { host } = cells.planItemContainerFor(details, events, b.anchorTs, b.anchorSeq);
      insertPlanItemInOrder(
        host,
        cells.createAggregatedThought(
          b.items.map((i) => i.content),
          false,
          b.anchorTs,
          b.anchorSeq,
          thoughtLabel(b.stepIndex),
        ),
        b.anchorTs,
      );
    }
    // § 运行时输入（形态甲）：跨重建快照条目 + finalize 合并流条目统一按时间键归位任务项分组
    //   （不搬家不追尾）；去重按身份键（qaDedupKey）——按 ts 单键会丢同批第 2..N 条。
    const renderedInputTs = new Set<string>();
    for (const el of existingInputs) {
      const tsKey = el.dataset.ts ?? '';
      const key = qaDedupKey(el.dataset.inputId, tsKey);
      if (!tsKey || renderedInputTs.has(key)) continue;
      renderedInputTs.add(key);
      const { host } = cells.planItemContainerFor(details, events, tsKey);
      insertPlanItemInOrder(host, el, tsKey);
    }
    for (const qa of interactiveInputs ?? []) {
      const tsKey = qa.ts ?? '';
      const key = qaDedupKey(qa.id, tsKey);
      if (!tsKey || renderedInputTs.has(key)) continue;
      renderedInputTs.add(key);
      const item = qaRowView.renderQaItem(qa.text, qa.kind, qa.question, qa.options);
      item.dataset.ts = tsKey;
      if (qa.id) item.dataset.inputId = qa.id;
      const { host } = cells.planItemContainerFor(details, events, tsKey);
      insertPlanItemInOrder(host, item, tsKey);
    }
    // § 过程轨迹（thinking 阶段：聚合计数，去噪——同一相位 N 条 thinking 事件
    //  压缩为一行「相位 ×N」，避免「调用模型中…」重复 12 次平铺成视觉噪点；保序：按首次出现序）
    const thinking = events.filter(
      (e): e is Extract<ProcessEvent, { type: 'thinking' }> => e.type === 'thinking',
    );
    if (thinking.length > 0) {
      const { listEl } = cells.sectionOf(details, '过程轨迹');
      const labelCount = new Map<string, number>();
      const order: string[] = [];
      for (const e of thinking) {
        const label = phaseLabel(e.payload.phase);
        if (!labelCount.has(label)) {
          labelCount.set(label, 0);
          order.push(label);
        }
        labelCount.set(label, labelCount.get(label)! + 1);
      }
      for (const label of order) {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        // 计数 > 1 显示「×N」；计数 1 省略（单次相位直接显名，不赘 ×1）
        row.textContent = labelCount.get(label)! > 1 ? `${label} ×${labelCount.get(label)}` : label;
        listEl.appendChild(row);
      }
    }
    // § 已沉淀 (N)
    const added = events.filter(
      (e): e is Extract<ProcessEvent, { type: 'memory_added' }> => e.type === 'memory_added',
    );
    if (added.length > 0) {
      const { listEl } = cells.sectionOf(details, '已沉淀');
      added.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = e.payload.name || e.payload.id;
        listEl.appendChild(row);
      });
    }
    // 后台任务收尾（后台任务跨轮存活方案·定案修订）：内核 turn 终态**脱管**（存活任务转后台常驻、
    // 进程不被杀）后产（无存活后台任务则无此事件、小节不出现——纯问答常态零块）。与 plan_snapshot
    // 同型：实时仅入缓冲，finalize/重放在此单点消费（实时/重放同源，规避「实时建行 → finalize
    // 重建删行」的双形态维护）。⚠️ 小节标题**不得**写「收割」——脱管定案下进程并未被杀，沿用旧标题会当着用户的面说反话（真机 2026-10-04 用户截图即此症状）。
    const bgReports = events.filter(
      (e): e is Extract<ProcessEvent, { type: 'background_report' }> =>
        e.type === 'background_report',
    );
    if (bgReports.length > 0) {
      const { listEl } = cells.sectionOf(details, '后台任务收尾');
      for (const rep of bgReports) {
        // 多行报告按 \n 拆行渲染（textContent 防注入；格式化单点在内核，宿主零猜测）
        for (const line of rep.payload.content.split('\n')) {
          const row = document.createElement('div');
          row.className = 'round-block__row';
          row.textContent = line;
          listEl.appendChild(row);
        }
      }
    }
    // § 自审查输出
    const reviews = events.filter(
      (e): e is Extract<ProcessEvent, { type: 'self_review' }> => e.type === 'self_review',
    );
    const reviewTexts = events.filter(
      (e): e is Extract<ProcessEvent, { type: 'text_self_review' }> =>
        e.type === 'text_self_review',
    );
    if (reviews.length > 0 || reviewTexts.length > 0) {
      const { listEl } = cells.sectionOf(details, '自审查输出');
      reviews.forEach((_e) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = '自审查终审';
        listEl.appendChild(row);
      });
      reviewTexts.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = e.payload.content;
        listEl.appendChild(row);
      });
    }
    // § 已停止（aborted 标记）
    const aborted = events.find(
      (e): e is Extract<ProcessEvent, { type: 'aborted' }> => e.type === 'aborted',
    );
    if (aborted) {
      const { listEl } = cells.sectionOf(details, '已停止');
      const row = document.createElement('div');
      row.className = 'round-block__row';
      // TS-12b：stopReason 语义映射（与 error.category→友好文案同构）——不把「如何结束」写死成
      // 用户取消；无 stopReason（旧数据）回退 reason 原文
      row.textContent = stopReasonLabel(aborted.payload);
      listEl.appendChild(row);
    }
    // § 执行指标（metrics 事件）
    const metrics = events.find(
      (e): e is Extract<ProcessEvent, { type: 'metrics' }> => e.type === 'metrics',
    );
    if (metrics) {
      const { listEl } = cells.sectionOf(details, '执行指标');
      // 未解析文本工具意图：>0 表示「想调用工具却未走原生协议」，
      // 不得显示为成功收尾——与 success 判据（流程跑完）正交，这是新增的诚实信号。
      const unparsed = metrics.payload.unparsedToolIntentCount ?? 0;
      // 空响应兜底：>0 表示末段正文是兜底文案而非模型产出——同族诚实信号
      const emptyResp = metrics.payload.emptyResponseCount ?? 0;
      // 截断救回：>0 表示本轮曾截断但被换策略重试救回——观测信号（正文是真实产出，不参与否决）
      const truncRecover = metrics.payload.truncationRecoveryCount ?? 0;
      const finalSuccess = metrics.payload.success && unparsed === 0 && emptyResp === 0;
      // meta 事件携带本轮**生效**输出上限（内核 buildChatOptions 裁决后的值；取证面不重算）
      const roundMeta = events.find(
        (e): e is Extract<ProcessEvent, { type: 'meta' }> => e.type === 'meta',
      );
      // undefined = 请求未传 max_tokens，回服务端默认（0-哨兵/未声明侧均落到此）
      const effectiveLimit = roundMeta?.payload.maxTokens;
      const lines = [
        `耗时：${fmtDuration(metrics.payload.durationMs)}`,
        // 口径须显式：入/出均为估算值；「入」是**本轮全部 LLM 调用输入的累加**（每次调用
        // 重发全量上下文，N 步即累加 N 次，故可远超单轮窗口——**不是**窗口占用率，
        // 勿据其判超窗）；「出」只计正文——不含思考与工具轮叙述，推理模型下远小于真实
        // 输出预算消耗（判压力看下行「输出上限」+ 截断重试救回）
        `Tokens（估算）：入 ${metrics.payload.tokenIn} 累计 / 正文 ${metrics.payload.tokenOut}（不含思考）`,
        // 生效上限直接亮给用户：配了面板却被角色包收紧时，这里与面板值不一致即可见
        `输出上限（生效）：${effectiveLimit ?? '服务端默认'}`,
        `工具失败：${metrics.payload.toolFailureCount} 次`,
        ...(unparsed > 0 ? [`未解析工具意图：${unparsed} 次`] : []),
        ...(emptyResp > 0 ? [`空响应兜底：${emptyResp} 次`] : []),
        ...(truncRecover > 0 ? [`截断重试救回：${truncRecover} 次`] : []),
        `完成：${finalSuccess ? '是' : '否（中断/失败）'}`,
      ];
      lines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = line;
        listEl.appendChild(row);
      });
    }
    // § 收起态摘要补 QA 计数（形态甲）：从合并流（快照 + interactiveInputs）统计——
    // 替代旧 refreshRoundBlockQaStats 的 DOM 扫描；stats span 已在函数开头重建，此处追加幂等。
    // 独立去重集合（不读 renderedInputTs——渲染循环已消费该集合，读它会误跳过本次计数）
    if (finalize) {
      const statsSpan = rb.querySelector('.round-block__stats');
      if (statsSpan) {
        const kindTag = (
          kind: 'question-answer' | 'supplement' | 'timeout' | 'unanswered',
        ): string | null =>
          kind === 'question-answer' ? '你答' : kind === 'supplement' ? '你补充' : '未回答';
        const qaCount = new Map<string, number>();
        const countedTs = new Set<string>();
        // 快照条目：tag 取内容行（.input-row .input-tag），避免误取「问」回顾行 tag
        for (const el of existingInputs) {
          const tag =
            el.querySelector<HTMLElement>('.round-block__input-row .round-block__input-tag')
              ?.textContent ?? '';
          if (!tag) continue;
          const elTs = el.dataset.ts ?? '';
          const key = qaDedupKey(el.dataset.inputId, elTs);
          if (elTs && countedTs.has(key)) continue;
          if (elTs) countedTs.add(key);
          qaCount.set(tag, (qaCount.get(tag) ?? 0) + 1);
        }
        // 合并流条目：按 kind 映射 tag（身份键去重，与渲染循环同源）
        for (const qa of interactiveInputs ?? []) {
          const tag = kindTag(qa.kind);
          const key = qaDedupKey(qa.id, qa.ts);
          if (!tag || !qa.ts || countedTs.has(key)) continue;
          countedTs.add(key);
          qaCount.set(tag, (qaCount.get(tag) ?? 0) + 1);
        }
        const qaParts: string[] = [];
        for (const [tag, n] of qaCount) qaParts.push(`${tag}×${n}`);
        if (qaParts.length > 0) {
          const base = statsSpan.textContent ?? '';
          statsSpan.textContent = base ? `${base} · ${qaParts.join(' · ')}` : qaParts.join(' · ');
        }
      }
    }
    // § 任务项状态（finalize/重放消费点）：从 plan_snapshot 快照建 map 应用状态图标。
    // 先补建组：组由 narrate/tool 消费 planItemContainerFor 时触发创建——boundary 之后
    // 无内容事件跟随的尾部任务项（真机实证：中断轮最后 boundary / 快照后新 boundary）
    // 组不存在，状态图标无处安放。与 renderProcessFlow 尾部建组循环同构（幂等，复用既有组）。
    const planBounds = events.filter(isPlanItemBoundaryEvent);
    for (const b of planBounds) cells.getOrCreatePlanItemGroup(details, b, planBounds);
    // 存量历史轮无快照 → planItemStatesFromEvents 无快照分支（最后 boundary 项 active，
    // 其余无图标——诚实降级，不伪造绿勾）。
    cells.applyPlanItemStates(details, planItemStatesFromEvents(events));
  }

  /**
   * 运行时过程平铺渲染：**无 round-block 大折叠壳**——
   * 过程事件按任务项时序平铺在 process-flow 容器里：
   *   narrate → 平铺文本行（结束补「：」——「AI 说什么：」后接工具块的叙述冒号形态）；
   *   tool  → 独立折叠行（复用 .round-block__tool 视觉，data-tool-call-id 去重）；
   *   thinking → 轻量状态行（phaseLabel，呼吸点，随最新相位更新）；
   *   任务表例外：有 plan_item_boundary 时 narrate/tool 归入「任务项 N · 标题」折叠块（offset：任务收纳）。
   * 增量幂等：data-seq / data-tool-call-id 去重防重复渲染；narrate 平铺行按 seq 有序插入。
   * finalize（done/interrupted）时不再调此函数：全量重建 round-block + flow 容器移除（见 finalizeRound
   * ——foldPendingQaIntoRoundBlock 只折 QA；narrate/tool 已由 renderRoundBlock finalize 分支全量承载，
   * 不物理搬运，仅删平铺容器，避免重复 DOM 与「折也不重插」的搬运成本）。
   */
  function renderProcessFlow(events: ProcessEvent[]): void {
    const flow = ensureProcessFlow();
    if (!flow) return;
    // 1) 轻量状态行：单条，优先级 = 进行中工具（「正在执行：xxx」行动叙述）> 最新 thinking 相位；
    //   （无则移除；TS-11 同构：工具执行中相位提供实时行动反馈，用户定案「显示」）
    const runningTool = findRunningTool(events);
    const thinking = [...events].reverse().find((e) => e.type === 'thinking') as
      Extract<ProcessEvent, { type: 'thinking' }> | undefined;
    let phaseRow = flow.querySelector<HTMLElement>('.process-flow__phase');
    if (runningTool) {
      if (!phaseRow) {
        phaseRow = document.createElement('div');
        phaseRow.className = 'process-flow__phase process-flow__phase--tool';
        flow.prepend(phaseRow);
      }
      phaseRow.classList.add('is-tool');
      phaseRow.textContent = `正在执行：${toolActionLabel(runningTool.payload.name, runningTool.payload.args)}`;
    } else if (thinking && thinking.payload.phase !== 'archiving') {
      if (!phaseRow) {
        phaseRow = document.createElement('div');
        phaseRow.className = 'process-flow__phase';
        flow.prepend(phaseRow);
      }
      phaseRow.classList.remove('is-tool');
      phaseRow.textContent = phaseLabel(thinking.payload.phase);
    } else {
      phaseRow?.remove();
    }
    // 2) narrate 平铺行 + 工具折叠行：按 seq 平铺（plan_item_boundary 时归入任务项折叠块，任务收纳例外）
    const narrates = events
      .filter((e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate')
      .sort((a, b) => a.seq - b.seq);
    for (const n of narrates) {
      if (flow.querySelector(`.process-flow__narrate[data-seq="${n.seq}"]`)) continue;
      const row = document.createElement('div');
      row.className = 'process-flow__narrate';
      row.dataset.seq = String(n.seq);
      row.dataset.ts = n.ts; // 时间键（统一排序）
      // 叙述冒号：结尾无标点时补「：」（用户定案「AI 说什么：」后接工具块）——文本防注入
      const text = n.payload.content.trim();
      row.textContent = /[:：。!！?？；;]$/.test(text) ? text : `${text}：`;
      // 任务表例外：有 plan_item_boundary 归入任务项折叠块（复用 getOrCreatePlanItemGroup 容器）
      const { host } = cells.planItemContainerFor(flow, events, n.ts, n.seq);
      insertPlanItemInOrder(host, row, n.ts);
    }
    // 2.5) thought 思考折叠（per-step 聚合）：**一个 step 一个折叠块**（同步内碎片原样连续
    //   拼接，不同 step 各自独立）；每个块维护自己 data-merged-seq 防重复拼接。
    const thoughtBuckets = groupThoughtBuckets(events);
    for (const b of thoughtBuckets) {
      // 复用任务项容器定位 → 与最终分桶位置一致，流式与 finalize 不偏移
      const { host } = cells.planItemContainerFor(flow, events, b.anchorTs, b.anchorSeq);
      // 查找或创建本 step 的折叠块（key = stepIndex 字符串，无归属为 'root'）
      const selector = `.process-flow__thought[data-step-bucket="${b.key}"]`;
      let row = host.querySelector<HTMLDetailsElement>(selector);
      if (!row) {
        row = document.createElement('details');
        row.className = 'process-flow__thought';
        row.dataset.stepBucket = b.key;
        row.dataset.mergedSeq = '0';
        row.dataset.ts = b.anchorTs; // 时间键（统一排序）
        row.dataset.seq = String(b.anchorSeq); // seq 兜底比较（同 ts/空串回落）
        const summaryEl = document.createElement('summary');
        // 思考类型标：thought icon 前置（与 createAggregatedThought 同构，增量/重建不偏移）
        const thoughtIcon = document.createElement('span');
        thoughtIcon.className = 'round-block__type-icon';
        thoughtIcon.setAttribute('aria-hidden', 'true');
        thoughtIcon.innerHTML = getIconSvg('thought', 12, 12); // 静态 SVG，无外部输入
        const thoughtLabelSpan = document.createElement('span');
        thoughtLabelSpan.textContent = thoughtLabel(b.stepIndex);
        summaryEl.append(thoughtIcon, thoughtLabelSpan);
        row.appendChild(summaryEl);
        const bodyEl = document.createElement('div');
        bodyEl.className = 'process-flow__thought-body';
        row.appendChild(bodyEl);
        insertPlanItemInOrder(host, row, b.anchorTs);
      }
      const body = row.querySelector('.process-flow__thought-body') as HTMLDivElement;
      let last = Number(row.dataset.mergedSeq ?? '0');
      for (const item of b.items) {
        if (item.seq <= last) continue;
        // 原样追加（不 trim、不加换行）：增量片段的天然间隔保留 → 连贯
        body.textContent += item.content;
        last = item.seq;
        row.dataset.mergedSeq = String(item.seq);
      }
    }
    // 2.6) 工具批（toolBatch）：相邻连续工具并块——分组判据单一真源 groupToolBatches
    //   （与 finalize 重建 / pending 行升级共用，禁内联三份）。幂等增量：行按 toolCallId
    //   配对键去重/升级，批块按段 id（data-tool-batch）寻址复用；批从单变多时旧平铺行
    //   并入批块（批 key 随迁，行不再持有）。流式按事件到达序推进，段只增不减。
    // 断面 ts 取容器内已上屏的问答卡（BATCH-SPLIT-1）
    const batches = groupToolBatches(events, visibleInputTs(flow));
    for (const batch of batches) {
      const multi = batch.entries.length > 1;
      // 归组定位与逐条插入同锚（段内首个 tool_start 的 ts/seq）——批块不越任务项边界
      const { host } = cells.planItemContainerFor(flow, events, batch.anchorTs, batch.segId);
      // 行的目标容器：多工具批 = 批块 body；单工具批 = 任务项容器（行即批，视觉等价现状）
      let body: HTMLElement = host;
      if (multi) {
        let block = host.querySelector<HTMLDetailsElement>(
          `:scope > .round-block__tool-batch[data-tool-batch="${batch.segId}"]`,
        );
        if (!block) {
          block = cells.createToolBatchBlock(batch, true);
          insertPlanItemInOrder(host, block, batch.anchorTs);
        } else {
          // 已有批块（增量期间结果/新工具到达）→ 叙述句与失败提示随批内容重算
          cells.refreshToolBatchSummary(block, batch);
        }
        body = block.querySelector('.round-block__tool-batch-body') as HTMLElement;
      }
      for (const entry of batch.entries) {
        const callId = entry.start.payload.toolCallId;
        // 既有行定位（toolCallId = 行配对键，updateToolRowState 同键消费；批容器寻址只用段 id）：
        // pending「准备中」行升级后并入所在批（口径③）/ 已渲染行幂等迁移
        const existing = flow.querySelector<HTMLDetailsElement>(
          `.round-block__tool[data-tool-call-id="${callId}"]`,
        );
        let row: HTMLDetailsElement;
        if (existing) {
          // pending 行（renderPendingToolRow 已建）→ 转执行态，不重建 DOM（参数此刻完整，
          // 叙述/状态/高亮同步复位）；正式行（非 pending）保持跳过
          if (existing.classList.contains('is-tool-pending')) {
            cells.upgradePendingToolRow(existing, entry.start);
          }
          row = existing;
        } else {
          row = cells.renderToolRow(entry.start, events);
        }
        if (multi) {
          // 并入所在批：批 key（段 id）唯一归属批块，行不再持有（防一键双主的死 key）
          delete row.dataset.toolBatch;
          if (row.parentElement !== body) body.appendChild(row);
        } else {
          // 行即批（单工具批）：平铺行保持现状形态，批 key（段 id）挂行自身
          if (row.parentElement !== host) insertPlanItemInOrder(host, row, batch.anchorTs);
          row.dataset.toolBatch = String(batch.segId);
        }
      }
    }
    // 3) tool_result 到达更新工具行状态（详情/展开态/等待时长）
    for (const e of events) {
      if (e.type === 'tool_result') {
        updateToolRowState(flow, e as Extract<ProcessEvent, { type: 'tool_result' }>);
      }
    }
    // 3.5) 任务项组建组 + 状态投影（真机反馈 2026-10-01：运行中无 active 靶心）：
    //   boundary 事件本身不建组（组由 narrate/tool/thought/batch 消费 planItemContainerFor
    //   时创建）——boundary 先于一切内容事件到达时（真机实证：LLM 建表后立刻宣告任务项，
    //   下一事件可能长时间未到），组必须由 boundary 自行创建，否则靶心无处安放。
    //   幂等：getOrCreatePlanItemGroup 复用既有组，重复调用零成本。
    //   状态投影走 livePlanStates（实时累加真源，含 plan_update 的 done——防被事件序推导
    //   抹掉）；空 map = 无状态信号，不投影（诚实降级，不伪造图标）。
    const planBounds = events.filter(isPlanItemBoundaryEvent);
    for (const b of planBounds) cells.getOrCreatePlanItemGroup(flow, b, planBounds);
    if (livePlanStates.size > 0) cells.applyPlanItemStates(flow, livePlanStates);
    // 4) 光标运行态同步：工具/思考 DOM 刚被本函数更新 → 推导一次（批次二推导单一入口；
    //    仅流式中生效——重放/骨架期调用无活动流式块，guard 内 no-op）
    if (streamingActive) syncRunningCursor();
  }

  /**
   * 重放中断轮孤儿宿主渲染（形态定案：与 done 轮同构——过程折叠 + 停止行平铺）
   *
   * 中断轮无 assistant 正文块（host 只对 complete 轮挂正文，避免半截文本与过程事件同源双份），
   * 但折叠收尾仍需要宿主——孤儿宿主 = 复用 buildAssistantShell 的 label/footer（单一实现）+ 移除
   * body（中断轮不显示半截正文），挂 messages 尾并记 data-round-id；随后临时锚定 activeAssistantEl
   * 让 renderRoundBlock 挂折叠块，再平铺停止行。旧「孤儿 process-flow 平铺 + flagInterruptedMarker」
   * 随之退役，闪烁相位行（process-flow__phase 呼吸点）连根消失。
   *
   * 容器化：「被停止的会话也是正常对话记录」——中断轮与 done 轮同构也收进
   * .round-group 容器建 footer（复制整链/分叉/删除 + 时间戳），支持用户手动删除。ts 用本轮首个
   * 过程事件时间（meta 恒为首条，真实闭环起点，对齐运行时中断块首 chunk ts），替代 new Date()
   * 伪值——伪值会使容器 footer 的 delete_turn 锚点错位。复制整链的原始文本 = 过程叙述
   * （narrate）拼接（半截正文已随中断丢弃；拼接逻辑在 `shared/narrateText` 单点，重放、运行时
   * 与宿主崩溃打捞共用一份）。
   *
   * @param roundId 本轮 ID（孤儿宿主归属标记）
   * @param evidence 本轮裁决证据（重放透传）：中断轮同样可能有记忆命中/搜索证据，
   *   不传则该轮重放时明细与归因一并丢失（与 done 轮同一缺口，一并补齐）
   */
  function renderInterruptedRound(roundId?: string, evidence?: RoundView['evidence']): void {
    const host = document.createElement('div');
    host.className = 'msg assistant is-interrupted-host';
    // 真实闭环起点（首条带 ts 的过程事件）；空事件/空 ts 兜底当前时间（旧行为，删除仍禁用）
    const startTs = currentEvents.find((e) => e.ts)?.ts ?? new Date().toISOString();
    buildAssistantShell(host, startTs, roundId);
    host.querySelector('.msg-body')?.remove();
    if (roundId) host.dataset.roundId = roundId;
    // 复制源（与运行时中断轮共用 deriveNarrateText 同源）：正文已随中断丢弃，整链复制 = 过程叙述拼接
    const narrateText = deriveNarrateText(currentEvents);
    if (narrateText) host.dataset.rawText = narrateText;
    messages.appendChild(host);
    const prevAssistant = activeAssistantEl;
    activeAssistantEl = host;
    roundBlockEl = null;
    roundBlockHostEl = null;
    try {
      // 容器化：中断轮与 done 轮同构进 .round-group（建容器 footer），已定稿传 pending=false
      ensureRoundGroup(roundId, host, false);
      renderRoundBlock(currentEvents, true, undefined, evidence, undefined, true);
      appendInterruptedRow(host, currentEvents);
    } finally {
      activeAssistantEl = prevAssistant;
    }
  }

  // 在日期交界插入日期分隔线（跨天合并分组，textContent 构建防注入）。
  // 仅当本条消息日期与上一条不同才插入；divider 先于消息追加，形成「日期 → 消息」分组。
  function renderDateDivider(ts?: string): void {
    if (!ts) return;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return;
    const key = toDateKey(d);
    if (key === lastShownDate) return;
    lastShownDate = key;
    const today = toDateKey(new Date());
    const yesterday = toDateKey(new Date(Date.now() - 86400000));
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    const label = key === today ? `${md} · 今天` : key === yesterday ? `${md} · 昨天` : md;
    const divider = document.createElement('div');
    divider.className = 'date-divider';
    divider.setAttribute('aria-hidden', 'true');
    divider.textContent = label;
    messages.appendChild(divider);
  }

  // ─── 归档停滞兜底 ────────────────────────────────────────────
  // 根因修复：内核 postProcess 已改非阻塞，正常路径 archiving 后立即收到 done 折叠。
  // 此兜底仅覆盖后端异常挂起（归档迟迟不发 done），避免 UI 永久停留在
  // 「归档记忆中…」呼吸动画——答案已完整输出，归档是后台动作，不应让用户无限等待。
  const ARCHIVING_STALL_MS = 15000;

  // 归档兜底定时器句柄（webview 环境 setTimeout 返回 number）
  let archivingFallbackTimer: ReturnType<typeof setTimeout> | undefined;

  /** 清除归档兜底定时器（幂等，done/中断/新轮次时调用） */
  function clearArchivingFallback(): void {
    if (archivingFallbackTimer !== undefined) {
      clearTimeout(archivingFallbackTimer);
      archivingFallbackTimer = undefined;
    }
  }

  /** 调度归档停滞兜底：超时后收起 round-block 呼吸点（与 done 收尾同构，v1.5） */
  function scheduleArchivingFallback(): void {
    clearArchivingFallback();
    archivingFallbackTimer = setTimeout(() => {
      archivingFallbackTimer = undefined;
      if (roundBlockEl && roundBlockEl.isConnected) {
        roundBlockEl.classList.remove('is-running');
      }
    }, ARCHIVING_STALL_MS);
  }

  /**
   * 骨架状态容器：会话控件（暂停/继续 + 发送按钮）的**唯一真源**。
   *
   * 容器由 `turn_update.state`（完整 `TurnState`）直接赋值——
   * `skeletonFromTurnState` 投影剥离 roundId/RoundStatus 后写入，派生链不动。
   * legacy 过渡适配器（`skeletonFromStatus` / `skeletonFromPausePending`）已删除（死代码）。
   * 会话三态与「申请在途」**不是两个独立变量**，一律派生——写入点唯一。
   */
  let skeletonState: SkeletonState = { phase: 'idle' };

  /**
   * 骨架状态单写点：更新容器 → 重算按钮语义。
   * 只做语义重算（与 legacy 调用集逐一对应）；`send.disabled`（syncSendEnabled）与
   * 会话控件锁由调用方按各自原有节奏调用，避免夹带行为变更。
   */
  function applySkeletonState(next: SkeletonState): void {
    skeletonState = next;
    syncButtonSemantics();
    // 2b-2b 换真源：容器写入点从 setStatus（内部曾调 syncSendEnabled）迁到 turn_update 分支，
    // disabled 属按钮语义一部分，须在单写点同步——否则 running/paused/settled 切换后
    // disabled 停留旧值（如 running 空输入仍禁用 → 停止按钮点不出）。
    syncSendEnabled();
  }

  /**
   * 按钮语义矩阵：会话状态 × 输入框内容 → 语义数据（矩阵本体 = `helpers/turnUiState.ts` 纯函数）。
   *
   * 本函数只做三步：取自变量快照 → 派生语义 → 施加到 DOM。
   * 矩阵抽出的理由 = 可单测 + 为「真源换成 TurnState」备好唯一派生入口（此刻仍读本地态）。
   * pauseBtn 图标永远是 pause（‖），不做本地 toggle——request/cancel 的行为 toggle 完全由 host 层
   * handlePause 通过 agent.isPausePending() 判断，UI 不感知 pending 状态。
   * 调用点 = applySkeletonState（骨架状态变了）+ input 事件（输入内容变了）+ sendMessage（发送/停止后复位）。
   * 不改变 disabled 态（那是 syncSendEnabled 的职责），不负责 round-block 呼吸点/导航锁（setStatus 的职责）。
   */
  function syncButtonSemantics(): void {
    applyButtonSemantics(currentButtonSemantics());
  }

  /** 当前自变量快照 → 按钮语义（**单一取数点**：两个 sync 函数共用，防两处各取一次而漂移） */
  function currentButtonSemantics(): ButtonSemantics {
    return deriveButtonSemantics({
      state: skeletonState,
      hasInput: input.value.trim().length > 0,
    });
  }

  /** 语义数据 → DOM（**唯一施加点**） */
  function applyButtonSemantics(spec: ButtonSemantics): void {
    if (pauseBtn) {
      // 无职责（spec.pause === null：done 态，或 waiting(ask) 空输入无纯续跑）：只隐藏，
      // 不改 icon/title/aria —— 否则会把隐藏按钮的属性改成与可见态不一致的值（无意义的状态污染）
      pauseBtn.hidden = spec.pause === null;
      if (spec.pause) {
        const icon = pauseBtn.querySelector<HTMLElement>('.btn-icon');
        if (icon) applyIcon(icon, spec.pause.icon);
        pauseBtn.setAttribute('title', spec.pause.title);
        pauseBtn.setAttribute('aria-label', spec.pause.ariaLabel);
      }
    }
    send.classList.toggle('loading', spec.send.loading);
    // 按钮形态只由 `loading` 类驱动（点击路由同判据）：loading=true →「停止生成」，否则「发送 / 发送补充」。
    // 暂停态续跑由 pauseBtn（play 图标）承载，发送键恒为「停止生成」（deriveButtonSemantics paused 分支锁定 loading=true）。
    send.setAttribute('title', spec.send.title);
    send.setAttribute('aria-label', spec.send.ariaLabel);
  }

  // ── 活动抽屉域（活动条/时间线/指标/未读位）：渲染与未读判定收口于 activityDrawerView
  // （HOST-SPLIT-1 chatView 第 4 刀，模块头见该文件）。创建须早于下方 registerDockEntry('activity')
  // 与一切 resolveDock 执行点（deps 的函数引用经声明提升与闭包捕获，创建时机安全）──
  const activityDrawerView = createActivityDrawerView({
    document,
    activityBar,
    activityList: document.getElementById('activityList') as HTMLElement,
    activityMetrics: document.getElementById('activityMetrics') as HTMLElement,
    activityMetricsEmpty: document.getElementById('activityMetricsEmpty') as HTMLElement,
    setDockActive,
    setDockFixed,
    notifyDockChanged: resolveDock,
    isDockExpanded: () => _dockExpanded,
  });

  // 指标空态指引的「在设置中开启」：只发导航消息，配置读写真源仍是 VS Code 原生设置
  // （对话面板不持有配置写入面，避免与设置面板形成第二套写入路径）
  document.getElementById('activityMetricsEmptyOpen')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'open_setting', key: 'memora.showMetrics' });
  });

  // ─── 底部状态条收纳器（StatusDock，ADR-037 形态宪法；实现契约详见
  // docs/方案-底部状态条收纳-20261001.md §三）───
  // 底部三条（fileChanges / pendingQueue / activityBar 非错误态）同屏堆叠收紧：
  // 主位常显优先级最高一条，其余收进「+N」浮层（同 planBar head→panel 纵向展开形态）。
  // 🔴 SSOT：三条的 hidden 与 DOM 归位**只由 resolveDock 裁决**——各条更新函数只上报
  // setDockActive / setDockFixed，禁直写 hidden / insertBefore（散写即回到堆叠现状）。
  // error 豁免（fail-visible）：fixed 恒主位，裁决优先于 priority 排序。
  // background 取最低（0）：activity 承载「正在思考/执行」主状态，不可被后台条顶掉；轮次
  // 收尾后 activity 归位、后台任务仍在跑 ⇒ 它自动成为唯一活跃条升主位，「终止」按钮恰在
  // 最需要它的时刻直接可见（方案 §2.3）。
  // ─── 提示 UI 两分收敛（A 类阻断 / B 类信息，方案-提示UI两分收敛-20261005.md §四/§五）───
  // 🔴 SSOT：A、B 两类**共用一个裁决器** resolveDock()——不另造 promptSlot 裁决器
  // （两个裁决器会争同一个插入锚点、顺序不定，即双源）。A 类作为最高优先级 entry 注册
  // 进来，复用既有 fixed/主位/收纳机制。数值含义：confirm(10) 恒主位，优先于 error 豁免
  // ——确认卡被收纳 = 不可见 = 超时自动拒绝，而 error 被收纳仍可从图标条点开，代价不对称
  // （方案 §九 A2）。
  const DOCK_PRIORITY = {
    confirm: 10,
    fileChanges: 3,
    pendingQueue: 2,
    activity: 1,
    background: 0,
  } as const;
  /** A 类阻断面板的优先级（恒主位判据；勿与 B 类数值混用） */
  const CONFIRM_PRIORITY = DOCK_PRIORITY.confirm;
  type DockId = keyof typeof DOCK_PRIORITY;
  type DockEntry = {
    el: HTMLElement;
    priority: number;
    /** error 豁免：恒主位（裁决优先于 priority）；error 消失时撤销 */
    fixed: boolean;
    active: boolean;
  };
  const dockEntries = new Map<DockId, DockEntry>();
  /**
   * 抽屉展开态（唯一折叠轴，C1）。
   *
   * 2026-10-05 C1 之前还有第二根轴——#activityDetail 自己的 `<details>.open`，
   * 两轴并存期靠 follower 显隐回调（reconcileActivityDetailVisibility）缝合，
   * 止血契约 P10C 即此物。C1 把时间线静态固定进 #dockPanel 后，details 退化为
   * 普通容器，随从机制整组拆除：开/合只剩这一个变量，只由用户点 #dockChip 翻转。
   */
  let _dockExpanded = false;

  function registerDockEntry(id: DockId, el: HTMLElement): void {
    dockEntries.set(id, { el, priority: DOCK_PRIORITY[id], fixed: false, active: false });
  }

  /**
   * composer 替换（A 类阻断面板激活 ⇒ 输入框整体让位）
   *
   * 采用**替换**而非**遮罩**：composer 直接 hidden，面板占据输入框的位置。差别不是审美——
   * ①遮罩要新开 z-index 层（消息区 1 / 输入区 20），会与 treedd 下拉菜单抢层级、还要手写
   * 焦点陷阱；②替换是流布局，零新层级零陷阱；③体验等价：用户此刻只能做「确认/拒绝」这一个决定。
   * 🔴 SSOT：只由 resolveDock 调用，禁散写（散写会出现「面板关了 composer 没回来」的卡死）。
   */
  function setComposerReplaced(replaced: boolean): void {
    if (inputWrap) inputWrap.hidden = replaced;
    // 同一裁决的第二表现（UI-CONFIRM-FIT-1，2026-10-22 真机反馈「到底部按钮和确认框交叠」）：
    // 一键到底按钮 bottom: calc(100% + sp-4) 锚 #inputBar 顶边，而审批卡恰好占据该区域；
    // 且 #inputBar 有 z-index: var(--z-bar)=20 建层叠上下文、卡片无 z-index ⇒ 按钮既压住
    // 卡片的操作按钮、又能抢走点击。审批时导航本就无意义，故让它一并让位（CSS 见
    // chatStyles.ts `body.confirm-active .scroll-to-bottom`）。
    // 🔴 必须写在这里：判据与 composer 让位完全相同，分开两处写必然漂移（一处改了另一处忘）。
    document.body.classList.toggle('confirm-active', replaced);
  }

  function setDockActive(id: DockId, active: boolean): void {
    const entry = dockEntries.get(id);
    if (!entry || entry.active === active) return;
    entry.active = active;
    resolveDock();
  }

  function setDockFixed(id: DockId, fixed: boolean): void {
    const entry = dockEntries.get(id);
    if (!entry || entry.fixed === fixed) return;
    entry.fixed = fixed;
    resolveDock();
  }

  // activityBar 接入收纳器（静态 HTML 节点，此处注册；fileChanges/pendingQueue 懒创建时注册）。
  // C1：时间线 #activityDetail 不再是本条随从（静态固定在抽屉时间段），注册只传单条本身。
  // ——注册必须在 dockEntries（const Map）初始化之后，放声明区会踩 TDZ
  registerDockEntry('activity', activityBar);
  // A 类阻断面板（审批卡）接入同一收纳器：显隐与归位自此**只由 resolveDock 裁决**，
  // renderWriteConfirmCard / 按钮回调一律改走 setDockActive，禁直写 hidden（散写即回到堆叠）。
  if (writeConfirmCard) registerDockEntry('confirm', writeConfirmCard);

  /**
   * 主位条裁决（SSOT 单点）：A 类阻断面板恒主位 > error 豁免（fixed）> priority 最大。
   *
   * 数值含义：confirm(10) 恒主位，优先于 error 豁免——确认卡被收纳 = 不可见 = 超时自动拒绝，
   * 而 error 被收纳仍可从图标条点开，代价不对称（方案§九 A2）。
   *
   * 🔴 勿把 error 豁免读成「不管优先级多低都硬占明面」：confirm 在场时 error 一样被收进
   * 浮层——豁免只相对 B 类 priority 排序成立，不越过 confirm。
   *
   * 🔴 单一真源：非活跃条归位（要退到主位之上）与主位条归位（要贴anchor）**共用此裁决**。
   * 早先两处各判一次，改一处忘另一处即出现「主位与 anchor 之间夹着隐藏节点」。
   */
  function pickDockHead(actives: DockEntry[]): DockEntry | undefined {
    return (
      actives.find((e) => e.priority === CONFIRM_PRIORITY) ??
      actives.find((e) => e.fixed) ??
      actives.reduce((a, b) => (b.priority > a.priority ? b : a), actives[0] as DockEntry)
    );
  }

  /**
   * 显隐与归位裁决（SSOT 单点，C1 重写）。
   *
   * 静态链（骨架写死，不再动态插拔）：非活跃条们(hidden) → #dockChip → #dockPanel → inputBar。
   * 每次全量重排三件事：①主位条（pickDockHead）插 inputBar 前，恒紧邻输入框；
   * ②其余活跃条单实例搬入 #dockControls（节点移动保留事件监听）；③非活跃条 hidden 退到
   * #dockChip 之上。时间线 #activityDetail 是 #dockPanel 的静态子节点，**永不参与搬运**。
   *
   * 抽屉入口状态同在此单点裁决：rest>0 显「+N」，否则时间段有内容时显「活动」；
   * 未读只挂 chip 徽章，抽屉从不自动弹（宪法④，ADR-037）。
   */
  function resolveDock(): void {
    const anchor = inputBar;
    const parent = anchor.parentNode;
    if (!parent || !dockChip || !dockPanel || !dockControls) return;
    const actives = [...dockEntries.values()].filter((e) => e.active);
    const head = actives.length > 0 ? pickDockHead(actives) : undefined;
    // UI-TOAST-1：主位恰是 activity 且槽在位 ⇒ 出流定位于浮层槽（confirm 恒主位 ⇒ 抑制涌现）
    const activityToast = isToastHead(head, dockEntries.get('activity'), toastSlot);
    // 全量归位（必须先于重新收纳）：把上一轮搬进 #dockControls 的条先搬回 parent。
    // appendChild 是移动（幂等），随后的归位循环立刻给它们正确位置，中间态无渲染帧。
    // （2026-10-05 探针实锤教训：旧动态 panel 摘除时不先搬空，条会随 panel 一起消失一轮。）
    for (const e of dockEntries.values()) {
      if (toastLoopSkip(e.el, e === head, activityToast, toastSlot)) continue;
      if (e.el.parentNode !== parent) parent.appendChild(e.el);
    }
    // composer 让位裁决（唯一写入点）：A 类阻断面板激活即替换掉输入框——用户此刻只能做
    // 「确认/拒绝」这一个决定。B 类信息条再多条也不抢输入框（它们不阻断）。
    const confirmActive = actives.some((e) => e.priority === CONFIRM_PRIORITY);
    setComposerReplaced(confirmActive);
    // 🔴 结构纪律（探针实锤，2026-10-05）：**主位条与 anchor 之间必须恒定干净**——
    // 物理相邻，不允许隐藏节点夹在中间（点击穿透/点击区错位）。故非活跃条统一退到
    // #dockChip 之上（静态抽屉比任何条都更靠近 anchor），不退 anchor 前。
    // 必须在空态分支之前执行，否则「最后一条撤销」时残留可见。
    for (const e of dockEntries.values()) {
      if (!e.active) {
        e.el.hidden = true;
        parent.insertBefore(e.el, dockChip);
      }
    }
    const rest = head ? actives.filter((e) => e !== head) : [];
    // 主位归位：浮层主位见 placeDockHead（UI-TOAST-1，出流不挤消息区）；其余条插 anchor
    // 前 = 静态 #dockPanel 之后、inputBar 之前，恒紧贴输入框。
    // 抽屉开合只切 #dockPanel.hidden，chip/panel 从骨架起就不插拔 ⇒ P7/P8 时代
    // 「chip/panel 反复插拔把确认卡挤开、主位条瞬移闪烁」的结构根在此不复存在。
    if (head) {
      placeDockHead(head.el, parent, anchor, activityToast, toastSlot);
      head.el.hidden = false;
    }
    // 被收纳条：单实例移入控件段；收起态隐藏条本身（panel 也 hidden，双保险）
    for (const e of rest) {
      e.el.hidden = !_dockExpanded;
      dockControls.appendChild(e.el);
    }
    dockControls.hidden = rest.length === 0;
    // 抽屉入口：有被收纳的活跃条（+N）**或**时间段有内容（历史/指标）才可达。
    // 时间线一旦有内容不清空（历史有界保留、metrics 渲染后常驻）⇒ 入口首次出现后常驻，
    // 单条 error 8s 撤后历史仍可从这里拉开——C1 闭合的最后残余缺口（台账 P15 病③）。
    // timelineReady/hasUnread 判据真源随活动抽屉域收口于 activityDrawerView.getDockState（第 4 刀）。
    const { timelineReady, hasUnread } = activityDrawerView.getDockState();
    // A 类阻断面板激活时入口一并让位（UI-CONFIRM-FIT-1 收尾，2026-10-22）：
    // 卡已按「输入框同盒替身」占据 inputBar 原位，chip 若留在卡上方，同盒错觉立即破功；
    // 且阻断态用户只能做「确认/拒绝」这一个决定，抽屉入口此刻没有承接面。
    // 代价与边界：隐藏的是**入口**不是数据——未读位由 activityDrawerView 持有，
    // 收卡后 resolveDock 重跑、chip 连同未读徽章原样恢复（不是清未读）。
    const chipVisible = !confirmActive && (rest.length > 0 || timelineReady);
    // 空态（入口不可达）时展开态无意义，强制收起——A 类阻断（confirm）同属入口不可达，
    // 由 chipVisible 判据统一覆盖；其余时刻**不替用户合抽屉**
    //（正在看历史时条全撤 = P10C open 轴血训的同一条纪律，折叠轴只剩这一个）。
    if (!chipVisible) _dockExpanded = false;
    dockChip.hidden = !chipVisible;
    dockChip.textContent = rest.length > 0 ? `+${rest.length}` : '活动';
    // 可见文案极简（+N/活动），可读名在此补全：收纳数 + 未读后缀。未读圆点是 ::before
    // 装饰（读屏拿不到），有未读必须靠 aria-label 让读屏器报出。
    dockChip.setAttribute(
      'aria-label',
      (rest.length > 0 ? `${rest.length} 个收纳状态` : '活动历史') + (hasUnread ? '，有未读' : ''),
    );
    dockChip.setAttribute('aria-expanded', String(_dockExpanded));
    dockChip.classList.toggle('is-unread', hasUnread);
    // 收起态形态降级（用户诉求 2026-10-07）：收起时 dockChip 收为输入框左侧小气泡，
    // 展开态不带该类 ⇒ 完全保持现状（全宽 pill + 抽屉）。仅切换类，不触碰搬运锚/显隐纪律。
    dockChip.classList.toggle('is-collapsed', !_dockExpanded);
    document.body.classList.toggle('dock-collapsed', !_dockExpanded);
    dockPanel.hidden = !_dockExpanded;
  }

  /**
   * 抽屉入口点击：唯一折叠轴。拉开＝已读（清两个未读位 + 现场消费指标信号），
   * 开合都只切 _dockExpanded 后交 resolveDock 单点重排，不直写任何 hidden。
   */
  dockChip?.addEventListener('click', () => {
    _dockExpanded = !_dockExpanded;
    // 拉开＝已读：未读位与信号消费真源随活动抽屉域收口于 activityDrawerView（第 4 刀）
    if (_dockExpanded) activityDrawerView.markDrawerOpened();
    resolveDock();
  });

  /**
   * 切换 LLM 运行状态：thinking → 发送按钮切换为「停止」方块（loading 类驱动图标切换），
   * 输入框保持可用（支持插话）；done 恢复发送按钮；paused 切换为「继续」按钮。
   * 按钮语义 = 会话状态 × 输入框内容 矩阵驱动（syncButtonSemantics 承载）。
   */
  function setStatus(state: 'thinking' | 'done' | 'paused'): void {
    // pauseBtn 图标永远是 pause（‖），UI 不维护 toggle 状态——直接进入状态分发
    if (state === 'thinking') {
      // 生成中：round-block summary 呼吸点 + 计数实时刷新（renderRoundBlock 驱动，无需额外文案）
    } else if (state === 'paused') {
      // 暂停中：停止呼吸（可通过「继续」按钮恢复）
      clearArchivingFallback();
      if (roundBlockEl && roundBlockEl.isConnected) {
        roundBlockEl.classList.remove('is-running');
      }
    } else {
      // 结束：停止呼吸（保留折叠态，不落库不重放）
      clearArchivingFallback();
      if (roundBlockEl && roundBlockEl.isConnected) {
        roundBlockEl.classList.remove('is-running');
      }
    }
    // 2b-2b 换真源：骨架容器由 setStatus 的 legacy 三态写入改为 turn_update.state 直接赋值——
    // status 消息职责收窄为「呼吸点 / 会话控件锁 / 焦点恢复」，不再参与按钮语义（发送按钮恢复
    // 时机 = turn_update(settled) 流尾即时，R-2b-1 裁决；控件锁仍跟随 status:'done' 延后解锁，
    // 护 round-summary 写入窗口——两个概念各回各的真源）。会话导航类控件运行时锁：**语义 =
    // 「宿主有在途后台写」窗口，不是 turn 状态**（宿主延迟发 status:'done' 是为护住摘要写入期，
    // 避免用户在该窗口删除轮次产生孤儿摘要）
    updateSessionControlsLock(state !== 'done');
    // done 态才需要恢复输入焦点（避免强制 focus 打断用户其他操作）
    if (state === 'done' && document.activeElement === document.body) input.focus();
  }

  /**
   * 同步发送按钮**可用态**：判据 = 语义派生的 `send.disabled`（唯一真源 = `helpers/turnUiState.ts`）。
   *
   * `disabled` 只出现在 **done + 空输入**（空输入无法发送）；运行中（thinking/paused）无论有无输入
   * 都可用——有输入 = interject 排队 / 带补充续跑，空输入 = 停止 / 继续。该不变量由派生层单测穷举锁定。
   * 调用点 = 一切输入内容/按钮状态变化处：input 事件、程序化预填/清空、setStatus。
   */
  function syncSendEnabled(): void {
    send.disabled = currentButtonSemantics().send.disabled;
  }

  /**
   * 会话导航类控件运行时锁（SSOT 收口点）：运行时（thinking/paused）禁用「新建会话 /
   * 切换历史 / 删除问答闭环」三类改变会话结构的操作，仅非运行时（done）可用。
   *
   * 单一真相源 = 宿主 `status` 事件（经 setStatus 驱动），webview 不另维护 isRunning 标志。
   * 删除按钮按消息实例存在（每条 AI 消息一个），故批量 querySelectorAll 统一置态；
   * locked 态优先（运行时强制禁用），unlock 时还原为「无锚点 ts 则禁用」的原始语义。
   */
  let sessionControlsLocked = false;
  /**
   * 会话导航类控件运行时锁（SSOT 收口点）：运行时禁用改变会话结构的操作。
   * 覆盖范围：新建会话 / 切换历史 / 删除问答闭环 / 分叉问答闭环。
   * 单一真相源 = 宿主 status 事件（经 setStatus 驱动）；locked 态优先，unlock 时还原为锚点缺失则禁用的原始语义。
   */
  function updateSessionControlsLock(locked: boolean): void {
    sessionControlsLocked = locked;
    newSessionBtn.disabled = locked;
    historyBtn.disabled = locked;
    // 轮级动作（重新生成 / 分叉 / 删除）统一交给真源刷新：判据只在 roundActions.available
    // 一处（取代旧的「删除扫一遍 + 分叉扫一遍 + 各写一份锚点提取」双实现）
    refreshRoundActionButtons(document, locked);
  }

  // ─── 回答等待指示器（③ 等待反馈）─────────────────
  // 缺口：prepare 阶段（meta 到达前的召回/装配/首 token 等待）仅有 thinking 事件、
  // 无骨架（骨架由 meta 建立）承接 → UI 静默「发送后无反应」。此指示器在该窗口内提
  // 供「相位文案 + 等待秒数」可见反馈；meta 到达（骨架接管）/ 正文开启 / 收尾即移除。
  let pendingWaitEl: HTMLElement | null = null;
  /** 等待起算时间戳（发送后首个 thinking 事件置位，跨相位不重置） */
  let pendingWaitStart = 0;
  /** 等待计时器（1s 刷新秒数） */
  let pendingWaitTimer: ReturnType<typeof setInterval> | undefined;
  /** 当前等待相位文案（最新 thinking 阶段，缺省准备中） */
  let pendingWaitPhase = '正在准备回答…';

  /** 建立/复用回答等待指示器（挂到消息区末尾，role=status 供读屏） */
  function ensurePendingWait(): void {
    if (pendingWaitEl && pendingWaitEl.isConnected) {
      updatePendingWait();
      return;
    }
    if (pendingWaitStart === 0) pendingWaitStart = Date.now();
    pendingWaitEl = document.createElement('div');
    pendingWaitEl.className = 'pending-wait';
    pendingWaitEl.setAttribute('role', 'status');
    messages.appendChild(pendingWaitEl);
    updatePendingWait();
    if (pendingWaitTimer === undefined) {
      pendingWaitTimer = setInterval(updatePendingWait, 1000);
    }
  }

  /** 刷新等待指示器文案（相位 + 已等待秒数） */
  function updatePendingWait(): void {
    if (!pendingWaitEl || !pendingWaitEl.isConnected) return;
    const elapsed = Math.floor((Date.now() - pendingWaitStart) / 1000);
    pendingWaitEl.textContent = `${pendingWaitPhase} · 已等待 ${elapsed}s`;
  }

  /** 清除等待指示器（幂等；meta 建骨架 / chunk 开正文 / done·error / 切轮时调用） */
  function clearPendingWait(): void {
    if (pendingWaitTimer !== undefined) {
      clearInterval(pendingWaitTimer);
      pendingWaitTimer = undefined;
    }
    pendingWaitEl?.remove();
    pendingWaitEl = null;
    pendingWaitStart = 0;
    pendingWaitPhase = '正在准备回答…';
  }

  // ── TS-11c：工具等待时长（瞬态展示，不落库） ─────────────────────
  // 进行中工具行的「已等待 Ns」秒数：仅 tool_start 已到、tool_result 未达期间实时刷新。
  // 瞬态不参与 eventsByRound（历史只记 tool_start/tool_result，时长属展示时点信息）。
  /** toolCallId → 工具开始时间戳（进程内瞬态，不随过程事件持久化） */
  const toolElapsedStart = new Map<string, number>();
  /** 工具等待秒数刷新的定时器句柄（仅有进行中工具时运行，空转兜底自动清理） */
  let toolElapsedTimer: ReturnType<typeof setInterval> | undefined;

  /** 停止工具计时并清空全部时点记录（流结束 / 新轮开始调用，防定时器泄漏） */
  function clearToolElapsed(): void {
    if (toolElapsedTimer !== undefined) {
      clearInterval(toolElapsedTimer);
      toolElapsedTimer = undefined;
    }
    toolElapsedStart.clear();
    messages.querySelectorAll('.round-block__elapsed').forEach((el) => el.remove());
  }

  /** 首个进行中工具到达时启动秒数刷新（幂等；无进行中工具时由 tick 兜底停止） */
  function ensureToolElapsedTimer(): void {
    if (toolElapsedTimer !== undefined) return;
    toolElapsedTimer = setInterval(tickToolElapsed, 1000);
  }

  /** 每秒刷新所有进行中工具行的「已等待 Ns」标签（elapsed 是个独立 span，不动 summary 文本，避免与状态标签替换冲突） */
  function tickToolElapsed(): void {
    let anyRunning = false;
    messages.querySelectorAll<HTMLElement>('.round-block__tool.is-tool-running').forEach((row) => {
      const id = row.dataset.toolCallId;
      if (!id) return;
      const summary = row.querySelector(':scope summary');
      if (!summary) return;
      const startTs = toolElapsedStart.get(id);
      if (startTs === undefined) {
        // 缺起点（map 被清但行仍在）→ 以当前时刻补记，防显示异常
        toolElapsedStart.set(id, Date.now());
        return;
      }
      let el = row.querySelector(':scope .round-block__elapsed') as HTMLElement | null;
      if (!el) {
        el = document.createElement('span');
        el.className = 'round-block__elapsed';
        summary.appendChild(el);
      }
      const seconds = Math.max(0, Math.floor((Date.now() - startTs) / 1000));
      el.textContent = `${seconds}s`;
      anyRunning = true;
    });
    // 无任何进行中工具 → 兜底停止（防漏挂清理的残留定时器空转）
    if (!anyRunning) clearToolElapsed();
  }

  /**
   * 更新输入区状态行「当前角色」徽章（SSOT：角色名与 AI 消息头/空状态共用 currentRoleName）。
   *
   * 徽章可点跳转：点击打开设置面板「角色」选项卡（open_settings_tab 消息，host 侧 memora.openSettings('roles')），
   * 切换动作仍由角色视图「设为当前」发起——本处只做状态展示与导航，不承载切换执行。
   * 可附加展示性格特征（traits）简要（取最高分 trait 的中文标签），让角色气质一眼可见。
   * 无角色名时隐藏徽章（保持输入区干净）；textContent 赋值防注入。
   */
  function updateRoleBadge(): void {
    if (!roleBadge) return;
    if (!currentRoleName) {
      roleBadge.hidden = true;
      return;
    }
    roleBadge.hidden = false;
    // 可访问性：aria-label 优先于按钮内容 ⇒ 须动态拼入当前角色名，
    // 写死文案会让读屏用户丢失「现在是谁」这一关键信息（2026-10-13 徽章可点化时补）。
    roleBadge.setAttribute('aria-label', `当前角色：${currentRoleName}，点击管理角色包`);
    // 附加最高分 trait 简要（可选），让角色气质一眼可见
    const traits = currentRoleTraits;
    if (traits && Object.keys(traits).length > 0) {
      // 选择得分最高的 trait 展示，避免徽章过长
      let topKey = '';
      let topScore = -1;
      for (const [key, score] of Object.entries(traits)) {
        if (score > topScore) {
          topScore = score;
          topKey = key;
        }
      }
      if (topKey) {
        const traitLabelMap: Record<string, string> = {
          precision: '精准',
          creativity: '创意',
          rigor: '严谨',
          empathy: '共情',
          speed: '迅捷',
          stability: '沉稳',
          assertiveness: '果断',
          curiosity: '好奇',
        };
        const label = traitLabelMap[topKey] ?? topKey;
        roleBadge.textContent = `${currentRoleName} · ${label}`;
        roleBadge.title = `角色：${currentRoleName}\n性格特征：${Object.entries(traits)
          .map(([k, v]) => `${traitLabelMap[k] ?? k} ${Math.round(v * 100)}%`)
          .join('、')}`;
        return;
      }
    }
    // 无 trait 时仅显示角色名
    roleBadge.textContent = currentRoleName;
  }

  /**
   * 小组会议启动图标（角色徽章旁，单图标触发）
   *
   * 形态：Trae 风格 team SVG 图标（icons.ts），无文字。
   * 可见性：currentActiveTeam 存在且 members.length > 0 时显示（roleBadge 旁）。
   * 交互：hover 显示队员名单（title），点击 → 填充「小组会议：」前缀到输入框并聚焦。
   *
   * 数据源：currentActiveTeam 由 chat_role_pack.team 消息填充（SSOT：内核 rolePackManager.getActiveTeam 截断过滤后下发）。
   * 实现：单例引用 teamMeetingIcon（懒创建，同计划常驻条的惰性单例范式（planBarView 模块））+ 复用 icons.ts 统一图标管理。
   *      幂等：chat_role_pack 可能多次到达（replaySession 与装配后补推各一次），
   *      重复调用只切换显隐，不重复创建。
   */
  function updateTeamMeetingIcon(): void {
    if (!roleBadge) return;
    const team = currentActiveTeam;
    // 无队伍 / 非组长 → 隐藏（未创建则无需任何操作）
    if (!team || team.members.length === 0) {
      if (teamMeetingIcon) teamMeetingIcon.hidden = true;
      return;
    }
    // 首次显示才创建（lazy create，避免无队伍时白占 DOM）
    if (!teamMeetingIcon) {
      teamMeetingIcon = roleBadgeView.createTeamMeetingIcon();
    }
    // 更新队员 tooltip（角色切换时队员名单可能变）
    teamMeetingIcon.title = `小组会议 · 组长：${team.leader} · 组员：${team.members.join('、')}（点击启动）`;
    teamMeetingIcon.hidden = false;
  }

  // 滚动到底部（rAF 节流，helpers/scrollToBottom 单一实现）：流式渲染时每 chunk 都可能
  // 触发滚动，用 requestAnimationFrame 合并为每帧一次，避免强制 reflow。此处统一以 messages
  // 为滚动容器；scrollToBottom + scrollRafPending 只存在于 helpers，本地不持副本。

  // 渲染模型下拉框选项
  function renderModelPicker(): void {
    pickerView.renderPicker(modelPickerMenu, modelPickerTrigger, currentProviders, currentActive, {
      emptyText: '未配置模型',
      labelFallback: '选择模型',
      ariaLabel: '选择模型',
    });
  }

  // 追加一条消息：role 决定样式，ts 显示时间戳；AI 消息底部加「复制」（主动可见）。
  // 返回创建的 .msg 元素，供调用方作为流式锚点。
  // 跨天合并时先插入日期分隔线；AI 消息带头像身份。

  function append(
    role: 'user' | 'assistant' | 'error',
    text: string,
    ts?: string,
    roundId?: string,
    att?: UserAttachmentView,
  ): HTMLElement {
    // 日期分隔线：仅日期交界插入，先于本条消息（textContent 构建防注入）
    renderDateDivider(ts);
    if (role === 'assistant') {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      // 同轮第 2+ 段不标记 is-continued / 「↻ 续接」chip：运行时补充与问答
      // 已由独立交互条目行（.round-block__input）上屏分隔，流式断流续跑场景不存在（中断=独立新轮），
      // 且系统从未发布过同轮多段历史数据——续接视觉为零真实场景消费，整体退役（含 CSS 与测试断言）。
      // 同轮归位语义（同 roundId 段进同一 .round-group 容器）仍由 isSameRoundContinue 判——保留
      // roundId 记录为本轮标识（无 roundId 的块不覆盖，重放每轮都有）
      if (roundId) lastAssistantRoundId = roundId;
      // AI 消息：复用骨架构建（label + body），
      // 一次性消息（历史回放）直接渲染 Markdown（代码块/列表/表格可读）
      const body = buildAssistantShell(div, ts, roundId);
      // 原始文本存于 .msg 的 dataset（流式/历史共用，复制按钮据此复制完整原始 Markdown 源）
      div.dataset.rawText = text;
      body.innerHTML = renderMarkdown(text, sanitize);
      // 历史回放同样做代码块增强（语言标签 + 复制按钮）
      codeBlockEnhancer.enhance(body);
      // 流式锚点跟随最新 assistant 消息（SSOT：单一锚点，append/chunk 共用）
      activeAssistantEl = div;
      messages.appendChild(div);
      // 容器化：归位到所属 .round-group（同 roundId 段收进容器；无 roundId 留消息流）
      ensureRoundGroup(roundId, div);
      scrollToBottom(messages);
      emptyStateView.update();
      return div;
    } else {
      // 用户消息：外层包裹（气泡 + hover 操作按钮）
      const wrapper = document.createElement('div');
      wrapper.className = 'msg-wrapper';
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      // 删除锚点：user 条必须自带 ts——右键菜单「删除」与 truncateFrom 下界匹配均以它为锚。
      // assistant 走 buildAssistantShell 写入，user 分支此前漏写 ⇒ 用户条右键无「删除」。
      // roundId 仍只由 assistant 承担（分叉点语义与 hover 分叉按钮同源，不在 user 条开第二入口）。
      div.dataset.ts = ts ?? '';
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = text;
      div.appendChild(body);
      if (att) renderAttachmentStrip(div, att);
      wrapper.appendChild(div);
      // 用户消息 hover 操作区：复制图标 + 时间戳
      const actions = document.createElement('div');
      actions.className = 'msg-user-actions';
      const copyBtn = createIcon('copy', '复制消息', 'msg-copy-icon');
      copyBtn.addEventListener('click', () => copyText(text));
      actions.appendChild(copyBtn);
      const t = fmtTime(ts);
      if (t) {
        const timeEl = document.createElement('span');
        timeEl.className = 'msg-time';
        timeEl.textContent = t;
        actions.appendChild(timeEl);
      }
      wrapper.appendChild(actions);
      messages.appendChild(wrapper);
      clampUserBubble(body, div);
      scrollToBottom(messages);
      emptyStateView.update();
      return wrapper;
    }
  }

  /**
   * 用户输入恒可见兜底（SSOT 单实现）：
   * 普通 user 气泡与 qa/supp 交互行渲染失败时共用——异常不静默（console.warn 取证，复现时
   * 浏览器 Console 即定位堆栈），且以最小文本块降级渲染保证用户输入不丢。
   *
   * @param text 输入全文
   * @param err  渲染异常（仅取证，不阻断降级渲染）
   */
  function ensureUserInputVisible(text: string, err: unknown): void {
    console.warn('[memora] 用户输入渲染失败（兜底降级）', err);
    const fallback = document.createElement('div');
    fallback.className = 'msg user msg-user-fallback';
    fallback.textContent = text;
    messages.appendChild(fallback);
  }

  /**
   * 交互元素插入锚（连环 ask：单轮多 ask = 正常需求）
   *
   * 运行时同轮可多次 ask_user（连环确认）。resume 续接骨架（prepareFlowShell 建的
   * 空正文段）在用户下次回答提交时被 user(kind) 分支移除（flowShellEl.remove）→
   * activeAssistantEl 悬空回退「最后 .msg.assistant」——若改用 :last-of-type 选择器会失配：
   *   - assistant 段在同轮 .round-group 内时，:last-of-type 受容器 footer（同为 div）
   *     干扰匹配失败 → host=null → 回答行 appendChild 消息流尾 = 第二轮 QA 散落容器外
   *     （脱离同轮容器、视觉断裂，折叠收敛只靠「树序巧合」救回）；
   *   - 无容器/无 footer 的轮 → 命中首 assistant 段 → 第二轮 QA 被顶到第一轮之前
   *     （[A][问2][答2][问1][答1]，与重放 ts 序倒挂）。
   * 锚定规则：锚 = assistant 段之后**连续同轮交互元素**的末位（提问框 .ask-inline）——运行时轮内
   * 交互元素链式紧随 assistant 段（round-group 内、footer 前），遇非交互元素即停。新正文段
   * 渲染后 activeAssistantEl 已指向新段（其自身即新锚），无需维护额外状态。
   * 形态甲：QA 条目收敛进过程容器（process-flow/round-block），消息流兄弟链
   * 只余提问框；跨轮安全：纯 DOM 兄弟链判定（运行时 roundId 到 done 才回填，不依赖数据）。
   */
  function resolveInteractionAnchor(): HTMLElement | null {
    const all = messages.querySelectorAll<HTMLElement>('.msg.assistant');
    const base =
      (activeAssistantEl && activeAssistantEl.isConnected ? activeAssistantEl : null) ??
      (all.length > 0 ? all[all.length - 1] : null);
    if (!base?.parentNode) return base;
    let anchor: HTMLElement = base;
    let cur = base.nextElementSibling;
    while (cur instanceof HTMLElement) {
      if (cur.classList.contains('ask-inline')) {
        anchor = cur;
        cur = cur.nextElementSibling;
        continue;
      }
      break;
    }
    return anchor;
  }

  /** 运行时输入条目缓存（形态甲）：finalize 合并流重建 QA 的数据源（落盘分源、渲染合并投影） */
  interface RuntimeInteractiveInput {
    text: string;
    ts?: string;
    // 与内核 InteractiveInputKind 同值面（'unanswered' = 崩溃收场转化的「问了没答」行）
    kind: 'question-answer' | 'supplement' | 'timeout' | 'unanswered';
    roundId?: string;
    question?: string;
    options?: string[];
    /** 条目身份（去重键真源；ts 只作归位键）：运行时=协议 inputId，重放=内核
     *  RoundInteractiveInput.id；缺省退化按 ts 去重（单条无碍，同批共享 ts 会丢第 2..N 条） */
    id?: string;
  }
  /** 本轮运行时输入累积（新闭环重置）；finalize 由 renderRoundBlock 从合并流重建归位 */
  let runtimeInteractiveInputs: RuntimeInteractiveInput[] = [];
  /** 交互输入去重键（单点判据，渲染与统计全部消费点共用）：身份优先、缺省退化时间键。
   *  禁按 ts 单键——同批 N 条共享 ms 级 ts，第 2..N 条会被当双轨重复吃掉（ASK-MULTI-Q-1 真机实锤） */
  const qaDedupKey = (id: string | undefined, ts: string | undefined): string => id ?? ts ?? '';
  /** 骨架期交互行暂存：过程容器（flowEl/round-block）尚未建立时
   *  fallback 渲染的补充/回答行 —— 先落消息流尾保「用户输入恒可见」，待骨架建立后
   *  由 flushSkeletonPendingItems 迁移进过程容器，修复「补充选项卡贴输入框下方」
   *  的视觉错位（重启重放正常 = 重放路径容器已建，根因是运行时骨架期挂载点缺失）。 */
  let skeletonPendingItems: HTMLElement[] = [];

  /**
   * 折叠态「程序强制展开」的唯一裁决点（优先级：用户输入恒可见 > 用户意图闩）。
   *
   * 交互条目（补充/回答）归位进收起的任务项分组时强制展开——用户自己的输入被折叠
   * 隐藏 = 「发了没反应」类体验事故，可见性在此让意图闩（data-user-toggled）让位；
   * 除此之外一切程序默认值（工具行成功收起/失败展开等）一律让位意图闩（消费点 =
   * updateToolRowState）。**程序侧写 open 只允许三类：创建期默认值 / 轮块 running→finalize
   * 生命周期转换（rb.open = !finalize，一次性）/ 本点强制展开**，其余（尤其反复覆盖型
   * 状态写）必须让位意图闩。
   */
  function openForUserVisibility(el: HTMLElement): void {
    if (el.tagName === 'DETAILS' && el.classList.contains('round-block__plan-item')) {
      (el as HTMLDetailsElement).open = true;
    }
  }

  /**
   * 交互输入渲染（QA 回答 / 补充 / 超时未答）统一入口（形态甲）：
   * - 渲染为**过程条目行**（renderQaItem），按 ts 插入 process-flow / round-block 对应任务项分组
   *   （与 thought/tool 同源同序，统一时间键）；无过程容器（纯问答轮）降级消息流。
   * - 同步缓存 runtimeInteractiveInputs（finalize 合并流重建 QA 的数据源）。
   * - 异常兜底降级（ensureUserInputVisible）——交互输入即便渲染失败也恒可见。
   *
   * @param text 输入全文（timeout 时为超时通知文案，与内核落盘 content 同值）
   * @param ts 时间戳（排序键；缺失时兜底当前时刻）
   * @param kind 交互类型（question-answer=提问回答 / supplement=补充 / timeout=提问超时未答 /
   *        unanswered=「问了没答」：appendInterrupted 收场转化或 runResume 批次内跳过题）
   * @param roundId 所属轮（随 user(kind) 消息透传）
   * @param question 提问原文（qa/timeout/unanswered 携带时，条目上方渲染只读「问」回顾行）
   * @param options 候选选项（静态文本随回顾行展示）
   * @param inputId 条目身份（批内唯一去重键；缺省退化按 ts 去重，单条形态无碍）
   */
  function appendInteractiveInput(
    text: string,
    ts: string | undefined,
    kind: 'question-answer' | 'supplement' | 'timeout' | 'unanswered',
    roundId?: string,
    question?: string,
    options?: string[],
    inputId?: string,
  ): void {
    // 显示逻辑统一：supplement / question-answer / timeout / unanswered 同为
    // 「闭环内用户交互」（数据同构 interactiveInputs.kind），共用过程条目行形态，
    // 仅 tag 文案区分语义：补充 →「你补充」；回答 →「你答」；超时/中断未答 →「未回答」。
    //
    // 提问等待结束 ⇒ 先销毁提问交互 UI（ask-inline / 兜底 clarifyBar），避免「提问框 +
    // 交互行」同屏残留。判据 = **该交互行是否终结了一次提问**：question-answer（已答）/
    // timeout（超时未答）/ unanswered（中断未答）都终结；supplement 是暂停态补充，不终结。
    // ⚠ 此前只判 `timeout`：`unanswered` 原只由崩溃恢复重放产生（那时屏上无卡），
    // ADR-044 后停止路径也在运行时产生它 ⇒ 强制中断后「提问框 + 三条未回答」同屏（真机实证）。
    if (kind !== 'supplement') {
      document.querySelector('.ask-inline')?.remove();
      clarifyBar.classList.remove('visible');
      inputBar.hidden = false;
    }
    // 缓存（finalize 合并流重建 QA 的数据源；重放路径同源累积，最终态一致）
    runtimeInteractiveInputs.push({ text, ts, kind, roundId, question, options, id: inputId });
    try {
      const item = qaRowView.renderQaItem(text, kind, question, options);
      const tsKey = ts ?? new Date().toISOString();
      item.dataset.ts = tsKey;
      if (inputId) item.dataset.inputId = inputId;
      // 目标容器：运行时 process-flow > 完成态/重放 round-block 详情区 > 降级消息流（纯问答轮无过程容器）。
      // 中断轮不走特例——它的可见性由折叠块展开态保证（renderRoundBlock 的 interrupted 判据），
      // 不靠换容器：容器一旦分叉，「这条数据属于哪」就变成对 DOM 连接态的运行时嗅探。
      const flow = flowEl?.isConnected ? flowEl : null;
      const rbDetails = roundBlockEl?.isConnected
        ? roundBlockEl.querySelector('.round-block__details')
        : null;
      const root = (flow ?? rbDetails) as HTMLElement | null;
      if (root) {
        const { host } = cells.planItemContainerFor(root, currentEvents, tsKey);
        insertPlanItemInOrder(host, item, tsKey);
        // 归位宿主为任务项分组（details）时展开该分组：任务项分组默认收起，
        // 交互条目（补充/回答）被归位进收起分组内用户看不到——「任务表运行中输入补充内容不可见、
        // 结束后才见」即此因。插入即展开，保证用户输入恒可见（裁决点 = openForUserVisibility）。
        openForUserVisibility(host);
      } else {
        // 兜底：无过程容器（重放纯 QA 轮正文块未建 / 纯问答轮无过程 / 骨架期 meta 未到）落消息流。
        // 有 roundId 时打归属标记——正文块建立后经 assistant 分支的合并流重建清理回收（标记
        // 不跨重建存活，避免孤儿标记挂消息流）；否则条目散落「用户提问 ↔ 最终回答」之间且无搬运时机
        if (roundId) item.dataset.roundId = roundId;
        messages.appendChild(item);
        // 骨架期暂存：此刻 round-block/flowEl 尚未建立（meta 首 token 未到），
        // 条目只会落消息流尾——「补充选项卡贴输入框下方」的视觉错位即由此来。暂存引用，
        // 待 meta 骨架建立时由 flushSkeletonPendingItems 迁移进过程容器（重放路径容器已建，
        // 序号入 flow 不暂存，故重启重放正常）。DOM 已落消息流保「用户输入恒可见」，
        // 暂存仅作迁移引用，不重复持有 DOM。
        if (!flowEl?.isConnected && !roundBlockEl?.isConnected) {
          skeletonPendingItems.push(item);
        }
      }
    } catch (err) {
      // 交互行渲染兜底：异常不静默 + 文本降级，"用户输入恒可见"纪律统一
      ensureUserInputVisible(text, err);
    }
    scrollToBottom(messages);
    emptyStateView.update();
  }

  /**
   * 骨架期暂存条目迁移
   *
   * meta 骨架建立（prepareFlowShell 内 renderProcessFlow 后）调用：把 meta 到达前 fallback
   * 落消息流尾的交互行（skeletonPendingItems）按 ts 归位进过程容器——修正「补充选项卡直接
   * 显示在输入框下方」的骨架期挂载错位，同时保留「补充输入早于首 token」的排队语义
   * （不砍插话，只是搬到正确的容器）。
   *
   * 迁移目标与 appendInteractiveInput 正常路径同源（flow > round-block details），
   * 复用 planItemContainerFor + insertPlanItemInOrder 按 tsKey 排序插入，不破坏既有事件时序。
   * 容器仍不可用（纯 QA 轮始终无过程容器）时静默保持消息流现状——条目已渲染可见，
   * 迁移是增强不是必需，不影响「用户输入恒可见」纪律。
   */
  function flushSkeletonPendingItems(): void {
    if (skeletonPendingItems.length === 0) return;
    const flow = flowEl?.isConnected ? flowEl : null;
    const rbDetails = roundBlockEl?.isConnected
      ? roundBlockEl.querySelector('.round-block__details')
      : null;
    const root = (flow ?? rbDetails) as HTMLElement | null;
    if (!root) return; // 无过程容器：条目留在消息流（fallback 已保证可见）
    for (const item of skeletonPendingItems) {
      if (!item.isConnected) continue; // 防御：条目已被其他路径（如折叠清空）移除
      const tsKey = item.dataset.ts ?? new Date().toISOString();
      const { host } = cells.planItemContainerFor(root, currentEvents, tsKey);
      insertPlanItemInOrder(host, item, tsKey);
      // 归位进任务项分组（details）时展开该分组，保证用户输入恒可见（裁决点 = openForUserVisibility）
      openForUserVisibility(host);
    }
    skeletonPendingItems = [];
  }

  /**
   * 运行时输入条目行（形态甲）：question-answer / supplement / timeout 统一形态，
   * 对齐 thought/tool 过程行样式（非独立折叠块）。条目 = 提问回顾行（可选）+ 内容行，
   * 来源以 tag 区分（「你答 / 你补充 / 未回答」）。textContent 构建防注入。
   *
   * @param text 输入全文
   * @param kind 交互类型
   * @param question 提问原文（qa/timeout 携带时渲染「问」回顾行）
   * @param options 候选选项（随回顾行展示）
   */
  /**
   * 同轮判定：是否有 roundId 且与上一 assistant 段同轮（同一问答闭环归位判定）
   *
   * 续接**视觉**已整体退役（is-continued / 「↻ 续接」chip 全剪，见 append 注释）；
   * 本判定仅剩**结构归位**用途——chunk 到达时判骨架所属容器：
   * 同轮 → 骨架留在原 .round-group；新轮 → 建新容器（L3666 骨架归位分支）
   *
   * @param roundId 待判 roundId（chunk/消息携带；undefined 一律非同轮）
   */
  function isSameRoundContinue(roundId: string | undefined): boolean {
    return !!roundId && roundId === lastAssistantRoundId;
  }

  /**
   * 问答闭环容器：把 AI 段归位到所属 .round-group
   *
   * 同 roundId 的所有 assistant 段收进同一容器（视觉一体 + 操作整体），
   * 四路归位共用：append（重放/一次性）、beginStreaming（运行时首块）、
   * chunk 骨架复用、prepareFlowShell 骨架随 chunk 归位。无 roundId 时不建容器
   * （骨架/异常兜底直接留消息流）。
   *
   * @param roundId 该段 turn ID；无则不入容器
   * @param el      待归位的 assistant 块（如已在消息流，则搬迁进容器）
   * @param pending 是否内容未定稿（流式创建传 true，回放/一次性传 false；
   *                仅新容器首次创建时生效——已有容器的 footer 幂等跳过）
   * @returns 容器元素或 null
   */
  function ensureRoundGroup(
    roundId: string | undefined,
    el: HTMLElement,
    pending = false,
  ): HTMLElement | null {
    if (!roundId) return null;
    if (roundGroupEl?.isConnected && roundGroupEl.dataset.roundId === roundId) {
      // 段必须插在容器 footer 之前（footer 恒居容器底部；直接 appendChild 会把段放进 footer 之后）
      if (el.parentNode !== roundGroupEl) {
        const foot = roundGroupEl.querySelector('.round-group__footer');
        if (foot && foot.parentNode === roundGroupEl) roundGroupEl.insertBefore(el, foot);
        else roundGroupEl.appendChild(el);
      }
      return roundGroupEl;
    }
    // 新容器：插在该段之前（袋紧 user 提问），段移入容器
    const g = document.createElement('div');
    g.className = 'round-group';
    g.dataset.roundId = roundId;
    el.before(g);
    g.appendChild(el);
    buildRoundGroupFooter({
      group: g,
      pending,
      locked: sessionControlsLocked,
      post: (m) => vscode.postMessage(m),
    });
    roundGroupEl = g;
    return g;
  }

  /**
   * 渲染内联选择题（提问形态内联化）
   *
   * 对齐主流对话流（Claude / TraeWork）：提问正文下直接出「选项按钮 + 补充输入」，
   * 点击选项即答（无需二次回车），也可直接打字补充后发送。渲染在提问块下方，
   * 不替换底部输入栏（clarifyBar 仅异常兜底）。
   *
   * 多 ask 聚合：多提问（questions.length > 1）合并一个卡片——逐题点选/输入，
   * answers[i] 逐题累计，全部答完才可点底部「提交全部回答」一次性提交（坑：逐个点选
   * 即提交会「点一个其余被跳过」）；单问同形态（单问 = 只有一个问题的多问）。
   *
   * @param questions 提问列表（question + 候选 options，可选）
   * @returns 内联块元素；无可用 assistant 锚点时返回 null（调用方走 clarifyBar 兜底）
   */
  function renderAskInline(
    questions: { question: string; options?: string[]; allowCustom?: boolean }[],
  ): HTMLElement | null {
    // 锚点 = 同轮交互链末位（提问块/骨架/前一问答对之后；连环 ask 与回答行
    // 共用 resolveInteractionAnchor——第二次提问框须出现在第一问答对之后而非之前）；
    // 无链接（异常）返回 null 降级 clarifyBar
    const host = resolveInteractionAnchor();
    if (!host?.parentNode) return null;
    // 提问等待态：容器操作栏保持隐藏（底部只留 ask-inline 交互块，不出现「复制+时间」）。
    // 防御 interrupted 已提前移除 is-pending 的路径——提问未回答前操作栏不显示，
    // 回答 resume 完成（done）后 finalizeStreaming 再统一显示（SSOT 同态收敛）
    host
      .closest<HTMLElement>('.round-group')
      ?.querySelector<HTMLElement>('.round-group__footer')
      ?.classList.add('is-pending');
    // 光标挂起态「等待输入」：ask 预检停顿（无正文块时 no-op——纯问答轮由 ask-inline 承担可见性）
    setActiveSheetStatus('等待输入');
    // 幂等：重复提问（如连续多问/多次 turn_update 推送）先移除旧内联块，再挂新
    document.querySelector('.ask-inline')?.remove();
    const box = document.createElement('div');
    box.className = 'ask-inline';
    // 单一形态：单问 = 只有一个问题的多问，统一「逐题点选/输入 → 一次性提交」。
    // 选项点击/输入/提交逻辑单一同源（SSOT），不为单/多问分写两套。answers[i] 逐题累计。
    // **部分作答合法（ASK-PARTIAL-ANSWER-1 判据②）**：至少答一题即可提交，未答项不拦提交、
    // 在按钮上明示「将记为未回答」；提交时按提问顺序**原样**回传（未答位空串），宿主与内核
    // 均按位消费 ⇒ 位次即配对真源，压缩位次即错位。
    const answers: (string | undefined)[] = questions.map(() => undefined);
    let submitBtn: HTMLButtonElement | null = null;
    const syncSubmit = (): void => {
      if (!submitBtn) return;
      const answered = answers.filter((a) => a && a.trim().length > 0).length;
      const missing = questions.length - answered;
      submitBtn.disabled = answered === 0;
      // 只在「已答一部分」时改文案：0 答时按钮 disabled，此时喊「还有 N 题未答」是空指针式提示
      submitBtn.textContent =
        questions.length > 1 && answered > 0 && missing > 0
          ? `提交（还有 ${missing} 题未答，将记为未回答）`
          : questions.length > 1
            ? '提交全部回答'
            : '提交回答';
    };
    // 强制单选：任一题带 options 且 allowCustom=false → 全部隐藏输入框（仅限点选，语义对齐内核 ask_user）
    const forceChoose = questions.some(
      (q) => q.options && q.options.length > 0 && q.allowCustom === false,
    );
    // 每题构建：question 标题 + 选项按钮组（点选标记该题已答，可再点改选）+ 每题输入框
    for (const [i, q] of questions.entries()) {
      const item = document.createElement('div');
      item.className = 'ask-inline__item';
      const qEl = document.createElement('div');
      qEl.className = 'ask-inline__q';
      qEl.textContent = q.question; // textContent 防注入
      item.appendChild(qEl);
      if (q.options && q.options.length > 0) {
        const opts = document.createElement('div');
        opts.className = 'ask-inline__opts';
        for (const opt of q.options) {
          const b = document.createElement('button');
          b.className = 'ask-inline__opt';
          b.textContent = opt;
          b.addEventListener('click', () => {
            // 点选标记该题已答（is-selected 高亮，可再点改选），不立即提交——全部答完走底部提交按钮
            answers[i] = opt;
            opts
              .querySelectorAll<HTMLElement>('.ask-inline__opt')
              .forEach((o) => o.classList.toggle('is-selected', o === b));
            syncSubmit();
          });
          opts.appendChild(b);
        }
        item.appendChild(opts);
      }
      // 每题输入框（forceChoose 时隐藏——仅点选，见下）
      const input = document.createElement('input');
      input.className = 'ask-inline__input';
      // INPUT-LIMIT-1：ask 回答 = 短档（值真源 shared/constants.ts，与 clarifyBar 兜底输入同档）
      input.maxLength = MAX_ASK_ANSWER_CHARS;
      input.placeholder = '输入你的回答…';
      input.addEventListener('input', () => {
        answers[i] = input.value;
        syncSubmit();
      });
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') {
          // 回车即视为提交当前输入：先同步 answers[i]（免依赖先触发 input 事件），再点提交按钮
          answers[i] = input.value;
          syncSubmit();
          submitBtn?.click();
        }
      });
      if (forceChoose) input.hidden = true;
      item.appendChild(input);
      box.appendChild(item);
    }
    // 底部一次性提交按钮（initial 文案由 syncSubmit 统一决定，此处只建节点）
    submitBtn = document.createElement('button');
    submitBtn.className = 'ask-inline__submit';
    submitBtn.textContent = questions.length > 1 ? '提交全部回答' : '提交回答';
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => {
      // 🔴 位次不变量：按提问顺序原样提交，未答位传空串。旧实现 `reduce` 压掉空位 ⇒
      // 其后答案整体前移 ⇒ 宿主按位回填时「答第 2 题的文本」落到第 1 题头上（错位根因）。
      // 「未答」不是错误态：内核把空串归一为 `[ASK_ABORTED]` 占位，并在盘上落 unanswered 行。
      commitAskAnswers(answers.map((a) => (a ?? '').trim()));
      box.remove();
      scrollToBottom(messages);
    });
    box.appendChild(submitBtn);
    host.after(box);
    // 焦点：连同输入行可见时才给输入框（强制单选时无从聚焦；多问聚焦首题输入框）
    const firstInput = box.querySelector<HTMLInputElement>('.ask-inline__input');
    if (firstInput && !firstInput.hidden) firstInput.focus();
    scrollToBottom(messages);
    return box;
  }

  /**
   * 提交多问答聚合回答（ask 提交唯一入口——单/多问统一走数组）
   *
   * 与 clarifyBar 兜底的 stopClarifyAnswer 共用同一置位语义（armAskResumeAnchor，SSOT）：
   * answers 与提问按序一对一，内核 answerQuestion(answers[]) 逐条回填 tool result。
   * （clarifyBar 走单条载荷、本入口走数组载荷，仅可读性区分，职责不变。）
   *
   * @param answers 用户回答数组（按提问顺序）
   */
  function commitAskAnswers(answers: string[]): void {
    armAskResumeAnchor();
    // answer 意图恒带 answers 数组（单问=单元素），宿主 waiting(ask) 相位 answerInput 消费
    vscode.postMessage({ type: 'input', kind: 'answer', answers });
  }

  /**
   * ask 回答提交共用置位（SSOT）：resumePending + 原位续写锚
   *
   * 置 resumePending：提问后的 resume 新 runFlow meta 将识别为「同闭环续跑」，保留
   * currentEvents 与 round-block 锚点（折叠留在闭环首块，不在续接块复制）。
   * 原位续写锚对称于 paused 消息的 pausedAssistantEl 置位（单一续写锚语义，两路径同构）——
   * 否则 resume meta 落入 resumePending 分支会新建块，与当前块同 round 并存（复制条 + 锚点悬空）。
   */
  function armAskResumeAnchor(): void {
    resumePending = true;
    if (activeAssistantEl && activeAssistantEl.isConnected) {
      pausedAssistantEl = activeAssistantEl;
    }
  }

  /**
   * 构建 AI 消息骨架（label + body）
   *
   * assistant 一次性消息与流式消息共用骨架，差异仅在 body 内容（markdown 渲染 vs
   * 纯文本 + 光标）。操作行已收口容器底栏（ACTIONS-SSOT-1：段级 footer 退役）——
   * 复制 / 重新生成 / 分叉 / 删除只存在于 `.round-group__footer`，本函数不再建段级操作行。
   *
   * @param div 已创建的空 .msg.assistant 元素
   * @param ts 消息时间戳
   * @param roundId 本轮问答闭环 ID（容器归位 / 分叉锚回填用）
   * @returns body 元素
   */
  function buildAssistantShell(div: HTMLElement, ts?: string, roundId?: string): HTMLElement {
    // 顶部身份标签（极简风格）：[小圆点]角色名[·]模型名
    const label = document.createElement('div');
    label.className = 'msg-ai-label';
    // 「↻ 续接」chip 随 is-continued 视觉整体退役（见 append 注释），身份标签直连
    // 角色名：优先级 = 本轮身份（meta）→ 会话级角色（chat_role_pack），品牌色 + 小圆点
    const roleName = currentRoundMeta?.role || currentRoleName || 'AI';
    const roleEl = document.createElement('span');
    roleEl.className = 'msg-ai-label__role';
    roleEl.textContent = roleName;
    label.appendChild(roleEl);
    // 模型名：灰色小字（可选），优先级 = 本轮身份（meta）→ 会话级模型
    const modelName = currentRoundMeta?.llm || currentModelName;
    if (modelName) {
      const modelEl = document.createElement('span');
      modelEl.className = 'msg-ai-label__model';
      modelEl.textContent = modelName;
      label.appendChild(modelEl);
    }
    div.appendChild(label);
    // 报告正文：label 之后、容器底栏之前（任务过程折叠区由 ensureRoundBlock 挂在 label 与 body 之间，
    // 形成「任务过程在上 · 报告在下」；body 单一连续，不被工具切碎）
    const body = document.createElement('div');
    body.className = 'msg-body';
    div.appendChild(body);
    // 记录消息 timestamp / roundId：容器底栏经 roundFooterView.roundActionCtx 单点读取
    // （删除 / 重新生成锚 = 首段 ts，分叉锚 = 容器 roundId，缺省回退本段 roundId）
    div.dataset.ts = ts ?? '';
    div.dataset.roundId = roundId ?? '';
    return body;
  }

  // ─── 光标状态机（UI-BLOCK-ICON 批次二，方案-过程块视觉辨识-20261001.md §三定案 B）───
  // 双属性两条通道（2026-10-19 SSOT 收敛）：运行/挂起态写 data-status、终态写 data-terminus，
  // 单一语义互不覆盖。文案与样式全由 CSS 承载——
  // 挂容器上不受增量 markdown 重渲染影响（🔴 禁真实 span，会被增量渲染吃掉）。载体契约：
  // 运行态挂 .msg-body；终态有正文轮挂 .msg-body、中断轮（半截正文已删）挂宿主块（运行时
  // .msg.assistant / 重放 .is-interrupted-host）；消费方泛匹配属性，不得只查 .msg-body。

  // 挂起：软暂停/用户暂停（半截正文静态展示）

  // 终态三档均收口底栏（TERMINUS-SSOT-1，2026-10-31：error 分支退役终态写入，
  // done 携 roundStatus 投影盘面收场；detail 通道零写入退役）

  /** 活动正文块运行态写入（实时流路径统一入口：activeAssistantEl 为正文块 SSOT） */
  function setActiveSheetStatus(status: CursorStatus | null): void {
    setCursorStatus(activeAssistantEl?.querySelector<HTMLElement>(':scope .msg-body'), status);
  }

  /**
   * 运行态推导（单一入口）：优先级固定 = 工具在途 > 思考相位 > 默认回答。
   * 判定源与过程渲染同源（DOM 单查询，无第二套状态轨道）：
   * 工具在途 = 活动容器内 .is-tool-running 行 / 相位行 --tool 形态（正在执行：xxx）；
   * 思考相位 = 相位行非工具形态（.process-flow__phase，renderProcessFlow 单条维护）。
   * 挂起/终态不走此函数（paused/ask/done/error 事件分支直接设置）；
   * 仅流式中调用（streamingActive guard 由调用方保证），重放路径显式落终态。
   */
  function syncRunningCursor(): void {
    const body = activeAssistantEl?.querySelector<HTMLElement>(':scope .msg-body');
    if (!body) return;
    const scope = body.closest('.round-group') ?? messages;
    if (scope.querySelector('.round-block__tool.is-tool-running, .process-flow__phase--tool')) {
      setCursorStatus(body, '运行工具中');
      return;
    }
    if (scope.querySelector('.process-flow__phase')) {
      setCursorStatus(body, '思考中');
      return;
    }
    setCursorStatus(body, '正在回答中');
  }

  /**
   * 开始一轮流式：创建新的 assistant 消息（纯文本 body + 默认回答态光标），并置流式状态
   *
   * 首个 chunk 到达时调用（streamingActive 为 false 时）。流式期间按 markdown 增量
   * 渲染（节流）+ 八态光标；流结束后由 finalizeStreaming 收敛（清光标态 + 代码块增强）。
   *
   * @param ts 本轮流式第一条 chunk 的时间戳
   * @param roundId turn roundId（chunk 携带；供 D3 同环续接判定与骨架 roundId 回填）
   */
  function beginStreaming(ts?: string, roundId?: string): void {
    renderDateDivider(ts);
    const div = document.createElement('div');
    div.className = 'msg assistant';
    // 同轮续接视觉已整体退役（见 append 注释），此处不标记 is-continued
    if (roundId) lastAssistantRoundId = roundId;
    const body = buildAssistantShell(div, ts, roundId);
    activeAssistantEl = div;
    streamBodyRendered = false;
    messages.appendChild(div);
    // 流式开启即默认回答态（后续工具/思考事件经 renderProcessFlow → syncRunningCursor 修正）；
    // 须在 append 后写入（setCursorStatus 的 isConnected guard 要求载体已入树）
    setCursorStatus(body, '正在回答中');
    // 容器化：运行时首块归位到所属 .round-group（chunk 携带 turn roundId）
    // 流式未定稿 → 容器 footer 初始隐藏（pending=true），done/interrupted 后 finalizeStreaming 展示
    ensureRoundGroup(roundId, div, true);
    // 挂载运行时过程平铺容器（meta 已先到）：过程按任务项时序平铺（无大折叠壳）
    renderProcessFlow(currentEvents);
    scrollToBottom(messages);
    emptyStateView.update();
  }

  // ─── 流式增量 Markdown 渲染（吸收养分：对齐 TraeWork 对话流实时格式化） ───
  // 首 chunk 立即渲染（TTFT 即时反馈），后续节流重渲染（避免每 chunk 全量重绘 O(n²)）。
  // 半截子补全由 renderMarkdown 内部 fixIncompleteMarkdown 承担（代码围栏/粗体闭合），
  // 故流式期间列表/代码块实时成形，用户不再看到 **、``` 等原始记号。

  /** 流式节流重渲染间隔：>1 帧，平衡「实时感」与「重绘成本」 */
  const STREAM_RENDER_INTERVAL_MS = 150;
  /** 流式重渲染节流定时器句柄 */
  let streamRenderTimer: ReturnType<typeof setTimeout> | undefined;
  /** 本轮是否已渲染过 body（首个 chunk 立即渲染的标志） */
  let streamBodyRendered = false;

  /**
   * 把当前累积的流式原文渲染为 Markdown（消毒后安全）。
   *
   * 单容器结构：正文 = 该轮唯一 .msg-body（报告正文），整段实时增量渲染，不被工具事件切碎。
   */
  function renderStreamBody(): void {
    if (!streamingActive || !activeAssistantEl || !activeAssistantEl.isConnected) return;
    const body = activeAssistantEl.querySelector(':scope .msg-body') as HTMLElement | null;
    if (!body) return;
    body.innerHTML = renderMarkdown(streamingRaw, sanitize);
    streamBodyRendered = true;
  }

  /** 调度流式重渲染（节流：已有挂起任务则跳过，避免频繁重绘） */
  function scheduleStreamRender(): void {
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(() => {
      streamRenderTimer = undefined;
      renderStreamBody();
    }, STREAM_RENDER_INTERVAL_MS);
  }

  /**
   * 流式结束：收敛渲染 Markdown + 清光标态 + 代码块增强 + 更新复制源
   *
   * done / interrupted 消息统一调用（幂等：无流式时 no-op）。流式期间已按节流增量渲染，
   * 此处做最终收敛：清定时器 + 终渲染 + 清光标态（终态「已完成」由 done 分支随后设置，
   * 中断轮正文块整块移除无需态）+ 代码块增强；复制按钮的原始文本源同步更新为完整流式文本。
   */
  function finalizeStreaming(): void {
    // ① 段级 footer 已退役（ACTIONS-SSOT-1）：定稿显形由 settleRoundFooter 单点承载
    // （容器底栏 + roundId 锚），此处不再触碰任何操作行
    const el = activeAssistantEl;
    // ② 流式专属清理（guard 保护：非流式状态下这些动作不该执行）
    if (!streamingActive || !el || !el.isConnected) return;
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
    }
    // 单容器结构：正文 = 该轮唯一 .msg-body（报告正文），收尾一次终渲染 + 清光标态 + 代码块增强
    const body = el.querySelector(':scope .msg-body') as HTMLElement | null;
    if (body) {
      setCursorStatus(body, null);
      body.innerHTML = renderMarkdown(streamingRaw, sanitize);
      codeBlockEnhancer.enhance(body);
    }
    // 复制源更新为完整原始文本（.msg.dataset.rawText 供复制按钮读取）
    el.dataset.rawText = streamingRaw;
    streamingActive = false;
    streamingRaw = '';
    streamBodyRendered = false;
    // 定稿终渲染会增高（代码块增强给每个 <pre> 补一行 header）⇒ 收尾补一次吸底，
    // 把视野对齐到定稿后的底部。是否真滚由 helpers/scrollToBottom 的吸底标记裁决——
    // 用户上滚阅读历史时静默，不被拽走。
    scrollToBottom(messages);
  }

  /**
   * 本轮问答闭环结束后回填 roundId（fork 按钮数据锚点）。
   *
   * 流式创建时 roundId 未知 → 按钮初始禁用；host 在 done / interrupted 消息上携带本轮 roundId，
   * 此处只回填 dataset.roundId（disabled 状态由 updateSessionControlsLock 统一管理——
   * SSOT：全局锁根据 sessionControlsLocked + dataset.roundId 存在与否判定，commitRoundId 不越权）。
   * 分叉按钮点击读 dataset（SSOT 单一读取点），回填即生效。
   */
  function commitRoundId(roundId?: string): void {
    if (!roundId || !activeAssistantEl) return;
    activeAssistantEl.dataset.roundId = roundId;
    // 形态甲：QA 条目在过程容器（process-flow / round-block）内，天然归属本轮
    // assistant 块，无需消息流扫描回填（旧 .msg-qa 消息流体系已删）。
    // 回填后立即让全局锁重新评估 disabled 状态（commitRoundId 不直接设 disabled，
    // 统一走 updateSessionControlsLock 的「locked || !dataset.roundId」判定）
    updateSessionControlsLock(sessionControlsLocked);
  }

  /** 链路上 done/interrupted 共用收尾：收起任务过程折叠区（已完成态）+ 关流式光标。
   *  形态甲：finalize 全量重建（合并流含运行时输入）+ 移除运行时平铺容器——
   *  QA 已由 renderRoundBlock 从合并流归位到对应任务项分组，无需再搬运（foldPending 已删）。
   *  evidence 随收场消息透传（done/interrupted 各带一轮证据）：重建时补渲 web_search 归因
   *  三件套——运行时证据轨不进 processEvents，故必须由收场消息补入（缺口补齐）。 */
  function finalizeRound(evidence?: RoundView['evidence'], interrupted = false): void {
    // renderRoundBlock 曾在 plan_item_boundary 嵌套场景抛 NotFoundError，导致后续
    // 「移除 flowEl / 收敛 QA / 关流式光标」全部不执行（过程不折叠 + 光标不消失，且异常在事件
    // 监听器内被静默吞掉）。收口三步放 finally：即便渲染失败，流式态也必收敛（不再带伤共存）。
    // 异常本身继续向上抛（由 onMessage 兜底 console.error 观测）——兜底观测，不掩盖根因。
    try {
      // 命中明细随收场一起回填：finalize 会全量重建工具行（运行时增量挂的 DOM 被丢弃），
      // 交实时模型比证据更新（含本轮删除反馈）；同一 toolCallId 实时缺位时渲染器回退证据副本。
      renderRoundBlock(
        currentEvents,
        true,
        runtimeInteractiveInputs,
        evidence,
        currentMemoryHitsByCall,
        interrupted,
      );
    } finally {
      flowEl?.remove();
      flowEl = null;
      finalizeStreaming();
    }
  }

  /** 最近一次新闭环用户输入时间戳（删除按钮 ts 锚回填源；'user' 无 kind 分支记录，追问/回放同源） */
  let lastUserTs: string | undefined;

  /**
   * 回填删除按钮的 ts 锚（done/interrupted 后调用，与 commitRoundId 同族对齐）。
   *
   * 运行时流式轮的容器首段（骨架转正块）dataset.ts 恒空 → 容器 footer 删除按钮
   * 「锚点 = firstSeg.dataset.ts」判定恒禁用（deleteBtn.disabled = !ts），只有切面板
   * 重建（append 带 ts）才可用——「回答结束后删除按钮不可用、重渲染后可用」根因。
   * 回填锚 = 本轮用户输入 ts（delete_turn 语义同源：删除该问答及之后所有对话）。
   * 只回填数据不改 disabled，统一走 updateSessionControlsLock 的既有判定（SSOT）。
   */
  function commitTurnTs(): void {
    if (!lastUserTs) return;
    const container = activeAssistantEl?.closest<HTMLElement>('.round-group');
    const firstSeg =
      (container ? container.querySelector<HTMLElement>('.msg.assistant') : null) ??
      activeAssistantEl;
    if (firstSeg && !firstSeg.dataset.ts) firstSeg.dataset.ts = lastUserTs;
    updateSessionControlsLock(sessionControlsLocked);
  }

  /**
   * 终态容器 footer 显形（done/interrupted 的唯一收口点）
   *
   * 显形真源 = 终态消息到达，锚 = 终态消息携带的 roundId——不依赖 activeAssistantEl
   * 连通性。旧路径由 finalizeStreaming 顺带移除容器 footer 的 is-pending，前提是正文块
   * 已入容器：中断发生在首 chunk 前（骨架未归位）时 closest('.round-group') 命中 null，
   * 显形信号丢失 → 中断轮只剩停止行、无「复制整链/分叉/删除 + 时间戳」底部栏。
   *
   * - 容器已建（正文流中的 done/中断）：显形与时间戳补建一次交给
   *   `roundFooterView.settleRoundGroupFooter`（同一 `roundActionCtx` 读锚；运行时建栏时
   *   首段 dataset.ts 恒空 → 时间戳从未创建，重放路径无此问题）。
   * - 容器未建（早相位中断）：hostEl 作首段建容器（pending=false 直接显形，与重放
   *   renderInterruptedRound 同构）；hostEl 回填 roundId（骨架期无 roundId，由终态消息补）。
   * - roundId 缺失 / 无载体可挂：诚实降级不建栏——无身份锚的删除/分叉按钮是死的，
   *   不猜不伪造。
   *
   * 调用顺序契约：须在 commitTurnTs 之后（时间戳补建读首段 dataset.ts，先回填再建栏）。
   */
  function settleRoundFooter(roundId: string | undefined, hostEl: HTMLElement | null): void {
    if (!roundId) return;
    // 属性比对而非选择器直拼（roundId 进 CSS 选择器需转义；循环量级 = 可视轮数，可接受）
    const existing = Array.from(messages.querySelectorAll<HTMLElement>('.round-group')).find(
      (g) => g.dataset.roundId === roundId,
    );
    if (existing) {
      // 显形 + 时间戳补建 = roundFooterView.settleRoundGroupFooter 单点（同一 roundActionCtx 读锚）
      settleRoundGroupFooter(existing);
      return;
    }
    if (hostEl?.isConnected) {
      hostEl.dataset.roundId = roundId;
      ensureRoundGroup(roundId, hostEl, false);
    }
  }

  /**
   * 终态 footer 显形 + 其前置 commitTurnTs 收口为单操作
   *
   * 防御性收口：commitTurnTs 回填首段 dataset.ts（删除 / 重新生成共用的 ts 锚，决定轮级
   * 动作可用性——`roundActions.available` 单点判据，底栏于 `roundFooterView.roundActionCtx`
   * 读取首段 ts）。主流水路径已在渲染期写入首段 dataset.ts（底栏时间戳同期由
   * `buildRoundGroupFooter` 按首段 ds 直接生成），故当前「顺序契约」对时间戳并不构成已复现的阻断；本组合的价值在
   * 于：对任意「终态」路径保证 commitTurnTs 随 footer 显形恒执行，消除调用方需记的隐式顺序，
   * 防未来某路径（如早相位中断/暂停续跑）未在建栏前回填 ds 导致删除按钮恒禁用或时间戳缺失。
   * 属防御性收口，非修复当前已复现 bug（与「单一操作自持其前置不变量」同源）。
   *
   * @see settleRoundFooter 具体显形逻辑
   * @see roundFooterView.roundActionCtx 轮级动作锚点（首段 ts / 容器 roundId）的单一读取点
   */
  function settleRoundWithFooter(roundId: string | undefined, hostEl: HTMLElement | null): void {
    commitTurnTs();
    settleRoundFooter(roundId, hostEl);
  }

  // ── 活动状态区（三合一：P0 错误 / P1 低扰 / P2 指标）已整体外置：活动条/时间线/未读位
  // 收口于 activityDrawerView（HOST-SPLIT-1 chatView 第 4 刀，容器创建见 StatusDock 区块头部）──

  /**
   * 正文首行截断（「已沉淀」提示用）：取首行去空白，超长省略号收尾。
   * 内核 truncate 定案「宿主零消费，不挂公共面」→ 本地私有实现，不 import。
   *
   * @param text 记忆正文（可缺省：老内核 / 历史轮无 content 字段）
   * @param max 最大字符数
   * @returns 截断后的单行文本；无正文返回空串（调用方回退 name / 通用文案）
   */
  function firstLine(text: string | undefined, max: number): string {
    if (!text) return '';
    const line = text.split('\n', 1)[0].trim();
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
  }

  /**
   * 记忆命中兜底行（HOST-S3-1 落位的**降级路径**）：当前轮「本轮参考了 N 条记忆」。
   *
   * 出场条件仅两种：`memory_hits` 缺 toolCallId（老内核 / 测试直调），或配对目标工具行
   * 尚未进 DOM（时序竞态）。有配对键且行就绪的命中走 toolRowView.attachMemoryHits——
   * 两者数据源分离（byCall Map / 本函数读的兜底 Map），同一批命中不会两处同现。
   * 落位 = 当前 assistant 块内正文（.msg-body）之前；聚合更新复用同一元素
   * （isConnected 守卫防翻列表重建后孤儿引用重复插入）。
   */
  function renderMemoryHits(): void {
    const host = activeAssistantEl;
    // 无宿主块 / 聚合为空 → 摘除（新轮清缓存后的兜底，防上一轮行残留引用）
    if (!host || currentMemoryHits.size === 0) {
      memoryHitsEl?.remove();
      memoryHitsEl = null;
      return;
    }
    let el = memoryHitsEl;
    // 首挂或引用失效（块被翻列表重建）→ 新建并挂到正文之前
    if (!el || !el.isConnected) {
      el = document.createElement('details');
      el.className = 'memory-hits';
      const summary = document.createElement('summary');
      summary.className = 'memory-hits__summary';
      const icon = document.createElement('span');
      icon.className = 'memory-hits__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = getIconSvg('history', 12, 12); // 静态 SVG，无外部输入
      summary.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'memory-hits__label';
      summary.appendChild(label);
      const list = document.createElement('div');
      list.className = 'memory-hits__list';
      el.appendChild(summary);
      el.appendChild(list);
      insertBeforeBody(host, el);
      memoryHitsEl = el;
    }
    // summary 文案（N = 聚合去重后条数，textContent 防注入）
    const label = el.querySelector<HTMLElement>('.memory-hits__label');
    if (label) label.textContent = `本轮参考了 ${currentMemoryHits.size} 条记忆`;
    // 列表全量重建（事件量小，简单确定性——与 sectionOf 全量重建同构）
    const list = el.querySelector<HTMLElement>('.memory-hits__list');
    if (!list) return;
    list.textContent = '';
    for (const item of memoryHitsBlock.buildItems(currentMemoryHits)) list.appendChild(item);
  }

  // 指标信号（metricsSignalOf）与指标渲染（renderMetrics）随活动抽屉域外置
  // （HOST-SPLIT-1 chatView 第 4 刀，容器 activityDrawerView，创建见 StatusDock 区块头部）

  // ── 上下文占用域（圆环/构成条/明细）：渲染与防误清零状态收口于 contextOccupancyView
  // （HOST-SPLIT-1 chatView 第 3 刀）；防误清零判据与类型同源取型说明见该模块头 ──
  const occupancyView = createContextOccupancyView({ document });

  /**
   * 新问答闭环锚点复位（运行时 user 无 kind 分支 + 重放 renderReplayRound 共用）
   *
   * 重置同环判定 / 续跑期待 / 输入累积与骨架暂存 / round-block 与 assistant 锚点，防止跨轮挂载串位。
   */
  function resetForNewClosedLoop(): void {
    lastAssistantRoundId = undefined;
    resumePending = false;
    runtimeInteractiveInputs = []; // 新闭环：运行时输入累积重置（形态甲）
    skeletonPendingItems = []; // 新闭环：骨架期暂存重置
    roundBlockEl = null;
    roundBlockHostEl = null;
    flowEl = null; // 新闭环：运行时平铺容器引用失效
    roundGroupEl = null; // 容器化：新闭环容器另行创建
    // 解除旧轮 assistant 块锚定（防跨轮挂载串位）：新闭环后 activeAssistantEl
    // 仍指向上一轮首块，重放首块正文创建前会以它为挂载目标导致折叠区错位；置 null 待建立时重锚。
    activeAssistantEl = null;
    // 清暂停续写锚：残留会让下一轮 meta 误判 pausedResume 原位续写
    pausedAssistantEl = null;
    // 命中聚合复位（HOST-S3-1 复位完整性）：与各复位对称——meta 新轮分支虽也会清，
    // 但复位函数不得依赖「每 turn 必经 meta」这一当前时序不变量兜底（防止未来不经 meta
    // 的复位路径漏清跨会话残留）。byCall / 兜底两份模型同点清（任漏一处 = 跨轮串味）
    currentMemoryHitsByCall.clear();
    currentMemoryHits.clear();
    memoryHitsEl = null;
  }

  /**
   * 清空消息区与全部渲染状态（clear_ok + 重放渲染 renderReplayFromRounds 复用）
   *
   * 不替换 messages 全部子节点（保留 #emptyState 占位）；空态/占位刷新由调用方 emptyStateView.update 负责。
   */
  function resetChatView(): void {
    // 清空消息区须同时清 .msg、.msg-wrapper（用户消息外层壳）、.round-block、.date-divider、
    // .followup、.interrupt-divider（行内打断切分条，与 .msg 平级）、.ask-inline、.round-group、
    // .process-flow（中断轮重放孤儿平铺容器）——漏清 .msg-wrapper 会在切换/新建会话后残留空壳块。
    messages
      .querySelectorAll(
        '.msg, .msg-wrapper, .round-block, .date-divider, .followup, .interrupt-divider, .ask-inline, .round-group, .process-flow',
      )
      .forEach((el) => el.remove());
    // H4：清空/切换会话时移除任务看板（global + inline 双轨 + 缓存，避免旧计划残留污染新会话）
    planBar.removeAll();
    // 引用回复快照（COPY-2 形态优化）随会话语境清：引用挂在对话上，不跨清空/切换残留
    //（同 planBar.removeAll 的跨会话残留清理范式）；重绘 chip 行同步显隐
    quoteDraft.clear();
    renderAttachmentRow();
    // 流式锚点失效：清空/重放后由下次 append 重建（排雷 P0-1）
    activeAssistantEl = null;
    pausedAssistantEl = null;
    // 命中聚合复位（HOST-S3-1 复位完整性）：切换/清空会话时旧轮命中不得跨会话残留
    //（DOM 行随 messages 清空已摘，此处清数据侧聚合 + 引用，与 resetForNewClosedLoop 对称）
    currentMemoryHitsByCall.clear();
    currentMemoryHits.clear();
    memoryHitsEl = null;
    // 流式状态复位：清空后不再累积/渲染半截流（下次 chunk 会 beginStreaming 重建）
    streamingActive = false;
    streamingRaw = '';
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
    }
    streamBodyRendered = false;
    // 过程事件状态复位：归档兜底定时器清除 + round-block 引用失效 + 骨架清除 + 本轮缓冲清空
    clearArchivingFallback();
    roundBlockEl = null;
    roundBlockHostEl = null;
    flowEl = null;
    flowShellEl = null;
    currentEvents = [];
    // 续接状态复位：清空/切换会话后上一轮的 roundId/续跑期待/容器不再生效（防跨会话误判）
    lastAssistantRoundId = undefined;
    resumePending = false;
    // 视图复位 = 队列投影清空（新会话无插话排队，防残留长度误拦 sendMessage 预检）
    statusBars.reset(); // 待发送投影缓冲随视图复位清空（防跨会话残留误拦 sendMessage 预检）
    // 注入挂载与本轮回执一并复位（HOST-CTX-4 ③）：清空 / 切会话后旧的注入 chip 与本轮
    // 注入量都是上一会话的残留，留着会把「本轮注入 N」按到新会话第一轮头上。
    currentInjections = [];
    activeFileTokens = undefined;
    pendingActiveFileTokens = undefined;
    hideInjectionReceipt();
    renderAttachmentRow();
    // 丢弃缓冲同步清空：跨会话残留会让新会话首帧消费条目被误吞（不上屏 = 内容蒸发）
    // 丢弃缓冲随 statusBars.reset() 一并清空（见上行；原 _pendingDiscardedBuffer = []）
    roundGroupEl = null;
    lastShownDate = undefined;
    // 视图复位 = 吸底标记复位：新会话默认从底部看起。容器清空时高度塌缩未必派发
    // scroll 事件（用户已停在顶部时 scrollTop 无变化），吸底标记只由滚动事件更新，
    // 故此处显式复位，避免上轮的上滚状态残留到新会话首条长回答。
    forceScrollToBottom(messages);
  }

  /**
   * 单轮重放渲染：由 RoundView 重建该轮 DOM（用户输入 → 过程事件整批 → 中间段 → 最终回答）
   *
   * 复用既有 append / renderRoundBlock / renderInterruptedRound / appendInteractiveInput，
   * 重放与运行时共用同一渲染函数；两路轮级语义对拍（4 字段）由 runtimeReplayParity §2 守卫。
   */
  function renderReplayRound(r: RoundView): void {
    // 1) 主用户输入：先落气泡，再复位新闭环锚点
    if (r.userMessage?.content) {
      try {
        const att = { attachments: r.userMessage.attachments, attachmentUris: r.attachmentUris };
        append('user', r.userMessage.content, r.userMessage.timestamp, r.id, att);
        if (r.userMessage.timestamp) lastUserTs = r.userMessage.timestamp;
      } catch (err) {
        ensureUserInputVisible(r.userMessage.content, err);
      }
      resetForNewClosedLoop();
    }
    // 2) 过程事件整批：meta 提取 + 中断/普通分流
    const events = r.processEvents ?? [];
    if (events.length > 0) {
      clearPendingWait(); // 重放为历史渲染，等待指示器不适用
      currentEvents = [...events];
      const metaEv = events.find(
        (e): e is Extract<ProcessEvent, { type: 'meta' }> => e.type === 'meta',
      );
      if (metaEv) {
        currentRoundMeta = { role: metaEv.payload.role, llm: metaEv.payload.llm };
      }
      if (r.status === 'interrupted') {
        // 孤儿宿主容器化进 round-group：先清理上一轮孤儿宿主（防跨轮堆积残留）
        const prevInterrupted = messages.querySelector<HTMLElement>('.msg.is-interrupted-host');
        if (prevInterrupted) (prevInterrupted.closest('.round-group') ?? prevInterrupted).remove();
        flowEl?.remove();
        flowEl = null;
        renderInterruptedRound(r.id, r.evidence);
      } else {
        // 普通轮：任务过程折叠区一次性渲染（finalize=true，收起态）；证据随轮透传（web_search 行补归因）
        renderRoundBlock(currentEvents, true, undefined, r.evidence);
      }
    }
    // 3) 中间段：前序 assistant 段 + 交互输入按时间升序交织（还原打断点 / 提问点时序）
    const middle: {
      kind: 'seg' | 'question-answer' | 'supplement' | 'timeout' | 'unanswered';
      content: string;
      ts?: string;
      question?: string;
      options?: string[];
      id?: string;
    }[] = [
      ...(r.assistantLog ?? []).map((m) => ({
        kind: 'seg' as const,
        content: m.content,
        ts: m.timestamp,
      })),
      ...(r.interactiveInputs ?? []).map((i) => ({
        kind: i.kind,
        content: i.content,
        ts: i.timestamp,
        question: i.question,
        options: i.options,
        id: i.id,
      })),
    ].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    for (const item of middle) {
      if (!item.content) continue;
      if (item.kind === 'seg') {
        // 正文块建立后补挂任务过程折叠区 + 回收同轮 fallback 残留
        append('assistant', item.content, item.ts, r.id);
        renderRoundBlock(currentEvents, true, runtimeInteractiveInputs, r.evidence);
        if (r.id && roundBlockEl?.isConnected) {
          messages
            .querySelectorAll<HTMLElement>(`.round-block__input[data-round-id="${r.id}"]`)
            .forEach((el) => el.remove());
        }
      } else if (item.kind === 'unanswered') {
        // 「问了没答」行——两个生产者：appendInterrupted 收场转化 / runResume 作答批次跳过题
        //（ASK-MULTI-Q-1，正文=ASK_ABORTED_RESULT 占位，可与 question-answer 行同批交错）。
        // 只落回顾行——不置 resumePending（轮已收场，无「同闭环续跑」可言）、不收拾打断骨架（无续跑场景）
        appendInteractiveInput(
          item.content,
          item.ts,
          item.kind,
          r.id,
          item.question,
          item.options,
          item.id,
        );
      } else if (item.kind === 'question-answer' || item.kind === 'timeout') {
        resumePending = true;
        appendInteractiveInput(
          item.content,
          item.ts,
          item.kind,
          r.id,
          item.question,
          item.options,
          item.id,
        );
      } else {
        // supplement：删除打断骨架后照常落交互行
        flowShellEl?.remove();
        flowShellEl = null;
        if (pausedAssistantEl && !pausedAssistantEl.isConnected) pausedAssistantEl = null;
        clearPendingWait();
        resumePending = true;
        appendInteractiveInput(
          item.content,
          item.ts,
          item.kind,
          r.id,
          item.question,
          item.options,
          item.id,
        );
      }
    }
    // 4) 最终回答（complete 轮挂正文——中断轮正文与平铺 narrate 同源，避免双份；
    //    live 轮 = 切界面重建重放时的本流进行中轮，正文为宿主 live buffer 的 streamingText 投影，
    //    同挂才能恢复「切走前已生成的半截回答」）
    if ((r.status === 'complete' || r.live) && r.assistantMessage?.content) {
      append('assistant', r.assistantMessage.content, r.assistantMessage.timestamp, r.id);
      // 重放终态：complete 轮直接落「已完成」（与实时 done 收尾同一函数、同一形态）；
      // live 轮在下方分支切运行态推导覆盖。变量化判据 = 渲染分流（怎么画光标，非收场判定），
      // isRoundSettled 判据单源守卫按此片段登记豁免
      const settledReplay = r.status === 'complete';
      if (settledReplay) {
        setTerminus(activeAssistantEl?.querySelector<HTMLElement>(':scope .msg-body'), '已完成');
      }
      // live 轮流式状态接手：重放正文同步进 streamingRaw——finalize 终渲染以 streamingRaw
      // 为全量真源（body.innerHTML = renderMarkdown(streamingRaw)），不同步则流尾 done
      // 会用空 raw 覆盖掉重放正文；同步后后续 chunk 走增量续写分支（同环 roundId 相等），
      // 重放文本 + 增量文本无缝拼接，与运行时单块续写同一管线。
      if (r.live) {
        streamingActive = true;
        streamingRaw = r.assistantMessage.content;
        // live 轮重放接手运行态：与实时流同一推导函数（工具在途/思考相位/默认回答）
        syncRunningCursor();
      }
      renderRoundBlock(currentEvents, true, runtimeInteractiveInputs, r.evidence);
      if (r.id && roundBlockEl?.isConnected) {
        messages
          .querySelectorAll<HTMLElement>(`.round-block__input[data-round-id="${r.id}"]`)
          .forEach((el) => el.remove());
      }
    }
  }

  /**
   * 整批重放渲染：`turn_update.replay:true` 驱动
   *
   * 先复位（清旧渲染，防跨会话/重建残留，与 clear_ok 同源），再逐轮重建，收尾更新空态。
   */
  function renderReplayFromRounds(rounds: RoundView[]): void {
    resetChatView();
    for (const r of rounds) {
      renderReplayRound(r);
    }
    emptyStateView.update();
    scrollToBottom(messages);
  }

  // 处理 extension → webview 消息（流式渲染 / 状态机 / 单一过程事件 / 下拉数据）
  function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>): void {
    const msg = event.data;
    if (msg.type === 'status') {
      setStatus(msg.state);
    } else if (msg.type === 'turn_update') {
      // 2b-2b 换真源：骨架容器改由**完整 TurnState 快照**直接赋值（skeletonFromTurnState 投影
      // 剥离 roundId/RoundStatus/questions——容器不消费）。turn_update.state 即全量状态，无增量
      // 结合前值推演；宿主在流起始（running 投影）、流尾（settled/waiting）、申请在途（waiting
      // pausePending）、重放（idle/settled）等一切 turn 状态变化点推送。legacy pause_pending
      // 消息已删（宿主/webview 双端同步，申请在途统一由 turn_update.state 承载）。
      // 暂停按钮显隐只看相位（running 恒显示）——不再消费 canContinue：该判据在流启动前
      // 采样恒 false，曾导致整轮无暂停按钮（ARCH-GAP-F1，判据已从协议/投影/矩阵单点撤除）。
      applySkeletonState(skeletonFromTurnState(msg.state));
      // 待发送区渲染真源并入 turn_update 单通道（pending_queue_update 已删）。
      // pendingQueue 可选字段，缺省（旧宿主/测试构造）则不刷新待发送区（保持现状）。
      if (msg.pendingQueue) {
        statusBars.updatePendingQueue(msg.pendingQueue);
      }
      // 会话重放快照（replay:true）→ 整批渲染 rounds。
      // ⚠ 顺序契约（必须排在提问渲染之前）：renderReplayFromRounds 首行 resetChatView 会清掉
      // .ask-inline；而宿主 postTurnUpdate(undefined, true) 一条消息同时携带 replay:true 与
      // state（waiting/ask + questions）——视图重建后的 ready 握手重放、流尾补重放，都在提问
      // 挂起时到达。先渲染提问卡会被紧随的重放抹掉 → 用户看不见提问，只面对无反应的「继续」
      // 按钮（resume 被静默丢弃），提问超时后自动续跑、记录留下「未回答」——故重放先、提问卡后。
      if (msg.replay === true) {
        renderReplayFromRounds(msg.rounds);
      }
      // 提问卡渲染真源 = turn_update.state（waiting/ask + questions）。
      // 位置在重放之后是顺序契约的一部分，勿上移。
      if (
        msg.state.phase === 'waiting' &&
        msg.state.reason === 'ask' &&
        (msg.state.questions?.length ?? 0) > 0
      ) {
        renderAskPhase(msg.state.questions!);
      }
    } else if (msg.type === 'pending_discarded') {
      // 插话丢弃信号：压入缓冲，随下一帧队列快照 diff 消耗（消失条目命中缓冲 = 丢弃不上屏）。
      // 时序契约：宿主保证本事件先于携带新快照的 turn_update 到达（postMessage FIFO）。
      statusBars.pushDiscarded(msg.items);
    } else if (msg.type === 'tool_pending') {
      // 工具意图预告：LLM 流式生成 tool_call 参数期间（name 成形即上报），
      // 工具尚未执行——提前渲染「准备中」工具行。瞬态展示轨：不落 events[]、不参与
      // currentEvents（finalize 全量重建时天然消失），后续 tool_start 按 toolCallId 升级。
      renderPendingToolRow(msg);
    } else if (msg.type === 'step_boundary') {
      // 迭代落盘点（瞬态信号，与 tool_pending 同族）：本步工具宿命已定（started 已升级；
      // 截断批/重试孤儿的 tool_start 永不到达）→ 预告行注销（生命周期契约见 dropStalePendingToolRows）
      toolRow.dropStalePendingToolRows();
    } else if (msg.type === 'process_event') {
      // 运行时单形态渲染投影（v1.5）：一律汇入当前轮 events[] 由 renderRoundBlock 渲染。
      // meta 为本轮首条 → 开新轮（清缓冲 + 挂载就绪）；瞬时「已召回/已沉淀」提示由事件本地派生
      const ev = msg.event;
      if (ev.type === 'meta') {
        // 新轮/续跑判定（三态收敛）：暂停续跑（pausedAssistantEl 有效）> 交互续跑
        //（resumePending）> 真新轮。
        //   pausedResume：pause→resume 的新 runFlow meta——原位续写暂停块（不建新骨架、
        //     不重置 round-block 锚点），后续 text chunk 走 pausedAssistantEl 分支续写同一
        //     assistant 块。宿主每个 runFlow 都会重发 meta，若不处理，骨架 B 会劫持 chunk
        //     走 flowShellEl 分支 ⇒「暂停后继续 = 视觉两个独立 LLM 回答」。
        //   resumePending：交互续跑 meta 兜底（无 paused 锚点）→ 建流式骨架（qa 第 2 段块
        //     既定形态；supplement 主路径不过此——interject 无新 meta，chunk 层单块续写）。
        //   真新轮：清空当前轮缓冲与 round-block 引用，随即建流式骨架（TTFT 前即时反馈）。
        clearPendingWait(); // 骨架接管：移除等待指示器
        clearToolElapsed(); // 切轮清工具等待计时（瞬态，防跨轮残留）
        currentRoundMeta = { role: ev.payload.role, llm: ev.payload.llm };
        // 交互输入（qa/supp/timeout）不制造 turn 分段——
        // ask/补充的 resume 一律原位续写同一回合，最终「单一折叠块 + 单一报告」，与重放整 round 折叠同构。
        // `!interactiveRowInserted` 门控会把交互 resume 改走 resumePending 建续接骨架 B，
        // 把同 turn 在 DOM 上分裂成 [块A][问/答][块B]，折叠块被夹在报告中间（污染两段式），故不设门控。
        const pausedResume = pausedAssistantEl !== null && pausedAssistantEl.isConnected;
        // 有暂停锚 → 原位续写同回合（不建新段，QA/补充行作为 turn 内过程，finalize 随折叠块折入）；
        // 无锚但有续跑期待 → 兜底建骨架（qa 第 2 段块形态）；supplement 正文由 chunk 层单块续写
        if (pausedResume) {
          // 暂停原位续写：锚点（pausedAssistantEl）与 currentEvents/round-block 全保留，
          // 不建骨架——由 chunk 分支的 pausedAssistantEl 原位续写路径消费。
          // 恢复 streamingActive：暂停时置 false 导致 syncRunningCursor 被 L2304 门控挡住；
          // 不恢复则 resume 后首个 thinking/tool 事件期间光标冻结「已暂停」——
          // 必须在此处翻回 true，让 syncRunningCursor 自然放行推导运行三态
          streamingActive = true;
          syncRunningCursor();
          // 必须同时消费 resumePending：暂停态补充输入时前三态
          // 判定 pausedResume 优先、不会走到 else-if resumePending 分支 → resumePending 残留
          // true。诚实定性：当前路径 pausedResume 恒优先，残留是惰性状态（突变验证不红），
          // 但属状态不变量维护——清理纪律与 done/interrupted 对称，防未来新路径引入误判
          // （如骨架期 ask_user 回答后残留被下一个无锚点 runFlow 消费成续接骨架）。
          resumePending = false;
        } else if (resumePending) {
          resumePending = false;
          // 交互续跑 meta 兜底路径：保持建续接骨架（qa 回答后第 2 段块为既定形态，D3 固化；
          // qa 无锚窗口/异常窗口同样落此）。supplement 主路径不经此——interject 不产生新
          // runFlow meta，chunk 直达 chunk 分支的活动块原位续写判定（方案 A 单块统一）。
          // 挂载到交互链末位之后——保持 [问/你答行] → [骨架] 顺序；连环
          // ask：统一 resolveInteractionAnchor，取代全范围「最后 .msg-qa」扫描——
          // 后者在 QA 已折入 rb / 前轮残留时会跨轮误取
          prepareFlowShell({ mountAfter: resolveInteractionAnchor() ?? undefined });
        } else {
          resumePending = false; // 真新轮：清续跑期待——残留 true 会被本分支误消费成续跑（清理纪律与 done/interrupted 对称）
          currentEvents = [];
          // 新轮：命中聚合重置（HOST-S3-1）——旧轮命中行留在旧轮 DOM 随轮固定，引用置 null 防误更新
          currentMemoryHitsByCall.clear();
          currentMemoryHits.clear();
          memoryHitsEl = null;
          livePlanStates = new Map(); // 新轮：实时任务项状态重置（残留会把上轮图标投影进新轮组）
          runtimeInteractiveInputs = []; // 新轮：运行时输入累积重置（形态甲）
          skeletonPendingItems = []; // 新轮：骨架期暂存重置——残留条目已 DOM 落地，清引用即可
          roundBlockEl = null;
          roundBlockHostEl = null;
          flowEl = null; // 新轮：运行时平铺容器引用失效（随 skeleton 重建）
          clearArchivingFallback();
          currentEvents.push(ev);
          prepareFlowShell();
        }
        // 交互（qa/supp/timeout）不制造 turn 分段，resume 一律原位续写同回合
      } else {
        if (ev.type === 'memory_added') {
          // 主句 = 记忆正文首行截断（用户心智：记住了什么）；缺 content（老内核/历史轮）
          // 回退 name，再回退通用文案（不裸显 id）
          activityDrawerView.showActivity(
            'info',
            `已沉淀：${firstLine(ev.payload.content, 48) || ev.payload.name || '本轮摘要'}`,
          );
        } else if (ev.type === 'thinking') {
          // 归档停滞兜底：archiving 激活即调度超时收起呼吸点
          if (ev.payload.phase === 'archiving') {
            scheduleArchivingFallback();
          }
          // 回答等待指示器（③ 等待反馈）：meta 前（无骨架无 flow）补可见反馈——文案随
          // 相位更新（召回/处理/规划…）+ 等待秒数，避免「发送后无反应」。
          // 运行时 thinking 相位已由 process-flow 内 .process-flow__phase 行承载，
          // 故仅 flow 未创建（骨架尚未挂载）时才落 pending-wait 兜底，防双显示。
          if (!roundBlockEl && !flowEl && ev.payload.phase !== 'archiving') {
            pendingWaitPhase = phaseLabel(ev.payload.phase);
            ensurePendingWait();
          }
        } else if (ev.type === 'tool_start') {
          // TS-11c：工具开始执行 → 记起点 + 启动秒数刷新（进行中行的「已等待 Ns」）
          toolElapsedStart.set(ev.payload.toolCallId, Date.now());
          ensureToolElapsedTimer();
        } else if (ev.type === 'tool_result') {
          // TS-11c：工具结束 → 移除计时点（行内 elapsed 由 result 后的重渲/清理移除）
          toolElapsedStart.delete(ev.payload.toolCallId);
        } else if (ev.type === 'plan_item_boundary') {
          // 任务项状态实时累加（真机反馈 2026-10-01）：boundary = 内核结构化宣告
          // 「任务项开始执行」（payload.planItemId），置 active。只改本项、不动其他项
          // （未被宣告完成的项不伪造终态）；投影统一归 renderProcessFlow 尾部（单点）。
          if (ev.payload.planItemId) livePlanStates.set(ev.payload.planItemId, 'active');
        } else if (ev.type === 'plan_snapshot') {
          // 收尾终态快照（内核 clearPlanOnTurnEnd yield，先拍后清）：全量重建——终态权威，
          // 覆盖此前累加的 active（运行期从未收 plan_update 时，绿勾在收尾即时点亮而非等 finalize）
          livePlanStates = new Map(ev.payload.items.map((i) => [i.planItemId, i.status]));
        }
        currentEvents.push(ev);
        // 运行时过程平铺容器随流同步刷新（增量：narrate 冒号行 + 工具折叠行 + 思考状态）
        renderProcessFlow(currentEvents);
      }
    } else if (msg.type === 'user') {
      // 无缝插话：生成中收到用户补充 → 打断当前流式正文：结清旧块的
      // 流式态（光标/定时器），但保留块引用 —— 打断分条将插在该块之后，后续 chunk 以「续接」
      // 段出现在分条之后（还原内核 interject() 的 abort→续跑语义）
      if (streamingActive) {
        // 打断旧流必须同时清旧块光标态——旧块只是"被打断的半截回答"，此刻既非运行也非终态
        //（后续 chunk 续写时重新推导运行态）；finalizeStreaming 也不会再被调用
        setCursorStatus(activeAssistantEl?.querySelector<HTMLElement>(':scope .msg-body'), null);
        if (streamRenderTimer) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = undefined;
        }
        streamingActive = false;
        // 🔴 streamingRaw 保留（不随打断清空）：方案 A 单块续写依赖它拼接打断前正文
        // （chunk 复用活动块时增量追加，renderStreamBody 全量重建）。新建块路径不受污染
        // （beginStreaming 自行重置 streamingRaw）；done 时残留值 = 本轮正文，语义自洽。
        streamBodyRendered = false;
        // 注意：不置 activeAssistantEl = null —— 打断点引用保留给打断分条定位（见下）
      }
      // 交互输入/问答：清等待指示器（后续段形态由 chunk/meta 决定）。
      // 🔴 user 消息一律不删骨架（flowShellEl）：骨架是当前轮过程容器宿主（工具行/任务项
      // 折叠块挂其内），删除 = 过程蒸发且运行中无全量重放补回（真机实证：暂停态/插话态补充
      // 输入后运行记录消失、条目散落消息流尾、内核吸收后投影+本地兜底双份）。
      // interject「不 abort 旧流、runFlow 继续」（宿主 sendInput 契约），骨架不是空壳；
      // 骨架清理职责单一路径归 meta（prepareFlowShell 重建时清旧）/ 重放（resetChatView），
      // user 消息处理不参与。补充行归位由 appendInteractiveInput 按 flowEl.isConnected
      // 正常路径进过程容器，无兜底散落。
      clearPendingWait();
      // 在途批宿命已定（用户输入 = 插话打断/新轮起步，[TOOL_ABORTED] 同源）：
      // 未升级预告行注销（生命周期契约见 dropStalePendingToolRows）
      toolRow.dropStalePendingToolRows();
      // 带 kind 的交互输入 → 行内打断分条（supplement）/ 消息流内联子行（qa）。
      // 单轨：后续 assistant 段是否续接由 chunk 携带的 roundId 与 lastAssistantRoundId
      // 相等判定（运行时与重放同一判定源）；resumePending 供下一次 process_event meta
      // 识别「同闭环续跑」（保留 currentEvents 与 round-block 锚点，不重置）。
      // 普通新闭环输入重置同环判定 + 清续跑期待 + round-block 锚点（供新轮首块挂载）
      if (msg.kind) {
        resumePending = true;
        appendInteractiveInput(
          msg.text,
          msg.ts,
          msg.kind,
          msg.roundId,
          msg.question,
          msg.options,
          msg.inputId,
        );
      } else {
        // 用户消息渲染兜底（防「重启后首输气泡偶发缺失」）：
        // 异常不再静默——console.warn 暴露堆栈（复制发现场 Console 即可定位），且以最小文本块
        // 降级渲染保证用户输入恒可见（与带 kind 交互行共用 ensureUserInputVisible 单实现）。
        try {
          append('user', msg.text, msg.ts, msg.roundId, msg);
          // 记录本轮用户输入 ts（删除按钮 ts 锚回填源，commitTurnTs 消费）
          if (msg.ts) lastUserTs = msg.ts;
        } catch (err) {
          ensureUserInputVisible(msg.text, err);
        }
        // 新问答闭环开始：重置同环判定 + 清续跑期待 + round-block 锚点（供新轮首块挂载）。
        // 复用抽出的 resetForNewClosedLoop —— 重放渲染（renderReplayRound）同用这套重置语义，
        // 保证「新轮锚点复位」在运行时与重放路径保持一致（防跨轮挂载串位）。
        resetForNewClosedLoop();
      }
    } else if (msg.type === 'chunk') {
      // 主回答流：流式追加：目标 = 活动 assistant 锚点（SSOT），而非 messages 最后一个元素。
      // 自审查输出不再走 chunk（host 已按 text_self_review 过程事件转发，渲染进折叠区）。
      // guardrailBlocked 标记：护栏阻断文案已由内核 content 承载（[输入/输出被护栏阻断：rule]），
      // 此处不再弹硬编码 banner——避免双份提示 + 输入/输出语义错位。
      // 首个 chunk：若骨架已由 meta 建立（TTFT 前即时反馈）→ 复用该块开启正文流，否则新建
      if (!streamingActive) {
        clearPendingWait(); // 正文开启：等待指示器退场（骨架已接管）
        if (flowShellEl) {
          // 复用骨架：正文流入同一块（不新建第二条 assistant 消息）
          // 同轮归位判定（chunk 到达才有 roundId）：同轮骨架继续留在原 round-group、新轮走新容器；
          // is-continued / 「↻ 续接」chip 已随续接视觉整体退役（见 append 注释）
          if (msg.roundId) {
            lastAssistantRoundId = msg.roundId;
            flowShellEl.dataset.roundId = msg.roundId;
          }
          streamingActive = true;
          streamingRaw = '';
          const body = flowShellEl.querySelector<HTMLElement>(':scope .msg-body');
          // 骨架转正文块：运行态推导（此时无工具/思考 → 默认回答态）
          setCursorStatus(body, '正在回答中');
          // 容器化：骨架随 chunk 归位到所属容器（骨架建时无 roundId）
          // 流式未定稿 → 容器 footer 初始隐藏（pending=true），done/interrupted 后 finalizeStreaming 展示
          ensureRoundGroup(msg.roundId, flowShellEl, true);
          flowShellEl = null; // 已转化为正文块，后续插话/新轮不再特殊处理
        } else if (
          (pausedAssistantEl?.isConnected || activeAssistantEl?.isConnected) &&
          isSameRoundContinue(msg.roundId)
        ) {
          // 同轮活动块原位续写（方案 A 统一单块）：两类来源共用同一判定——
          // ① pause→resume 暂停锚块（无输入 continue）②插话前的活动正文块
          // （interject 补充后 chunk 流回原块，打断分段退役：正文单块连续，
          // 补充行在过程区不丢信息）。roundId 护栏保留：跨轮 chunk（roundId 不等
          // 或缺失）→ 走 else 新建，防跨轮挂载串位（历史事故护栏，不得放宽）。
          // streamingRaw 不重置——打断前已累积文本保留，续写增量拼接（renderStreamBody 全量重建）。
          activeAssistantEl = (
            pausedAssistantEl?.isConnected ? pausedAssistantEl : activeAssistantEl
          )!;
          pausedAssistantEl = null;
          const body = activeAssistantEl.querySelector<HTMLElement>(':scope .msg-body');
          // 暂停锚块原位续写：运行态重新推导（续写点无工具/思考 → 默认回答态）
          setCursorStatus(body, '正在回答中');
          streamingActive = true;
        } else {
          beginStreaming(msg.ts, msg.roundId);
          streamingActive = true;
          streamingRaw = '';
        }
      }
      // 报告正文持续流式写入：正文 = 该轮唯一 .msg-body（单容器结构，不被工具事件切碎）
      const target = activeAssistantEl
        ? (activeAssistantEl.querySelector(':scope .msg-body') as HTMLElement | null)
        : null;
      if (target) {
        streamingRaw += msg.content;
        // 正文流式 = 最强「正在回答」信号：覆盖思考相位态（相位行随 thinking 事件常驻，
        // 不覆盖会把流式正文误标「思考中」）；工具在途不受影响（chunk 与工具执行不同时发生）
        setCursorStatus(target, '正在回答中');
        // 流式增量渲染：首个 chunk 立即渲染（TTFT 即时反馈），后续 150ms 节流重渲染。
        // 用户实时看到 markdown 成形（列表/代码块不显示 **、``` 原始记号），对齐 TraeWork 对话流。
        if (!streamBodyRendered) renderStreamBody();
        else scheduleStreamRender();
      }
      scrollToBottom(messages);
    } else if (msg.type === 'narrate_withdraw') {
      // 回抽：首轮工具步的叙述文本会被逐字流式进正文区（消息级分类前无法
      // 预判工具轮）——内核确认工具轮后下发该段原文，此处把它从正文撤出。正文是全量重渲染自
      // streamingRaw，故去掉该后缀 + 重渲染即可（无需移 DOM 节点）；该段随即由 narrate 过程
      // 事件渲染进过程叙述行（撤正文 → 补过程，两次 post 保证顺序）。
      if (msg.text && streamingRaw.endsWith(msg.text)) {
        streamingRaw = streamingRaw.slice(0, streamingRaw.length - msg.text.length);
        renderStreamBody();
      } else if (msg.text && streamingRaw.includes(msg.text)) {
        // 防御：正文含其它文本（多轮复用块等）→ 删除最后一次出现处，防残留窜入正文
        const i = streamingRaw.lastIndexOf(msg.text);
        streamingRaw = streamingRaw.slice(0, i) + streamingRaw.slice(i + msg.text.length);
        renderStreamBody();
      }
    } else if (msg.type === 'retry') {
      // LLM 失败重试 → 低扰提示条（活动透明，对齐 UX 基线）
      activityDrawerView.showActivity('info', `LLM 调用重试 ${msg.attempt}/${msg.maxRetries}…`);
    } else if (msg.type === 'paused') {
      // Agent 暂停（输入待定/step 边界软暂停）→ 提示条
      activityDrawerView.showActivity('info', 'Agent 已暂停');
      // 记录暂停块（resume 原位续接锚）：无输入 continue 的首 text chunk 复用此块
      // 续写，避免 beginStreaming 新建第 2 个 assistant 块（视觉双回答分裂）；块 A 保留静态展示。
      if (activeAssistantEl && activeAssistantEl.isConnected) {
        pausedAssistantEl = activeAssistantEl;
      }
      // 暂停即流暂停：光标切挂起态「已暂停」（静态淡色，不撒运行态）+ 停节流定时器
      //（保留半截正文静态展示，不 finalize 终态）。
      // 提问/补充后 resume 的新 runFlow 由 meta/chunk 建续接块，本暂停块不再闪烁「调用大模型」
      if (streamingActive) {
        if (streamRenderTimer) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = undefined;
        }
        setActiveSheetStatus('已暂停');
        streamingActive = false;
      }
    } else if (msg.type === 'capability_badge') {
      // 角色能力徽章 → 更新工具权限展示
      roleBadgeView.updateCapabilityBadge(msg.toolMode, msg.capabilities);
    } else if (msg.type === 'metrics') {
      // 活动指标（透明面板 + 指纹可见）：每轮结束后刷新详情折叠区
      activityDrawerView.renderMetrics(msg);
    } else if (msg.type === 'context_occupancy') {
      // ④ 预算可视化：更新输入区常驻上下文占用条
      occupancyView.updateOccupancy(msg.occupancy);
    } else if (msg.type === 'error') {
      clearPendingWait(); // 失败即收尾，等待指示器退场
      // 先清运行态——终态与运行态两通道不得并存（2026-10-19 SSOT 收敛）。
      // 终态写入退役（TERMINUS-SSOT-1）：error 是流内事件非终态，终态归属收场消息（done 携
      // roundStatus 投影盘面）；原因显示面 = 平铺错误行；done 必达（收尾段 catch 无 return）。
      setActiveSheetStatus(null);
      // 错误收尾清理语义：error 属「可恢复流中断」，不清交互行标志——与既有收窄语义一致：
      // 交互行（qa/supp）一旦上屏，后续正文恒分块续接（interactiveRowInserted 门控
      // pausedResume），error 后继续/重试也不例外；清标志会让「交互行已插 → error →
      // resume」退回原位续写、QA 行被顶到续写正文之后（bug 复发）。标志清理归口：done /
      // interrupted / 新闭环 user / meta 消费（均已就位）——主路径 error 后宿主流收尾必发
      // done 紧随清理；error 为末条（宿主异常未发 done）时残留被下一 send 的 user 分支兜底，
      // 且 UI 无 paused 态则无 resume 入口，无触发面。
      append('error', msg.message);
    } else if (msg.type === 'done') {
      // 本轮流式结束：清除归档停滞兜底定时器 + 骨架引用（已定型为正文/异常块）
      clearPendingWait();
      clearArchivingFallback();
      flowShellEl = null;
      pausedAssistantEl = null; // 结束即收尾：暂停续接锚失效
      resumePending = false; // 同节奏清续跑期待（防中断/补充后残留污染下轮判定）
      // 顺序关键：先回填本轮 roundId（commitRoundId 同步给 QA 行补 roundId，fold 按归属过滤）→
      // 收起任务过程折叠区（finalize 全量渲染）→ 收敛 QA 行进折叠块 → 关流式
      // （QA 不留在折叠块与报告之间）
      commitRoundId(msg.roundId);
      finalizeRound(msg.evidence);
      // 终态定格（TERMINUS-SSOT-1）：标签 = 盘面轮收场投影（roundStatus）——complete=淡勾；
      // 其余（failed 收场 interrupted / 未收场 pending / 打捞保留 error）=「异常中断」红字。
      // 缺省（无 store/旧消息回放）按已完成兼容。通道分离纪律见 statusAttrs。
      setTerminus(
        activeAssistantEl?.querySelector<HTMLElement>(':scope .msg-body'),
        msg.roundStatus && msg.roundStatus !== 'complete' ? '异常中断' : '已完成',
      );
      // 回填删除按钮 ts 锚 + 容器 footer 显形收口（commitTurnTs 前置契约已内嵌于
      // settleRoundWithFooter，无需调用方记顺序——时间戳补建读首段 ts）
      settleRoundWithFooter(msg.roundId, activeAssistantEl);
    } else if (msg.type === 'interrupted') {
      // 用户主动停止（mvp-scope 打断能力）：清除归档兜底定时器 + 等待指示器同步收尾
      // ③：done/error 均清，唯独中断漏清——残留的 pending-wait 会悬挂
      // 「已等待 Ns」且 1s 定时器空转，直到下次用户输入才被清掉。
      clearPendingWait();
      clearToolElapsed(); // TS-11c：中断同样清工具等待计时（防定时器残留空转）
      clearArchivingFallback();
      flowShellEl = null;
      pausedAssistantEl = null; // 中断即放弃暂停后续写：不残留锚点给下轮
      resumePending = false; // 同节奏清续跑期待（P-1 对称：与 pausedAssistantEl 同一清理纪律）
      // 同 done 顺序纪律：先回填 roundId（供 fold 归属过滤）→ 收起任务过程折叠区 → 收敛 QA → 关流式。
      // 形态定案（与重放同构）：中断 = 掐断运行中的 step 内容（半截正文丢弃）→
      // 过程收进折叠块（保留已完成 step）→ 收尾分化（2026-10-13 终态标签收口底栏）：
      // 用户主动停止不铺行，宿主态 + 底栏「用户中断」标签承接收口；异常/兜底原因句照旧平铺。
      commitRoundId(msg.roundId);
      finalizeRound(msg.evidence, true);
      const interruptedHost = activeAssistantEl;
      if (interruptedHost?.isConnected) {
        // 丢弃半截正文（运行中 step 的内容因中断作废，与重放中断轮不显示正文同源同形）
        interruptedHost.querySelector<HTMLElement>(':scope > .msg-body')?.remove();
        // 复制源同源化（deriveNarrateText 单点，与重放 renderInterruptedRound 共用）：
        // 半截正文已删，整链复制 = 过程叙述拼接（覆盖 finalizeStreaming 刚写的半截正文 rawText）
        const narrateText = deriveNarrateText(currentEvents);
        if (narrateText) interruptedHost.dataset.rawText = narrateText;
        appendInterruptedRow(interruptedHost, currentEvents);
      }
      // 打断也可能产生部分回答：同样回填 roundId，允许从该轮分叉
      // 容器 footer 显形收口（commitTurnTs 前置契约已内嵌）：正文流中断走「容器已建」分支，
      // 早相位中断（骨架未归位）走「建容器」分支——两相位都保证中断轮有底部栏
      settleRoundWithFooter(msg.roundId, interruptedHost);
      activityDrawerView.showActivity('info', '已停止生成');
    } else if (msg.type === 'prefill_input') {
      // 角色 handoff 上下文传递：填入输入框并聚焦，不自动发送（用户可编辑后回车）
      input.value = msg.text;
      input.style.height = 'auto';
      input.focus();
      autoResize();
      syncSendEnabled(); // 程序化预填不触发 input 事件，须手动同步可用性
      syncButtonSemantics(); // 程序化预填同理不触发 input 事件，须同步按钮语义（标题随相位+输入重算），避免窗口期文案过期
    } else if (msg.type === 'focus_input') {
      // HOST-CTX-16：@ 提及 QuickPick 收场后宿主归还焦点——QuickPick 开着时焦点在它那，
      // 收场后 VS Code 不自动还给网页输入框，用户继续打字前得先点一下。只 focus 不改文本
      // （@ 撤不撤归下面 addRef 的 source='mention' 分支，两个关注点不混）。
      input.focus();
    } else if (msg.type === 'addRef') {
      // 右键「添加到对话」：接收宿主推送的文件/目录引用，挂到输入盒上方气泡行
      addRefs(msg.refs);
      // HOST-CTX-1：@ 提及通道（source='mention'）挂载成功 → 撤掉输入框里触发 QuickPick
      // 的那个 '@' 字符（否则键入的 @ 残留在正文里）。其余入口（右键等）不带 source、
      // 不撤——防止误删正文里合法的 @ 字样（如邮箱）。offset 失效（文本被编辑过）则不猜不删。
      if (msg.source === 'mention') removeMentionAt();
    } else if (msg.type === 'active_file') {
      // 活动文件投影（宿主判定结果的单向展示）：整体替换后重绘附件行。
      // 不合并、不推断——状态全是宿主的，webview 只负责画（见 activeFile 变量注释）。
      // 本轮注入数字的「认领」也在此：汇总已预备的数字归位到这一份投影（见变量注释）。
      activeFile = msg.projection;
      activeFileTokens = pendingActiveFileTokens;
      pendingActiveFileTokens = undefined;
      renderAttachmentRow();
    } else if (msg.type === 'add_injection') {
      // 注入型上下文挂载（@ 提及 QuickPick 的关键字项）：**幂等**——身份判据是来源枚举，
      // 同一 source 重复挂载恒一枚（瞬态数据每轮内容都变，按内容判重会把新一轮吞掉）。
      if (!currentInjections.includes(msg.source)) currentInjections.push(msg.source);
      // 与 addRef(source='mention') 同款：撤掉触发 QuickPick 的那个 '@'（只选关键字项时
      // 少了这一步，'@' 会当成正文一起发出去）。
      if (msg.via === 'mention') removeMentionAt();
      renderAttachmentRow();
    } else if (msg.type === 'injection_summary') {
      // 本轮注入汇总（发送后一次性回执）：先预备活动文件分项的数字给紧随的投影认领，
      // 再把合计与分项写进圆环 hover 卡片底部的回执行（分项明细同屏，不再藏 title）。
      pendingActiveFileTokens = msg.summary.segments.find(
        (s) => s.source === 'active-file' && s.injected,
      )?.tokens;
      renderInjectionReceipt(msg.summary);
    } else if (msg.type === 'plan_update') {
      // H4 任务驱动多步闭环：LLM 更新任务表 → 刷新任务看板（容器内自建/更新）
      planBar.renderBoard(msg.items);
      // 任务项组状态实时同步（单一写入点 applyPlanItemStates 的实时消费点）：
      // 看板数据即状态真源投影，同步点亮过程区任务项组图标（done 绿勾 / active 靶心）。
      // 全量重建 livePlanStates（LLM 显式表态 = 权威，覆盖 boundary 累加的 active）——
      // 后续内容事件到达时 renderProcessFlow 尾部投影同一 map，绿勾不被事件序推导抹掉。
      livePlanStates = new Map(msg.items.map((s) => [s.id, s.status]));
      // 根选择与 QA 归位同构：运行时 flow 优先，finalize 后 round-block 兜底。
      const stateRoot = flowEl?.isConnected
        ? flowEl
        : roundBlockEl?.isConnected
          ? roundBlockEl.querySelector<HTMLElement>('.round-block__details')
          : null;
      if (stateRoot) {
        cells.applyPlanItemStates(stateRoot, livePlanStates);
      }
    } else if (msg.type === 'polish_input_result') {
      // 输入框润色结果：ok=true 替换输入框内容；ok=false 提示失败
      if (msg.ok && msg.text) {
        input.value = msg.text;
        autoResize();
        syncSendEnabled(); // 程序化回填不触发 input 事件，须手动同步可用性
        syncButtonSemantics(); // 程序化回填同理不触发 input 事件，须同步按钮语义（标题随相位+输入重算）
      }
      // 恢复润色按钮状态（图标按钮，无需恢复文本）
      if (polishBtn) {
        polishBtn.classList.remove('loading');
      }
      if (!msg.ok && msg.message) {
        activityDrawerView.showActivity('info', `润色失败：${msg.message}`);
      }
    } else if (msg.type === 'clear_ok') {
      // 清空消息区与全部渲染状态（resetChatView，重放渲染 renderReplayFromRounds 复用
      // ——跨会话/重建前同样需要复位，避免旧渲染残留污染新会话）。
      resetChatView();
      emptyStateView.update();
    } else if (msg.type === 'history_loaded') {
      // 历史消息加载完成 → 强制滚到底部（不走吸底逻辑）
      // 解决多条历史消息 rAF 节流导致滚动位置不正确的问题
      forceScrollToBottom(messages);
    } else if (msg.type === 'session_title') {
      // 更新会话标题条（ADR-024 会话标题层）：textContent 防注入；
      // 切换/改名/清空后由 chatPanel 推送最新标题，标题条始终指向当前会话。
      sessionTitleText.textContent = msg.title;
    } else if (msg.type === 'session_list_data') {
      // 历史会话列表：渲染到 treedd 历史下拉菜单（全量 + 留存区标记，前端过滤分两组）
      historyMenuApi.renderMenu(msg.sessions, msg.archivedIds ?? []);
    } else if (msg.type === 'chat_archive_mode') {
      // 归档模式运行时真值：只驱动留存按钮文案（manual 模式按钮兼做归档触发）；
      // 「有数据才就地重渲染」的判断收在容器 setArchiveMode 内
      historyMenuApi.setArchiveMode(msg.mode);
    } else if (msg.type === 'chat_providers') {
      currentProviders = msg.providers || [];
      currentActive = msg.activeName;
      // 更新当前模型名（用于 AI 消息头部标签展示）
      if (currentActive) {
        currentModelName = findActiveProvider()?.displayName || currentActive;
      }
      renderModelPicker();
      // ④ 预算可视化：按当前选中 LLM 的上下文上限实时渲染占用条容量（首轮对话前即有真实上限）
      occupancyView.renderLimit(currentProviders, currentActive);
      // ⑤ 上传按钮置灰态（Q3）：唯一来源 = chat_providers 的 vision 投影，本处只转发不判
      imageCapture.setAttachEnabled(findActiveProvider()?.vision === true);
      // 无 Provider 时空态切换为「去配置模型」引导（首次使用关键路径，
      // 避免用户不知道去哪配置而卡在空态）；配置就绪后恢复角色化空态（幂等）
      if (currentProviders.length === 0) {
        emptyStateView.onboarding();
      } else {
        emptyStateView.updateRole(currentRoleName, currentRolePacks);
        emptyStateView.clearOnboardBtn();
      }
      // SSOT 收敛：身份条已删，模型名由输入区 model-picker 触发器单一展示（renderModelPicker 内更新）
    } else if (msg.type === 'chat_role_pack') {
      // textContent 赋值防注入。角色名供 AI 消息头部标签 + 空状态标题 + 输入区角色徽章共用
      // （角色切换已独立到「角色」视图）
      currentRoleName = msg.rolePack;
      currentRoleTraits = msg.traits;
      // 队伍快照：小组会议启动图标数据源（SSOT，内核 rolePackManager.getActiveTeam 截断过滤后下发）
      currentActiveTeam = msg.team ?? null;
      // 输入区左侧徽章：展示当前角色（只读状态，让用户感知当前定位）
      updateRoleBadge();
      // 小组会议启动图标：activeTeam 存在 → 显示，否则隐藏
      updateTeamMeetingIcon();
      // P3（空状态角色化）：角色切换 → 空状态标题/提示随角色生长（避免定位错位）
      emptyStateView.updateRole(currentRoleName, currentRolePacks);
    } else if (msg.type === 'chat_role_packs') {
      // 角色包列表（description 供空状态提示副文案）；切换入口已独立到「角色」视图
      currentRolePacks = msg.packs || [];
      // 若当前角色名未同步到列表（如 displayName 未收录），回退为激活角色的显示名
      if (!currentRoleName && msg.activeName) {
        const activePack = currentRolePacks.find((p) => p.name === msg.activeName);
        if (activePack) currentRoleName = activePack.displayName;
      }
      // 回退补齐后同步徽章（chat_role_packs 可能先于 chat_role_pack 到达）
      updateRoleBadge();
    } else if (msg.type === 'skills_loaded') {
      // 动态技能清单（SSOT 收紧）：与设置面板同一来源，重建下拉列表
      // `disabled` 必须随行带出——丢弃该字段会让用户通道看不出技能已禁用
      // （选它就等于静默落空）。标记仅供显示，**不做拦截**：
      // 真源判定在 host（`isSkillDisabled`），webview 若自行拒绝会在 reload 后假拒绝。
      // `description` 随行带出：菜单搜索按「名称 + 描述」匹配（载荷本有，此前消费时被丢弃）。
      skillOptions = msg.skills.map((s) => ({
        name: s.name,
        description: s.description,
        disabled: s.disabled,
      }));
      renderSkillPickerMenu();
    } else if (msg.type === 'file_changes') {
      // 未确认文件改动快照：宿主在**改动集变化**时推 + **webview ready 时补推一次**
      // （两个时机缺一即漏面——只推变化的话，面板重开后常驻条会消失）
      statusBars.updateFileChanges(msg.files);
    } else if (msg.type === 'background_tasks') {
      // 后台任务快照（宿主按事件点推、已内建内容签名去重）→ 空列表即隐藏（无任务零占用）
      statusBars.updateBackgroundTasks(msg.items);
    } else if (msg.type === 'notice') {
      activityDrawerView.showActivity(msg.level, msg.message, undefined, msg.kind);
    } else if (msg.type === 'memory_hits') {
      // HOST-S3-1 / MEM-EVENT-2：记忆命中明细（宿主透明转发内核 memoryRecalled）。
      // 降级单点：hits 缺失/空 = 4.0.x 内核不发明细 → 回落条数提示（notice 同款形态），
      // 宿主不分支（跨 dist 容错收敛在渲染层）。
      if (!msg.hits || msg.hits.length === 0) {
        activityDrawerView.showActivity('info', `LLM 查询记忆命中 ${msg.count} 条`);
      } else if (msg.toolCallId) {
        // 主路径：按 toolCallId 收进**对应那次调用**的工具折叠块（一次调用一块，块内按 id
        // 去重——同一次调用重复命中同一记忆只列一次；跨调用各算各的，不互相吞并）。
        const callId = msg.toolCallId;
        const bucket = currentMemoryHitsByCall.get(callId) ?? new Map<string, MemoryHitEntry>();
        for (const h of msg.hits)
          bucket.set(h.id, { name: h.name, source: h.source, contentPreview: h.contentPreview });
        currentMemoryHitsByCall.set(callId, bucket);
        if (!toolRow.attachMemoryHits(callId)) {
          // 目标行尚未进 DOM（时序竞态）→ 数据转入兜底聚合行：信息不丢，位置退回旧行为。
          // 必须把该 callId 在 byCall 里**置空**（不是删键）：删键会让收场重建的
          // `live ?? evidence` 落到证据副本上，同一批命中在工具块与轮次行双写；置空 =
          // 「这次调用的明细已认领，但不在行内渲染」的唯一表达，且空表下 attach 会把
          // 块/徽章一并摘除（幂等重建的空态分支）。
          currentMemoryHitsByCall.set(callId, new Map());
          for (const h of msg.hits)
            currentMemoryHits.set(h.id, {
              name: h.name,
              source: h.source,
              contentPreview: h.contentPreview,
            });
          renderMemoryHits();
        }
      } else {
        // 无配对键（老内核 / 直调）→ 轮次级聚合行（旧落位，不改行为）
        for (const h of msg.hits)
          currentMemoryHits.set(h.id, {
            name: h.name,
            source: h.source,
            contentPreview: h.contentPreview,
          });
        renderMemoryHits();
      }
    } else if (msg.type === 'memory_deleted') {
      // HOST-S3-3 反馈应答：成功 → 全局摘除该记忆（实时聚合 + 已归档轮 DOM——回看时反馈，
      // 只摘当前轮会漏）；失败 → error 提示。宿主侧「取消」不发本消息（settingsPanel 同款契约）。
      if (msg.ok) {
        currentMemoryHits.delete(msg.id);
        // 按调用分组同步摘除：收场重建从 byCall 取数，模型不清则明细会被重新挂回来
        //（表现为「删了又出现」的鬼打墙，用户视角是反馈无效）。
        for (const [callId, bucket] of currentMemoryHitsByCall) {
          if (!bucket.delete(msg.id)) continue;
          // 该调用仍有明细 → 重建块与徽章计数；已清空 → 块与徽章一并摘除（重建器内部处理空态）
          toolRow.attachMemoryHits(callId);
        }
        // 已归档轮的命中行只存在于 DOM（数据随轮固定，不在任何 Map 里）→ 按 id 全局摘除
        document.querySelectorAll<HTMLElement>('[data-memory-id]').forEach((el) => {
          if (el.dataset.memoryId === msg.id) el.remove();
        });
        renderMemoryHits(); // 兜底聚合空则整行摘除（renderMemoryHits 空态分支）
        activityDrawerView.showActivity(
          'info',
          '已反馈「无用」，记忆移入回收站（可在记忆管理中恢复）',
        );
      } else {
        activityDrawerView.showActivity('error', `反馈失败：${msg.message ?? '未知错误'}`);
      }
    } else if (msg.type === 'image_ingest_result') {
      imageCapture.applyIngestResult(msg); // 图片落盘回执（IMG-2）：chip 换真 / 转拒收态归采集层单点
    } else if (msg.type === 'image_picked') {
      imageCapture.applyPicked(msg); // 文件选择框回执（Q3）：ref 即真相建卡 / 转可见拒收 chip，同归采集层单点
    } else if (msg.type === 'write_confirm_request') {
      // H0 写入审批卡：confirmWrites 时写文件触发 → 渲染审批卡等用户裁决，回传 write_confirm_answer。
      // 多请求**不再并存**（宿主侧 FIFO 串行送审）⇒ 旧请求不会「用户看不到就超时静默拒绝」（修 S2）。
      renderWriteConfirmCard(msg);
    } else if (msg.type === 'write_confirm_closed') {
      // 请求已终结（裁决 / 超时自动拒绝）→ 收卡；requestId 不匹配即丢弃（当前卡可能已切到更新的请求）
      if (pendingWriteConfirmRequestId === msg.requestId) closeWriteConfirmCard();
    }
  }

  /**
   * 确认审批卡渲染（webview 侧唯一实现点）
   *
   * 填充卡片字段（工具名 / 目标 / 描述 / 内容预览）并显示；
   * 记录当前 requestId，供确认/拒绝按钮回传 write_confirm_answer。
   *
   * ⚠️ 本卡承载**全部四类**确认（写入 / 命令 / 代码 / 脚本执行）——文案一律用中性动词
   * （「确认」而非「确认写入」），diff 域缺省时不得渲染假的写入前后对比（见下方 hasDiff 注释）。
   *
   * @param msg write_confirm_request 载荷（host 推送）
   */
  function renderWriteConfirmCard(
    msg: Extract<ExtensionToWebviewMessage, { type: 'write_confirm_request' }>,
  ): void {
    if (
      !writeConfirmCard ||
      !writeConfirmTool ||
      !writeConfirmPath ||
      !writeConfirmDesc ||
      !writeConfirmDiff
    )
      return;
    // 全部字段用 textContent 填充（SSOT：不信任 host 输入，防注入——与消息区渲染同纪律）
    // 工具名走中文显示名单一真源（与工具行 toolActionLabel 同源）
    writeConfirmTool.textContent = getToolDisplayName(msg.tool);
    writeConfirmPath.textContent = msg.targetPath;
    writeConfirmDesc.textContent = msg.description ?? '';
    // diff 域判据归内核单点（`WriteConfirmationInfo.hasDiff` 经协议载荷透传）：
    // 仅写入场景 true；命令 / 代码 / 脚本执行（含删除文件）恒 false——宿主不再用
    // beforeContent/afterContent truthy 自猜（2026-10-03 实锤：truthy 判据属措辞折叠型带伤，
    // 判据归位内核后，即使载荷意外带内容字段也不会渲染假的写入前后对比）。
    if (msg.hasDiff) {
      // 有 diff 对比域（仅写入场景）：before 为 null 即新建文件
      const before = msg.beforeContent ?? '(新建文件)';
      writeConfirmDiff.textContent =
        before === msg.afterContent
          ? before
          : `--- 写入前 ---\n${before}\n\n+++ 写入后 +++\n${msg.afterContent ?? ''}`;
    } else {
      // 无 diff 域（命令 / 代码 / 脚本执行确认）：渲染目标摘要，绝不伪造写入前后对比
      writeConfirmDiff.textContent = `--- 目标 ---\n${msg.targetPath}\n\n${msg.description ?? ''}`;
    }
    pendingWriteConfirmRequestId = msg.requestId;
    // 退出等待态（2026-10-05 P5 落地 A）：宿主推来新 request = 上一张已终结、队列还有下一条。
    // 此处复位按钮可用性与提示——卡片**保持可见**（同DOM 覆盖内容，天然无闪烁）。
    // ⚠️ 显隐不归本函数：只 setDockActive('confirm', true)（幂等，SSOT 仍是 resolveDock）。
    exitConfirmAwaitingNext();
    // 显隐交裁决器（SSOT）：不再直写 hidden——直写会绕过 resolveDock 的主位/收纳裁决，
    // 与 B 类条同屏时顺序不定（方案 §九 A1）。
    setDockActive('confirm', true);
    // 末段倒计时（时长真源 = 宿主 timeoutMs）
    startConfirmCountdown(msg.timeoutMs);
    // 焦点落「拒绝」：composer 已被替换，焦点不能丢到 body（键盘用户会失去落点）。
    // 选拒绝而非确认是与 fail-closed 同向的安全默认（超时亦为拒绝），误触不会造成副作用。
    writeConfirmReject?.focus();
  }

  /** 末段倒计时窗口（ms）：剩余不足该值才显示倒计时，之前保持静默不打扰 */
  const CONFIRM_COUNTDOWN_WINDOW_MS = 60_000;
  /** 当前审批截止时刻（epoch ms）——由宿主透传的 timeoutMs 换算，webview 不自算时长 */
  let confirmDeadlineAt = 0;
  /** 倒计时定时器（唯一实例；关卡与 dispose 都必须清，否则跨测试污染 DOM） */
  let confirmCountdownTimer: ReturnType<typeof setInterval> | undefined;

  /** 停表 + 清空倒计时（关卡 / 新请求覆盖 / dispose 共用唯一收口） */
  function stopConfirmCountdown(): void {
    if (confirmCountdownTimer !== undefined) {
      clearInterval(confirmCountdownTimer);
      confirmCountdownTimer = undefined;
    }
    confirmDeadlineAt = 0;
    if (writeConfirmCountdown) {
      writeConfirmCountdown.hidden = true;
      writeConfirmCountdown.textContent = '';
    }
  }

  /**
   * 启动末段倒计时
   *
   * 时长**只**来自宿主载荷（timeoutMs）——真源是宿主 CONFIRM_TIMEOUT_MS；webview 自算即
   * 真源双写，末段提示会与宿主实际拒绝时刻漂移。
   */
  function startConfirmCountdown(timeoutMs: number): void {
    stopConfirmCountdown();
    const el = writeConfirmCountdown;
    if (!el) return;
    // 载荷缺 timeoutMs / 非正数 = 协议违约（真源必须由宿主透传，见 protocol.ts 该字段注释）。
    // 🔴 不得静默 return：真源一旦漂移（如宿主漏填），倒计时会无声消失——用户只见一张
    // 永不提示的卡，直到 30 分钟后突然被拒，且**无任何痕迹可查**（E2 同款病：
    // 字段进了协议零消费）。显式抛错让违约在开发期第一眼暴露，而非潜伏到真机。
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `write_confirm_request 载荷缺少合法 timeoutMs（收到 ${String(timeoutMs)}）——` +
          `超时真源在宿主 CONFIRM_TIMEOUT_MS，必须经协议透传`,
      );
    }
    confirmDeadlineAt = Date.now() + timeoutMs;
    const tick = (): void => {
      const left = confirmDeadlineAt - Date.now();
      if (left <= 0) {
        stopConfirmCountdown();
        return;
      }
      if (left > CONFIRM_COUNTDOWN_WINDOW_MS) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.textContent = `还有 ${Math.ceil(left / 1000)} 秒将自动拒绝`;
    };
    tick();
    confirmCountdownTimer = setInterval(tick, 1000);
  }

  /**
   * 关闭审批卡（唯一收口点）
   *
   * 🔴 真源已迁至宿主（2026-10-05 P5 落地 A）：卡片显隐只由本函数与 renderWriteConfirmCard
   * 两处**互斥**触发，且两处的内容源都是宿主消息——
   * ① `write_confirm_request` ⇒ 覆盖渲染（队列还有下一条，宿主协调器不推 closed）
   * ② `write_confirm_closed` ⇒ 收卡（队列已空）
   * 用户点击**不再**调本函数（改调 enterConfirmAwaitingNext），否则会造出第三处显隐写入点
   * 并造成「同步关卡 / 异步开卡」两帧空档（用户实测的闪烁，F1 重复提交窗口）。
   * 另两种调用来源：宿主推 closed（含超时兜底）、write_confirm_closed 终结。
   *
   * 注：等待态（writeConfirmAwaitingNext）**刻意不进dispose 清理**——它只改DOM 属性
   * 与 button.disabled，无定时器 ⇒ 无跨用例泄漏；dispose 时页面已销毁、清它反而多余。
   */
  function closeWriteConfirmCard(): void {
    stopConfirmCountdown();
    exitConfirmAwaitingNext();
    pendingWriteConfirmRequestId = null;
    setDockActive('confirm', false);
  }

  /**
   * 进入等待态（点击裁决后、宿主推下一条前）
   *
   * 只改**按钮可用性 + 提示 + 卡片透明度**，**不开关卡片**（显隐真源在宿主）。
   * 同时停掉倒计时（F3）：这张已裁决，倒数对它已无意义。
   */
  function enterConfirmAwaitingNext(approved: boolean): void {
    writeConfirmAwaitingNext = true;
    stopConfirmCountdown();
    // 两键同构：JS 只翻 disabled 布尔；等待态样式（cursor/opacity）由 CSS
    // `.write-confirm-card__btn[disabled]` 接管（基类静态在骨架上），样式类不进 JS。
    if (writeConfirmOk) writeConfirmOk.disabled = true;
    if (writeConfirmReject) writeConfirmReject.disabled = true;
    if (writeConfirmHint) {
      writeConfirmHint.hidden = false;
      writeConfirmHint.textContent = approved ? '已确认，等待下一条…' : '已拒绝，等待下一条…';
    }
    writeConfirmCard?.setAttribute('data-pending', 'true');
  }

  /** 退出等待态（宿主推来新的 request 覆盖渲染时，由 renderWriteConfirmCard 调） */
  function exitConfirmAwaitingNext(): void {
    if (!writeConfirmAwaitingNext) return;
    writeConfirmAwaitingNext = false;
    if (writeConfirmOk) writeConfirmOk.disabled = false;
    if (writeConfirmReject) writeConfirmReject.disabled = false;
    if (writeConfirmHint) {
      writeConfirmHint.hidden = true;
      writeConfirmHint.textContent = '';
    }
    writeConfirmCard?.removeAttribute('data-pending');
  }

  /**
   * H0 审批卡按钮事件（确认/拒绝 → 回传 write_confirm_answer + 进入等待态）
   *
   * ⚠️ 等待态期间**不再收卡**（显隐真源在宿主，见 closeWriteConfirmCard 注释）。
   * 双击由 disabled 天然挡住（F4）；pendingWriteConfirmRequestId 在等待态期间保持非空，
   * 故重复 click 事件若漏网仍会回传同一 requestId —— 宿主 pending 已 delete 会静默丢弃，
   * 但那不该发生，disabled 是第一道防线，requestId 相同只是兜底。
   */
  if (writeConfirmOk && writeConfirmReject && writeConfirmCard) {
    writeConfirmOk.addEventListener('click', () => {
      if (writeConfirmAwaitingNext) return;
      if (pendingWriteConfirmRequestId !== null) {
        vscode.postMessage({
          type: 'write_confirm_answer',
          requestId: pendingWriteConfirmRequestId,
          approved: true,
        });
        enterConfirmAwaitingNext(true);
      }
    });
    writeConfirmReject.addEventListener('click', () => {
      if (writeConfirmAwaitingNext) return;
      if (pendingWriteConfirmRequestId !== null) {
        vscode.postMessage({
          type: 'write_confirm_answer',
          requestId: pendingWriteConfirmRequestId,
          approved: false,
        });
        enterConfirmAwaitingNext(false);
      }
    });
  }

  /**
   * message 事件监听入口：唯一职责 = 异常兜底 + 可观测输出。
   *
   * 背景：webview 事件监听器内的异常会被宿主**静默吞掉**（既不向 dispatchEvent 传播，也不进
   * 宿主日志），用户只见现象（任务过程不折叠 / 流式光标不消失）不见任何报错——F2 的 NotFoundError
   * 正是这样藏了整轮。此处统一 console.error 暴露堆栈（复制 Extension Host 的 Console 即可定位
   * 现场），纪律同源：既有用户输入渲染兜底「异常不再静默」（见 ensureUserInputVisible 调用点）。
   *
   * 注意：这里只做观测兜底，**不掩盖根因**——根因由 insertPlanItemInOrder 直接子节点限定根治。
   */
  function onMessage(event: MessageEvent<ExtensionToWebviewMessage>): void {
    try {
      handleMessage(event);
    } catch (err) {
      // 既有观测兜底保留（根因定位靠 Extension Host Console，不掩盖）——补用户侧非阻断红条，
      // 避免「渲染抛异常 → 冻住/半成品 UI + 零报错」的可见性黑洞（观察点③）。
      console.error('[chatView] 消息处理异常（已兜底，UI 可能不完整）：', err);
      activityDrawerView.showActivity('error', '界面渲染异常，详情见开发者控制台');
    }
  }

  window.addEventListener('message', onMessage);

  // 选区复制兜底（Layer A）：挂一次即可，幂等。修复「选中对话记录后 Ctrl+C /
  // 右键 Copy 复制不出」——原生复制在 WebviewView 不可靠，本 guard 在 copy 事件
  // 同步写盘；输入区 <textarea> 选区不计入 getSelection ⇒ 自动放行原生复制。
  installSelectionCopyGuard();

  // textarea 自适应高度（Enter 发送 / Shift+Enter 换行）
  // SSOT：高度上限单一真理源 — 从 CSS 令牌(--input-max-h)的计算值读取，
  // JS 与 CSS 共用同一上限，杜绝双源漂移。
  // overflow 动态切换：空内容/未满高时 hidden（无滚动条轨道），超限才 auto
  const inputMaxHeight = parseInt(window.getComputedStyle(input).maxHeight, 10) || 180;
  function autoResize(): void {
    input.style.height = 'auto';
    const h = Math.min(input.scrollHeight, inputMaxHeight);
    input.style.height = h + 'px';
    // 仅当内容超过最大高度时才显示滚动条
    input.style.overflowY = input.scrollHeight > inputMaxHeight ? 'auto' : 'hidden';
  }
  function sendMessage(): void {
    // ask 等待期：composer 不承担答题——内核 answerQuestion 按序一对一，单条文本只能配
    // 第 1 题、其余题落 [ASK_ABORTED] 占位（多题必错），单题时又与内联卡完全重复。
    // 故提交一律拒收并指引内联卡（文本保留在框内，不清空 = 不背刺）。
    // 判据只读骨架相位、不含题数：webview 是第一道呈现拦截，宿主 sendInput 同判据兜底
    //（旧 bundle / 竞态漏网）。停止能力不受影响——■ 仍走 stop 分支（内核收场本轮）。
    if (skeletonState.phase === 'waiting' && skeletonState.reason === 'ask') {
      activityDrawerView.showActivity(
        'info',
        '提问等待中——请在上方提问卡逐题作答；不答可点 ■ 停止本轮',
      );
      return;
    }
    // 引用回复快照（COPY-2 形态优化）：此处**只读**，真正消费必须在三条早退之后——
    // 提前 consume 会让「插话满员 / 图片 blocked / 整轮限额」拒发时静默吞掉引用
    //（快照已清、胶囊仍挂屏 = DOM 与状态分叉，用户重发得重新右键选中）。
    const raw = input.value.trim();
    // IMG-10（2026-10-29 拍板：纯图不激活发送）：拦下是既定行为，但**必须说明原因**——
    // 按钮灰着 + Enter 无反应会被读成「按键失灵」；有无候选图只有采集层知道，故判据外置。
    // 空判据含引用快照：正文为空但挂着引用也算有载荷（引用块本身即内容）。
    if (!raw && !quoteDraft.get()) return imageCapture.explainEmptySend();
    // 插话满员预检（INPUT-LIMIT-1）：满员时宿主整条拒收，若先清框用户文本随警告消失（丢内容=背刺）
    // ⇒ **清框前**用队列投影预检，满员即拒发。paused 带补充 / done 走 chat 不入队，不预检（宿主闸门兜底）。
    const isInterjectRoute = deriveSessionUiState(skeletonState) === 'thinking';
    if (isInterjectRoute && statusBars.getPendingCount() >= MAX_PENDING_INTERJECTIONS) {
      activityDrawerView.showActivity(
        'info',
        `待发送已满 ${MAX_PENDING_INTERJECTIONS} 条——先在待发送区删减，本条仍保留在输入框`,
      );
      return;
    }
    // 图片发送交付（IMG-2）：取图唯一出口 = 采集层（含 D13 判据）；有图发不出去整条拦下并保留输入框与 chip。
    const sendable = imageCapture.resolveSendable(isInterjectRoute);
    if ('blocked' in sendable) {
      activityDrawerView.showActivity('info', sendable.blocked);
      return;
    }
    // IMG-8 整轮预检（清框前）：三维聚合限额（张数/总字节/token），越界 ⇒ 拒发给数字并保留输入框与 chip
    const turnCheck = imageCapture.checkTurnLimits(findActiveProvider()?.limitTokens);
    if (!turnCheck.ok) return activityDrawerView.showActivity('info', turnCheck.message);
    // 提交点（三条早退已全过）：此刻才展开引用块并**消费**快照（consumeFor = 拼接 + 清状态单点）
    const text = quoteDraft.consumeFor(raw);
    input.value = '';
    input.style.height = 'auto';
    input.style.overflowY = 'hidden';
    // 清输入框后按钮语义也要重算（hasInput 变了）
    syncButtonSemantics();
    syncSendEnabled();
    // 构建消息：send 意图单消息，宿主按相位路由到 chat / interject / 带文本续跑；技能按名注入
    const payload: WebviewToExtensionMessage = {
      type: 'input' as const,
      kind: 'send' as const,
      text,
      ...(currentSkill ? { skillName: currentSkill.name } : {}),
      ...(currentRefs.length
        ? {
            refs: currentRefs.map((r) => ({
              path: r.path,
              kind: r.kind,
              ...(r.range ? { range: r.range } : {}),
            })),
          }
        : {}),
      // 注入型上下文（HOST-CTX-4 ④）：**只声明通道**，不携带任何内容——数据此刻还没取，
      // 宿主收到后在发送时刻采集（保证模型看到的是最新一份）。
      ...(currentInjections.length ? { injections: [...currentInjections] } : {}),
      // 图片附件（IMG-2）：只带已落盘的真值 `ref`（取图单点见上方 resolveSendable）
      ...(sendable.refs.length ? { attachments: sendable.refs } : {}),
    };
    vscode.postMessage(payload);
    // 注入 chip 发送后无条件清（HOST-CTX-4 ③）：瞬态数据无「钉住」语义，留着等于每轮悄悄塞一份
    currentInjections = [];
    activeFileTokens = pendingActiveFileTokens = undefined;
    hideInjectionReceipt();
    // 引用发送后处置（判据 = chip 的 pinned）：未钉住的即消费清除；钉住的常驻，下一轮仍随消息发出
    currentRefs = currentRefs.filter((r) => r.pinned);
    renderAttachmentRow();
    // 图片 chip 发送后整批收场（IMG-2）：留着会变成下一轮的重复附件（图已在数据目录）
    if (sendable.refs.length > 0) imageCapture.clear();
    // 技能同一 pinned 判据：默认钉住常驻（锁预开）⇒ 发送不清除；updateSkillPickerLabel 内含重绘
    if (currentSkill && !currentSkill.pinned) {
      currentSkill = null;
      updateSkillPickerLabel();
    }
  }
  // 发送按钮：空闲 = 发送；生成中 = 停止（按钮已切为停止方块）；暂停中 = 继续。
  // 生成中插话走 Enter（见下方 keydown，不经此分支）。
  send.addEventListener('click', () => {
    if (send.classList.contains('loading')) {
      vscode.postMessage({ type: 'stop' });
    } else {
      // done / thinking + 有输入：统一走 sendMessage，宿主按 turn 相位路由
      sendMessage();
    }
  });
  // pauseBtn 双态语义：thinking 发 pause（暂停 / 取消暂停）；paused 发 resume（继续，或带补充续跑）。
  pauseBtn?.addEventListener('click', () => {
    if (deriveSessionUiState(skeletonState) === 'paused') {
      // paused 态：根据输入框内容决定是纯续跑还是带补充续跑
      if (input.value.trim()) {
        // 有输入：走 sendMessage（宿主层根据状态路由到 resumeExecution 带补充）
        sendMessage();
      } else {
        // 空输入：纯续跑
        vscode.postMessage({ type: 'input', kind: 'resume' });
      }
    } else {
      // thinking 态：暂停 / 取消暂停（宿主 handlePause 根据 isPausePending 自动切换）
      vscode.postMessage({ type: 'pause' });
    }
  });
  /**
   * HOST-CTX-1：@ 提及触发点（键入 @ 时的光标位，用于挂载成功后精准撤除该字符）
   *
   * 声明**先于**下方 keydown 监听器注册（HOST-CTX-11：曾置于监听器之后，虽因回调晚于
   * 声明执行而运行时安全，但任何在「注册监听」与「声明」之间插入的同步派发都会踩 TDZ
   * 崩——声明挨着使用点放，不赌执行时序）。
   */
  let mentionTriggerOffset: number | null = null;

  input.addEventListener('keydown', (e) => {
    // isComposing 守卫：中文输入法组合确认（如打字中途按 Enter 选字）不误触发发送
    if (e.isComposing) return;
    // HOST-CTX-1：键入 @ → 请求宿主开文件 QuickPick（多选，选中即挂引用 chip，不注入内容）。
    // '@' 先留在正文（用户 Esc 取消时文本无扰动、想打 @ 字符零骚扰）；宿主确认挂载
    // （addRef source='mention'）后才按触发点撤除。默认的 Enter 发送分支不受影响。
    if (e.key === '@') {
      // selectionStart 在 keydown 期 = '@' 尚未落入文本（keydown 先于字符插入），
      // 故触发点就是当前光标位；记录之，mention_attached 时按此处撤除。
      mentionTriggerOffset = input.selectionStart;
      vscode.postMessage({ type: 'mention_open' });
      return; // 不 preventDefault：让 '@' 正常落入文本（取消场景文本无扰动）
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', (e) => {
    autoResize();
    // 输入内容变化时，按钮语义（classList 图标）和 disabled 态都要重算
    syncButtonSemantics();
    syncSendEnabled();
    // HOST-CTX-13：@ 提及的**兜底触发路径**（中文输入法 / 粘贴）。
    // 根因：上方 keydown 路径的判据是 `e.key === '@'`——那是**按键事实**，依赖键盘布局与 IME 行为。
    // 中文输入法插入的 @ 不保证走这条路（IME 可能吞掉 keydown 或上报 'Process'/'Unidentified'），
    // 粘贴 @ 则根本不产生 keydown ⇒ 真机实测「需要英文 @ 才有反应」。判据改为**文本事实**：光标前一个字符恰为 '@'。
    // 为何两条路径并存（而非只留 input）：keydown 期 selectionStart 即 '@' 落点（字符尚未插入），offset 语义直接；
    // input 期字符已插入，要减 1。保留 keydown 作快路径，input 兜住它漏掉的场景。双触发由宿主
    // `_mentionQuickPickOpen` in-flight 守卫拦掉（HOST-CTX-11 的守卫在此成为复用地基——不新建第二套防抖机制）。
    // 为何要 inputType 判据：删除文本同样触发 input，若光标恰好停在 '@' 前会把「删到 @ 前面」误判成「插入 @」。
    // 只认 insert 家族（insertText / insertCompositionText / insertFromPaste / …）即可精确表达「刚刚有个字符被放进来」。
    const ie = e as InputEvent;
    if (typeof ie.inputType === 'string' && ie.inputType.startsWith('insert')) {
      const at = input.selectionStart - 1;
      if (at >= 0 && input.value[at] === '@') {
        mentionTriggerOffset = at;
        vscode.postMessage({ type: 'mention_open' });
      }
    }
  });

  /**
   * HOST-CTX-1：撤掉触发 @ 提及的那个 '@' 字符（宿主确认挂载后调用）
   *
   * 判据（不猜）：触发时记录的光标位有效、该位置**恰好是 '@'**——keydown 期
   * selectionStart 就是 '@' 的落点（尚未落入），故直接按索引比对；文本已被用户编辑过
   * （offset 失效）时原样不动。只删一个字符，恢复光标到删除位。
   *
   * HOST-CTX-11 订正「判据三重」的夸大：三条 guard 里真正带语义的**只有落点校验**
   * （`input.value[at] !== '@'`）——另两条（null / 越界）删掉行为等价：`at` 为 null 或
   * 越界时 `input.value[at]` 得 undefined，落点校验同样拦住。故守卫强度配得上「缺一不删」
   * 的只有第三条，而它此前**零测试**（实测：删掉该行 → chatView 448 例全绿）。测试已补
   * （offset 失效 / 越界两例），此处保留前两条是廉价纵深，不是「三重」同权。
   */
  function removeMentionAt(): void {
    const at = mentionTriggerOffset;
    if (at === null || at < 0 || at >= input.value.length) return; // 无记录 / 越界：不猜（纵深，等价于落点校验）
    if (input.value[at] !== '@') return; // 落点已变（用户编辑过）：不猜（唯一语义判据，有守卫）
    input.value = input.value.slice(0, at) + input.value.slice(at + 1);
    mentionTriggerOffset = null; // 一次性：撤完即清，防后续 addRef 误删同一位置
    input.focus();
    const caret = at;
    input.setSelectionRange(caret, caret);
    autoResize();
    syncSendEnabled();
    syncButtonSemantics();
  }

  // 历史菜单（会话记录 / 留存区）：渲染、分组与搜索状态收口于 historyMenuView（HOST-SPLIT-1
  // chatView 第 2 刀，域外置工厂；开合/外部收起/Escape/条目委托由 initDropdowns treedd 组件
  // 管理，本域只管数据——协作与分组形态论证见该模块头）。tab/search 监听随元素归属入容器
  //（方案 §2.2 判据）；historyBtn 监听留本文件：同元素双监听器（treedd 开合）顺序敏感，原位置零变化。
  const historyMenuApi = createHistoryMenuView({
    document,
    menuEl: historyMenu,
    tabRecent: historyTabRecent,
    tabArchived: historyTabArchived,
    archivedCountEl: historyArchivedCount,
    searchInput: historySearch,
    postMessage: (msg) => vscode.postMessage(msg),
  });

  // 标题条按钮：改名笔 / 新建「＋」（分叉统一收敛到消息底部——任意 LLM 回答处可分叉，标题条不再冗余入口）
  renameSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'rename_request' }));
  newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'new_session' }));
  // 历史按钮：开合由 treedd 管理（initDropdowns），本层只负责「打开时重置浏览态并请求最新列表」
  //（动作体收口于容器 openFresh；「视图重置挂打开时机、不挂数据下发」的论证见容器模块头 ②）
  historyBtn.addEventListener('click', () => {
    historyMenuApi.openFresh();
  });

  // 任务常驻条（合并单轨）：点击头部展开/收起锚定浮层；浮层轻交互——
  // 点击浮层外区域收起（非 modal：看进度时需同时看正文，故不遮罩全屏）。
  // 监听器**留在本文件**：注册时机与顺序保持原样（匿名监听器原本就未随 dispose 移除），
  // 拆分刀不改时序面，只把内部调用换成容器窄接口。
  const planBarHead = document.getElementById('planBarHead');
  planBarHead?.addEventListener('click', () => {
    planBar.toggleExpanded();
  });
  document.addEventListener('click', (e) => {
    if (planBar.isExpanded() && !planBar.containsTarget(e.target as Node)) {
      planBar.collapse();
    }
  });
  // Esc 收起对齐 dropdown 族键盘契约（dropdown.ts 同款）：展开态任意焦点位置均可关，
  // 仅展开态生效，不干扰输入框（输入框 Esc 无既有语义）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && planBar.isExpanded()) {
      planBar.collapse();
    }
  });

  // 空状态示例提问 chips：点击填入输入框并聚焦。
  // 事件委托于 document，兼容 emptyStateView 动态渲染的 chips（角色切换后新增元素）。
  function onDocumentClick(e: Event): void {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.suggestion-chip');
    if (!chip) return;
    const prompt = chip.dataset.prompt || '';
    input.value = prompt;
    input.style.height = 'auto';
    input.focus();
    autoResize();
    syncSendEnabled(); // 程序化回填不触发 input 事件，须手动同步可用性
    syncButtonSemantics(); // 程序化回填同理不触发 input 事件，须同步按钮语义（标题随相位+输入重算）
  }
  document.addEventListener('click', onDocumentClick);

  // 用户折叠意图闩（单一写入点）：点击 summary = 用户接管该 details 的开合。
  // 此后程序默认值（工具行成功收起/失败展开等）不得再覆盖该块的 open——
  // 覆盖消费点见 updateToolRowState；键盘激活 summary 同样派生 click，一并覆盖。
  document.addEventListener('click', (e) => {
    const summary = (e.target as HTMLElement | null)?.closest?.('summary');
    const details = summary?.closest('details');
    if (details) details.dataset.userToggled = 'true';
  });

  // 下拉菜单：显式回调映射替代原 window.__xxx 全局函数名（去全局污染）
  // 键名与 buildDropdownHtml 的 data-on-select 属性值一一对应。
  // toolbar 为模型选择器（角色切换独立到「角色」视图）
  initDropdowns(document, {
    __modelPickerOnSelect: (id) => vscode.postMessage({ type: 'chat_set_provider', name: id }),
    // 历史下拉：条目（.treedd__item）点击 → 加载该会话（host 切入并回放，SSOT 剪枝 v2）
    __historyOnSelect: (id) => vscode.postMessage({ type: 'switch_session', sessionId: id }),
    // Skill 下拉：选择真实技能名后设为当前 skill（SSOT 收紧，与设置面板同一清单；发送时传技能名走内核）
    __skillPickerOnSelect: (id) => {
      const found = skillOptions.find((s) => s.name === id);
      if (found) {
        // 随行带出 disabled（选择时刻的快照）——仅供 chip 显示提示，
        // 发送时的**判定**仍由 host 真源（`isSkillDisabled`）负责，webview 不拦截。
        // 新挂载 = 锁预开常驻（pinned 默认 true，与「skill 发送后不消失」的既有行为一致）
        currentSkill = { name: id, disabled: !!found.disabled, pinned: true };
        updateSkillPickerLabel();
      } else if (id === '__clear_skill') {
        currentSkill = null;
        updateSkillPickerLabel();
      }
    },
  });

  // ─── 右键语义菜单（COPY-2 · Layer B）───
  // 项表外置 `components/contextMenuItems`：表是数据（8 条 when/run），长在视图函数体里会与
  // prettier / max-lines 互相顶牛。此处只注入依赖；场合命中判据仍在 resolveContextMenuCtx 单点。
  // 锁态用**取值函数**而非布尔快照——菜单在弹出时判定，快照会按打开前的旧态显示。
  const contextMenuController = initContextMenu(
    document,
    createContextMenuItems({
      copy: copyText,
      quoteReply: (t) => {
        quoteDraft.set(t);
        renderAttachmentRow();
        input.focus();
      },
      post: (m) => vscode.postMessage(m),
      isLocked: () => sessionControlsLocked,
    }),
  );

  // 角色徽章点击 → open_settings_tab(roles)（host 打开设置面板「角色」选项卡，导航单点）。
  // 拍板 2（2026-10-13）：**运行时不禁用**——跳界面不改变任何状态，禁 = 挡无害操作；也不挂
  // updateSessionControlsLock 收口——该锁语义 = 「运行时禁用改变会话结构的操作」（新建/切历史/
  // 删除），导航不属于此类，塞进去即语义污染。权限面如实声明：运行时切换能力**本就可及**（内核
  // switchRolePack 对话中允许，自动匹配依赖它，设置面板「设为当前」无 busy 守门），本入口只是
  // 补上「发现性」，未放宽也未收紧任何切换权限。
  roleBadge?.addEventListener('click', () => {
    vscode.postMessage({ type: 'open_settings_tab', tab: 'roles' });
  });

  /** 更新 Skill 选择器标签 + 盒内附件行 chip：
   * 入口触发器 ⚡（accent 边框表示已启用）+ 菜单内 is-active 高亮 + title/aria 兜底；
   * 输入盒内文字上方由 renderSkillChip 呈现「名称 + × 可移除」的状态 chip。 */
  function updateSkillPickerLabel(): void {
    if (skillPickerTrigger) {
      if (currentSkill) {
        skillPickerTrigger.setAttribute('title', '当前 Skill：' + currentSkill.name);
        skillPickerTrigger.setAttribute('aria-label', '当前 Skill：' + currentSkill.name);
      } else {
        skillPickerTrigger.setAttribute('title', '选择 Skill');
        skillPickerTrigger.setAttribute('aria-label', '选择 Skill');
      }
      skillPicker?.classList.toggle('active', !!currentSkill);
    }
    if (skillPickerMenu) {
      skillPickerMenu.querySelectorAll<HTMLElement>('.treedd__item').forEach((it) => {
        // 未选择技能时高亮「未选择技能」（__clear_skill），选中时高亮对应项
        const on = currentSkill
          ? it.dataset.treeddId === currentSkill.name
          : it.dataset.treeddId === '__clear_skill';
        it.classList.toggle('is-active', on);
      });
    }
    renderSkillChip();
  }

  /** 在输入盒内、textarea 上方构建/清空「名称 + × 可移除」的技能 chip（附件行成员）。
   * 用 textContent 逐节点构建（skill 名来自 SKILL_PRESETS 常量，天然安全）；
   * × 点击移除 = 清空 currentSkill 并刷新（保持与菜单触发器同源，单一真理源）。 */
  function renderSkillChip(): void {
    if (!skillChipRow) return;
    skillChipRow.textContent = '';
    if (!currentSkill) {
      skillChipRow.hidden = true;
      return;
    }
    skillChipRow.hidden = false;
    // 闭包内 let 的 narrowing 失效 → 取局部副本供 🔒 处理器读取当前挂载态
    const skill = currentSkill;
    const chip = document.createElement('span');
    chip.className = 'skill-chip';
    // 钉住（常驻锁）= 发送后保留不消失。chip 级 .is-pinned **无视觉职责**，仅作状态标记
    // 与测试锚点——视觉交给 pin 按钮的 is-on + 图标形状（chip 底色会被 .is-disabled 吃掉）
    if (skill.pinned) {
      chip.classList.add('is-pinned');
    }
    // 选中的技能已禁用 → 标记 chip。否则用户以为「已挂载」，实际发送时不注入。
    // 术语沿用设置页同一词汇「已禁用」，不新增概念。
    if (currentSkill.disabled) {
      chip.classList.add('is-disabled');
      chip.setAttribute('title', '该技能已禁用，发送时不会注入');
    }
    const icon = document.createElement('span');
    icon.className = 'skill-chip__icon';
    // 图标语言唯一 = icons.ts 柔和线条 SVG
    icon.innerHTML = getIconSvg('bolt', 11, 11);
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = currentSkill.name;
    chip.appendChild(name);
    if (currentSkill.disabled) {
      const note = document.createElement('span');
      note.className = 'skill-chip__note';
      note.textContent = '已禁用';
      chip.appendChild(note);
    }
    // 常驻锁切换（🔒）：与 ✕ 语义二分——🔒 只切「发送后是否保留」，✕ 才是移除。
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'skill-chip__pin';
    // 二态落在 pin 按钮自身（class + 图标形状），**不依赖 chip 底色**——chip 底色会被
    // .is-disabled 覆盖吃掉（禁用技能钉住后视觉归零），按钮自己的着色不受其影响。
    if (skill.pinned) {
      pin.classList.add('is-on');
    }
    // 图标 = 状态投影（SSOT）：闭合锁 = 已钉住常驻，开口锁 = 未钉住发送后清除。
    // 曾写死为常量 'lock' ⇒ 两态同图标、用户无法分辨钉住与否（真机实测缺陷）。
    pin.innerHTML = getIconSvg(skill.pinned ? 'lock' : 'lock-open', 11, 11);
    pin.setAttribute('aria-pressed', String(skill.pinned));
    pin.setAttribute('title', skill.pinned ? '取消常驻（发送后清除）' : '常驻（发送后保留）');
    pin.setAttribute('aria-label', (skill.pinned ? '取消常驻：' : '常驻：') + skill.name);
    pin.addEventListener('click', () => {
      currentSkill = { ...skill, pinned: !skill.pinned };
      renderSkillChip();
    });
    chip.appendChild(pin);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.innerHTML = getIconSvg('close', 11, 11);
    remove.setAttribute('title', '移除 Skill');
    remove.setAttribute('aria-label', '移除 Skill：' + currentSkill.name);
    remove.addEventListener('click', () => {
      currentSkill = null;
      updateSkillPickerLabel();
    });
    chip.appendChild(remove);
    skillChipRow.appendChild(chip);
    // 重建后 scrollLeft 归零、内容宽度也变了：边缘渐隐必须按新尺寸重算
    syncRowEdges(skillChipRow);
  }

  /** 接收宿主推送的引用（右键「添加到对话」）：合并去重后渲染气泡行。
   * SSOT = currentRefs 数组；去重判据 = `refKeyOf`（**含行区间**，与宿主缓冲同源）：
   * 整文件与其某段选区是**两条**引用，按 path 去重会让后加的那条静默失效。 */
  function addRefs(refs: ChatRef[]): void {
    const seen = new Set(currentRefs.map(refKeyOf));
    for (const r of dedupeRefs(refs)) {
      const key = refKeyOf(r);
      if (!seen.has(key)) {
        // 新挂载默认不钉住（发送即清，保持现状）；已存在的走上面 seen 分支，
        // 不会重置其 pinned（保留用户已钉的锁）。无 range 时不写该字段（保持「缺省」语义）。
        // 区间经 `normalizeRefRange` 归一后才入列：非法区间一律降级为整文件引用，
        // 否则它会以「无标签」形态存活在 currentRefs 里，与真正的整文件引用撞同一个键。
        const range = normalizeRefRange(r.range);
        currentRefs.push({
          path: r.path,
          kind: r.kind,
          ...(range ? { range } : {}),
          pinned: false,
        });
        seen.add(key);
      }
    }
    renderAttachmentRow();
  }

  /** 注入原因 → 中文短语（唯一产地：chip 徽记与 title 共用，别在调用点各写一套） */
  const ACTIVE_FILE_REASON_LABELS: Record<'dirty' | 'untitled' | 'outside', string> = {
    dirty: '未保存',
    untitled: '未命名',
    outside: '工作区外',
  };

  /** token 数的短显（3258 → ≈3.3k；842 → 842）：chip 徽记空间窄，长数字难扫读 */
  function formatTokensShort(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  /**
   * 活动文件 chip（**第三种 chip**，与 skill / ref 同构）
   *
   * 把「当前打开文件会不会进本轮上下文」摊在输入框上方——此前它完全隐形，用户既看不到
   * 也没法关。两形态：
   *   - attached：`📄 白话设计文档.md · 未保存（全文已附）` + ✕（本会话不再附加）
   *   - suppressed：虚线胶囊「当前文件未附加 · 点击启用」（整枚可点回开，不留死路）
   *
   * 为什么要标「全文已附」：干净文件只给指针（不占预算），脏/未命名/工作区外才注入正文
   * （3~4k token）。不标，用户永远看不懂「这条消息为什么突然贵了、模型为什么看到了我
   * 没保存的东西」。**文案与 HOST-CTX-6 预算可视化共用这一句**，不拆两处。
   * CTX-6② 归因：发送后的本轮回推（`injection_summary` 的 active-file 分项）给出 token 数，
   * 徽记短显 `≈3.3k`、title 给全数——让「这轮贵在哪」有归因入口（圆环只示总量，这里示出处）。
   * ⚠️ 数字不再长在投影字段上（HOST-CTX-4 ②：三个源各挂一个字段 = 并列腐化），统一由
   * 汇总投影按源分项下发，见 `activeFileTokens` 变量的预备/认领契约。
   *
   * 视觉上复用 `.skill-chip` 基类（不造新范式）；suppressed 复用 `.is-disabled`
   * （虚线 + 次要色，语义正是「挂着但不会生效」）。
   */
  function buildActiveFileChip(p: ActiveFileProjection): HTMLElement | null {
    if (p.kind === 'none') return null;
    const icon = (): HTMLElement => {
      const el = document.createElement('span');
      el.className = 'skill-chip__icon';
      el.innerHTML = getIconSvg('file', 11, 11);
      el.setAttribute('aria-hidden', 'true');
      return el;
    };
    if (p.kind === 'suppressed') {
      // 整枚是按钮：关闭态若只显示不给回开入口，就成了用户抱怨过的「关不掉」的反面
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'skill-chip active-file-chip is-disabled';
      chip.dataset.activeFile = 'suppressed';
      chip.title = '当前打开文件未作为上下文附加（本会话）——点击重新启用';
      chip.setAttribute('aria-label', '重新启用当前文件上下文');
      const name = document.createElement('span');
      name.className = 'skill-chip__name';
      name.textContent = '当前文件未附加';
      const note = document.createElement('span');
      note.className = 'skill-chip__note';
      note.textContent = '点击启用';
      chip.append(icon(), name, note);
      chip.addEventListener('click', () => {
        vscode.postMessage({ type: 'set_active_file_attach', enabled: true });
      });
      return chip;
    }
    const chip = document.createElement('span');
    chip.className = 'skill-chip active-file-chip';
    chip.dataset.activeFile = 'attached';
    chip.appendChild(icon());
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    // HOST-CTX-18 降噪（对齐 CTX-17 引用气泡）：可见文本只留文件名，完整相对路径降级到
    // title 末尾括号（hover 可辨）——投影 label 仍是全路径（aria-label 与去重判据都用它）。
    // 活动文件永远只有一个，不存在引用气泡那种同名撞车，纯文件名无歧义代价。
    name.textContent = refDisplayName(p.label);
    // title 承载「本轮以什么方式附加」——不能只靠徽记（窄面板下徽记可能被省略号吃掉）。
    // 注入量归因（CTX-6②）：数字只在「发送后本轮回推」里出现（非常驻值，下一次不带汇总
    // 的投影推送即抹掉），挂在「全文已附」同一句上——CTX-3/CTX-6 文案不拆两处。
    // CTX-18：完整路径附在末尾括号——可见文本降噪后，目录位置靠 hover 这一眼。
    name.title = p.injected
      ? `本轮已附全文（${ACTIVE_FILE_REASON_LABELS[p.reason ?? 'dirty']}）${
          activeFileTokens !== undefined ? `· 注入约 ${activeFileTokens} token（估算）` : ''
        }（${p.label}）`
      : `本轮仅给路径指针，正文由模型按需读取（不占预算）（${p.label}）`;
    chip.appendChild(name);
    if (p.injected) {
      const note = document.createElement('span');
      note.className = 'skill-chip__note';
      // 徽记带短显估算（≈3.3k）：全数字（3258）在窄 chip 里挤且难扫读；无值时不显示
      // （常态附加 chip = 判据已知、本轮规模未知，不造假数）
      note.textContent =
        `${ACTIVE_FILE_REASON_LABELS[p.reason ?? 'dirty']}·全文已附` +
        (activeFileTokens !== undefined ? ` ≈${formatTokensShort(activeFileTokens)}` : '');
      chip.appendChild(note);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.innerHTML = getIconSvg('close', 11, 11);
    remove.setAttribute('title', '本会话不再附加当前文件');
    remove.setAttribute('aria-label', `关闭当前文件上下文：${p.label}`);
    remove.addEventListener('click', () => {
      vscode.postMessage({ type: 'set_active_file_attach', enabled: false });
    });
    chip.appendChild(remove);
    return chip;
  }

  /**
   * 引用 chip 的**可见**文件名（HOST-CTX-17：全路径降噪）
   *
   * 真机反馈「气泡显示完整相对路径噪音太多」——可见文本只留文件名（`a/b/foo.ts` → `foo.ts`）。
   * 这不是把路径信息删掉，完整路径仍在三处：① chip title（hover 即见，同名文件可辨）；
   * ② pin/remove 的 aria-label（屏幕阅读器要全量信息）；③ open_ref 上行载荷与发送信封
   * （功能面，本就不随显示形态改）。
   * 已知限制：同一批引用里两个同名文件（如两个 `index.ts`）可见标签相同，靠 title 区分——
   * 刻意不做 VS Code 式「父目录消歧」：附件行通常个位数 chip，hover 成本低于维护歧义判据
   * （复杂度守恒；真痛了再按 tab 同款算法加）。
   *
   * 路径形态 = `relativeUnderPrimaryRoot` 的规范形（POSIX `/`、无冗余段，消费侧 round-trip
   * 校验保证）⇒ 按 `/` 切末段即可；webview 包不引 node:path，一个 split 不造依赖。
   */
  function refDisplayName(path: string): string {
    const segs = path.split('/');
    return segs[segs.length - 1] || path;
  }

  /** 回执归零（新一轮发送 / 清空会话 / 本轮无注入）：不做「本轮注入 0」这种无信息显示 */
  function hideInjectionReceipt(): void {
    if (!injectionReceipt) return;
    injectionReceipt.hidden = true;
    injectionReceipt.textContent = '';
  }

  /**
   * 注入型上下文 chip（**第四种 chip**，HOST-CTX-4）
   *
   * 与引用 chip 的根本差别：引用只挂指针（模型按需读），注入 chip **当轮就把内容塞进信封**
   * ——因为诊断 / git 变更 / 终端输出这类瞬态数据在内核工具箱里**没有对应读取工具**，
   * 「提示模型去看」此路不通（见 HOST-CTX-0 例外的理由）。
   *
   * 可辨性（硬约束③「明示」）：与引用 chip 并排在同一行，故**形状 + 颜色双通道**区分——
   * 圆角矩形（非胶囊）+ warn 色实线边框 + ⚠ 图标 + 「内容已注入」短标。
   * ⚠️ 不用半透明 / 低对比度表达：真机证过半透明 chip 看着像未渲染（CTX-17 同款教训）。
   *
   * 无 🔒（硬约束④「不泛化」）：常驻 = 每轮都悄悄塞一份进信封，用户会失去预算控制；
   * 要再用就重新挂一次。✕ 即移除（从 currentInjections 过滤，单一真理源）。
   */
  function buildInjectionChip(source: MountableInjectionSource): HTMLElement {
    const meta = MOUNTABLE_INJECTION_META[source];
    const sourceName = INJECTION_SEGMENT_LABELS[source];
    const chip = document.createElement('span');
    // .skill-chip 基类 + .injection-chip 差异化（形状 / 颜色）；data-injection 是测试锚点
    chip.className = 'skill-chip injection-chip';
    chip.dataset.injection = source;
    const icon = document.createElement('span');
    icon.className = 'skill-chip__icon';
    icon.innerHTML = getIconSvg('warning', 11, 11);
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = sourceName;
    // 可见文本只有四个字，全部说明进 title（hover 第一问就是「这挂的是啥、占不占」）
    name.title = meta.chip.title;
    const note = document.createElement('span');
    note.className = 'skill-chip__note';
    note.textContent = meta.chip.note;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.innerHTML = getIconSvg('close', 11, 11);
    remove.setAttribute('title', `移除：${sourceName}`);
    remove.setAttribute('aria-label', `移除${sourceName}注入`);
    remove.addEventListener('click', () => {
      currentInjections = currentInjections.filter((s) => s !== source);
      renderAttachmentRow();
    });
    chip.append(icon, name, note, remove);
    return chip;
  }

  /**
   * 圆环 hover 卡片底部「本轮注入」回执行（HOST-CTX-4 ② 的呈现落点）
   *
   * 一次性回执：只在**发送后**由 `injection_summary` 驱动，下一轮发送 / 清空会话时清。
   * 显示判据 = 至少一个分项真的注入了内容且合计 > 0——「本轮注入 0」是纯噪音，
   * 且会让人误以为「挂了但没生效」。
   * 分项明细**同屏可见**（徽记时代只能进 title）：hover 卡片本就是「精确」层，
   * 明细没有理由再藏一层；数字口径与卡片其余行统一走 `fmtTokens`（精确式）。
   */
  function renderInjectionReceipt(summary: InjectionSummary): void {
    if (!injectionReceipt) return;
    // 类型谓词收窄（不是「过滤后再取」）：分项名后跟的必须是 number，若过滤条件改松，
    // `${s.tokens}` 会静默印出 `undefined`——收窄后 tsc 直接拦住。
    const injected = summary.segments.filter(
      (s): s is InjectionSegment & { tokens: number } => s.injected && typeof s.tokens === 'number',
    );
    if (summary.total <= 0 || injected.length === 0) {
      hideInjectionReceipt();
      return;
    }
    const detail = injected
      .map((s) => `${INJECTION_SEGMENT_LABELS[s.source]} ${fmtTokens(s.tokens)}`)
      .join(' · ');
    injectionReceipt.textContent = `本轮注入 ${fmtTokens(summary.total)}（${detail}）· 发送时刻估算，下一轮覆盖`;
    injectionReceipt.hidden = false;
  }

  /** 构建/清空附件行：**活动文件 chip + 注入 chip + 引用 chip** 共用一个容器（`#refChips`）。
   *
   * 引用 chip 形态：`文件名(+行号) + 🔒 + ×`（HOST-CTX-17 降噪：可见文本只留文件名，
   * 完整相对路径降级到 title / aria-label——hover 与屏幕阅读器仍拿得到，见 refDisplayName），
   * 与技能 chip 同构复用 `.skill-chip*` 样式；
   * 🔒 切 pinned（发送后是否保留），× 移除 = 从 currentRefs 过滤并刷新（单一真理源），
   * 文件名/行号 span 点击 = 上报 open_ref 跳编辑器定位；注入 chip（第四类，⚠ 图标 +
   * 圆角矩形 + warn 色）在活动文件之后、引用之前——它带内容，故与注入方（活动文件）同侧，
   * 与纯指针的引用分开。
   * 显隐判据只写一次（`hasAttachment`）：三类 chip 任一存在即显示——分成多处各判一次，
   * 必然出现「refs 清空后活动文件 chip 被连坐隐藏」这类漂移。 */
  function renderAttachmentRow(): void {
    if (!refChipRow) return;
    refChipRow.textContent = '';
    const quoteChip = quoteDraft.chip();
    if (
      activeFile.kind === 'none' &&
      currentRefs.length === 0 &&
      currentInjections.length === 0 &&
      !quoteChip
    ) {
      refChipRow.hidden = true;
      return;
    }
    refChipRow.hidden = false;
    // 活动文件在前（常态背景上下文），引用在后（本轮临时挂载）
    const activeChip = buildActiveFileChip(activeFile);
    if (activeChip) refChipRow.appendChild(activeChip);
    for (const source of currentInjections) refChipRow.appendChild(buildInjectionChip(source));
    // 引用回复快照胶囊（COPY-2 形态优化）：快照语义 ≠ 文件指针，但同属「本轮挂载的引用」混排
    if (quoteChip) refChipRow.appendChild(quoteChip);
    // 钉住的排最前（「锁定在顶部」）：稳定排序保同组内插入序；只影响渲染顺序，
    // 不改 currentRefs 本体——pinned 判据仍以 currentRefs 为唯一真源（SSOT）。
    const ordered = [...currentRefs].sort((a, b) => Number(b.pinned) - Number(a.pinned));
    for (const ref of ordered) {
      const chip = document.createElement('span');
      chip.className = 'skill-chip';
      // 同 skill chip：.is-pinned 只是 chip 级状态标记与测试锚点，视觉在 pin 按钮上
      if (ref.pinned) {
        chip.classList.add('is-pinned');
      }
      const icon = document.createElement('span');
      icon.className = 'skill-chip__icon';
      icon.innerHTML = getIconSvg(ref.kind === 'folder' ? 'folder' : 'file', 11, 11);
      icon.setAttribute('aria-hidden', 'true');
      chip.appendChild(icon);
      // 区间先归一再渲染：非法区间（start>end / 非整数）不渲染行号 span、不上行，
      // 视觉与协议两处同时降级为「整文件引用」，不产生 `#Lundefined` 这类脏标签。
      const markedRange = normalizeRefRange(ref.range);
      // aria-label 用**全路径**+行号（屏幕阅读器要全量信息）；可见文本用文件名——两个受众
      // 两种形态，见 refDisplayName（HOST-CTX-17 降噪）。
      const label = `${ref.path}${formatRefRange(markedRange)}`;
      // 点击跳转（open_ref，W→E）：**路径与行号两个 span 都可点**——行号 span 不参与截断
      //（flex-shrink: 0），窄路径被 ellipsis 截掉尾部时行号依然点得中。载荷只带协议字段（path/kind/range）：
      // webview 私有的 pinned 不随上行（协议契约，见 open_ref 注释）；行号保持 1-based 原样上行，逆转换归宿主单点。
      const openRef = (): void => {
        vscode.postMessage({
          type: 'open_ref',
          ref: { path: ref.path, kind: ref.kind, ...(markedRange ? { range: markedRange } : {}) },
        });
      };
      const name = document.createElement('span');
      name.className = 'skill-chip__name';
      // HOST-CTX-17 降噪：可见文本只留文件名（全路径在 title 与 aria-label，见下）。
      name.textContent = refDisplayName(ref.path);
      // 定位提示是**中文语句**而非协议标签，故不复用 formatRefRange（两者语言不同、不可共享）；
      // 但端点同样取归一化结果，避免出现「第 NaN 行」。
      const rangeHint = markedRange
        ? `并定位到第 ${markedRange.start}${markedRange.start === markedRange.end ? '' : `-${markedRange.end}`} 行`
        : '';
      // CTX-6①：指针语义提示放最前（用户 hover 的第一问是「这挂的是啥、占不占」）——引用只挂
      // 指针不注入内容，目录更是只给模型一张目录地图（内容按需 list_dir）。与信封侧
      // buildRefContextBlock 的「按需读取」标注同义：信封说给模型听，这里说给用户听。
      // HOST-CTX-17：全路径附在末尾括号——可见文本降噪后，同名文件的区分靠 hover 这一眼。
      name.title = `仅挂指针，正文由模型按需读取（不占预算）；点击在编辑器中打开${rangeHint}（${ref.path}）`;
      // 键盘可达：span 非原生按钮，补 role/tabindex/Enter-Space 与鼠标同构
      // （焦点环走 tokens.ts 全局 focus-visible，此处不自写）
      name.setAttribute('role', 'button');
      name.tabIndex = 0;
      name.addEventListener('click', openRef);
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openRef();
        }
      });
      chip.appendChild(name);
      if (markedRange) {
        // 行号独立 span：语义与可点性与路径对等，但**不继承 name 的 ellipsis 截断**
        const rng = document.createElement('span');
        rng.className = 'skill-chip__range';
        rng.textContent = formatRefRange(markedRange);
        rng.title = name.title;
        rng.setAttribute('role', 'button');
        rng.tabIndex = 0;
        rng.addEventListener('click', openRef);
        rng.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openRef();
          }
        });
        chip.appendChild(rng);
      }
      // 常驻锁切换（🔒）：与 ✕ 语义二分——🔒 只切「发送后是否保留」，✕ 才是移除。
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'skill-chip__pin';
      // 与 skill chip 同一组二态规则：class + 图标形状都由 pinned 投影（详见 skill 侧注释）
      if (ref.pinned) {
        pin.classList.add('is-on');
      }
      pin.innerHTML = getIconSvg(ref.pinned ? 'lock' : 'lock-open', 11, 11);
      pin.setAttribute('aria-pressed', String(ref.pinned));
      pin.setAttribute('title', ref.pinned ? '取消常驻（发送后清除）' : '常驻（发送后保留）');
      pin.setAttribute('aria-label', (ref.pinned ? '取消常驻：' : '常驻：') + label);
      pin.addEventListener('click', () => {
        // 按身份键匹配（非 path）：同文件不同选区是两条引用，按 path 会一并翻转
        const key = refKeyOf(ref);
        currentRefs = currentRefs.map((r) =>
          refKeyOf(r) === key ? { ...r, pinned: !r.pinned } : r,
        );
        renderAttachmentRow();
      });
      chip.appendChild(pin);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'skill-chip__remove';
      remove.innerHTML = getIconSvg('close', 11, 11);
      remove.setAttribute('title', `移除引用：${label}`);
      remove.setAttribute('aria-label', `移除引用：${label}`);
      remove.addEventListener('click', () => {
        // 同 pin：按身份键过滤（非 path），否则删一条会带走同 path 的另一条选区引用
        const key = refKeyOf(ref);
        currentRefs = currentRefs.filter((r) => refKeyOf(r) !== key);
        renderAttachmentRow();
      });
      chip.appendChild(remove);
      refChipRow.appendChild(chip);
    }
    // CTX-7：批量出口「清空全部引用」——同一 chip 行缺同类批量出口（挂 6 条要逐个点 ✕ 六次）。
    // 范式照抄 pending-queue-bar__clear（图标同 close、title/aria 同款），但**不走上行消息**：
    // 待发送队列的 SSOT 在宿主（须 post clear_pending_queue 由宿主清），而引用 SSOT =
    // 本文件 currentRefs，单删 ✕ 同为纯本地过滤——批量移除只是同一过滤的全量版，上行反而让
    // 宿主镜像一份引用状态（第二真理源）。显隐与范式一致：有引用即在（单条也无害）。
    // 范围只清引用：活动文件 chip 是另一语义（CTX-3 本会话开关，宿主投影），不受牵连；注入
    // chip 同理不牵连（各有自己的 ✕，且批量出口标题/aria 明写「引用」——不把「清空全部」
    // 扩成「清空全部附件」：标题说引用却连注入一起清 = 语义越界）。pinned 一并清——与 ✕
    // 语义一致（✕ 也能删 pinned），🔒 只管「发送后是否保留」。
    if (currentRefs.length > 0) {
      const clearAll = document.createElement('button');
      clearAll.type = 'button';
      clearAll.className = 'ref-chips__clear';
      clearAll.innerHTML = getIconSvg('close', 11, 11);
      clearAll.setAttribute('title', '清空全部引用（含常驻）');
      clearAll.setAttribute('aria-label', '清空全部引用');
      clearAll.addEventListener('click', () => {
        currentRefs = [];
        renderAttachmentRow();
      });
      refChipRow.appendChild(clearAll);
    }
    // 同一行里既有活动文件 chip 又有引用：重建后必须按新宽度重算渐隐（见 syncRowEdges）
    syncRowEdges(refChipRow);
  }

  // 两行的绑定在此一次完成（行元素在脚本加载时已存在）；窗口尺寸变化只影响是否溢出，
  // 重算一次边缘类即可——不为「侧栏拖宽」引入 ResizeObserver（Chat 面板拖宽不触发
  // window resize，但此时行内也不滚动，渐隐最多残留到下次滚动/重渲染，代价可接受）。
  bindSingleTrackRow(skillChipRow);
  bindSingleTrackRow(refChipRow);
  bindSingleTrackRow(imageChipRow);
  // 图片采集层（粘贴 / 拖入）：采集即写盘（Q1）——校验通过当场上行 `image_ingest`，
  // 宿主回执经 handleMessage 转 `applyIngestResult` 把 chip 提案值换真
  const imageCapture = createImageCapture({
    doc: document,
    input,
    dropZone: inputWrap,
    row: imageChipRow,
    post: (msg) => vscode.postMessage(msg),
    notice: (text) => activityDrawerView.showActivity('info', text),
    attachBtn: imageAttachBtn,
  });
  window.addEventListener(
    'resize',
    () => {
      syncRowEdges(skillChipRow);
      syncRowEdges(refChipRow);
      syncRowEdges(imageChipRow);
      // 大纲条（HOST-NAV-1）：视口高变 ⇒ 压密预算重算。sync 内 applyMetrics 总会跑，
      // 故即便轮数/签名未变，也会按新预算重排条列（与上面两行同一 resize 拍子）。
      roundNavController.sync();
    },
    { passive: true },
  );

  /** 润色按钮事件绑定：对输入框内容进行润色（图标按钮，无文本） */
  if (polishBtn) {
    polishBtn.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      polishBtn.classList.add('loading');
      vscode.postMessage({ type: 'polish_input', text });
    });
  }

  /** 动态技能清单（SSOT 收紧）：不硬编码预设，由 host 推 skills_loaded 填充，与设置面板同一来源。
   * `disabled` 随行带出：下拉项据此弱化 + 标注「已禁用」，chip 据此提示 —— 纯显示，不拦截。
   * `description` 随行带出：供菜单顶部搜索按「名称 + 描述」匹配。 */
  let skillOptions: { name: string; description?: string; disabled?: boolean }[] = [];
  /** 菜单搜索词：跨 skills_loaded 全量重建保留——数据下发不清词（用户常在搜索结果上
   * 连续操作，同会话搜索 FD-3-A 纪律） */
  let skillSearchQuery = '';

  /** 菜单顶部搜索框（元素只建一次，恒驻 DOM —— 重建绝不触碰它）。
   * 不带 .treedd__item 类：点击不命中菜单项委托（防选中/收起），符合 dropdown 硬约束范式。
   * 🔴 历史教训（2026-10-11 真机实锤）：曾随全量 innerHTML='' 重建被 detach 再插回，
   * 聚焦中被摘即失焦 ⇒ 打一个字第二个字进不去（中文 IME 更明显）。故搜索框与列表
   * 分容器：输入元素永不出重建区。 */
  const skillSearchInput = document.createElement('input');
  skillSearchInput.className = 'treedd__search';
  skillSearchInput.type = 'search';
  skillSearchInput.placeholder = '搜索技能（名称/描述）';
  skillSearchInput.setAttribute('aria-label', '搜索技能');
  skillSearchInput.title = '按名称或描述过滤技能列表';
  skillSearchInput.addEventListener('input', () => {
    skillSearchQuery = skillSearchInput.value;
    renderSkillPickerMenu();
  });

  /** 列表容器：唯一重建区（清除项/分隔线/过滤项/空态都在这），搜索框在其外恒驻 */
  const skillPickerList = document.createElement('div');
  skillPickerList.className = 'treedd__list';

  /** 菜单匹配（空词恒真、大小写不敏感）：名称 / 描述任一命中即匹配
   * （形状同历史菜单的元数据匹配，见 historyMenuView；列表仅数十条，同步过滤不引入防抖） */
  function matchesSkillSearch(s: (typeof skillOptions)[number], q: string): boolean {
    if (!q) return true;
    return `${s.name} ${s.description ?? ''}`.toLowerCase().includes(q);
  }

  /** 重建 Skill 菜单（初始装配 + skills_loaded 刷新 + 搜索过滤共用单点）：
   * 顶部常驻搜索框（恒驻，出重建区）→ 列表容器内：恒显「未选择技能」清除项 + 分隔线
   * （逃逸舱，不参与过滤）→ 过滤后的技能项（禁用标记随行、不因过滤隐藏）→ 空态「无匹配技能」。
   * 🔴 只清 skillPickerList，绝不清 skillPickerMenu —— 内含恒驻的搜索框，
   * 全量清空会把它 detach 致失焦（真机「打一个字就进不去」根因）。 */
  function renderSkillPickerMenu(): void {
    if (!skillPickerMenu) return;
    // 首次装配：搜索框 + 列表容器入菜单，此后永不再动（重建只清列表容器）
    if (skillSearchInput.parentElement !== skillPickerMenu) {
      skillPickerMenu.appendChild(skillSearchInput);
      skillPickerMenu.appendChild(skillPickerList);
    }
    skillPickerList.innerHTML = '';
    skillSearchInput.value = skillSearchQuery;
    const clearItem = document.createElement('div');
    clearItem.className = 'treedd__item';
    // 顶部项语义 = 「普通对话、不挂载技能」——用中性「未选择技能」替代原「不使用 Skill」：
    // 原文字易被误读为「禁用技能」（禁用另属设置页禁用清单），且暗示「提及技能名即自动
    // 命中」（当前机制是显式选择，见 title 提示）。
    clearItem.textContent = '未选择技能';
    clearItem.title =
      '未挂载任何技能，进行普通对话（技能需从下方显式选择；提示词提及技能名不会自动加载）';
    clearItem.dataset.treeddId = '__clear_skill';
    skillPickerList.appendChild(clearItem);
    const divider = document.createElement('div');
    divider.className = 'treedd__divider';
    skillPickerList.appendChild(divider);
    const q = skillSearchQuery.trim().toLowerCase();
    let visible = 0;
    for (const s of skillOptions) {
      if (!matchesSkillSearch(s, q)) continue;
      visible++;
      const item = document.createElement('div');
      item.className = 'treedd__item';
      item.textContent = s.name;
      item.dataset.treeddId = s.name;
      if (s.disabled) {
        // 已禁用：弱化 + 后缀徽记（复用设置面板同一语义词汇，非隐蔽、不隐藏条目）
        item.classList.add('is-disabled');
        const note = document.createElement('span');
        note.className = 'treedd__item-note';
        note.textContent = '已禁用';
        item.appendChild(note);
      }
      skillPickerList.appendChild(item);
    }
    // 空态：有技能但无命中才显示（不带 .treedd__item = 不参与选择委托）
    if (skillOptions.length > 0 && visible === 0) {
      const empty = document.createElement('div');
      empty.className = 'treedd__empty';
      empty.textContent = '无匹配技能';
      skillPickerList.appendChild(empty);
    }
    updateSkillPickerLabel();
  }

  // 初始装配：空清单（搜索框 + 清除项 + 分隔线），具体清单由 skills_loaded 动态填充
  renderSkillPickerMenu();

  // 提问卡渲染（真源 = turn_update.state 的 waiting/ask）
  // 职责与原 need_clarify 分支等价：优先内联块（renderAskInline 挂问答交互行下），
  // 无锚点时降级底部 clarifyBar 异常兜底。questions 来自 turn_update.state.questions
  //（宿主 postTurnUpdate 投影派生，非独立消息载荷）。
  function renderAskPhase(questions: PendingQuestionDto[]): void {
    // 挂起批次收口：提问定型 = 本批工具不再执行，未升级预告行退场（幽灵块防残留）
    toolRow.dropStalePendingToolRows();
    // 提问形态内联化：选择题 + 补充输入渲染到消息流提问块下方
    //（对齐 TraeWork/主流对话流交互），不再用底部 clarifyBar 替换输入栏。
    // 底部 clarifyBar 保留为异常兜底（无 assistant 块锚点时退化使用）
    const askBlock = renderAskInline(questions);
    if (!askBlock) {
      clarifyText.textContent = 'Agent 需要你确认：' + questions.map((q) => q.question).join('；');
      clarifyInput.value = '';
      clarifyOptions.textContent = '';
      // 强制单选（同 renderAskInline 语义）：任一提问带 options 且 allowCustom=false → 隐藏自由输入框
      const forceChoose = questions.some(
        (q) => q.options && q.options.length > 0 && q.allowCustom === false,
      );
      clarifyInput.hidden = forceChoose;
      questions.forEach((q) => {
        (q.options || []).forEach((opt) => {
          const b = document.createElement('button');
          b.className = 'opt-btn';
          b.textContent = opt;
          b.addEventListener('click', () => {
            // 点击即答：选项直接作为澄清答案提交续跑（无需二次回车）
            clarifyInput.value = opt;
            sendClarifyAnswer();
          });
          clarifyOptions.appendChild(b);
        });
      });
      clarifyBar.classList.add('visible');
      inputBar.hidden = true;
      clarifyInput.focus();
    }
  }

  // 主动提问回答（clarifyBar 异常兜底路径）：提交并续跑
  // 与内联选择题主路径（commitAskAnswers）共用同一置位语义 armAskResumeAnchor（SSOT 收敛：
  // resumePending 置位单点，勿再手写；载荷为单条 answer 意图）
  function sendClarifyAnswer(): void {
    const text = clarifyInput.value.trim();
    if (!text) return;
    clarifyInput.value = '';
    clarifyBar.classList.remove('visible');
    inputBar.hidden = false;
    armAskResumeAnchor();
    // 单问=单元素数组（answer 意图恒 answers，无 answer_multi 变体）
    vscode.postMessage({ type: 'input', kind: 'answer', answers: [text] });
  }
  clarifySend.addEventListener('click', sendClarifyAnswer);
  clarifyInput.addEventListener('keydown', (e) => {
    // isComposing 守卫：中文输入法组合确认不误触发澄清答复
    if (e.isComposing) return;
    if (e.key === 'Enter') sendClarifyAnswer();
  });

  // 首屏刷新
  emptyStateView.update();
  updateRoleBadge(); // 输入区角色徽章（首屏可能有历史推送的角色名）
  emptyStateView.updateRole(currentRoleName, currentRolePacks); // P3：空状态文案随当前角色生长（首屏可能已有角色推送）
  renderModelPicker();
  syncSendEnabled(); // 初始输入为空 → 发送按钮禁用（输入后经 input 事件恢复）

  // 通知 extension：脚本已就绪、监听器已注册，可安全回放会话
  // （消除折叠/展开重建 HTML 时，消息在监听器注册前到达而被丢弃的竞态）
  vscode.postMessage({ type: 'ready' });

  // ─── 可销毁：移除全局监听器 + 清理全部定时器（测试环境隔离 / 页面卸载复用） ───
  // 根因：createChatView 在 window / document 上注册全局监听且内部持有多个定时器，
  // 若无显式销毁，单测每个 mountChatView 都会累积泄漏的监听器（跨测试污染 DOM），
  // 表现为「单独跑全绿、整包跑偶发红灯」的非确定性 flake。
  function dispose(): void {
    window.removeEventListener('message', onMessage);
    document.removeEventListener('click', onDocumentClick);
    if (streamRenderTimer) clearTimeout(streamRenderTimer);
    if (archivingFallbackTimer !== undefined) clearTimeout(archivingFallbackTimer);
    if (pendingWaitTimer !== undefined) clearInterval(pendingWaitTimer);
    if (toolElapsedTimer !== undefined) clearInterval(toolElapsedTimer);
    activityDrawerView.dispose(); // 瞬态条撤出计时器随活动抽屉域收口（第 4 刀）
    statusBars.dispose(); // 三挂载条 DOM 随状态条域收口（第 6 刀）
    imageCapture.dispose(); // 采集层监听器（paste / dragover / drop）必须随 view 收干净
    contextMenuController.dispose(); // 右键菜单 document 级监听随 view 收干净（COPY-2）
    stopConfirmCountdown();
  }

  return { dispose };
}
