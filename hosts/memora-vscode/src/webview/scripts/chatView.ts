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
  ExtensionToWebviewMessage,
  PendingQuestionDto,
  PlanItemDto,
  RoundView,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
// ProcessThinkingPhase 纯类型导入，仅编译期用（esbuild 剥离，不影响 bundle）
import type { ProcessEvent, ProcessThinkingPhase } from '@zooique/memora';
// 错误文案映射单一真理源（与 Node 侧 chatPanel 实时提示条共用，防文案双源漂移）
import { friendlyErrorMessage } from '../../shared/errorText.js';
import { fmtTime } from '../helpers/fmtTime.js';
import { fmtTokens, fmtCompactTokens } from '../helpers/fmtTokens.js';
import { forceScrollToBottom, scrollToBottom, trackScroll } from '../helpers/scrollToBottom.js';
import { renderMarkdown } from '../helpers/renderMarkdown.js';
import { getToolDisplayName } from '../helpers/toolNameMap.js';
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
import { applyIcon, createIcon, getIconSvg, populateIcons } from './icons.js';
import { createSanitizer } from '../helpers/sanitizer.js';

/** 任务项状态 → 中文标签（状态枚举固定，缺一即编译报错，无需运行时兜底） */
const PLAN_ITEM_STATUS_LABEL: Record<PlanItemDto['status'], string> = {
  pending: '待执行',
  active: '进行中',
  done: '已完成',
  blocked: '阻塞',
};

/** chatView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface ChatViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象（脚本在浏览器环境运行） */
  window: Window;
}

/** 空状态示例提问项（点击填入输入框） */
interface Suggestion {
  /** 填入输入框的完整提问 */
  prompt: string;
  /** chip 展示文案 */
  label: string;
}

/**
 * 空状态示例提问集（SSOT）
 *
 * ROLE_SUGGESTION_SETS 按角色显示名特化示例提问：命中展示专属示例，未命中回退通用。
 * showcase 角色（白话方案设计师）展示"种子收敛"引导——让用户一键体验 memora 最吸引人的
 * 「给模糊想法 → 引导收敛最小单元」设计魅力；其余角色保持通用打磨引导，
 * 避免为每条角色特化造成维护成本（新增 showcase 角色时在此追加映射即可）。
 */
const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { prompt: '帮我审阅当前文档的架构合理性', label: '审阅架构' },
  { prompt: '帮我精简文档中的冗余表达', label: '精简表达' },
  { prompt: '检查文档与代码实现是否一致', label: '对齐实现' },
];

const ROLE_SUGGESTION_SETS: Record<string, Suggestion[]> = {
  白话方案设计师: [
    { prompt: '我想做一个个人知识库，帮我设计一个方案', label: '设计知识库' },
    { prompt: '我想做一个记忆系统，帮我找出最小单元', label: '设计记忆系统' },
    { prompt: '我想做一个待办工具，帮我找出最小功能', label: '找最小单元' },
  ],
};

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
  const input = document.getElementById('input') as HTMLTextAreaElement;
  const send = document.getElementById('send') as HTMLButtonElement;
  // 暂停按钮（Gap A：用户主动暂停入口，仅生成中可见，与「停止」并列的软暂停控制）
  const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement | null;
  // 润色按钮（输入框旁，对当前输入内容进行润色）
  const polishBtn = document.getElementById('polishBtn') as HTMLButtonElement | null;
  // Skill 选择器（输入框旁，选择后作为提示词传给 LLM）
  const skillPicker = document.querySelector<HTMLElement>('.skill-picker');
  const skillPickerMenu = skillPicker
    ? skillPicker.querySelector<HTMLElement>('.treedd__menu')
    : null;
  const skillPickerTrigger = skillPicker
    ? skillPicker.querySelector<HTMLElement>('.treedd__trigger')
    : null;
  // Grok 式技能 chip 行：输入框上方展示当前已选 Skill（名称 + × 可移除）
  const skillChipRow = document.getElementById('skillChips') as HTMLElement | null;
  let currentSkill: { name: string; disabled?: boolean } | null = null;
  // 活动状态区（三合一：错误 / 低扰通知单条主状态 + 指标折叠详情）
  const activityBar = document.getElementById('activityBar') as HTMLElement;
  const activityDetail = document.getElementById('activityDetail') as HTMLElement;
  const activityList = document.getElementById('activityList') as HTMLElement;
  const activityMetrics = document.getElementById('activityMetrics') as HTMLElement;
  const inputBar = document.getElementById('inputBar') as HTMLElement;
  const clarifyBar = document.getElementById('clarifyBar') as HTMLElement;
  const clarifyText = document.getElementById('clarifyText') as HTMLElement;
  const clarifyOptions = document.getElementById('clarifyOptions') as HTMLElement;
  const clarifyInput = document.getElementById('clarifyInput') as HTMLInputElement;
  // 写入审批卡：confirmWrites=true 时写文件触发，渲染审批卡
  // 供用户确认/拒绝；回传 write_confirm_answer（fail-closed：host 30s 超时即自动拒绝）
  const writeConfirmCard = document.getElementById('writeConfirmCard') as HTMLElement | null;
  const writeConfirmTool = document.getElementById('writeConfirmTool') as HTMLElement | null;
  const writeConfirmPath = document.getElementById('writeConfirmPath') as HTMLElement | null;
  const writeConfirmDesc = document.getElementById('writeConfirmDesc') as HTMLElement | null;
  const writeConfirmDiff = document.getElementById('writeConfirmDiff') as HTMLElement | null;
  const writeConfirmOk = document.getElementById('writeConfirmOk') as HTMLButtonElement | null;
  const writeConfirmReject = document.getElementById(
    'writeConfirmReject',
  ) as HTMLButtonElement | null;
  let pendingWriteConfirmRequestId: string | null = null;
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

  // 当前角色只读徽章（输入区左侧，展示角色名让用户感知当前定位；切换入口在独立「角色」视图）
  const roleBadge = document.getElementById('currentRoleBadge') as HTMLElement | null;
  // 工具权限徽章（输入区角色徽章旁，展示工具模式与能力列表）
  const capabilityBadge = document.getElementById('currentCapabilityBadge') as HTMLElement | null;
  // 当前角色队伍快照（小组会议启动图标用；由 chat_role_pack.team 填充）
  let currentActiveTeam: { leader: string; members: readonly string[] } | null = null;
  // 小组会议启动图标单例（懒创建，同计划常驻条 getPlanBarEl 范式）：身份即本引用。
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
  //   lastAssistantRoundId — 上一个 assistant 块的 roundId（同轮结构归位唯一依据：chunk 到达时判
  //                          骨架留原容器 / 新轮建新容器）。宿主透传 chunk.roundId，运行时与重放
  //                          统一走「roundId 相等」判定，无独立时序标志。
  //   resumePending        — 问答/补充续跑期待：交互输入（qa/supplement）或内联提问提交后置位，
  //                          下一个 process_event meta 消费为「同闭环续跑的 meta」而非新轮——
  //                          保留 currentEvents 与 round-block 锚点（折叠留在闭环首块），
  //                          避免 resume 二次 runFlow 的 meta 被当新轮重置出第二个运行时折叠。
  let lastAssistantRoundId: string | undefined;
  let resumePending = false;
  /** 运行时/重放同环容器：同 roundId 的 AI 段收进 .round-group，
   *  操作上移容器级 footer（复制整链/分叉/删除）；user 主输入在容器外，与 AI 作答单元分离 */
  let roundGroupEl: HTMLElement | null = null;

  // 当前 Provider 列表（由 chat_providers 消息填充）
  // limitTokens = 宿主经内核 resolveContextWindow 解析的上下文窗口上限
  // （用户 per-LLM 配置的 contextWindow，未配置回落内核默认 120K）
  interface ChatProviderItem {
    name: string;
    displayName: string;
    contextWindow?: number;
    limitTokens: number;
  }
  let currentProviders: ChatProviderItem[] = [];
  let currentActive: string | undefined;

  /**
   * 任务看板（任务驱动多步闭环，单轨呈现）
   *
   * 单轨呈现：
   *   ① planBar：顶部固定插槽（#planBar，与 #messages **同级**、非其子节点——#messages 是
   *      overflow-y:auto 滚动容器，插进它内部一滚即滚出视野）。默认一行
   *      N/M + 进度条 + 当前 active 任务项摘要，点击展开**锚定浮层**看全量任务项 + planItemLog。
   *      常驻门槛 ≥3 个任务项 —— **webview 展示层自身的门槛**（2 个任务项的小任务常驻成噪音）。
   *      ⚠️ 与内核 `detectNeedsPlanning` **无对应关系**：后者是关键词/结构命中式**布尔判定**
   *      （src/agent/needsPlanning.ts），**不含任何任务项数阈值**。二者职责正交：本门槛只管**是否常驻展示**，
   *      内核判定只管**是否注入规划引导**，不存在互相「同步」关系。（内核另有 `taskTableRenderer`
   *      的 `plan.length < 3` 收尾验证门槛，同数字但别义，亦非同源——见 renderPlanBoard 内注释。）
   *   ② 运行时**不渲染 inline 轨**，内容区零卡片：任务过程全部由 round-block 折叠块承载，
   *      plan 清空（turn 收尾）时顶部条随空 plan_update 收起，不在对话流里留投影。
   *
   * 数据源头：plan_update 协议消息（plan 数据由内核 checkpoint.plan 驱动，宿主 postPlanUpdate
   * 做只读快照推送）。webview 只消费不写，SSOT 不变。**零新增协议字段。**
   */
  /** 顶部常驻进度条插槽（HTML #planBar；hidden 由 renderPlanBoard 直控）。惰性查询（getPlanBarEl） */
  let planBarEl: HTMLElement | null = null;
  /** 锚定浮层展开态（点击 head 切换；浮层非 modal——看进度时需同时看正文） */
  let planBarExpanded = false;
  /** 当前计划快照缓存（供 round-block 任务项标签 + 浮层复用，零新增协议）。
   *  保持「最近一次非空 plan」：plan 清空时不覆写（round-block 重建时任务项标签仍可读） */
  let currentPlanItems: PlanItemDto[] = [];

  /** 惰性获取常驻条插槽（单例：同一 DOM 节点，避免每次渲染重新 getElementById） */
  function getPlanBarEl(): HTMLElement | null {
    if (!planBarEl) planBarEl = document.getElementById('planBar');
    return planBarEl;
  }

  /** 移除所有任务看板（常驻条隐藏 + 浮层收起 + 状态缓存重置）。
   *  注意：clear_ok/切换会话时调用，与 plan 清空（autoClearPlan）的「顶部条收起」语义不同——
   *  clear_ok 意味着完全重置对话区，缓存也应一起清 */
  function removeAllPlanBoards(): void {
    setPlanBarVisible(false);
    currentPlanItems = [];
  }

  /**
   * 「过程在上 · 报告在下」挂载锚点（SSOT）：把过程类元素插到 assistant 块报告正文之前。
   *
   * 两处挂载点共用同一实现，杜绝措辞/语义漂移：
   *   ① ensureProcessFlow（运行时平铺容器 .process-flow）
   *   ② ensureRoundBlock（finalize 折叠区 .round-block）
   *
   * 三段式降级：`.msg-body` 存在 → 插到它之前；否则紧随 `.msg-ai-label`；再否则 prepend。
   *
   * 运行时**无 round-block**，锚点不得依赖它——以它为锚时 querySelector 恒返回 null，
   * 而 insertBefore(el, null) 按 DOM 规范退化为 appendChild，元素落到 assistant 块最末
   * （正文 .msg-body 与 .msg-footer 之后）= 会话内容底部（坑）。
   *
   * @param host assistant 容器（.msg.assistant）
   * @param el 待挂载的过程类元素
   */
  function insertBeforeBody(host: HTMLElement, el: HTMLElement): void {
    const msgBody = host.querySelector(':scope > .msg-body');
    if (msgBody) {
      host.insertBefore(el, msgBody);
      return;
    }
    const label = host.querySelector(':scope > .msg-ai-label');
    if (label) {
      label.after(el);
      return;
    }
    host.prepend(el);
  }

  /** 常驻条可见性切换（幂等：hidden 布尔直控；隐藏时同步收起浮层，防浮层孤儿） */
  function setPlanBarVisible(visible: boolean): void {
    const bar = getPlanBarEl();
    if (!bar) return;
    bar.hidden = !visible;
    if (!visible) setPlanBarExpanded(false);
  }

  /** 锚定浮层展开/收起（点击 head 切换；浮层非 modal——看进度时需同时看正文）。
   *  展开态同时写 aria-expanded（可访问性）与 chevron 图标（chevron-right 收起态 /
   *  chevron-down 展开态，icons.ts 的 SVG）。
   *  懒构建：展开时才从当前快照补建面板（收起态 renderPlanBar 不建 DOM，省运行期开销）。
   *  ⚠ 收起时清空面板内容：plan 清空（收尾 autoClearPlan）后 setPlanBarVisible(false) 把
   *  planBarExpanded 置 false，若旧面板 DOM 残留——再次展开时懒构建门 childElementCount===0
   *  被残留 DOM 挡住不重建，任务表保持第一次展开的快照（数字更新但完成状态不更新）。坑：
   *  清空后展开必重建为最新快照。 */
  function setPlanBarExpanded(expanded: boolean): void {
    planBarExpanded = expanded;
    const bar = getPlanBarEl();
    const head = bar?.querySelector<HTMLElement>('#planBarHead');
    const panel = bar?.querySelector<HTMLElement>('#planBarPanel');
    const chevron = bar?.querySelector<HTMLElement>('#planBarChevron');
    if (head) head.setAttribute('aria-expanded', String(expanded));
    if (panel) {
      // 展开且面板尚未构建（收起态跳过建 DOM）→ 从当前快照补建
      if (expanded && panel.childElementCount === 0 && currentPlanItems.length > 0) {
        renderPlanBarPanel(currentPlanItems);
      } else if (!expanded) {
        // 收起即视为「未构建」：清空面板，防残留 DOM 挡住下次展开的懒构建重建
        panel.innerHTML = '';
      }
      panel.hidden = !expanded;
    }
    if (chevron) applyIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
  }

  /** 渲染常驻条（一行头 + 锚定浮层内容）。头 = N/M + 进度条 + 当前 active 任务项摘要。
   *  浮层懒构建：仅展开态重建面板（运行时 plan_update 频繁，收起态不建 DOM——省开销） */
  function renderPlanBar(items: PlanItemDto[]): void {
    const bar = getPlanBarEl();
    if (!bar) return;
    const doneCount = items.filter((s) => s.status === 'done').length;
    const total = items.length;
    const percent = total > 0 ? (doneCount / total) * 100 : 0;
    const activePlanItem = items.find((s) => s.status === 'active');
    // 头行各槽位（HTML #planBar 内固定 id；零新增协议）
    const countEl = bar.querySelector<HTMLElement>('#planBarCount');
    const fillEl = bar.querySelector<HTMLElement>('#planBarFill');
    const currentEl = bar.querySelector<HTMLElement>('#planBarCurrent');
    if (countEl) countEl.textContent = `${doneCount}/${total}`;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (currentEl) {
      if (doneCount === total && total > 0) {
        currentEl.textContent = '已完成';
      } else if (activePlanItem) {
        const brief =
          activePlanItem.description.length > 28
            ? `${activePlanItem.description.slice(0, 28)}…`
            : activePlanItem.description;
        currentEl.textContent = brief;
      } else {
        currentEl.textContent = '';
      }
    }
    if (planBarExpanded) {
      renderPlanBarPanel(items); // 展开态：面板跟随最新快照重建
    }
    setPlanBarExpanded(planBarExpanded); // 保持展开态（aria/chevron 同步；收起态不建面板）
  }

  /** 渲染锚定浮层内容（全量任务项列表 + 折叠 planItemLog） */
  function renderPlanBarPanel(items: PlanItemDto[]): void {
    const bar = getPlanBarEl();
    const panel = bar?.querySelector<HTMLElement>('#planBarPanel');
    if (!panel) return;
    panel.innerHTML = '';
    panel.appendChild(buildPlanItemList(items));
  }

  /** 构建全量任务项列表（ul.plan-board-list；浮层与 round-block 任务项标签共用——任务项结构单一实现） */
  function buildPlanItemList(items: PlanItemDto[]): HTMLUListElement {
    const ul = document.createElement('ul');
    ul.className = 'plan-board-list';
    for (const planItem of items) {
      // 任务节点折叠：每个任务项一个 details，summary = 序号+描述+状态徽标
      const item = document.createElement('details');
      item.className = `plan-item plan-item-${planItem.status}`;
      item.open = false;
      const summary = document.createElement('summary');
      summary.className = 'plan-item-summary';
      const label = document.createElement('span');
      label.className = 'plan-item-title';
      label.textContent = `${planItem.order + 1}. ${planItem.description}`;
      summary.appendChild(label);
      const badge = document.createElement('span');
      badge.className = 'plan-item-badge';
      badge.textContent = PLAN_ITEM_STATUS_LABEL[planItem.status];
      summary.appendChild(badge);
      item.appendChild(summary);
      const logs = planItem.planItemLog;
      if (logs.length > 0) {
        const body = document.createElement('div');
        body.className = 'plan-item-rounds';
        const now = Date.now();
        for (const r of logs) {
          const row = document.createElement('div');
          row.className = 'plan-item-round';
          // 相对时间：completedAt 可选，有则显示"3s 前 / 2m 前 / 1h 前"
          if (r.completedAt) {
            const span = document.createElement('span');
            span.className = 'plan-item-round-time';
            span.textContent = formatRelativeTime(r.completedAt, now);
            row.appendChild(span);
            const text = document.createElement('span');
            text.textContent = r.summary;
            row.appendChild(text);
          } else {
            row.textContent = r.summary;
          }
          body.appendChild(row);
        }
        item.appendChild(body);
      }
      ul.appendChild(item);
    }
    return ul;
  }

  /** 渲染/刷新单轨任务看板（收到 plan_update 消息时调用）。
   *  非空 plan → 缓存 + 常驻条（≥3 个任务项才显示；该门槛属**展示层自身决策**，与内核
   *  needsPlanning 的布尔判定无对应关系——详见上方任务看板设计注释）；
   *  空 plan → 收起常驻条（内容区零投影——任务过程由 round-block 折叠块承载，不留完成卡片） */
  function renderPlanBoard(items: PlanItemDto[]): void {
    if (items.length === 0) {
      // 空计划（turn 收尾 autoClearPlan / LLM 写入空表）→ 收起顶部条
      setPlanBarVisible(false);
      return;
    }
    // 非空计划：缓存（供 round-block 任务项标签 + 浮层复用）；plan 清空时不清此缓存
    currentPlanItems = items;
    // 常驻门槛 ≥3 个任务项：webview 展示层自身决策（2 个任务项的小任务常驻成噪音）。
    // ⚠️ 勿称「对齐内核 needsPlanning 阈值」——内核 detectNeedsPlanning 是关键词/结构式
    // 布尔判定，**无任务项数阈值**；二者无对应关系，也**不构成需互相同步的一致约束**。
    // ⚠️ 另注意别把内核里那个同数字的 `plan.length < 3` 当成本门槛的真源：它属
    // `agent/taskTableRenderer.buildCompletionVerifyNudge`（≥3 个任务项才注入「补验证任务项」nudge，
    // 理由是「太短不值得打断」）——**收尾验证门槛，与 UI 是否常驻无关**。两处同为 3 属巧合，
    // 改任一处**不需要**同步另一处。
    setPlanBarVisible(items.length >= 3);
    if (items.length >= 3) {
      renderPlanBar(items);
    }
  }
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
  /** 本轮身份（meta 事件写入）：该轮 AI 消息挂的角色/模型标签（与会话级 chat_role_pack 分离） */
  let currentRoundMeta: { role: string; llm: string } | undefined;
  /** 当前轮 round-block 容器（挂在本轮首个 assistant 块；null = 正文块尚未创建） */
  let roundBlockEl: HTMLDetailsElement | null = null;
  /** round-block 已挂载的 assistant 块（重放去重判定：roundId 首次出现才挂） */
  let roundBlockHostEl: HTMLElement | null = null;
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
  // 消息区滚动监听：更新吸底状态 + 一键到底按钮显隐
  messages.addEventListener('scroll', () => {
    const atBottom = trackScroll(messages);
    scrollToBottomBtn.hidden = atBottom;
  });
  // 一键到底点击：滚动到底部并隐藏按钮
  scrollToBottomBtn.addEventListener('click', () => {
    messages.scrollTop = messages.scrollHeight;
    scrollToBottomBtn.hidden = true;
  });
  // 日期分隔线：跨天合并视图在日期交界插入分组
  let lastShownDate: string | undefined;

  /** 本地时区 YYYY-MM-DD 日期键。
   *  ⚠️ **镜像点（刻意为之，勿强行收口）**：内核同语义真源 = `src/utils/time.ts` 的
   *  `formatDateKey`（宿主 Node 侧 chatPanel / sessionStore 即 import 它）。webview 侧**不能**
   *  复用——本文件由 esbuild 以 `platform: 'browser'` / `format: 'iife'` 单独打包
   *  （esbuild.config.mjs 步骤 3），webview 运行时对内核只有 `import type`、无运行时依赖。
   *  故此处为**必要镜像**：改判定口径（换格式 / 改时区）须**两侧同改**。
   *  等价关系：内核 `todayDate()` = 本文件 `toDateKey(new Date())`。
   *  背景：用本地时区（getFullYear/getMonth/getDate）而非 `toISOString().slice(0,10)`（UTC）——
   *  Asia/Shanghai 凌晨 00:00–08:00 期间 UTC 仍是前一天，会导致跨天分组错位。 */
  function toDateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  }

  /** 相对时间格式化（planItemLog 完成时间 → "3s 前 / 2m 前 / 1h 前"） */
  function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
    const diff = Math.max(0, now - timestamp);
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s 前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m 前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h 前`;
    const days = Math.floor(hours / 24);
    return `${days}d 前`;
  }

  /** thinking 阶段 → 中文标签（展示面）。相位取值来自内核 **`ProcessThinkingPhase`**
   *  （memory/roundStore.ts，随 ProcessEvent 下发）；勿误引 agent 层类型 `ThinkingPhase`
   *  ——那是 agent/types.ts 的**另一个类型**（当前同值，但非同一符号、非本条数据来源）。 */
  function phaseLabel(phase: ProcessThinkingPhase): string {
    const map: Record<ProcessThinkingPhase, string> = {
      assembling: '装配上下文中…',
      llm_calling: '调用模型中…',
      processing: '处理中…',
      archiving: '归档记忆中…',
    };
    // `?? '思考中…'` 是**有意保留的兜底，不属「类型兜底残留」**——勿按本文件
    // PLAN_ITEM_STATUS_LABEL 的「枚举固定、无需运行时兜底」原则删掉它：
    // 相位经 postMessage 跨进程到达且**未经运行时校验**，且 replay 会把旧持久化轮的
    // 事件原样重放——历史轮文件可能携带已下线的 `recalling`（现归并为 `assembling`）。
    // 删兜底 → 旧数据渲染出 `undefined`（用户可见的破图）。
    return map[phase] ?? '思考中…';
  }

  /**
   * 工具 → 行动叙述生成器（SSOT：任务过程文字化）
   *
   * 对齐 Trae「执行过程」的工程侧人话渲染（"调用了 X 技能 / 浏览了 N 个网页"）：
   * 由工具名 + args 关键参数确定性生成「读取文件：path」式叙述，零 LLM 成本。
   * 参数名与 src/agent/builtinTools.ts（ToolDefinition.parameters）一一对应。
   * 兜底纪律：未收录工具 / 参数缺失 / args 非 JSON 均回退中文显示名（toolNameMap 单一真源）；
   * 中文名亦未收录的角色包自定义工具才落到原生英文名（零遗漏）；
   * 原始 args JSON 仍保留在折叠 pre 中（细节不丢）。
   */
  type ToolActionFn = (args: Readonly<Record<string, unknown>>) => string | undefined;

  /** 工具 → 行动叙述映射（未收录键 → 回退原生工具名） */
  const TOOL_ACTION_LABELS: Record<string, ToolActionFn> = {
    read_file: (a) => {
      const p = argStr(a, 'path');
      return p ? `读取文件：${p}` : undefined;
    },
    write_file: (a) => {
      const p = argStr(a, 'path');
      return p ? `写入文件：${p}` : undefined;
    },
    delete_file: (a) => {
      const p = argStr(a, 'path');
      return p ? `删除文件：${p}` : undefined;
    },
    list_dir: (a) => {
      const p = argStr(a, 'path');
      return p ? `浏览目录：${p}` : '浏览项目目录';
    },
    search_project: (a) => {
      const q = argStr(a, 'query');
      return q ? `搜索项目：${q}` : '列出项目文件';
    },
    search_memories: (a) => {
      const q = argStr(a, 'query');
      return q ? `检索记忆：${q}` : undefined;
    },
    web_search: (a) => {
      const q = argStr(a, 'query');
      return q ? `联网搜索：${q}` : undefined;
    },
    web_fetch: (a) => {
      const u = argStr(a, 'url');
      return u ? `浏览网页：${u}` : undefined;
    },
    // run_code 双模式：script_path（执行脚本） vs code（直接执行代码片段）
    run_code: (a) => {
      const script = argStr(a, 'script_path');
      if (script) return `运行脚本：${script}`;
      return argStr(a, 'code') ? '运行代码片段' : undefined;
    },
    run_skill_script: (a) => {
      const skill = argStr(a, 'skill_name');
      const script = argStr(a, 'script_path');
      return script ? `执行技能脚本：${skill ? `${skill}/` : ''}${script}` : undefined;
    },
    read_skill: (a) => {
      const n = argStr(a, 'name');
      return n ? `读取技能：${n}` : undefined;
    },
    read_resource: (a) => {
      const p = argStr(a, 'resource_path');
      return p ? `读取资源：${p}` : undefined;
    },
    trace_summary: (a) => {
      const s = argStr(a, 'sessionId');
      return s ? `追溯对话记录：${s}` : undefined;
    },
    list_sessions: () => '列出历史会话',
    list_resources: (a) => {
      const n = argStr(a, 'skill_name');
      return n ? `列出技能资源：${n}` : '列出技能资源';
    },
    list_skills: () => '列出可用技能',
    task_table_write: () => '建立任务计划',
    task_table_update: () => '更新任务进度',
    register_work: (a) => {
      const p = argStr(a, 'path');
      return p ? `登记作品：${p}` : undefined;
    },
    compress_context: () => '整理上下文空间',
  };

  /** 安全取工具 args 的字符串参数（args 为 JSON 解析后的对象；类型不符 / 空返回 undefined） */
  function argStr(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const v = args[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  /** 解析工具 args JSON → 对象；非 JSON / 空返回空对象（叙述按缺参回退原生工具名） */
  function parseToolArgs(raw: string | undefined): Readonly<Record<string, unknown>> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /**
   * 工具行动叙述：命中映射且参数齐备 → 人话描述；否则回退中文显示名（再回退原生工具名）
   *
   * 兜底走 toolNameMap.getToolDisplayName（**工具中文名的唯一真源**）——两类场景在 UI 上
   * 不裸露英文工具名：①未收录工具——ask_user /
   * remember_intel / run_project_script / run_team_meeting（均无可叙述参数，故不入
   * TOOL_ACTION_LABELS）；②已收录但本次 args 缺参（如 read_file 无 path）。
   */
  function toolActionLabel(name: string, argsRaw: string | undefined): string {
    return TOOL_ACTION_LABELS[name]?.(parseToolArgs(argsRaw)) ?? getToolDisplayName(name);
  }

  /** 工具动作分型（收尾叙述句的分组依据，语义与 TOOL_ACTION_LABELS 对齐） */
  type ToolActionType = 'read' | 'search' | 'write' | 'run' | 'other';

  /** 工具名 → 动作分型（未收录归 other） */
  function toolActionType(name: string): ToolActionType {
    if (
      name === 'read_file' ||
      name === 'read_skill' ||
      name === 'read_resource' ||
      name === 'trace_summary' ||
      name === 'web_fetch'
    )
      return 'read';
    if (
      name === 'web_search' ||
      name === 'search_project' ||
      name === 'search_memories' ||
      name === 'list_dir' ||
      name === 'list_sessions' ||
      name === 'list_resources' ||
      name === 'list_skills'
    )
      return 'search';
    if (
      name === 'write_file' ||
      name === 'delete_file' ||
      name === 'register_work' ||
      name === 'task_table_write' ||
      name === 'task_table_update'
    )
      return 'write';
    if (name === 'run_code' || name === 'run_skill_script') return 'run';
    return 'other';
  }

  /** 耗时格式化：≥60s 显示「x m y s」，否则「x.x s」 */
  function fmtDuration(ms: number): string {
    const sec = Math.round(ms / 100) / 10;
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
  }

  /** 轮事件流里全部工具名（按 tool_start 序）——工具叙述的唯一取材点 */
  function toolStartNames(events: ProcessEvent[]): string[] {
    return events.flatMap((e) => (e.type === 'tool_start' ? [e.payload.name] : []));
  }

  /**
   * 工具叙述句（**唯一形成点**）：「工具×N（读取文件 2 · 网络搜索 1）」
   *
   * **词表单一**：句内一律用工具显示名（`getToolDisplayName` = 中文名唯一真源），与工具行叙述
   * （`toolActionLabel`）同词表。轮摘要若另按类别粗分（「读取 2 · 搜索 1」）会形成第二套词汇
   * ——同一次调用在屏上被叫成两种名字，且两套映射表可按不同节奏更新。
   * **不参与成句的工具**：`toolActionType === 'other'`（未知 / 自定义 / 空间整理类）只计入 N、
   * 不占一段，避免用无法辨识的名撑长句子误导读者。
   * **段序**：按工具首次出场序（Map 插入序），与过程流的发生顺序一致，便于回看。
   *
   * 消费方二：轮收尾摘要（整轮）与工具批标题（单批）——同一函数、同一词表，只有取材范围不同。
   *
   * @param names 工具英文名序列（按出场序）
   * @returns 叙述句；无工具返回空串（调用方据此省略整段）
   */
  function toolSummaryText(names: readonly string[]): string {
    if (names.length === 0) return '';
    const counts = new Map<string, number>();
    for (const name of names) {
      if (toolActionType(name) === 'other') continue;
      const label = getToolDisplayName(name);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([label, n]) => `${label} ${n}`);
    return parts.length > 0
      ? `工具×${names.length}（${parts.join(' · ')}）`
      : `工具×${names.length}`;
  }

  /**
   * 审查次数（运行时与重放同一函数）
   *
   * 原 `countEvents` 还兼算工具分型（reads/searches/writes/runs），随着工具叙述改由
   * `toolSummaryText` 承担，那些字段全部清零消费者 → 一并按「不用就删」清掉，避免僵尸结构。
   */
  function countReviews(events: ProcessEvent[]): number {
    return events.filter((e) => e.type === 'self_review').length;
  }

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
    // 流式未完成：footer 初始隐藏（is-pending 由 buildAssistantShell 加类），finalize 时展示。
    // 骨架此刻无 roundId（meta 不带），roundId 由首个 chunk 到达时回填（dataset + 归位判定）
    buildAssistantShell(div, new Date().toISOString(), undefined, { pending: true });
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
    updateEmptyState();
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

  /** 获取或创建小节容器（进行中增量专用：不清理已有内容，防误删已追加的工具行） */
  function getOrCreateSection(details: HTMLElement, title: string): HTMLElement {
    let section = details.querySelector<HTMLElement>(`[data-section="${title}"]`);
    if (!section) {
      section = document.createElement('div');
      section.className = 'round-block__section';
      section.dataset.section = title;
      const titleEl = document.createElement('div');
      titleEl.className = 'round-block__section-title';
      titleEl.textContent = title;
      section.appendChild(titleEl);
      const listEl = document.createElement('div');
      listEl.className = 'round-block__section-list';
      section.appendChild(listEl);
      details.appendChild(section);
    }
    return section;
  }

  /** 在 details 中创建/复用小节容器（标题 + 内容行容器，textContent 构建防注入） */
  function sectionOf(
    details: HTMLElement,
    title: string,
  ): { titleEl: HTMLElement; listEl: HTMLElement } {
    // 全量重建：清空已有列表重排（简单确定性——事件量小），再更新标题计数
    const section = getOrCreateSection(details, title);
    const listEl = section.querySelector('.round-block__section-list') as HTMLElement;
    listEl
      .querySelectorAll('.round-block__row, .round-block__tool, .round-block__pre')
      .forEach((el) => el.remove());
    const titleEl = section.querySelector('.round-block__section-title') as HTMLElement;
    const count = listEl.children.length;
    titleEl.textContent = `${title}${count > 0 ? ` (${count})` : ''}`;
    return { titleEl, listEl };
  }

  /**
   * 过程叙述父块（扁平化）：LLM 一段行动叙述 = 一个可折叠父块——
   * summary 显示首行摘要（截断），展开看全文。工具调用不再嵌套进叙述块——narrate 与 tool
   * 平级、各自独立折叠，按 seq 顺序平铺在 details 顶层（Trae Work 式扁平 step 流）。返回父块 el。
   */
  function createNarrateGroup(
    ev: Extract<ProcessEvent, { type: 'narrate' }>,
    openByDefault = false,
  ): HTMLDetailsElement {
    const row = document.createElement('details');
    row.className = 'round-block__narrate';
    // 展开态：运行中（增量投影）默认展开——过程叙述直显，
    // 保持「任务过程可见」体验；收尾/回放（finalize 重建）默认收起，与 round-block 一致
    row.open = openByDefault;
    // seq 锚点：进行中增量追加去重 + 顶层按序插入（insertPlanItemInOrder）；ts 时间键：统一排序
    row.dataset.seq = String(ev.seq);
    row.dataset.ts = ev.ts;
    const summary = document.createElement('summary');
    const text = ev.payload.content.trim();
    summary.textContent = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const body = document.createElement('div');
    body.className = 'round-block__narrate-body';
    body.textContent = text;
    row.append(summary, body);
    return row;
  }

  /**
   * 思考折叠块（聚合版）：把同一 step 的 thought 碎片聚合成**一个**折叠块，
   * 正文为各碎片累积拼接（碎片不逐条成块，防 LLM 流式 reasoning 切成几十个片段满屏小折叠）。
   * summary = 标题（label，缺省「思考」）+ 首行预览；textContent 构建防注入。
   * streaming 时默认展开（openByDefault=true 由调用方按运行期传），finalize 默认收起。
   */
  function createAggregatedThought(
    contents: readonly string[],
    openByDefault = false,
    ts?: string,
    seq?: number,
    label = '思考',
  ): HTMLDetailsElement {
    // 思考事件存的是**增量 delta 片段**（如 "Now let me also read" / "the" / "gap analysis."），
    // 按序**原样连续拼接**（无分隔符、不逐条 trim，保留片段的天然间隔）→ 还原真正的连续思考流，
    // 而非「每段一行」的碎片化（P3 之二：确保任务项间连贯）。仅外层做 trim 去首尾空白。
    const text = contents.join('').trim();
    const preview = text.slice(0, 80);
    const cnt = contents.filter((c) => c.trim() !== '').length;
    const row = document.createElement('details');
    row.className = 'round-block__thought';
    row.open = openByDefault;
    // ts 时间键（统一排序）：锚点事件 ts，供 insertPlanItemInOrder 时间序归位；
    // seq 兜底比较（同 ts/空串时回落 seq 序，与 narrate/tool 平铺同构）
    if (ts) row.dataset.ts = ts;
    if (seq !== undefined) row.dataset.seq = String(seq);
    const summary = document.createElement('summary');
    summary.textContent =
      cnt > 1
        ? `${label} · ${preview}${text.length > preview.length ? '…' : ''}`
        : preview
          ? `${label} · ${preview}`
          : label;
    const body = document.createElement('div');
    body.className = 'round-block__thought-body';
    body.textContent = text;
    row.append(summary, body);
    return row;
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
    const labelSpan = document.createElement('span');
    labelSpan.className = 'round-block__tool-label';
    // 参数未成形，无法生成行动叙述 → 直显中文显示名（与 toolActionLabel 兜底同源：toolNameMap）
    labelSpan.textContent = getToolDisplayName(pending.name);
    const statusSpan = document.createElement('span');
    statusSpan.className = 'round-block__tool-status';
    statusSpan.textContent = ' (准备中)';
    summary.append(labelSpan, statusSpan);
    row.appendChild(summary);
    flow.appendChild(row);
  }

  /**
   * 工具行升级：pending「准备中」行在 tool_start 到达时转执行态，不重建 DOM——
   * 与 renderToolRow 新建的执行态行同构（叙述/状态/进行中高亮），后续 tool_result 更新
   * （updateToolRowState 按 data-tool-call-id）天然复用，无需特判。
   * 排序键补挂（data-seq / data-ts）：升级后并入所在批（口径③）需要与正式行同构的
   * 时间序锚（insertPlanItemInOrder 归位 / 批内平铺排序）。
   */
  function upgradePendingToolRow(
    row: HTMLDetailsElement,
    start: Extract<ProcessEvent, { type: 'tool_start' }>,
  ): void {
    row.classList.remove('is-tool-pending');
    row.classList.add('is-tool-running');
    // 排序键补挂（与 renderToolRow 同构）：seq = tool_start seq（段 id 取材同源）、ts = 时间键
    row.dataset.seq = String(start.seq);
    row.dataset.ts = start.ts;
    const labelEl = row.querySelector<HTMLElement>('.round-block__tool-label');
    // 参数此刻已完整，按既有多参数叙述生成器复原（renderToolRow 同路）
    if (labelEl) labelEl.textContent = toolActionLabel(start.payload.name, start.payload.args);
    const statusEl = row.querySelector<HTMLElement>('.round-block__tool-status');
    if (statusEl) statusEl.textContent = ' (进行中)';
    // 参数补挂（与 renderToolRow 的 args pre 同构）：展开可看本次调用入参
    if (start.payload.args && !row.querySelector(':scope > .round-block__pre')) {
      const pre = document.createElement('pre');
      pre.className = 'round-block__pre';
      pre.textContent = start.payload.args;
      row.appendChild(pre);
    }
  }

  /**
   * 任务项内过程行按 seq 顺序插入 details 顶层（narrate 与 tool 共用，扁平化平铺）。
   * 进行中增量调用（每次事件到达），避免整体重排导致闪烁/展开态丢失；finalize 全量重建亦
   * 走此通道保持同一排序逻辑。相位行固定在最前，其余按 seq 升序。
   */
  /**
   * 任务项级折叠容器：把 narrate/tool 按 plan_item_boundary 归组。
   * 先在清除式重建时清理旧任务项容器，再按事件 seq 定位应归入的任务项组：
   *   - 无任何 plan_item_boundary → 返回 details 本身（整轮一组，退回扁平现状）；
   *   - 有 plan_item_boundary → 返回最近一条任务项级边界（seq ≤ 目标 seq）所属的任务项折叠块容器，
   *     懒创建（summary 显示「任务项 N · 标题」），保证边界后的过程事件归入对应任务项分组。
   * 调用方用返回值替换 details 作为节点插入目标，实现「边界切组、任务项内平铺」。
   */
  function isPlanItemBoundaryEvent(
    e: ProcessEvent,
  ): e is Extract<ProcessEvent, { type: 'plan_item_boundary' }> {
    return e.type === 'plan_item_boundary';
  }

  /**
   * 定位条目应插入的任务项容器（ts 为该条目的时间键；processEvents 行与 interactiveInputs
   * 条目共用，形态甲统一时间序）。无边界回退 details（整轮一组）。
   *
   * 同 ts（含全空串的历史/测试数据）回落 seq 兜底：boundary 在条目之前（boundary.seq <= 条目 seq）
   * 才归该任务项；QA 条目无 seq（undefined）时同 ts 归最近 boundary，靠写入序稳定。
   */
  function planItemContainerFor(
    root: HTMLElement,
    events: ProcessEvent[],
    ts: string,
    seq?: number,
  ): {
    host: HTMLElement;
    bounds: Extract<ProcessEvent, { type: 'plan_item_boundary' }>[];
  } {
    const bounds = events
      .filter(isPlanItemBoundaryEvent)
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
    if (bounds.length === 0) return { host: root, bounds };
    // 找到 ts 前最近的边界（含本条边界自身）——本条边界之前（ts < 首边界）条目归 details 顶层；
    // 同 ts 时边界须已发生（boundary.seq <= 条目 seq），否则跨到后续 step
    const active = [...bounds]
      .reverse()
      .find((b) => b.ts < ts || (b.ts === ts && (seq === undefined || b.seq <= seq)));
    if (!active) return { host: root, bounds };
    return { host: getOrCreatePlanItemGroup(root, active, bounds), bounds };
  }

  /** 获取或创建任务项折叠块（summary 显示任务项名；存在则复用，不解体既有已插入的任务项内元素） */
  function getOrCreatePlanItemGroup(
    root: HTMLElement,
    bound: Extract<ProcessEvent, { type: 'plan_item_boundary' }>,
    bounds: Extract<ProcessEvent, { type: 'plan_item_boundary' }>[],
  ): HTMLElement {
    const existing = root.querySelector<HTMLElement>(
      `.round-block__plan-item[data-plan-item="${bound.payload.planItemId ?? ''}"]`,
    );
    if (existing && existing.isConnected) return existing;
    const grp = document.createElement('details');
    grp.className = 'round-block__plan-item';
    if (bound.payload.planItemId) grp.dataset.planItem = bound.payload.planItemId;
    // ts/seq = 边界事件自身的排序键：任务项组**参与** insertPlanItemInOrder 的统一 (ts, seq) 序
    // （组与行是同一坐标系里的两种条目）。不挂 → 行无处可比 → 根层无同层行时 appendChild
    // 把「组外内容」甩到所有组之下（组内工具已全部进组时必然发生）。
    grp.dataset.ts = bound.ts;
    // 任务项序号 = 该边界在所有边界中的排名 + 1（从 1 起）
    const order = bounds.indexOf(bound) + 1;
    const title = bound.payload.title?.trim() ?? '';
    const summary = document.createElement('summary');
    summary.className = 'round-block__plan-item-summary';
    summary.textContent = `任务项 ${order} · ${title.length > 36 ? `${title.slice(0, 36)}…` : title}`;
    grp.appendChild(summary);
    // 任务项内叙述/工具父容器：按序插入 details 顶层，容器内平铺该任务项过程事件
    insertPlanItemGroupInOrder(root, grp, bound.ts, bound.seq);
    return grp;
  }

  /** 任务项级容器按边界的 (ts, seq) 插入 details 顶层（与任务项/时间轴插入域的排序键同源，防乱序） */
  function insertPlanItemGroupInOrder(
    root: HTMLElement,
    grp: HTMLElement,
    boundTs: string,
    boundSeq: number,
  ): void {
    // 候选限定为 root 的**直接子节点**：与 insertPlanItemInOrder 同构隐患，
    // 对称补齐——不然任意深度后代会让 insertBefore(grp, next) 的 next 不是 root 的直接子节点，
    // 按 DOM 规范抛 NotFoundError（同类失败模式的另一半）。当前任务项分组恒为容器直接子节点
    // （静态上 root 只会是 flow / details，绝不会是任务项分组自身），故属防御性、零行为变更。
    const existingGrps = Array.from(
      root.querySelectorAll<HTMLElement>(':scope > .round-block__plan-item'),
    );
    const next = existingGrps.find((g) => {
      // 排序键与 bounds 排序 / 任务项编号 / insertPlanItemInOrder 同源：ts 优先、同 ts 回落 seq。
      // 组的视觉位置与「任务项 N」编号出自同一把键，否则 ts 与 seq 逆序的样本（时钟回拨 /
      // 历史补写）会让两者分家——屏幕上「任务项 2」排到「任务项 1」之前。
      const t = g.dataset.ts ?? '';
      if (t !== boundTs) return t > boundTs;
      return Number(g.dataset.seq ?? Infinity) > boundSeq;
    });
    if (next) {
      root.insertBefore(grp, next);
    } else {
      root.appendChild(grp);
    }
    grp.dataset.seq = String(boundSeq);
  }

  /** 思考折叠块标题：stepIndex 已知 = 标注第几步（一个 step 一个折叠块）；无归属 = 裸「思考」 */
  function thoughtLabel(stepIndex?: number): string {
    return stepIndex !== undefined ? `思考 · 第 ${stepIndex} 步` : '思考';
  }

  /**
   * 思考碎片按「所属 step」分桶（SSOT；finalize 与流式两类上下文共用）。
   *
   * 语义：**一个 step 一个思考折叠块**（step = 一次 LLM 调用 + 可选工具执行）。分桶键 =
   * 该碎片自带的 stepIndex（内核 loop 打标、随事件落盘，运行时与重放同源）。同一桶内碎片
   * 保序**原样连续**拼接（连贯）；不同 step 各自独立折叠（不跨步混批）。含 anchorSeq
   * （桶内最早碎片的 seq，做插入锚点）。stepIndex 缺省（旧数据 / 非迭代路径产出）回落
   * 'root' 整轮单桶——不猜测推断归属。有任务表时桶仍按 anchor 归入任务项分组（planItemContainerFor）。
   */
  function groupThoughtBuckets(events: ProcessEvent[]): {
    key: string;
    stepIndex?: number;
    anchorSeq: number;
    anchorTs: string;
    items: { seq: number; ts: string; content: string }[];
  }[] {
    const thoughts = events
      .filter((e): e is Extract<ProcessEvent, { type: 'thought' }> => e.type === 'thought')
      .sort((a, b) => a.seq - b.seq);
    const buckets = new Map<
      string,
      {
        key: string;
        stepIndex?: number;
        anchorSeq: number;
        anchorTs: string;
        items: { seq: number; ts: string; content: string }[];
      }
    >();
    for (const t of thoughts) {
      const stepIndex = t.payload.stepIndex;
      const key = stepIndex !== undefined ? String(stepIndex) : 'root';
      const bucket = buckets.get(key) ?? {
        key,
        stepIndex,
        anchorSeq: t.seq,
        anchorTs: t.ts,
        items: [],
      };
      bucket.items.push({ seq: t.seq, ts: t.ts, content: t.payload.content });
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.anchorSeq - b.anchorSeq);
  }

  /**
   * 工具批（toolBatch）批内条目：一次工具调用 = tool_start + 按 toolCallId 配对的 tool_result
   * （结果未回 = 进行中条目，批内占位不拆段）。
   */
  interface ToolBatchEntry {
    /** 工具开始事件（段内容主体；行渲染的锚） */
    start: Extract<ProcessEvent, { type: 'tool_start' }>;
    /** 已回的结果（缺省 = 进行中；失败/被拒同样留段内，口径②） */
    result?: Extract<ProcessEvent, { type: 'tool_result' }>;
  }

  /**
   * 工具批（toolBatch）：过程条目流中前后相邻、中间无打断物的最大工具序列。
   *
   * segId = 段内首个 tool_start 的 seq——批容器唯一 DOM key（`data-tool-batch`），
   * 稳定可复现、不新造标识（口径③：批 key 用段 id，不用 toolCallId）。
   */
  interface ToolBatch {
    /** 段 id（= 段内首个 tool_start 的 seq） */
    segId: number;
    /** 段内首个 tool_start 的 ts（批块插入定位时间键，与逐条工具行同锚） */
    anchorTs: string;
    /** 段内工具按 tool_start seq 序 */
    entries: ToolBatchEntry[];
  }

  /**
   * 批间打断物白名单（**唯一声明处**；他处引用本名，不重述集合）。
   *
   * 资格 = 「自身在过程条目流中渲染成一条可见内容」——只有这样才能充当两个相邻工具之间的视觉断面。
   * - `narrate`：工具轮叙述行（宿主渲染「AI 说什么：」后接工具块）；
   * - `text_self_review`：自审查**输出**（**非**正文——主回答正文走内容轨 `chunk`，落盘没有对应过程事件，
   *   结构上不可能出现在工具之间）。自审查只在工具循环后做一次终审，故它**常态**居工具之后；
   *   仅「审查轮交付后排队插话续跑、续跑再调工具」这一路径可让它落在两条工具之间 → **可达，保留**。
   * - `plan_item_boundary`：任务项折叠分组边界（分组容器本身即断面）。
   * 其余类型（thinking / memory_added / self_review / tool_start / tool_result / metrics / aborted / meta）
   * 都不渲染成可断面 → 不断段。
   */
  const BATCH_SPLITTER_TYPES: ReadonlySet<ProcessEvent['type']> = new Set([
    'narrate',
    'text_self_review',
    'plan_item_boundary',
  ]);

  /**
   * 外部可见条目的边界时间集（工具批断面的**取数处**）。
   *
   * 为什么需要：`groupToolBatches` 只吃 `events`，而问答卡（`.round-block__input`）来自
   * `interactiveInputs` / 运行时缓存——**无 seq、不在 events 里** ⇒ 对切段判据天然不可见，
   * 于是「工具 → 问答卡 → 工具」被并成一批、卡片被推到批块之后（登记缺陷 BATCH-SPLIT-1）。
   * 本函数抽出「同容器里实际可见的问答卡 ts」，作**虚拟断面**喂给切段判据（不碰内核）。
   *
   * 只取 ts：问答卡无 seq，唯一可用的时空键就是 ts；而落位（`insertPlanItemInOrder`）同样按 ts，
   * 故断面判据与呈现同键——避免「判据一套键、呈现另一套键」的双键病复发。
   *
   * @param root  过程容器（`.round-block__details` 或 `.process-flow`），取其后代问答卡
   * @param extra 尚未落 DOM 的条目（finalize 的 `interactiveInputs` 入参）
   * @returns    去重后的 ts 列表（空串剔除——历史/测试数据无时间键，不构成断面；无需排序，仅用于计数）
   */
  function visibleInputTs(
    root: HTMLElement,
    extra: readonly (string | undefined)[] = [],
  ): string[] {
    const ts = new Set<string>();
    root.querySelectorAll<HTMLElement>('.round-block__input').forEach((el) => {
      const t = el.dataset.ts;
      if (t) ts.add(t);
    });
    for (const t of extra) if (t) ts.add(t);
    return [...ts];
  }

  /**
   * 工具批切段（SSOT；三渲染上下文共用：运行时流式 / finalize 全量重建 / pending 行升级）
   *
   * 判据（docs/architecture/tool-batch-splitting.md §4.1；扩展 方案-工具批折叠合并-20260925.md §3.1）：
   *   · 打断物（一切断段）：`BATCH_SPLITTER_TYPES` 三成员（narrate / text_self_review / plan_item_boundary）。
   *   · **步切换（新增）**：`thought` 归属新 step（其 `stepIndex` ≠ 当前批所属 step）→ 断段。
   *     语义 = 「可见分隔物」——思考块换步即视觉断面，工具随之按步分块。**同 step 的思考碎片**
   *     （同 `stepIndex`）**不断段**（step 内伴随物）；两侧任一 `stepIndex` 缺省（旧数据）→ 回落相邻性。
   *     无思考分隔的跨 step 工具序列（模型不产 reasoning）→ 维持相邻合并（无可见断面即不切）。
   *   · `tool_start` / `tool_result` 为段内容（结果按 toolCallId 配对归属其 tool_start）。
   *   · **外部可见条目（新增）**：`boundaryTs` 非空时，相邻两条工具的 ts 之间若夹着外部可见条目
   *     （问答卡，见 `visibleInputTs`）→ 断段。判据 = 「桶号」（小于该工具 ts 的边界数）变化，
   *     与落位同用 ts 键——呈现在哪、断面就在哪。
   * 其余条目（thinking / memory_added 等）不在打断物清单内 → 不断段。
   *
   * @param events     当前轮全部过程事件（流式与重放同源输入）
   * @param boundaryTs 外部可见条目（问答卡）的 ts 集。**必传、不设默认值**：空数组的语义 = 「无外部
   *   条目即无断面」，而那正是缺陷 BATCH-SPLIT-1 的形态——设默认值等于让漏传者静默回落缺陷行为
   * @returns 批数组（按段内首个 tool_start 的 seq 升序；空流返回空数组）
   */
  function groupToolBatches(events: ProcessEvent[], boundaryTs: readonly string[]): ToolBatch[] {
    // 全序按 seq 稳定排序（宿主可见 ProcessEvent 全序，方案 §二约束：判据只读 seq/类型/toolCallId）
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    // 桶号 = 小于该 ts 的边界条目数：相邻工具桶号不同 ⇒ 二者之间夹着问答卡 ⇒ 断段
    const bucketOf = (ts: string): number => {
      let n = 0;
      for (const b of boundaryTs) if (b < ts) n += 1;
      return n;
    };
    // toolCallId → 结果（段内容配对表；先建表后分组，结果可晚于打断物到达仍归属其 start）
    const results = new Map<string, Extract<ProcessEvent, { type: 'tool_result' }>>();
    for (const e of ordered) {
      if (e.type === 'tool_result') results.set(e.payload.toolCallId, e);
    }
    const batches: ToolBatch[] = [];
    // 当前开放中的段（null = 下一个 tool_start 开新段）
    let current: ToolBatch | null = null;
    // 当前批所属 step（= 开批那条 tool_start 的 stepIndex；undefined = 旧数据无归属 → 不参与步切换判据）
    let currentStep: number | undefined;
    // 当前批的边界桶号（开批时定；与新工具比对，变化即断段）
    let currentBucket = 0;
    for (const e of ordered) {
      if (e.type === 'tool_start') {
        const bucket = bucketOf(e.ts);
        // 外部可见条目断面：跨过问答卡 → 关批（由下方开新批）
        if (current && bucket !== currentBucket) current = null;
        if (!current) {
          current = { segId: e.seq, anchorTs: e.ts, entries: [] };
          currentStep = e.payload.stepIndex;
          currentBucket = bucket;
          batches.push(current);
        }
        current.entries.push({ start: e, result: results.get(e.payload.toolCallId) });
      } else if (BATCH_SPLITTER_TYPES.has(e.type)) {
        // 打断物（白名单 = BATCH_SPLITTER_TYPES 唯一声明）：断段；其余条目穿插不断段
        current = null;
      } else if (e.type === 'thought') {
        // 步切换断段：思考归属新 step（两侧 stepIndex 均已知且不同）→ 可见分隔物出现，断段
        const s = e.payload.stepIndex;
        if (current && currentStep !== undefined && s !== undefined && s !== currentStep) {
          current = null;
        }
      }
    }
    return batches;
  }

  /**
   * 刷新批块标题（工具叙述句 + 失败/被拒块级标红提示）
   *
   * 标题 = `toolSummaryText` 的输出（轮收尾摘要同款，同一处形成）——批不再按工具名另起一份计数，
   * 也不挂序号：批号与「思考 · 第 N 步」互不对齐，属屏上第二套编号（STEP-ID-1 防复发精神）。
   *
   * 口径②：失败/被拒工具留段内不拆块，仅在块级打红色提示——拆块会让视觉随错误率抖动。
   * 流式每次增量渲染与 finalize 全量重建都全量重算（结果后到时提示随之更新，幂等）。
   *
   * @param block 批块元素（.round-block__tool-batch）
   * @param batch 工具批（小计/失败统计的唯一数据源）
   */
  function refreshToolBatchSummary(block: HTMLDetailsElement, batch: ToolBatch): void {
    const summary = block.querySelector(':scope > .round-block__tool-batch-summary');
    if (!summary) return;
    // 标题 span 为稳定节点（get-or-create）+ 变化才写文本：summary 子节点重建会销毁点击目标，
    // 事件密集期点击被吞
    let title = summary.querySelector<HTMLElement>(':scope > .round-block__tool-batch-title');
    if (!title) {
      title = document.createElement('span');
      title.className = 'round-block__tool-batch-title';
      summary.appendChild(title);
    }
    const titleText = toolSummaryText(batch.entries.map((e) => e.start.payload.name));
    if (title.textContent !== titleText) title.textContent = titleText;
    // 失败/被拒统计（留段内，块级标红）：ok=false 且非 blocked = 失败；blocked = 被拒/拦截
    let failed = 0;
    let blocked = 0;
    for (const e of batch.entries) {
      const r = e.result;
      if (!r) continue;
      if (r.payload.blocked === true) blocked += 1;
      else if (!r.payload.ok) failed += 1;
    }
    block.classList.toggle('is-tool-batch-failed', failed + blocked > 0);
    const parts: string[] = [];
    if (failed > 0) parts.push(`含失败 ${failed}`);
    if (blocked > 0) parts.push(`含拦截 ${blocked}`);
    // 提示 span 同为稳定节点：无提示即移除（生命周期随统计结果，title 节点不受影响）
    let warn = summary.querySelector<HTMLElement>(':scope > .round-block__tool-batch-warn');
    if (parts.length === 0) {
      warn?.remove();
      return;
    }
    if (!warn) {
      warn = document.createElement('span');
      warn.className = 'round-block__tool-batch-warn';
      summary.appendChild(warn);
    }
    const warnText = `（${parts.join(' · ')}）`;
    if (warn.textContent !== warnText) warn.textContent = warnText;
  }

  /**
   * 创建批块容器（多工具批专用；单工具批不包裹 = 行即批，视觉等价现状零回归）
   *
   * DOM key 契约（口径③）：批容器键 = 段 id（`data-tool-batch`），不用 toolCallId；
   * 行自身的 `data-tool-call-id` 只作 tool_result 配对键（updateToolRowState 消费），二者不混用。
   *
   * @param batch 工具批
   * @param open  是否默认展开（流式过程实时可见 = true；finalize 收起 = false）
   */
  function createToolBatchBlock(batch: ToolBatch, open: boolean): HTMLDetailsElement {
    const block = document.createElement('details');
    block.className = 'round-block__tool-batch';
    // 段 id = 段内首个 tool_start 的 seq：批容器唯一 DOM key（data-tool-batch）+ seq 兜底排序键
    block.dataset.toolBatch = String(batch.segId);
    block.dataset.seq = String(batch.segId);
    block.dataset.ts = batch.anchorTs;
    block.open = open;
    const summary = document.createElement('summary');
    summary.className = 'round-block__tool-batch-summary';
    const body = document.createElement('div');
    body.className = 'round-block__tool-batch-body';
    block.append(summary, body);
    refreshToolBatchSummary(block, batch);
    return block;
  }

  /**
   * 过程条目按统一时间键（data-ts）插入容器顶层。
   *
   * 形态甲：排序键统一为 **ts（时间键）**——processEvents 行（narrate/tool/thought）
   * 与 interactiveInputs 条目（QA，无 seq）共用同一时间序，用户输入自然归位到对应任务项间隙。
   * 行创建点统一挂 `data-ts`（ISO 字符串，localeCompare 同值比较即时间序）；无 data-ts 的
   * 异常节点（如 pending 工具行）视为最大键（恒末尾，与 appendChild 流尾语义一致）。
   *
   * 候选限定为 details 的**直接子节点**：存在 plan_item_boundary 时同款元素
   * 嵌套在 .round-block__plan-item 分组内部，任意深度后代会让 insertBefore(el, next) 的 next 不是
   * details 的直接子节点 → 按 DOM 规范抛 NotFoundError（曾静默打断 finalizeRound 收口）。
   * 候选类型 = narrate/tool/thought/工具批块 + 任务项组 + 运行时输入条目（input，形态甲）。
   *
   * **任务项组必须入候选（勿删）**：组与行同处一条 (ts, seq) 序——组挂边界事件的 ts/seq，
   * 行挂自身事件键。若把组排除在外，则「组 vs 行」永不比较，行只与行比、组只与组比；
   * 一旦根层没有同层行可锚（该轮工具已全被任务项边界收进组内），行会走 appendChild 落到
   * **所有组之后**，表现为「组外的思考块沉底」。
   */
  function insertPlanItemInOrder(details: HTMLElement, el: HTMLElement, ts: string): void {
    const existing = Array.from(
      details.querySelectorAll<HTMLElement>(
        ':scope > .process-flow__narrate, :scope > .round-block__narrate, :scope > .round-block__tool, :scope > .process-flow__tool, :scope > .round-block__tool-batch, :scope > .round-block__thought, :scope > .process-flow__thought, :scope > .round-block__input, :scope > .process-flow__input, :scope > .round-block__plan-item',
      ),
    ).filter((e) => e !== el);
    const next = existing.find((e) => {
      const t = e.dataset.ts ?? '';
      // 排序键 = ts（统一时间序）；同 ts（含全空串的历史/测试数据）回落 seq 兜底：
      // processEvents 行挂 data-seq，seq 大者排后；QA 条目无 seq 视为 0，靠写入序保持稳定
      if (t !== ts) return t > ts;
      const s = Number(e.dataset.seq ?? 0);
      const myS = Number(el.dataset.seq ?? 0);
      return s > myS;
    });
    if (next) {
      details.insertBefore(el, next);
    } else {
      // 无更高 ts → append 到末尾。注意：不用 phase.after(el)（phase 在 prepend 后居首，
      // phase.after 会把元素插到第二位置，破坏与低 ts 平铺元素——如 narrate——的时间序）
      details.appendChild(el);
    }
  }

  /**
   * 工具调用行（tool_start 配对 tool_result）——折叠行：summary = 名称(状态) 常显，
   * args + result 摘要折叠进 body，避免工具详情抢占报告主体。失败/进行中默认展开（错误直显）。
   * 宿主容器（扁平化）：直接平铺在 round-block__details 顶层（insertPlanItemInOrder 按 seq 插入）。
   */
  /**
   * TS-12b：aborted 中断语义 → 展示文案（单一映射，与 error category 词典同构）。
   * 'user' → 用户停止；'interrupted' → 中断；
   * 无 stopReason（旧数据/直接构造） → 回退 reason 原文（调试可追溯，不丢原始细节）。
   * 注：'connection' 不在此映射——连接中断统一由 error chunk category 承载（TS-10b chatPanel 映射），
   * aborted 永不带此语义，假分支删除防文案双源漂移。
   */
  function stopReasonLabel(payload: { reason: string; stopReason?: string }): string {
    const map: Record<string, string> = {
      user: '用户停止了对话',
      timeout: '对话处理超时，请稍后重试',
      interrupted: '对话已中断',
    };
    return (payload.stopReason && map[payload.stopReason]) || payload.reason;
  }

  /**
   * TS-11a：定位「进行中工具」——tool_start 已到、tool_result 未达的最新一个（工具并行执行时以
   * 最新未完成者作为「当前正在做什么」的展示主体）。无进行中工具返回 null（相位行回退 thinking）。
   */
  function findRunningTool(
    events: ProcessEvent[],
  ): Extract<ProcessEvent, { type: 'tool_start' }> | null {
    const starts = events.filter(
      (e): e is Extract<ProcessEvent, { type: 'tool_start' }> => e.type === 'tool_start',
    );
    // 从最新往前找第一个没有配对的 tool_result 的 tool_start
    for (let i = starts.length - 1; i >= 0; i--) {
      const start = starts[i]!;
      const matched = events.some(
        (e) => e.type === 'tool_result' && e.payload.toolCallId === start.payload.toolCallId,
      );
      if (!matched) return start;
    }
    return null;
  }

  /**
   * 工具行状态（单一推导，renderToolRow/updateToolRowState 共用）：
   * 无结果=进行中（TS-11b 默认展开 + running 标记，让正在执行的工具可见）；
   * 策略拦截（blocked）=已拦截且默认展开（拒绝文案应直接可见）；
   * 其余按 ok 成功/失败，失败默认展开（错误可见优先于整洁）。
   */
  function toolRowStatus(result: Extract<ProcessEvent, { type: 'tool_result' }> | undefined): {
    label: string;
    open: boolean;
    running: boolean;
  } {
    if (!result) return { label: '进行中', open: true, running: true };
    if (result.payload.blocked === true) return { label: '已拦截', open: true, running: false };
    return result.payload.ok
      ? { label: '成功', open: false, running: false }
      : { label: '失败', open: true, running: false };
  }

  function renderToolRow(
    start: Extract<ProcessEvent, { type: 'tool_start' }>,
    events: ProcessEvent[],
  ): HTMLDetailsElement {
    const result = events.find(
      (e): e is Extract<ProcessEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && e.payload.toolCallId === start.payload.toolCallId,
    );
    const { label: status, open, running } = toolRowStatus(result);
    const row = document.createElement('details');
    row.className = 'round-block__tool';
    // 增量追加去重锚点：toolCallId（唯一标识）+ seq（顶层按序平铺，insertPlanItemInOrder）；ts 时间键
    row.dataset.toolCallId = start.payload.toolCallId;
    row.dataset.seq = String(start.seq);
    row.dataset.ts = start.ts;
    row.open = open;
    // TS-11b：进行中态 class（未出结果时高亮；result 到达由 updateToolRowState 移除）
    row.classList.toggle('is-tool-running', running);
    const summary = document.createElement('summary');
    summary.className = 'round-block__tool-name';
    // TS-11 结构化管理：叙述与状态标签分孤儿 span——状态标签独占定位供 updateToolRowState 精确更新，
    // 与 TS-11c elapsed 等待标签（append 到 summary 尾部）共存不冲突（若仍用整体 textContent 替换，
    // 尾部 Ns 会使状态正则 `\)$` 失配，状态标签停更）
    const labelSpan = document.createElement('span');
    labelSpan.className = 'round-block__tool-label';
    labelSpan.textContent = toolActionLabel(start.payload.name, start.payload.args);
    const statusSpan = document.createElement('span');
    statusSpan.className = 'round-block__tool-status';
    statusSpan.textContent = ` (${status})`; // 前导空格：span 间空白不折叠，显式补「叙述 (状态)」间距
    summary.append(labelSpan, statusSpan);
    row.appendChild(summary);
    if (start.payload.args) {
      const pre = document.createElement('pre');
      pre.className = 'round-block__pre';
      pre.textContent = start.payload.args;
      row.appendChild(pre);
    }
    if (result?.payload.summary) {
      const sum = document.createElement('div');
      sum.className = 'round-block__tool-summary';
      sum.textContent = result.payload.summary;
      row.appendChild(sum);
    }
    // 返回行元素：由调用方按 seq 插入 details 顶层（扁平化，不再自挂容器）
    return row;
  }

  /**
   * 工具行状态局部更新：tool_result 到达时，定位已渲染的工具行更新 状态/展开/结果摘要。
   * （进行中工具行已由增量追加创建，result 后到只需原地更新，不重建 DOM）
   *
   * @param container 工具行所在的小节容器（.round-block__section-list）
   * @param result    tool_result 事件
   */
  function updateToolRowState(
    container: HTMLElement,
    result: Extract<ProcessEvent, { type: 'tool_result' }>,
  ): void {
    container
      .querySelectorAll<HTMLDetailsElement>(
        `.round-block__tool[data-tool-call-id="${result.payload.toolCallId}"]`,
      )
      .forEach((row) => {
        const { label: status, open, running } = toolRowStatus(result);
        // 结构化管理：仅更新状态标签 span 文本（不动整体 summary，保留 label / elapsed 子节点）。
        // 幂等写：文本未变不重写（重写销毁文本节点，点击目标抖动）
        const statusEl = row.querySelector('.round-block__tool-status');
        const statusText = ` (${status})`;
        if (statusEl && statusEl.textContent !== statusText) statusEl.textContent = statusText;
        // 用户意图闩（data-user-toggled，写入点 = summary 点击委托）：用户动过开合的行，
        // 默认值（成功收起/失败展开）不再覆盖——每次事件都回写会把用户的展开态打回。
        // 唯一例外通道 = openForUserVisibility（用户输入恒可见强制展开，只作用任务项分组）
        if (row.dataset.userToggled !== 'true') row.open = open;
        // result 已到达 → 移除进行中态（恢复普通行样式）
        row.classList.toggle('is-tool-running', running);
        // 工具已出结果 → 移除该行等待时长标签（瞬态退场，不再刷新）
        row.querySelector(':scope .round-block__elapsed')?.remove();
        // 结果摘要：首次到达补 DOM（后续到达不重复）
        if (result.payload.summary && !row.querySelector('.round-block__tool-summary')) {
          const s = document.createElement('div');
          s.className = 'round-block__tool-summary';
          s.textContent = result.payload.summary;
          row.appendChild(s);
        }
      });
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
   */
  function renderRoundBlock(
    events: ProcessEvent[],
    finalize: boolean,
    interactiveInputs?: RuntimeInteractiveInput[],
  ): void {
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
    // 从 currentPlanItems 缓存读（plan_update 消息存，零新增协议）；每次重建保证始终正确
    const existingTag = rb.querySelector(':scope .round-block__plan-tag') as HTMLElement | null;
    if (currentPlanItems.length > 0) {
      const activePlanItem = currentPlanItems.find((s) => s.status === 'active');
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
        // 无 active step（全部 done 或 pending）→ 移除标签
        existingTag.remove();
      }
    } else if (existingTag) {
      // currentPlanItems 为空 → 移除旧标签
      existingTag.remove();
    }
    // 展开态：进行中自动展开（任务过程实时可见），完成自动收起（只留摘要，报告干净）
    rb.open = !finalize;
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
      const { host } = planItemContainerFor(details, events, n.ts, n.seq);
      insertPlanItemInOrder(host, createNarrateGroup(n), n.ts);
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
      const { host } = planItemContainerFor(details, events, batch.anchorTs, batch.segId);
      if (!multi) {
        const row = renderToolRow(batch.entries[0]!.start, events);
        // 行即批：批容器 key（段 id）挂行自身（口径③：批 key = 段 id，非 toolCallId）
        row.dataset.toolBatch = String(batch.segId);
        insertPlanItemInOrder(host, row, batch.anchorTs);
        continue;
      }
      const block = createToolBatchBlock(batch, false);
      const body = block.querySelector('.round-block__tool-batch-body') as HTMLElement;
      for (const entry of batch.entries) body.appendChild(renderToolRow(entry.start, events));
      insertPlanItemInOrder(host, block, batch.anchorTs);
    }
    // § 思考（per-step 聚合折叠块）：**一个 step 一个折叠块**（同 step 碎片原样连续拼接，
    // 不同 step 各自独立），按各自最早 seq 与 narrate/tool 平铺（finalize 默认收起）；
    // 有任务表时随 anchor 归入任务项分组（边界切组语义不变）。
    const thoughtBuckets = groupThoughtBuckets(events);
    for (const b of thoughtBuckets) {
      const { host } = planItemContainerFor(details, events, b.anchorTs, b.anchorSeq);
      insertPlanItemInOrder(
        host,
        createAggregatedThought(
          b.items.map((i) => i.content),
          false,
          b.anchorTs,
          b.anchorSeq,
          thoughtLabel(b.stepIndex),
        ),
        b.anchorTs,
      );
    }
    // § 运行时输入（形态甲）：跨重建快照条目 + finalize 合并流条目统一按统一时间键（ts）
    //   归位到对应任务项分组（补充挂刚结束的任务项间隙），不搬家、不追加末尾。data-ts 去重防双轨重复。
    const renderedInputTs = new Set<string>();
    for (const el of existingInputs) {
      const tsKey = el.dataset.ts ?? '';
      if (!tsKey || renderedInputTs.has(tsKey)) continue;
      renderedInputTs.add(tsKey);
      const { host } = planItemContainerFor(details, events, tsKey);
      insertPlanItemInOrder(host, el, tsKey);
    }
    for (const qa of interactiveInputs ?? []) {
      const tsKey = qa.ts ?? '';
      if (!tsKey || renderedInputTs.has(tsKey)) continue;
      renderedInputTs.add(tsKey);
      const item = renderQaItem(qa.text, qa.kind, qa.question, qa.options);
      item.dataset.ts = tsKey;
      const { host } = planItemContainerFor(details, events, tsKey);
      insertPlanItemInOrder(host, item, tsKey);
    }
    // § 过程轨迹（thinking 阶段：聚合计数，去噪——同一相位 N 条 thinking 事件
    //  压缩为一行「相位 ×N」，避免「调用模型中…」重复 12 次平铺成视觉噪点；保序：按首次出现序）
    const thinking = events.filter(
      (e): e is Extract<ProcessEvent, { type: 'thinking' }> => e.type === 'thinking',
    );
    if (thinking.length > 0) {
      const { listEl } = sectionOf(details, '过程轨迹');
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
      const { listEl } = sectionOf(details, '已沉淀');
      added.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = e.payload.name || e.payload.id;
        listEl.appendChild(row);
      });
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
      const { listEl } = sectionOf(details, '自审查输出');
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
      const { listEl } = sectionOf(details, '已停止');
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
      const { listEl } = sectionOf(details, '执行指标');
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
        // 口径须显式：入/出均为估算值；「出」只计正文——不含思考与工具轮叙述，
        // 推理模型下远小于真实输出预算消耗（判压力看下行「输出上限」+ 截断重试救回）
        `Tokens（估算）：入 ${metrics.payload.tokenIn} / 正文 ${metrics.payload.tokenOut}（不含思考）`,
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
        const kindTag = (kind: 'question-answer' | 'supplement' | 'timeout'): string | null =>
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
          if (elTs && countedTs.has(elTs)) continue;
          if (elTs) countedTs.add(elTs);
          qaCount.set(tag, (qaCount.get(tag) ?? 0) + 1);
        }
        // 合并流条目：按 kind 映射 tag（data-ts 去重同渲染循环）
        for (const qa of interactiveInputs ?? []) {
          const tag = kindTag(qa.kind);
          if (!tag || !qa.ts || countedTs.has(qa.ts)) continue;
          countedTs.add(qa.ts);
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
      const { host } = planItemContainerFor(flow, events, n.ts, n.seq);
      insertPlanItemInOrder(host, row, n.ts);
    }
    // 2.5) thought 思考折叠（per-step 聚合）：**一个 step 一个折叠块**（同步内碎片原样连续
    //   拼接，不同 step 各自独立）；每个块维护自己 data-merged-seq 防重复拼接。
    const thoughtBuckets = groupThoughtBuckets(events);
    for (const b of thoughtBuckets) {
      // 复用任务项容器定位 → 与最终分桶位置一致，流式与 finalize 不偏移
      const { host } = planItemContainerFor(flow, events, b.anchorTs, b.anchorSeq);
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
        summaryEl.textContent = thoughtLabel(b.stepIndex);
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
      const { host } = planItemContainerFor(flow, events, batch.anchorTs, batch.segId);
      // 行的目标容器：多工具批 = 批块 body；单工具批 = 任务项容器（行即批，视觉等价现状）
      let body: HTMLElement = host;
      if (multi) {
        let block = host.querySelector<HTMLDetailsElement>(
          `:scope > .round-block__tool-batch[data-tool-batch="${batch.segId}"]`,
        );
        if (!block) {
          block = createToolBatchBlock(batch, true);
          insertPlanItemInOrder(host, block, batch.anchorTs);
        } else {
          // 已有批块（增量期间结果/新工具到达）→ 叙述句与失败提示随批内容重算
          refreshToolBatchSummary(block, batch);
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
            upgradePendingToolRow(existing, entry.start);
          }
          row = existing;
        } else {
          row = renderToolRow(entry.start, events);
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
  }

  /**
   * 中断轮平铺收尾行（形态定案：RT/RP 同构——过程收进折叠块、「用户停止了对话」平铺折叠块外）
   *
   * 语义映射同旧的 §已停止：error（失败：超时/连接中断）优先，其次 aborted（中断：用户停止/锁超时），
   * 皆无则 generic 停文案（旧数据）。error 优先是保守排序——二者本应互斥（failed 路径 signal 未 abort），
   * 此序仅防异常组合。执行指标留在折叠块 §执行指标/摘要（收起态摘要含耗时），停止行只承担
   * 「这轮为何停」的常驻提示，不重复指标。data-interrupted-row 去重幂等（重放重复投递防叠加）。
   *
   * @param host  折叠块宿主（RT = 当前 assistant 块；RP = 孤儿折叠宿主 .is-interrupted-host）
   * @param events 本轮 processEvents（含 error/aborted/metrics）
   */
  function appendInterruptedRow(host: HTMLElement, events: ProcessEvent[]): void {
    if (host.querySelector('[data-interrupted-row]')) return;
    const row = document.createElement('div');
    row.className = 'round-block__interrupted';
    row.dataset.interruptedRow = 'true';
    const errorEv = events.find(
      (e): e is Extract<ProcessEvent, { type: 'error' }> => e.type === 'error',
    );
    const aborted = events.find(
      (e): e is Extract<ProcessEvent, { type: 'aborted' }> => e.type === 'aborted',
    );
    row.textContent = errorEv
      ? friendlyErrorMessage(errorEv.payload.category, errorEv.payload.message)
      : aborted
        ? stopReasonLabel(aborted.payload)
        : stopReasonLabel({ reason: 'interrupted' });
    // 挂载点：折叠块（round-block）之后——「过程折叠 · 停止行平铺在外」
    const rb = host.querySelector(':scope > .round-block');
    if (rb) rb.after(row);
    else host.appendChild(row);
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
   * （narrate）拼接（半截正文已随中断丢弃，运行时同源同形）。
   *
   * @param roundId 本轮 ID（孤儿宿主归属标记）
   */
  function renderInterruptedRound(roundId?: string): void {
    const host = document.createElement('div');
    host.className = 'msg assistant is-interrupted-host';
    // 真实闭环起点（首条带 ts 的过程事件）；空事件/空 ts 兜底当前时间（旧行为，删除仍禁用）
    const startTs = currentEvents.find((e) => e.ts)?.ts ?? new Date().toISOString();
    buildAssistantShell(host, startTs, roundId, { pending: false });
    host.querySelector('.msg-body')?.remove();
    if (roundId) host.dataset.roundId = roundId;
    // 复制整链语义与运行时中断轮对齐：正文已丢弃，原始文本由过程叙述（narrate）拼接供复制
    const narrateText = (
      currentEvents.filter(
        (e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate',
      ) as Extract<ProcessEvent, { type: 'narrate' }>[]
    )
      .map((e) => e.payload.content)
      .join('\n');
    if (narrateText) host.dataset.rawText = narrateText;
    messages.appendChild(host);
    const prevAssistant = activeAssistantEl;
    activeAssistantEl = host;
    roundBlockEl = null;
    roundBlockHostEl = null;
    try {
      // 容器化：中断轮与 done 轮同构进 .round-group（建容器 footer），已定稿传 pending=false
      ensureRoundGroup(roundId, host, false);
      renderRoundBlock(currentEvents, true);
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
  // 此兜底仅覆盖后端异常挂起（宿主 forceReleaseChatLock 超时前），避免 UI 永久停留在
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

  /**
   * 待发送区（interject 队列可视化）：由 turn_update.pendingQueue 更新。
   * 懒创建 DOM 元素（挂在 inputBar 前面）——列出全部待发补充，每条带序号 + 文本 + 独立 × 按钮。
   * 仅 thinking 态有排队时显示；paused 宿主已清队列；done 不可能有队列。
   *
   * 连续补充的用户心智：用户在 LLM 思考期间连发多条 → 每条独立显示 + 可删除，
   * step 边界时内核一次性注入全部 → UI 渲染层 appendInterruptDivider 合并成一个气泡展示。
   */
  let _pendingQueueBar: HTMLElement | null = null;
  function updatePendingQueueBar(items: readonly string[]): void {
    if (!_pendingQueueBar) {
      // 懒创建：顶行（徽章 + 标题 + 清空按钮）+ 列表（每条可独立删除）
      // 计数为圆形徽章（视觉聚焦），结构保持轻量无重造
      _pendingQueueBar = document.createElement('div');
      _pendingQueueBar.className = 'pending-queue-bar';
      _pendingQueueBar.innerHTML = `
        <div class="pending-queue-bar__head">
          <span class="pending-queue-bar__badge"></span>
          <span class="pending-queue-bar__label">待发送</span>
          <span class="pending-queue-bar__hint">补充将紧随当前步骤后注入</span>
          <button class="pending-queue-bar__clear" type="button" title="清空全部" aria-label="清空全部待发送"><span class="btn-icon" data-icon="close"></span></button>
        </div>
        <div class="pending-queue-bar__list"></div>
      `;
      inputBar.parentNode?.insertBefore(_pendingQueueBar, inputBar);
      // 本节点运行期创建 → 初始化时的 populateIcons（document.body）未覆盖 → 此处补填充 data-icon
      populateIcons(_pendingQueueBar);
      const clearBtn = _pendingQueueBar.querySelector('.pending-queue-bar__clear');
      clearBtn?.addEventListener('click', () => {
        // 清空全部 interject（宿主层 chatPanel 清 _pendingQueue 并 post 空队列通知）
        vscode.postMessage({ type: 'clear_pending_queue' });
      });
    }
    if (items.length === 0) {
      _pendingQueueBar.hidden = true;
      return;
    }
    // 顶部：计数徽章（圆形，数字）+ 标题
    const badgeEl = _pendingQueueBar.querySelector('.pending-queue-bar__badge')!;
    badgeEl.textContent = String(items.length);
    // 列表容器重建（每次全量重渲染，items.length 小时成本可忽略）
    const listEl = _pendingQueueBar.querySelector('.pending-queue-bar__list')!;
    listEl.innerHTML = '';
    items.forEach((text, idx) => {
      const row = document.createElement('div');
      row.className = 'pending-queue-bar__item';
      // 序号（1. / 2. / 3.）
      const num = document.createElement('span');
      num.className = 'pending-queue-bar__num';
      num.textContent = `${idx + 1}.`;
      // 文本（过长截断，title 悬停看全文）
      const preview = document.createElement('span');
      preview.className = 'pending-queue-bar__text';
      preview.textContent = text.length > 100 ? text.slice(0, 100) + '…' : text;
      preview.title = text;
      // 单条删除按钮
      const delBtn = document.createElement('button');
      delBtn.className = 'pending-queue-bar__item-del';
      delBtn.type = 'button';
      delBtn.title = '删除这条';
      // 图标语言唯一 = icons.ts 柔和线条 SVG（注意 × 兼作语义乘号，
      // 如「工具×3」——“乘号”与“关闭图标”须靠位置区分，不可机械替换）
      delBtn.innerHTML = getIconSvg('close', 10, 10);
      delBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'remove_pending_item', index: idx });
      });
      row.append(num, preview, delBtn);
      listEl.appendChild(row);
    });
    _pendingQueueBar.hidden = false;
  }

  // ─── 文件改动常驻条（DIFF-1）───
  let _fileChangesBar: HTMLElement | null = null;
  /**
   * 未确认文件改动常驻条（懒创建，与 pending-queue-bar 同范式：插在输入栏之前）
   *
   * 两个动作按钮**不自己实现逻辑**，只 postMessage 给宿主 → 宿主 executeCommand 复用已注册命令
   * （与文件内 CodeLens / 状态栏 QuickPick / 命令面板同一实现，SSOT，无第二份清理逻辑）。
   * 「全部回退」是破坏性操作，宿主侧必弹模态二次确认——webview 不做前置拦截（拦截逻辑只能落 host）。
   * 计数只在宿主推来 file_changes 时更新：**webview 不自维护副本**（真源 = 宿主 tracker）。
   */
  function updateFileChangesBar(files: readonly string[]): void {
    if (files.length === 0) {
      if (_fileChangesBar) _fileChangesBar.hidden = true;
      return;
    }
    if (!_fileChangesBar) {
      _fileChangesBar = document.createElement('div');
      _fileChangesBar.className = 'file-changes-bar';
      _fileChangesBar.innerHTML = `
        <span class="file-changes-bar__badge"></span>
        <span class="file-changes-bar__label">个文件有未确认改动</span>
        <span class="file-changes-bar__spacer"></span>
        <button class="file-changes-bar__confirm" type="button" title="确认全部改动（仅清除本提示，不改文件内容）">全部确认</button>
        <button class="file-changes-bar__revert" type="button" title="回退全部改动到 agent 之前（不可撤销，需二次确认）">全部回退</button>
      `;
      inputBar.parentNode?.insertBefore(_fileChangesBar, inputBar);
      _fileChangesBar.querySelector('.file-changes-bar__confirm')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'confirm_all_file_changes' });
      });
      _fileChangesBar.querySelector('.file-changes-bar__revert')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'revert_all_file_changes' });
      });
    }
    const badge = _fileChangesBar.querySelector('.file-changes-bar__badge');
    if (badge) badge.textContent = String(files.length);
    // 悬停看完整文件清单（相对路径由宿主下发，webview 只展示不解析）
    _fileChangesBar.title = files.join('\n');
    _fileChangesBar.hidden = false;
  }

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
    // status 消息的职责收窄为「呼吸点 / 会话控件锁 / 焦点恢复」，不再参与按钮语义
    // （发送按钮恢复时机 = turn_update(settled) 流尾即时，R-2b-1 裁决；控件锁仍跟随
    // status:'done' 延后解锁，护 round-summary 写入窗口——两个概念各回各的真源）
    // 会话导航类控件运行时锁：**语义 = 「宿主有在途后台写」窗口，不是 turn 状态**
    // （宿主延迟发 status:'done' 是为了护住摘要写入期，避免用户在该窗口删除轮次产生孤儿摘要）
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
    // 删除按钮：锚点归一化——段级（.msg 内 button）取自身 dataset.ts；容器级（round-group footer）
    // button 无自身 dataset，取容器内首段 .msg.assistant 的 dataset.ts（与构建时 firstSeg 语义一致；
    // 首段 ts 空会致删除恒禁用——commitTurnTs 回填后此处即生效）
    document.querySelectorAll<HTMLButtonElement>('.msg-delete-icon').forEach((b) => {
      const ts =
        b.dataset.ts ||
        b.closest<HTMLElement>('.round-group')?.querySelector<HTMLElement>('.msg.assistant')
          ?.dataset.ts ||
        '';
      b.disabled = locked || !ts;
    });
    // 分叉按钮：锚点从父块继承（.msg.assistant 段级 / .round-group 容器级），
    // 与点击 handler 读父块 dataset.roundId 保持 SSOT 一致；forkBtn 自身不存 roundId
    document.querySelectorAll<HTMLButtonElement>('.msg-fork-icon').forEach((b) => {
      const anchor = b.closest<HTMLElement>('.msg.assistant, .round-group');
      b.disabled = locked || !anchor?.dataset.roundId;
    });
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

  // 复制消息文本到剪贴板
  function copyText(text: string): void {
    window.navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }

  // 空状态开关：消息区无 .msg 时显示空状态提示，有消息则隐藏
  function updateEmptyState(): void {
    emptyState.hidden = messages.querySelector('.msg') !== null;
  }

  /**
   * 更新输入区左侧「当前角色」只读徽章（SSOT：角色名与 AI 消息头/空状态共用 currentRoleName）。
   *
   * 角色切换入口已独立到「角色」视图，此处仅做只读状态展示——让用户在输入前感知当前定位。
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
   * 实现：单例引用 teamMeetingIcon（懒创建，同计划常驻条 getPlanBarEl 范式）+ 复用 icons.ts 统一图标管理。
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
      teamMeetingIcon = createTeamMeetingIcon();
    }
    // 更新队员 tooltip（角色切换时队员名单可能变）
    teamMeetingIcon.title = `小组会议 · 组长：${team.leader} · 组员：${team.members.join('、')}（点击启动）`;
    teamMeetingIcon.hidden = false;
  }

  /**
   * 创建 team-meeting 图标按钮（roleBadge 右侧，Trae 风格图标）。
   * 单例：仅由 updateTeamMeetingIcon 首次显示时调用一次；返回值存入 teamMeetingIcon。
   * 复用 icons.ts 统一图标管理，创建后挂到 roleBadge 同行容器。
   */
  function createTeamMeetingIcon(): HTMLElement {
    // 用 createIcon 创建按钮（Trae 统一图标管理，team 图标双人轮廓）
    const btn = createIcon('team', '小组会议（点击启动）', 'team-meeting-icon');
    // 插入 roleBadge 同行容器（roleBadge.parentNode 是底部徽章行）
    const container = roleBadge!.parentNode as HTMLElement;
    if (container) {
      // roleBadge 之后插入，跟在角色名右侧
      const refNode = roleBadge!.nextSibling;
      if (refNode) container.insertBefore(btn, refNode);
      else container.appendChild(btn);
    }
    // 点击：填充「小组会议：」前缀 + 聚焦 + 光标停在冒号后
    btn.addEventListener('click', () => {
      const input = document.getElementById('input') as HTMLTextAreaElement | null;
      if (!input) return;
      const PREFIX = '小组会议：';
      input.value = PREFIX + input.value;
      input.focus();
      input.setSelectionRange(PREFIX.length, PREFIX.length);
    });
    // 键盘可达（Enter / Space 触发）
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btn.click();
      }
    });
    return btn;
  }

  /**
   * 更新工具权限徽章（角色能力面可见性）
   *
   * 根据 capability_badge 消息更新：
   * - block 模式 → 显示「纯 LLM」标签
   * - allow + 有能力 → 显示能力列表（如「文件」「联网」「记忆」）
   * - allow + 无能力 → 显示「全部工具」
   * 无数据时隐藏徽章。
   */
  function updateCapabilityBadge(
    toolMode: 'allow' | 'block',
    capabilities: { capability: string; label: string }[],
  ): void {
    if (!capabilityBadge) return;
    if (toolMode === 'block') {
      capabilityBadge.hidden = false;
      capabilityBadge.textContent = '纯 LLM';
      capabilityBadge.title = '纯 LLM 模式（无工具暴露）';
      return;
    }
    if (capabilities.length === 0) {
      capabilityBadge.hidden = false;
      capabilityBadge.textContent = '全部工具';
      capabilityBadge.title = '允许所有工具';
      return;
    }
    const labels = [...new Set(capabilities.map((c) => c.label))];
    capabilityBadge.hidden = false;
    capabilityBadge.textContent = labels.join(' · ');
    capabilityBadge.title = `允许：${labels.join('、')}`;
  }

  /**
   * P3（空状态角色化）：空状态标题/提示随激活角色包动态生成
   *
   * 原空状态文案硬编码「开始打磨你的设计文档」（doc-review 定位），切换角色包后错位。
   * 改为标题用角色显示名、提示用角色定位描述（manifest.description，可选），随角色生长。
   * 示例提问 chips 由 renderEmptySuggestions 随 showcase 角色动态渲染。
   */
  function updateEmptyStateRole(): void {
    const name = currentRoleName || 'AI';
    emptyTitle.textContent = '开始与 ' + name + ' 对话';
    // 角色定位描述优先；无描述时回退默认引导文案（textContent 赋值防注入）
    const activePack = currentRolePacks.find((p) => p.displayName === currentRoleName);
    emptyHint.textContent = activePack?.description || '在下方输入你的想法，或点击示例提问快速开始';
    // 示例提问随 showcase 角色特化（白话方案设计师展示"种子收敛"引导，其余回退通用）
    renderEmptySuggestions(name);
  }

  /**
   * LLM 未配置时的空态 onboarding
   *
   * 无 Provider 时切换空状态为「去配置模型」引导：提示用户先配置大模型（首次使用关键路径），
   * 并提供一键跳转按钮（点击 post open_config → host 执行 memora.configureModel）。
   * 配置就绪后调用方应再次走 updateEmptyStateRole 恢复普通引导（幂等，按钮用 querySelector 复用）。
   * 文案一律 textContent 赋值防注入；按钮事件直接在创建处绑定（随空态 DOM 常驻，无需委托）。
   */
  function updateEmptyStateOnboarding(): void {
    emptyTitle.textContent = '还没有配置大模型';
    emptyHint.textContent = '配置一个大模型后即可开始对话（支持 OpenAI 兼容接口）';
    emptySuggestions.textContent = '';
    // 防重复追加（配置后回普通空态再触发时幂等）
    let btn = emptyState.querySelector<HTMLButtonElement>('.empty-onboard-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'empty-onboard-btn';
      btn.textContent = '去配置模型';
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'open_config' });
      });
      emptyState.appendChild(btn);
    }
  }

  /** 空状态示例提问 Chips：随激活角色动态渲染（SSOT，事件委托兼容动态元素）。
   *
   * 命中 ROLE_SUGGESTION_SETS 的角色展示专属示例（showcase，如白话方案设计师的"种子收敛"引导，
   * 让 memora 设计魅力一键可体验）；未命中回退 DEFAULT_SUGGESTIONS 通用打磨引导
   * （避免为每条角色特化造成维护成本）。textContent 赋值防注入。 */
  function renderEmptySuggestions(name: string): void {
    if (!emptySuggestions) return;
    const set = ROLE_SUGGESTION_SETS[name] ?? DEFAULT_SUGGESTIONS;
    emptySuggestions.textContent = '';
    set.forEach((s) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.dataset.prompt = s.prompt;
      chip.textContent = s.label;
      emptySuggestions.appendChild(chip);
    });
  }

  /**
   * 渲染 Follow-up 建议（回复后关联推荐）
   *
   * 在最新一条 AI 消息下方追加「接下来可以探索」chips 块；点击 chip 填入输入框并聚焦
   * （与空状态示例 chips 共用 .suggestion-chip 点击委托，SSOT 复用同一交互）。
   * 文案一律 textContent 防注入；渲染前先移除上一次的 follow-up 块（幂等，
   * 避免多轮建议堆叠成「残影」，对齐 memoryView 搜索结果的竞态清理思路）。
   */
  function renderFollowUpSuggestions(items: { prompt: string; label: string }[]): void {
    if (items.length === 0) return;
    const prev = messages.querySelector('.followup');
    if (prev) prev.remove();
    const block = document.createElement('div');
    block.className = 'followup';
    const caption = document.createElement('div');
    caption.className = 'followup__caption';
    caption.textContent = '接下来可以探索';
    block.appendChild(caption);
    const row = document.createElement('div');
    row.className = 'followup__chips';
    items.forEach((s) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.dataset.prompt = s.prompt;
      chip.title = s.prompt;
      chip.textContent = s.label;
      row.appendChild(chip);
    });
    block.appendChild(row);
    messages.appendChild(block);
    scrollToBottom(messages);
  }

  // 滚动到底部（rAF 节流，helpers/scrollToBottom 单一实现）：流式渲染时每 chunk
  // 都可能触发滚动，用 requestAnimationFrame 合并为每帧一次，避免强制 reflow。
  // 此处统一以 messages 为滚动容器；scrollToBottom + scrollRafPending
  // 只存在于 helpers，本地不持副本。

  // ─── 下拉选择器渲染工厂（SSOT） ───
  // 模型选择器等下拉共用单一渲染器（「清空菜单 → 遍历建项 → 更新触发器」）；角色选择器
  // 独立在「角色」视图。picker 通过 { menu, trigger, items, activeName, 文案 } 配置声明
  // 差异（对齐 §四.2 声明式工厂）。

  /** 下拉项数据（name 为事件 id，displayName 为展示名，description 可选副标题） */
  interface PickerItem {
    name: string;
    displayName: string;
    description?: string;
  }

  /** 渲染下拉选择器：构建菜单项 + 更新触发器文本 + 可访问性标签（textContent 防注入） */
  function renderPicker(
    menu: HTMLElement | null,
    trigger: HTMLElement | null,
    items: PickerItem[],
    activeName: string | undefined,
    opts: { emptyText?: string; labelFallback: string; ariaLabel: string },
  ): void {
    if (!menu) return;
    // 防注入：名称来自用户配置/角色包，禁止 innerHTML 拼接，一律 createElement + textContent
    menu.textContent = '';
    if (items.length > 0) {
      items.forEach((p) => {
        const isActive = p.name === activeName;
        const btn = document.createElement('button');
        btn.className = 'treedd__item' + (isActive ? ' is-active' : '');
        btn.setAttribute('role', 'menuitem');
        btn.setAttribute('data-treedd-id', p.name);
        const nameEl = document.createElement('span');
        nameEl.className = 'dd-item-name';
        nameEl.textContent = p.displayName || p.name;
        btn.appendChild(nameEl);
        // 可选描述副标题（角色包定位，供下拉展示；无描述时仅显示名称）
        if (p.description) {
          const descEl = document.createElement('span');
          descEl.className = 'dd-item-desc';
          descEl.textContent = p.description;
          btn.appendChild(descEl);
        }
        menu.appendChild(btn);
      });
    } else if (opts.emptyText) {
      const empty = document.createElement('div');
      empty.className = 'treedd__empty';
      empty.textContent = opts.emptyText;
      menu.appendChild(empty);
    }
    // 更新触发器显示当前项（textContent 防注入）。
    // SSOT：用 <span class="dd-trigger-name"> 包裹名称，CSS 只对此 span 做 ellipsis 截断，
    // 而 ::after 下拉箭头 flex-shrink:0 永远外露（dd-trigger-name 为通用语义类，模型/角色共用）
    if (trigger) {
      const active = items.find((p) => p.name === activeName);
      const label = active ? active.displayName : opts.labelFallback;
      trigger.textContent = '';
      const span = document.createElement('span');
      span.className = 'dd-trigger-name';
      span.textContent = label;
      trigger.appendChild(span);
      // 触发器可访问性：为读屏提供名称（aria-haspopup 已在组件 HTML 中声明）
      trigger.setAttribute('aria-label', opts.ariaLabel + '：' + label);
    }
  }

  // 渲染模型下拉框选项
  function renderModelPicker(): void {
    renderPicker(modelPickerMenu, modelPickerTrigger, currentProviders, currentActive, {
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
      // AI 消息：复用骨架构建（label + content + body + footer），
      // 一次性消息（历史回放）直接渲染 Markdown（代码块/列表/表格可读）
      const { body } = buildAssistantShell(div, ts, roundId);
      // 原始文本存于 .msg 的 dataset（流式/历史共用，复制按钮据此复制完整原始 Markdown 源）
      div.dataset.rawText = text;
      body.innerHTML = renderMarkdown(text, sanitize);
      // 历史回放同样做代码块增强（语言标签 + 复制按钮）
      enhanceCodeBlocks(body);
      // 流式锚点跟随最新 assistant 消息（SSOT：单一锚点，append/chunk 共用）
      activeAssistantEl = div;
      messages.appendChild(div);
      // 容器化：归位到所属 .round-group（同 roundId 段收进容器；无 roundId 留消息流）
      ensureRoundGroup(roundId, div);
      scrollToBottom(messages);
      updateEmptyState();
      return div;
    } else {
      // 用户消息：外层包裹（气泡 + hover 操作按钮）
      const wrapper = document.createElement('div');
      wrapper.className = 'msg-wrapper';
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = text;
      div.appendChild(body);
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
      scrollToBottom(messages);
      updateEmptyState();
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
    kind: 'question-answer' | 'supplement' | 'timeout';
    roundId?: string;
    question?: string;
    options?: string[];
  }
  /** 本轮运行时输入累积（新闭环重置）；finalize 由 renderRoundBlock 从合并流重建归位 */
  let runtimeInteractiveInputs: RuntimeInteractiveInput[] = [];
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
   * @param kind 交互类型（question-answer=提问回答 / supplement=补充 / timeout=提问超时未答）
   * @param roundId 所属轮（随 user(kind) 消息透传）
   * @param question 提问原文（qa/timeout 携带时，条目上方渲染只读「问」回顾行）
   * @param options 候选选项（静态文本随回顾行展示）
   */
  function appendInteractiveInput(
    text: string,
    ts: string | undefined,
    kind: 'question-answer' | 'supplement' | 'timeout',
    roundId?: string,
    question?: string,
    options?: string[],
  ): void {
    // 显示逻辑统一：supplement / question-answer / timeout 同为
    // 「闭环内用户交互」（数据同构 interactiveInputs.kind），共用过程条目行形态，
    // 仅 tag 文案区分语义：补充 →「你补充」；回答 →「你答」；超时未答 →「未回答」。
    // timeout 到达即提问等待结束（宿主已自动续跑）——先销毁提问交互 UI（ask-inline /
    // 兜底 clarifyBar），避免「提问框 + 未回答行」同屏残留。
    if (kind === 'timeout') {
      document.querySelector('.ask-inline')?.remove();
      clarifyBar.classList.remove('visible');
      inputBar.hidden = false;
    }
    // 缓存（finalize 合并流重建 QA 的数据源；重放路径同源累积，最终态一致）
    runtimeInteractiveInputs.push({ text, ts, kind, roundId, question, options });
    try {
      const item = renderQaItem(text, kind, question, options);
      const tsKey = ts ?? new Date().toISOString();
      item.dataset.ts = tsKey;
      // 目标容器：运行时 process-flow > 完成态/重放 round-block > 降级消息流（纯问答轮无过程容器）
      const flow = flowEl?.isConnected ? flowEl : null;
      const rbDetails = roundBlockEl?.isConnected
        ? roundBlockEl.querySelector('.round-block__details')
        : null;
      const root = (flow ?? rbDetails) as HTMLElement | null;
      if (root) {
        const { host } = planItemContainerFor(root, currentEvents, tsKey);
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
    updateEmptyState();
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
      const { host } = planItemContainerFor(root, currentEvents, tsKey);
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
  function renderQaItem(
    text: string,
    kind: 'question-answer' | 'supplement' | 'timeout',
    question?: string,
    options?: string[],
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'round-block__input';
    // 提问回顾行：question-answer/timeout 携带 question 时先渲染只读「问」行（还原提问上下文）
    if ((kind === 'question-answer' || kind === 'timeout') && question) {
      const q = document.createElement('div');
      q.className = 'round-block__input-q';
      const qTag = document.createElement('span');
      qTag.className = 'round-block__input-tag';
      qTag.textContent = '问';
      const qTxt = document.createElement('span');
      qTxt.className = 'round-block__input-text';
      qTxt.textContent = question;
      q.append(qTag, qTxt);
      if (options && options.length > 0) {
        const opts = document.createElement('span');
        opts.className = 'round-block__input-opts';
        opts.textContent = `候选：${options.join(' ｜ ')}`;
        q.appendChild(opts);
      }
      row.appendChild(q);
    }
    // 内容行：tag 语义映射（回答 →「你答」；补充 →「你补充」；超时未答 →「未回答」）
    const main = document.createElement('div');
    main.className = 'round-block__input-row';
    const tag = document.createElement('span');
    tag.className = 'round-block__input-tag';
    tag.textContent = kind === 'supplement' ? '你补充' : kind === 'timeout' ? '未回答' : '你答';
    const txt = document.createElement('span');
    txt.className = 'round-block__input-text';
    txt.textContent = text;
    main.append(tag, txt);
    row.appendChild(main);
    return row;
  }

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
    ensureRoundGroupFooter(g, pending);
    roundGroupEl = g;
    return g;
  }

  /**
   * 容器级 footer（容器化）：复制整链 / 分叉 / 删除 + 时间戳
   *
   * 整链复制 = 该 round 的「用户提问（容器前一兄弟）+ 全部 assistant 段」，单一入口
   * 覆盖闭环全量（R1 修复）。段级 footer 由 CSS 隐藏，操作整体上移到容器读取。
   * is-pending：与段级 footer 同一「内容未定稿」语义（SSOT 复用）——流式创建时隐藏，
   * 回答定稿（finalizeStreaming）后移除；历史回放/一次性消息直接传 false（已定稿）。
   *
   * @param g       容器元素（幂等：已有 footer 不重复建）
   * @param pending 是否内容未定稿（流式创建传 true，回放/一次性传 false）
   */
  function ensureRoundGroupFooter(g: HTMLElement, pending: boolean): void {
    if (g.querySelector('.round-group__footer')) return;
    const footer = document.createElement('div');
    footer.className = 'round-group__footer';
    if (pending) footer.classList.add('is-pending'); // 流式/提问等待中：未定稿隐藏；回放/已定稿直接显示
    const copyBtn = createIcon('copy', '复制整条问答（含你的提问与全部回答）', 'msg-copy-icon');
    copyBtn.addEventListener('click', () => copyText(roundChainText(g)));
    const forkBtn = createIcon('fork', '从此问答闭环分叉新会话', 'msg-fork-icon');
    forkBtn.disabled = !g.dataset.roundId;
    forkBtn.addEventListener('click', () =>
      vscode.postMessage({ type: 'fork_session', roundId: g.dataset.roundId }),
    );
    const deleteBtn = createIcon('delete', '删除该问答及之后所有对话', 'msg-delete-icon');
    const firstSeg = g.querySelector<HTMLElement>('.msg.assistant');
    deleteBtn.disabled = !firstSeg?.dataset.ts;
    deleteBtn.addEventListener('click', () => {
      if (firstSeg?.dataset.ts)
        vscode.postMessage({ type: 'delete_turn', ts: firstSeg.dataset.ts });
    });
    // 按钮组靠左、时间戳靠右（flex space-between 分散）
    const actions = document.createElement('div');
    actions.className = 'round-group__actions';
    actions.append(copyBtn, forkBtn, deleteBtn);
    footer.append(actions);
    // 时间戳：取首段时间（闭环起点）
    const t = firstSeg ? fmtTime(firstSeg.dataset.ts) : '';
    if (t) {
      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = t;
      footer.appendChild(timeEl);
    }
    g.appendChild(footer);
  }

  /**
   * 容器整链文本：用户提问（前一兄弟，若为 user 气泡）+ 容器内全部 assistant 段正文
   *
   * 复制拿「最终汇报」实质内容，不掺交互噪声；rawText 原文完整保留（溯源不受影响）。
   */
  function roundChainText(g: HTMLElement): string {
    const parts: string[] = [];
    const user = g.previousElementSibling;
    if (user instanceof HTMLElement && user.classList.contains('msg-wrapper')) {
      const t = user.textContent?.trim();
      if (t) parts.push(t);
    }
    g.querySelectorAll<HTMLElement>('.msg.assistant').forEach((a) => {
      const t = (a.dataset.rawText ?? '').trim();
      if (t) parts.push(t);
    });
    return parts.join('\n\n');
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
    // 幂等：重复提问（如连续多问/多次 turn_update 推送）先移除旧内联块，再挂新
    document.querySelector('.ask-inline')?.remove();
    const box = document.createElement('div');
    box.className = 'ask-inline';
    // 单一形态：单问 = 只有一个问题的多问，统一「逐题点选/输入 → 全部答完才提交」。
    // 选项点击/输入/提交逻辑单一同源（SSOT），不为单/多问分写两套。answers[i] 逐题累计，
    // submitBtn 全部答完才 enabled；single 时按钮文案
    // 用「提交回答」，multi 用「提交全部回答」（仅文案差异，逻辑单一同源）。
    const answers: (string | undefined)[] = questions.map(() => undefined);
    let submitBtn: HTMLButtonElement | null = null;
    const syncSubmit = (): void => {
      if (submitBtn) submitBtn.disabled = !answers.every((a) => a && a.trim().length > 0);
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
    // 底部一次性提交按钮（single「提交回答」/ multi「提交全部回答」，全部答完才 enabled）
    submitBtn = document.createElement('button');
    submitBtn.className = 'ask-inline__submit';
    submitBtn.textContent = questions.length > 1 ? '提交全部回答' : '提交回答';
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => {
      // 全部题目答案按序一对一回填（filter 保序：跳过未答题，与按序对话保持对应）
      const filled = answers.reduce<string[]>((acc, a) => {
        const t = (a ?? '').trim();
        if (t) acc.push(t);
        return acc;
      }, []);
      commitAskAnswers(filled);
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
   * 构建 AI 消息骨架（label + content + body + footer[复制 + 时间戳]）
   *
   * assistant 一次性消息与流式消息共用骨架，差异仅在 body 内容（markdown 渲染 vs
   * 纯文本 + 光标）。复制按钮读取 .msg 的 dataset.rawText（流式结束后更新为完整文本），
   * 修复「流式复制只复制第一 chunk」的缺陷。
   *
   * @param div 已创建的空 .msg.assistant 元素
   * @param ts 消息时间戳
   * @param roundId 本轮问答闭环 ID（流式结束回填启用分叉）
   * @param opts.pending 流式回答未完成 → footer 初始隐藏（is-pending），finalizeStreaming 展示
   * @returns body 元素 + footer 元素
   */
  function buildAssistantShell(
    div: HTMLElement,
    ts?: string,
    roundId?: string,
    opts?: { pending?: boolean },
  ): { body: HTMLElement; footer: HTMLElement } {
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
    // 报告正文：label 之后、footer 之前（任务过程折叠区由 ensureRoundBlock 挂在 label 与 body 之间，
    // 形成「任务过程在上 · 报告在下」；body 单一连续，不被工具切碎）
    const body = document.createElement('div');
    body.className = 'msg-body';
    div.appendChild(body);
    // footer 独立（msg 直接子元素，永远排在 round-block / body 之后）
    const footer = document.createElement('div');
    footer.className = 'msg-footer';
    const copyBtn = createIcon('copy', '复制消息', 'msg-copy-icon');
    // 复制按钮读取 .msg.dataset.rawText（原始 Markdown 源）；流式结束更新后即复制完整文本
    copyBtn.addEventListener('click', () => copyText(div.dataset.rawText ?? ''));
    footer.appendChild(copyBtn);
    // 分叉按钮（round-based 模式）：从当前问答闭环位置创建新会话。
    // 流式期间 roundId 未知 → 初始禁用；轮结束（done/interrupted）由 commitRoundId 回填并启用。
    // SSOT：点击始终读 dataset.roundId（单一读取点），回填即生效，无需重建事件。
    const forkBtn = createIcon('fork', '从此处分叉创建新会话', 'msg-fork-icon');
    forkBtn.disabled = !roundId;
    forkBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'fork_session', roundId: div.dataset.roundId || undefined });
    });
    footer.appendChild(forkBtn);
    // 删除按钮：AI 消息承载「删除问答闭环」入口——删了答也删问。
    // 携带该条 AI 消息的 timestamp 作锚点，host 端确认后 truncate-from-turn（删该问答及之后所有）。
    // 无 ts（如流式未完成即被清空）时禁用，避免删除锚点失效。
    const deleteBtn = createIcon('delete', '删除该问答及之后所有对话', 'msg-delete-icon');
    // 存锚点供运行时锁批量读取；disabled 继承全局锁态（运行时强制禁用）或「无锚点则禁用」
    deleteBtn.dataset.ts = ts ?? '';
    deleteBtn.disabled = sessionControlsLocked || !ts;
    deleteBtn.addEventListener('click', () => {
      if (div.dataset.ts) vscode.postMessage({ type: 'delete_turn', ts: div.dataset.ts });
    });
    footer.appendChild(deleteBtn);
    const t = fmtTime(ts);
    if (t) {
      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = t;
      footer.appendChild(timeEl);
    }
    div.appendChild(footer);
    // 流式回答未完成时隐藏底部操作行（复制/分叉/删除 + 时间戳）——操作在内容定稿前无意义；
    // 回答完毕（finalizeStreaming）移除 is-pending 再展示。历史回放的一次性消息不传 pending。
    if (opts?.pending) footer.classList.add('is-pending');
    // 记录消息 timestamp 供删除锚点；roundId 供分叉按钮读取
    div.dataset.ts = ts ?? '';
    div.dataset.roundId = roundId ?? '';
    return { body, footer };
  }

  /**
   * 开始一轮流式：创建新的 assistant 消息（纯文本 body + 光标 ▋），并置流式状态
   *
   * 首个 chunk 到达时调用（streamingActive 为 false 时）。流式期间按 markdown 增量
   * 渲染（节流）+ 末尾闪烁光标；流结束后由 finalizeStreaming 收敛（去光标 + 代码块增强）。
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
    const { body } = buildAssistantShell(div, ts, roundId, { pending: true });
    // 流式期间：is-streaming 类驱动 CSS ::after 闪烁光标（markdown 由增量渲染填充）
    body.classList.add('is-streaming');
    activeAssistantEl = div;
    streamBodyRendered = false;
    messages.appendChild(div);
    // 容器化：运行时首块归位到所属 .round-group（chunk 携带 turn roundId）
    // 流式未定稿 → 容器 footer 初始隐藏（pending=true），done/interrupted 后 finalizeStreaming 展示
    ensureRoundGroup(roundId, div, true);
    // 挂载运行时过程平铺容器（meta 已先到）：过程按任务项时序平铺（无大折叠壳）
    renderProcessFlow(currentEvents);
    scrollToBottom(messages);
    updateEmptyState();
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
   * 代码块增强（吸收养分：对齐 TraeWork 代码块「语言标签 + 一键复制」）
   *
   * renderMarkdown 后调用：把每个 <pre> 包装为 .code-block（header[语言名 + 复制按钮] + pre）。
   * 语言名取自 marked 渲染的 class="language-xxx"；无语言回退显示 code。复制按钮读取
   * <pre> 内文本。仅最终渲染时增强一次（流式期间不包装，避免节流重绘反复重建 DOM）。
   *
   * @param container 已渲染 markdown 的消息正文容器
   */
  function enhanceCodeBlocks(container: HTMLElement): void {
    container.querySelectorAll('pre').forEach((pre) => {
      // 已增强（history 回放多次渲染防重复包装）
      if (pre.parentElement?.classList.contains('code-block')) return;
      const code = pre.querySelector('code');
      const lang = (code?.className.match(/language-([\w-]+)/) ?? [])[1] ?? 'code';
      const block = document.createElement('div');
      block.className = 'code-block';
      const header = document.createElement('div');
      header.className = 'code-block__header';
      const langEl = document.createElement('span');
      langEl.className = 'code-block__lang';
      langEl.textContent = lang;
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'code-block__copy';
      copyBtn.textContent = '复制';
      copyBtn.title = '复制代码';
      copyBtn.addEventListener('click', () => copyText(code?.textContent ?? ''));
      header.appendChild(langEl);
      header.appendChild(copyBtn);
      // 用 .code-block 包裹原 <pre>（replaceWith 把 pre 移入 block）
      pre.replaceWith(block);
      block.appendChild(header);
      block.appendChild(pre);
    });
  }

  /**
   * 流式结束：收敛渲染 Markdown + 移除光标 + 代码块增强 + 更新复制源
   *
   * done / interrupted 消息统一调用（幂等：无流式时 no-op）。流式期间已按节流增量渲染，
   * 此处做最终收敛：清定时器 + 终渲染 + 去光标（is-streaming）+ 代码块增强；复制按钮的
   * 原始文本源同步更新为完整流式文本。
   */
  function finalizeStreaming(): void {
    // ① UI 收尾（与流式状态无关，done/interrupted/打断均需执行）：
    // 段级/容器级 footer 的 is-pending 移除 = 内容已定稿的信号，打断也是定稿（半截内容到此为止）。
    // 放在 guard 之外——打断路径已把 streamingActive 清为 false，guard 会挡住旧逻辑。
    const el = activeAssistantEl;
    if (el?.isConnected) {
      el.querySelector<HTMLElement>('.msg-footer')?.classList.remove('is-pending');
      el.closest<HTMLElement>('.round-group')
        ?.querySelector<HTMLElement>('.round-group__footer')
        ?.classList.remove('is-pending');
    }
    // ② 流式专属清理（guard 保护：非流式状态下这些动作不该执行）
    if (!streamingActive || !el || !el.isConnected) return;
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
    }
    // 单容器结构：正文 = 该轮唯一 .msg-body（报告正文），收尾一次终渲染 + 去光标 + 代码块增强
    const body = el.querySelector(':scope .msg-body') as HTMLElement | null;
    if (body) {
      body.classList.remove('is-streaming');
      body.innerHTML = renderMarkdown(streamingRaw, sanitize);
      enhanceCodeBlocks(body);
    }
    // 复制源更新为完整原始文本（.msg.dataset.rawText 供复制按钮读取）
    el.dataset.rawText = streamingRaw;
    streamingActive = false;
    streamingRaw = '';
    streamBodyRendered = false;
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
   *  QA 已由 renderRoundBlock 从合并流归位到对应任务项分组，无需再搬运（foldPending 已删）。 */
  function finalizeRound(): void {
    // renderRoundBlock 曾在 plan_item_boundary 嵌套场景抛 NotFoundError，导致后续
    // 「移除 flowEl / 收敛 QA / 关流式光标」全部不执行（过程不折叠 + 光标不消失，且异常在事件
    // 监听器内被静默吞掉）。收口三步放 finally：即便渲染失败，流式态也必收敛（不再带伤共存）。
    // 异常本身继续向上抛（由 onMessage 兜底 console.error 观测）——兜底观测，不掩盖根因。
    try {
      renderRoundBlock(currentEvents, true, runtimeInteractiveInputs);
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

  // ─── 活动状态区（三合一：P0 错误 / P1 低扰 / P2 指标） ───
  // 单一主状态条（#activityBar）同时只显示一条；被覆盖的提示不丢失，
  // 全部进「▾ 活动详情」历史（最近 MAX_ACTIVITY_HISTORY 条，带时间戳）。
  // 优先级策略：P0 错误显示期间，P1/P2 不打断它（错误优先保护）；P2 指标常驻详情。

  /** 详情历史最大条数（有界，防长期使用累积） */
  const MAX_ACTIVITY_HISTORY = 20;
  /** 活动历史记录：level=error 时标红、info 时灰显；仅用于详情回溯，不含指标 */
  interface ActivityRecord {
    level: 'error' | 'info';
    text: string;
    ts: string;
  }
  const activityHistory: ActivityRecord[] = [];

  let activityTimer: number | null = null;

  /** 渲染「活动详情」列表（历史 + 指标），收到任何活动即显示详情折叠区 */
  function renderActivityDetail(): void {
    // 历史列表：textContent 构建防注入（全部来自内核/宿主文案或用户输入）
    activityList.textContent = '';
    for (const r of activityHistory) {
      const row = document.createElement('div');
      row.className = 'activity-list__row ' + r.level;
      const text = document.createElement('span');
      text.className = 'activity-list__text';
      text.textContent = r.text;
      const time = document.createElement('span');
      time.className = 'activity-list__time';
      time.textContent = r.ts;
      row.appendChild(text);
      row.appendChild(time);
      activityList.appendChild(row);
    }
    // 详情折叠区有内容即显示（含指标）
    activityDetail.hidden = activityHistory.length === 0 && activityMetrics.hidden;
  }

  /**
   * 显示主状态条（P0 错误 / P1 低扰）
   *
   * 优先级：P0 显示期间 P1 不覆盖（错误优先保护，P1 仅记历史）；新 P0 覆盖旧 P0。
   * 停留时长按档位分级——error 醒目停留更久，info 低扰短暂（对齐排雷雷-4 语义分离）。
   *
   * 支持可选 action 按钮：当宿主标记错误为「可重试」时，action.label 显示按钮文案、
   * action.onClick 绑定重试回调。当前宿主暂未接入（框架先行就绪），不传 action 时该能力不生效。
   */
  function showActivity(
    level: 'error' | 'info',
    text: string,
    action?: { label: string; onClick: () => void },
  ): void {
    // 全部活动先入历史（被覆盖的提示不丢失，详情可回溯）
    const record: ActivityRecord = {
      level,
      text,
      ts: fmtTime(new Date().toISOString()),
    };
    activityHistory.push(record);
    if (activityHistory.length > MAX_ACTIVITY_HISTORY) activityHistory.shift();
    renderActivityDetail();

    // P0 保护：当前显示 error 时，后续 info 不打断（仅进历史，主条保持错误可见）
    if (level === 'info' && activityBar.dataset.level === 'error') return;

    activityBar.dataset.level = level;
    activityBar.className = 'activity-bar ' + level;
    // 文本 + 可选操作按钮：action 存在时用 span 包裹文本 + button，否则纯 textContent
    if (action) {
      activityBar.textContent = '';
      const textSpan = document.createElement('span');
      textSpan.className = 'activity-bar__text';
      textSpan.textContent = text;
      activityBar.appendChild(textSpan);
      const btn = document.createElement('button');
      btn.className = 'activity-bar__action';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      activityBar.appendChild(btn);
    } else {
      activityBar.textContent = text;
    }
    activityBar.hidden = false;
    if (activityTimer) window.clearTimeout(activityTimer);
    activityTimer = window.setTimeout(
      () => {
        activityBar.hidden = true;
        delete activityBar.dataset.level;
      },
      level === 'error' ? 8000 : 2500,
    );
  }

  /**
   * 渲染活动指标详情（P2：§13.x 透明面板 + §5.2.1 指纹可见）
   *
   * 指纹（系统提示 hash 前 12 位）+ 累计指标（LLM / 工具失败 / 截断）。
   * textContent 赋值防注入；指标只进详情折叠区，不占用主状态条。
   * 注：「附着记忆条数 / 召回命中率」已退役——自动记忆注入与
   * recall 指标随自动召回退役恒零（假指标），显示即误导。
   */
  function renderMetrics(msg: Extract<ExtensionToWebviewMessage, { type: 'metrics' }>): void {
    const fp = msg.fingerprints;
    const lines = [
      // 指纹行：只显示 hash，不显示内容（可追溯性边界）
      '本轮指纹：' + (fp.systemPromptHash ? '系统提示 ' + fp.systemPromptHash : '系统提示 -'),
      // 累计指标行（未解析工具意图累计，诊断面板可见文本 tool_call 静默失败）
      '累计：LLM ' +
        msg.metrics.llmCallCount +
        ' 次 · 工具失败 ' +
        msg.metrics.toolFailureCount +
        (msg.metrics.unparsedToolIntentCount && msg.metrics.unparsedToolIntentCount > 0
          ? ' · 未解析工具意图 ' + msg.metrics.unparsedToolIntentCount
          : '') +
        ' · 截断 ' +
        msg.metrics.truncationCount,
      // token 用量（可选字段，缺省不显示）：估算口径，「出」只计正文、不含思考——
      // 与轮详情执行指标同口径标注，防推理模型下把正文数误读成总输出
      'Tokens（估算）：' +
        (typeof msg.metrics.llmTokenIn === 'number' ? '入 ' + msg.metrics.llmTokenIn : '入 -') +
        ' / 正文 ' +
        (typeof msg.metrics.llmTokenOut === 'number'
          ? msg.metrics.llmTokenOut + '（不含思考）'
          : '-'),
      // ④ 预算分配构成（可选字段，缺省不显示）——窗口内空间如何被 锚点/对话层 瓜分
      ...(msg.metrics.budget
        ? [
            '预算：可用 ' +
              fmtCompactTokens(msg.metrics.budget.availableTokens) +
              ' · 锚点 ' +
              fmtCompactTokens(msg.metrics.budget.anchorTokens) +
              ' · 对话层 ' +
              fmtCompactTokens(msg.metrics.budget.dialogueBudgetTokens) +
              ' · 剩余 ' +
              fmtCompactTokens(msg.metrics.budget.remainingTokens),
          ]
        : []),
      // B9 可观测补齐：最近操作流（span 标签新→旧，指标区末尾渲染，缺省不显示）
      ...(msg.trace && msg.trace.length > 0
        ? ['操作流：', ...msg.trace.map((t) => '  › ' + t.label)]
        : []),
      // 安全/装配透明：路径守卫审计概要（有审计事件才显示；basename 路径）
      ...(msg.securityAudit && msg.securityAudit.total > 0
        ? [
            '安全审计 ' +
              msg.securityAudit.total +
              ' 次 · 拒绝 ' +
              msg.securityAudit.denied +
              (msg.securityAudit.recent.length > 0
                ? ' · 最近：' +
                  msg.securityAudit.recent
                    .map((r) => r.type + ' ' + r.path + (r.reason ? ' (' + r.reason + ')' : ''))
                    .join(', ')
                : ''),
          ]
        : []),
    ];
    activityMetrics.textContent = lines.join('\n');
    activityMetrics.hidden = false;
    renderActivityDetail();
  }

  // 当前占用条已展示的容量上限（token）——Provider 列表推送（含上限）时据此判断
  // 「上限未变则保留已展示的真实占用」，避免面板数据刷新把已用数字误清零
  let contextLimitShown: number | undefined;

  // 圆环充能几何：SVG r=16 → 周长 2π×16 ≈ 100.53（stroke-dasharray/dashoffset 单位统一）
  const RING_CIRCUMFERENCE = 2 * Math.PI * 16;

  /**
   * 圆环充能填充：按占用比例（0-100）设置 stroke-dashoffset，比例越高弧越满。
   *
   * @param el      圆环 SVG 容器（找 #occFill 圆）
   * @param usedPct 占用百分比（0-100）
   */
  function setRingFill(el: HTMLElement, usedPct: number): void {
    const fill = el.querySelector<SVGCircleElement>('#occFill');
    if (!fill) return;
    const pct = Math.max(0, Math.min(100, usedPct));
    // dasharray = 周长（满环）；dashoffset = 周长 × (1 − 占比) → 占比越高可见弧越长
    fill.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct / 100));
  }

  /**
   * 组装占用明细弹窗文字（纯文字，多行；供 hover/聚焦浮层展示）。
   *
   * 每行「标签：数量 · token（占比）」；rolePack 额外给「占窗口比例」；
   * UI 只渲染宿主透传的数字与条数，不重算（守内核/宿主边界）。
   */
  function buildOccupancyTipText(
    occ: Extract<ExtensionToWebviewMessage, { type: 'context_occupancy' }>['occupancy'],
  ): string {
    const total = Math.max(1, occ.totalTokens);
    const pctOf = (val: number): string => ((val / total) * 100).toFixed(1) + '%';
    const lines: string[] = [`上下文占用（总容量 ${fmtTokens(occ.totalTokens)}）`];
    lines.push(
      `角色包/系统设定：${fmtTokens(occ.rolePackBaseTokens)}（占窗口 ${pctOf(occ.rolePackBaseTokens)}）`,
    );
    lines.push(
      `完整对话：${occ.dialogueCount} 条 · ${fmtTokens(occ.dialogueTokens)}（${pctOf(occ.dialogueTokens)}）`,
    );
    lines.push(
      `当前输入锚点：${fmtTokens(occ.inputAnchorTokens)}（${pctOf(occ.inputAnchorTokens)}）`,
    );
    lines.push(
      `输出预留：${fmtTokens(occ.outputReserveTokens)}（${pctOf(occ.outputReserveTokens)}）`,
    );
    lines.push(`剩余可用：${fmtTokens(occ.freeTokens)}（${pctOf(occ.freeTokens)}）`);
    return lines.join('\n');
  }

  /**
   * ④ 预算可视化：首轮对话前，按当前选中 LLM 的上下文上限渲染圆环空态。
   *
   * chat_providers 到达时调用：真实占用（context_occupancy）要等首轮流式结束才有，
   * 在此之前圆环展示「0% 空环 + 总容量」，让用户即时感知所选模型的窗口容量。
   * 无选中 Provider 时不展示（无「当前模型」可依赖，避免展示误导性的缺省值）。
   * 上限与已展示值相同 → 跳过（保留真实占用，不重复清零）。
   */
  function renderOccupancyLimit(
    providers: ChatProviderItem[],
    activeName: string | undefined,
  ): void {
    const el = document.getElementById('contextOccupancy');
    if (!el) return;
    if (!activeName) return;
    const active = providers.find((p) => p.name === activeName);
    if (!active || typeof active.limitTokens !== 'number') return;
    // 上限未变化 → 保留已展示的真实占用（同一模型，无重置必要）
    if (contextLimitShown === active.limitTokens) return;
    contextLimitShown = active.limitTokens;
    // 展示容量上限 + 空环（真实占用待 context_occupancy 覆盖）
    el.hidden = false;
    setRingFill(el, 0);
    const percentEl = document.getElementById('occPercent');
    if (percentEl) percentEl.textContent = '0%';
    // 空态明细复用 buildOccupancyTipText（同一份明细拼装，不手写第二份）：
    // 全 0 占用 + free=total（100% 剩余），与真实态共用同一行结构与格式
    const tipEl = document.getElementById('occTip');
    if (tipEl) {
      tipEl.textContent = buildOccupancyTipText({
        totalTokens: active.limitTokens,
        rolePackBaseTokens: 0,
        dialogueTokens: 0,
        dialogueCount: 0,
        inputAnchorTokens: 0,
        outputReserveTokens: 0,
        freeTokens: active.limitTokens,
      });
    }
  }

  /**
   * ④ 预算可视化：更新输入框内圆环充能图标。
   *
   * 各段为 prepare 期**真实用量**（token）+ 条数，圆环按占用比例充能；
   * hover/聚焦弹窗出完整分层明细（含条数、token、占比、角色包比例）。
   * UI 只渲染宿主透传的数字，不重算（守内核/宿主边界）。
   */
  function updateContextOccupancy(
    occ: Extract<ExtensionToWebviewMessage, { type: 'context_occupancy' }>['occupancy'],
  ): void {
    const el = document.getElementById('contextOccupancy');
    if (!el) return;
    el.hidden = false;
    // 记录内核真实总容量：后续同款 chat_providers 推送不再重置已用数字
    contextLimitShown = occ.totalTokens;
    const total = Math.max(1, occ.totalTokens);
    // 圆环充能比例 = 已用占比（total − free）/ total
    const usedPct = Math.max(0, Math.min(100, ((total - occ.freeTokens) / total) * 100));
    setRingFill(el, usedPct);
    const percentEl = document.getElementById('occPercent');
    if (percentEl) percentEl.textContent = usedPct.toFixed(0) + '%';
    const tipEl = document.getElementById('occTip');
    if (tipEl) tipEl.textContent = buildOccupancyTipText(occ);
  }

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
  }

  /**
   * 清空消息区与全部渲染状态（clear_ok + 重放渲染 renderReplayFromRounds 复用）
   *
   * 不替换 messages 全部子节点（保留 #emptyState 占位）；空态/占位刷新由调用方 updateEmptyState 负责。
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
    removeAllPlanBoards();
    // 流式锚点失效：清空/重放后由下次 append 重建（排雷 P0-1）
    activeAssistantEl = null;
    pausedAssistantEl = null;
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
    roundGroupEl = null;
    lastShownDate = undefined;
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
        append('user', r.userMessage.content, r.userMessage.timestamp, r.id);
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
        renderInterruptedRound(r.id);
      } else {
        // 普通轮：任务过程折叠区一次性渲染（finalize=true，收起态）
        renderRoundBlock(currentEvents, true);
      }
    }
    // 3) 中间段：前序 assistant 段 + 交互输入按时间升序交织（还原打断点 / 提问点时序）
    const middle: {
      kind: 'seg' | 'question-answer' | 'supplement' | 'timeout';
      content: string;
      ts?: string;
      question?: string;
      options?: string[];
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
      })),
    ].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    for (const item of middle) {
      if (!item.content) continue;
      if (item.kind === 'seg') {
        // 正文块建立后补挂任务过程折叠区 + 回收同轮 fallback 残留
        append('assistant', item.content, item.ts, r.id);
        renderRoundBlock(currentEvents, true, runtimeInteractiveInputs);
        if (r.id && roundBlockEl?.isConnected) {
          messages
            .querySelectorAll<HTMLElement>(`.round-block__input[data-round-id="${r.id}"]`)
            .forEach((el) => el.remove());
        }
      } else if (item.kind === 'question-answer' || item.kind === 'timeout') {
        resumePending = true;
        appendInteractiveInput(item.content, item.ts, item.kind, r.id, item.question, item.options);
      } else {
        // supplement：删除打断骨架后照常落交互行
        flowShellEl?.remove();
        flowShellEl = null;
        if (pausedAssistantEl && !pausedAssistantEl.isConnected) pausedAssistantEl = null;
        clearPendingWait();
        resumePending = true;
        appendInteractiveInput(item.content, item.ts, item.kind, r.id, item.question, item.options);
      }
    }
    // 4) 最终回答（仅 complete 轮挂正文——中断轮正文与平铺 narrate 同源，避免双份）
    if (r.status === 'complete' && r.assistantMessage?.content) {
      append('assistant', r.assistantMessage.content, r.assistantMessage.timestamp, r.id);
      renderRoundBlock(currentEvents, true, runtimeInteractiveInputs);
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
    updateEmptyState();
    scrollToBottom(messages);
  }

  // 处理 extension → webview 消息（流式渲染 / 状态机 / 单一过程事件 / 下拉数据）
  function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>): void {
    const msg = event.data;
    if (msg.type === 'status') {
      setStatus(msg.state);
    } else if (msg.type === 'turn_update') {
      // 2b-2b 换真源：骨架容器改由**完整 TurnState 快照**直接赋值（skeletonFromTurnState 投影剥离
      // roundId/RoundStatus/questions——容器不消费）。`turn_update.state` 即全量状态，无增量结合
      // 前值推演；宿主在流起始（running 投影）、流尾（settled/waiting）、申请在途（waiting pausePending）、
      // 重放（idle/settled）等一切 turn 状态变化点推送。legacy pause_pending 消息已删除
      //（宿主/ webview 双端同步删，申请在途统一由 turn_update.state 承载）。
      applySkeletonState(skeletonFromTurnState(msg.state));
      // 待发送区渲染真源并入 turn_update 单通道（pending_queue_update 已删）。
      // pendingQueue 可选字段，缺省（旧宿主/测试构造）则不刷新待发送区（保持现状）。
      if (msg.pendingQueue) {
        updatePendingQueueBar(msg.pendingQueue);
      }
      // 会话重放快照（replay:true）→ 整批渲染 rounds。
      // ⚠ 顺序契约（必须排在提问渲染之前）：renderReplayFromRounds 首行 resetChatView
      // 会清掉 .ask-inline；而宿主 postTurnUpdate(undefined, true) 这一条消息同时携带
      // replay:true 与 state（waiting/ask + questions）——视图重建后的 ready 握手重放、
      // 以及流尾「流期间视图重建过」补重放，都发生在提问仍挂起时。若先渲染提问卡，会被紧随的
      // 重放抹掉 → 用户看不见提问，只面对一个无反应的「继续」按钮（ask 相位点 resume 被静默丢弃），
      // 提问超时后自动续跑、记录里留下「未回答」——即实测现象。故重放先、提问卡后。
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
    } else if (msg.type === 'tool_pending') {
      // 工具意图预告：LLM 流式生成 tool_call 参数期间（name 成形即上报），
      // 工具尚未执行——提前渲染「准备中」工具行。瞬态展示轨：不落 events[]、不参与
      // currentEvents（finalize 全量重建时天然消失），后续 tool_start 按 toolCallId 升级。
      renderPendingToolRow(msg);
    } else if (msg.type === 'step_boundary') {
      // 迭代落盘点（瞬态信号，与 tool_pending 同族）：本步工具宿命已定（started 已升级；
      // 截断批/重试孤儿的 tool_start 永不到达）→ 预告行注销（生命周期契约见 dropStalePendingToolRows）
      dropStalePendingToolRows();
    } else if (msg.type === 'process_event') {
      // 运行时单形态渲染投影（v1.5）：一律汇入当前轮 events[] 由 renderRoundBlock 渲染。
      // meta 为本轮首条 → 开新轮（清缓冲 + 挂载就绪）；瞬时「已召回/已沉淀」提示由事件本地派生
      const ev = msg.event;
      if (ev.type === 'meta') {
        // 新轮/续跑判定（三态收敛）：暂停续跑（pausedAssistantEl 有效）
        // > 交互续跑（resumePending）> 真新轮。
        //   pausedResume：pause→resume 的新 runFlow meta——原位续写暂停块（不建新骨架、
        //     不重置 round-block 锚点），后续 text chunk 走 pausedAssistantEl 分支续写同一
        //     assistant 块。宿主每个 runFlow 都会重发 meta，若不处理，骨架 B 会劫持 chunk
        //     走 flowShellEl 分支，导致「暂停后继续 = 视觉两个独立 LLM 回答」。
        //   resumePending：插话/提问续跑（无 paused 锚点）→ 保留锚点但建续接骨架（新段）。
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
        // 无锚但有续跑期待（生成中 interject 打断补充）→ 续接骨架（打断分段，非 turn 内补问）
        if (pausedResume) {
          // 暂停原位续写：锚点（pausedAssistantEl）与 currentEvents/round-block 全保留，
          // 不建骨架——由 chunk 分支的 pausedAssistantEl 原位续写路径消费。
          // 必须同时消费 resumePending：暂停态补充输入时前三态
          // 判定 pausedResume 优先、不会走到 else-if resumePending 分支 → resumePending 残留
          // true。诚实定性：当前路径 pausedResume 恒优先，残留是惰性状态（突变验证不红），
          // 但属状态不变量维护——清理纪律与 done/interrupted 对称，防未来新路径引入误判
          // （如骨架期 ask_user 回答后残留被下一个无锚点 runFlow 消费成续接骨架）。
          resumePending = false;
        } else if (resumePending) {
          resumePending = false;
          // 交互续跑（提问/补充答后 resume）：建**续接骨架**（无任何续接视觉标识——
          // 「↻ 续接」chip 已整体退役；补充/问答由独立交互条目行分隔，见 append 注释），挂载到交互链末位
          // 之后——保持 [块A] → [问/你答行] → [块B] 的顺序（运行时同构；连环
          // ask：统一 resolveInteractionAnchor，取代全范围「最后 .msg-qa」扫描——
          // 后者在 QA 已折入 rb / 前轮残留时会跨轮误取）
          prepareFlowShell({ mountAfter: resolveInteractionAnchor() ?? undefined });
        } else {
          currentEvents = [];
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
          showActivity('info', `已沉淀：${ev.payload.name || ev.payload.id}`);
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
        // 打断旧流必须同时移除旧块流式光标（is-streaming ▋）——否则旧块光标残留闪烁：
        // 该块只是"被打断的半截回答"，不再有新 chunk，finalizeStreaming 也不会再被调用
        activeAssistantEl
          ?.querySelector<HTMLElement>(':scope .msg-body')
          ?.classList.remove('is-streaming');
        if (streamRenderTimer) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = undefined;
        }
        streamingActive = false;
        streamingRaw = '';
        streamBodyRendered = false;
        // 注意：不置 activeAssistantEl = null —— 打断点引用保留给打断分条定位（见下）
      }
      // 交互输入/问答：清残留骨架 + 等待指示器（后续段形态由 chunk/meta 决定）。
      // 骨架期 ask 防回归护栏：ask 挂起（question-answer/timeout）时骨架是原位续写锚
      // （flowShellEl + pausedAssistantEl 双引用）——删除会使 resume meta 的 pausedResume 判定失效
      // （isConnected=false）→ 误走 resumePending → prepareFlowShell 挂 resolveInteractionAnchor 兜底位
      // （消息流最后 assistant 块 = 上一轮）致回答错位，且 flowEl 随骨架消散使「你答」条目兜底挂
      // 消息流尾（实证：ask 点选项后 LLM 回答接上一 turn、用户输入/补充孤零零在底部）。
      // 保留骨架与引用：后续 chunk 走 flowShellEl 分支复用开启正文流（原位续写单块，与重放同构）。
      // supplement（打断补充 interject）维持删除语义：打断后由 beginStreaming 新建块 + 容器化归位，
      // 空壳骨架无保留价值。
      if (msg.kind === 'supplement') {
        flowShellEl?.remove();
        flowShellEl = null;
        // 防御：被删骨架若持 pausedAssistantEl 锚（罕见混合态），同步失效防悬空续写误判
        if (pausedAssistantEl && !pausedAssistantEl.isConnected) pausedAssistantEl = null;
      }
      clearPendingWait();
      // 在途批宿命已定（用户输入 = 插话打断/新轮起步，[TOOL_ABORTED] 同源）：
      // 未升级预告行注销（生命周期契约见 dropStalePendingToolRows）
      dropStalePendingToolRows();
      // 带 kind 的交互输入 → 行内打断分条（supplement）/ 消息流内联子行（qa）。
      // 单轨：后续 assistant 段是否续接由 chunk 携带的 roundId 与 lastAssistantRoundId
      // 相等判定（运行时与重放同一判定源）；resumePending 供下一次 process_event meta
      // 识别「同闭环续跑」（保留 currentEvents 与 round-block 锚点，不重置）。
      // 普通新闭环输入重置同环判定 + 清续跑期待 + round-block 锚点（供新轮首块挂载）
      if (msg.kind) {
        resumePending = true;
        appendInteractiveInput(msg.text, msg.ts, msg.kind, msg.roundId, msg.question, msg.options);
      } else {
        // 用户消息渲染兜底（防「重启后首输气泡偶发缺失」）：
        // 异常不再静默——console.warn 暴露堆栈（复制发现场 Console 即可定位），且以最小文本块
        // 降级渲染保证用户输入恒可见（与带 kind 交互行共用 ensureUserInputVisible 单实现）。
        try {
          append('user', msg.text, msg.ts);
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
          const body = flowShellEl.querySelector(':scope .msg-body');
          body?.classList.add('is-streaming');
          // 容器化：骨架随 chunk 归位到所属容器（骨架建时无 roundId）
          // 流式未定稿 → 容器 footer 初始隐藏（pending=true），done/interrupted 后 finalizeStreaming 展示
          ensureRoundGroup(msg.roundId, flowShellEl, true);
          flowShellEl = null; // 已转化为正文块，后续插话/新轮不再特殊处理
        } else if (
          pausedAssistantEl &&
          pausedAssistantEl.isConnected &&
          isSameRoundContinue(msg.roundId)
        ) {
          // pause→resume 原位续写：无输入 continue 后首个 text chunk，
          // 同闭环（roundId 相等）且存在暂停块 → 复用暂停块续写（还原该块流式状态），
          // 而非 beginStreaming 新建第 2 个 assistant 块——修复「一次输入、视觉两个独立 LLM 回答」。
          // 注意：streamingRaw 不重置——暂停前已累积文本保留，续写增量拼接（renderStreamBody 全量重建）。
          activeAssistantEl = pausedAssistantEl;
          pausedAssistantEl = null;
          const body = activeAssistantEl.querySelector(':scope .msg-body');
          body?.classList.add('is-streaming');
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
      showActivity('info', `LLM 调用重试 ${msg.attempt}/${msg.maxRetries}…`);
    } else if (msg.type === 'paused') {
      // Agent 暂停（输入待定/step 边界软暂停）→ 提示条
      showActivity('info', 'Agent 已暂停');
      // 记录暂停块（resume 原位续接锚）：无输入 continue 的首 text chunk 复用此块
      // 续写，避免 beginStreaming 新建第 2 个 assistant 块（视觉双回答分裂）；块 A 保留静态展示。
      if (activeAssistantEl && activeAssistantEl.isConnected) {
        pausedAssistantEl = activeAssistantEl;
      }
      // 暂停即流暂停：清流式光标 + 停节流定时器（保留半截正文静态展示，不 finalize 终态）。
      // 提问/补充后 resume 的新 runFlow 由 meta/chunk 建续接块，本暂停块不再闪烁「调用大模型」
      if (streamingActive) {
        if (streamRenderTimer) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = undefined;
        }
        activeAssistantEl
          ?.querySelector<HTMLElement>(':scope .msg-body')
          ?.classList.remove('is-streaming');
        streamingActive = false;
      }
    } else if (msg.type === 'capability_badge') {
      // 角色能力徽章 → 更新工具权限展示
      updateCapabilityBadge(msg.toolMode, msg.capabilities);
    } else if (msg.type === 'metrics') {
      // 活动指标（透明面板 + 指纹可见）：每轮结束后刷新详情折叠区
      renderMetrics(msg);
    } else if (msg.type === 'context_occupancy') {
      // ④ 预算可视化：更新输入区常驻上下文占用条
      updateContextOccupancy(msg.occupancy);
    } else if (msg.type === 'error') {
      clearPendingWait(); // 失败即收尾，等待指示器退场
      // 错误收尾清理语义：
      // error 属「可恢复流中断」，不清交互行标志——与既有收窄语义一致：
      // 交互行（qa/supp）一旦上屏，后续正文恒分块续接（interactiveRowInserted 门控
      // pausedResume），error 后继续/重试也不例外；清标志会让「交互行已插 → error →
      // resume」退回原位续写、QA 行被顶到续写正文之后（bug 复发）。
      // 标志清理归口：done / interrupted / 新闭环 user / meta 消费（均已就位）——
      // 主路径 error 后宿主流收尾必发 done 紧随清理；error 为末条（宿主异常未发 done）
      // 时残留被下一 send 的 user 分支兜底，且 UI 无 paused 态则无 resume 入口，无触发面。
      append('error', msg.message);
    } else if (msg.type === 'done') {
      // 本轮流式结束：清除归档停滞兜底定时器 + 骨架引用（已定型为正文/异常块）
      clearPendingWait();
      clearArchivingFallback();
      flowShellEl = null;
      pausedAssistantEl = null; // 结束即收尾：暂停续接锚失效
      resumePending = false; // 同节奏清续跑期待（防中断/补充后残留污染下轮判定）
      // 顺序关键：先回填本轮 roundId（commitRoundId 同步给 QA 行补 roundId，fold 按归属过滤）→
      // 收起任务过程折叠区（finalize 全量渲染）→ 收敛 QA 行进折叠块 → 关流式光标
      // （QA 不留在折叠块与报告之间）
      commitRoundId(msg.roundId);
      finalizeRound();
      // 回填删除按钮 ts 锚（运行时流式块 dataset.ts 恒空 → 删除按钮恒禁用修复）
      commitTurnTs();
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
      // 过程收进折叠块（保留已完成 step）→ 「用户停止了对话」平铺折叠块外（收起态常驻可见）。
      commitRoundId(msg.roundId);
      finalizeRound();
      const interruptedHost = activeAssistantEl;
      if (interruptedHost?.isConnected) {
        // 丢弃半截正文（运行中 step 的内容因中断作废，与重放中断轮不显示正文同源同形）
        interruptedHost.querySelector<HTMLElement>(':scope > .msg-body')?.remove();
        appendInterruptedRow(interruptedHost, currentEvents);
      }
      // 打断也可能产生部分回答：同样回填 roundId，允许从该轮分叉
      commitTurnTs();
      showActivity('info', '已停止生成');
    } else if (msg.type === 'suggestions') {
      // Follow-up 建议：回复结束后「下一步可探索」chips（点击填入输入框并聚焦）
      renderFollowUpSuggestions(msg.items);
    } else if (msg.type === 'prefill_input') {
      // 角色 handoff 上下文传递：填入输入框并聚焦，不自动发送（用户可编辑后回车）
      input.value = msg.text;
      input.style.height = 'auto';
      input.focus();
      autoResize();
      syncSendEnabled(); // 程序化预填不触发 input 事件，须手动同步可用性
      syncButtonSemantics(); // 程序化预填同理不触发 input 事件，须同步按钮语义（标题随相位+输入重算），避免窗口期文案过期
    } else if (msg.type === 'plan_update') {
      // H4 任务驱动多步闭环：LLM 更新任务表 → 刷新任务看板（renderPlanBoard 自建/更新容器）
      renderPlanBoard(msg.items);
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
        showActivity('info', `润色失败：${msg.message}`);
      }
    } else if (msg.type === 'clear_ok') {
      // 清空消息区与全部渲染状态（resetChatView，重放渲染 renderReplayFromRounds 复用
      // ——跨会话/重建前同样需要复位，避免旧渲染残留污染新会话）。
      resetChatView();
      updateEmptyState();
    } else if (msg.type === 'history_loaded') {
      // 历史消息加载完成 → 强制滚到底部（不走吸底逻辑）
      // 解决多条历史消息 rAF 节流导致滚动位置不正确的问题
      forceScrollToBottom(messages);
    } else if (msg.type === 'session_title') {
      // 更新会话标题条（ADR-024 会话标题层）：textContent 防注入；
      // 切换/改名/清空后由 chatPanel 推送最新标题，标题条始终指向当前会话。
      sessionTitleText.textContent = msg.title;
    } else if (msg.type === 'session_list_data') {
      // 历史会话列表：渲染到 treedd 历史下拉菜单
      renderHistoryMenu(msg.sessions);
    } else if (msg.type === 'chat_providers') {
      currentProviders = msg.providers || [];
      currentActive = msg.activeName;
      // 更新当前模型名（用于 AI 消息头部标签展示）
      if (currentActive) {
        const activeProvider = currentProviders.find((p) => p.name === currentActive);
        currentModelName = activeProvider?.displayName || currentActive;
      }
      renderModelPicker();
      // ④ 预算可视化：按当前选中 LLM 的上下文上限实时渲染占用条容量（首轮对话前即有真实上限）
      renderOccupancyLimit(currentProviders, currentActive);
      // 无 Provider 时空态切换为「去配置模型」引导（首次使用关键路径，
      // 避免用户不知道去哪配置而卡在空态）；配置就绪后恢复角色化空态（幂等）
      if (currentProviders.length === 0) {
        updateEmptyStateOnboarding();
      } else {
        updateEmptyStateRole();
        emptyState.querySelector('.empty-onboard-btn')?.remove();
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
      updateEmptyStateRole();
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
      skillOptions = msg.skills.map((s) => ({ name: s.name, disabled: s.disabled }));
      if (skillPickerMenu) {
        skillPickerMenu.innerHTML = '';
        const clearItem = document.createElement('div');
        clearItem.className = 'treedd__item';
        // 顶部项语义 = 「普通对话、不挂载技能」——用中性「未选择技能」替代原「不使用 Skill」：
        // 原文字易被误读为「禁用技能」（禁用另属设置页禁用清单），且暗示「提及技能名即自动
        // 命中」（当前机制是显式选择，见 title 提示）。
        clearItem.textContent = '未选择技能';
        clearItem.title =
          '未挂载任何技能，进行普通对话（技能需从下方显式选择；提示词提及技能名不会自动加载）';
        clearItem.dataset.treeddId = '__clear_skill';
        skillPickerMenu.appendChild(clearItem);
        const divider = document.createElement('div');
        divider.className = 'treedd__divider';
        skillPickerMenu.appendChild(divider);
        for (const s of skillOptions) {
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
          skillPickerMenu.appendChild(item);
        }
      }
      updateSkillPickerLabel();
    } else if (msg.type === 'file_changes') {
      // 未确认文件改动快照：宿主在**改动集变化**时推 + **webview ready 时补推一次**
      // （两个时机缺一即漏面——只推变化的话，面板重开后常驻条会消失）
      updateFileChangesBar(msg.files);
    } else if (msg.type === 'notice') {
      showActivity(msg.level, msg.message);
    } else if (msg.type === 'goal_drift_detected') {
      // 目标漂移检测：展示原目标 vs 新目标 + 相似度，供用户确认或忽略
      const pct = Math.round(msg.similarity * 100);
      const levelLabel = msg.level === 'drift' ? '严重偏离' : '需要确认';
      showActivity('info', `目标漂移（${levelLabel}，相似度 ${pct}%）：${msg.newGoal}`);
    } else if (msg.type === 'write_confirm_request') {
      // H0 写入审批卡：confirmWrites=true 时写文件触发 → 渲染审批卡等待用户确认/拒绝；
      // 用户点击后回传 write_confirm_answer。多请求同一时刻只展示最新（前一张被新请求覆盖，
      // 与 host 侧「每个 requestId 独立超时 fail-closed」语义兼容——旧请求由超时自动拒绝）。
      renderWriteConfirmCard(msg);
    }
  }

  /**
   * 写入审批卡渲染（webview 侧唯一实现点）
   *
   * 填充卡片字段（工具名 / 目标文件 / 描述 / 写入内容 diff 预览）并显示；
   * 记录当前 requestId，供确认/拒绝按钮回传 write_confirm_answer。
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
    // diff 预览：afterContent 为写入后的完整内容（beforeContent 为 null 时即新建文件）
    const before = msg.beforeContent ?? '(新建文件)';
    writeConfirmDiff.textContent =
      before === msg.afterContent
        ? before
        : `--- 写入前 ---\n${before}\n\n+++ 写入后 +++\n${msg.afterContent ?? ''}`;
    pendingWriteConfirmRequestId = msg.requestId;
    writeConfirmCard.hidden = false;
  }

  /** H0 审批卡按钮事件（确认/拒绝 → 回传 write_confirm_answer + 隐藏卡片） */
  if (writeConfirmOk && writeConfirmReject && writeConfirmCard) {
    writeConfirmOk.addEventListener('click', () => {
      if (pendingWriteConfirmRequestId !== null) {
        vscode.postMessage({
          type: 'write_confirm_answer',
          requestId: pendingWriteConfirmRequestId,
          approved: true,
        });
      }
      writeConfirmCard.hidden = true;
      pendingWriteConfirmRequestId = null;
    });
    writeConfirmReject.addEventListener('click', () => {
      if (pendingWriteConfirmRequestId !== null) {
        vscode.postMessage({
          type: 'write_confirm_answer',
          requestId: pendingWriteConfirmRequestId,
          approved: false,
        });
      }
      writeConfirmCard.hidden = true;
      pendingWriteConfirmRequestId = null;
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
      console.error('[chatView] 消息处理异常（已兜底，UI 可能不完整）：', err);
    }
  }

  window.addEventListener('message', onMessage);

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
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    input.style.overflowY = 'hidden';
    // 清输入框后按钮语义也要重算（hasInput 变了）
    syncButtonSemantics();
    syncSendEnabled();
    // 构建消息：选中技能传技能名（SSOT 收紧，host 按名走内核 buildSystemPrompt，取消前端硬编码提示）
    // send 意图单消息（宿主按相位路由到 chat / interject / 带文本续跑；skillName 为 input 原生成员）
    const payload: WebviewToExtensionMessage = {
      type: 'input' as const,
      kind: 'send' as const,
      text,
      ...(currentSkill ? { skillName: currentSkill.name } : {}),
    };
    vscode.postMessage(payload);
  }
  // 发送按钮：空闲点击 = 发送；生成中点击 = 停止（按钮已切换为停止方块，
  // mvp-scope 打断能力）；暂停中点击 = 继续（恢复 Agent 执行）。
  // 生成中插话走 Enter（见下方 keydown，不经此分支）。
  send.addEventListener('click', () => {
    if (send.classList.contains('loading')) {
      // thinking / paused 态：发送键恒为「停止生成（丢弃检查点）」——暂停态续跑走 pauseBtn（play 图标）。
      vscode.postMessage({ type: 'stop' });
    } else {
      // done+有输入 / thinking+有输入：统一走 sendMessage 发 type='send'，
      // 宿主层 handleInput 按 turn 相位路由到 chat() / interject() / resumeExecution()
      sendMessage();
    }
  });
  // pauseBtn 双态语义：thinking 态发 pause（暂停生成 / 或取消暂停）；
  // paused 态发 resume（继续生成 / 或发送补充并继续）——click 行为由骨架状态派生路由。
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
  input.addEventListener('keydown', (e) => {
    // isComposing 守卫：中文输入法组合确认（如打字中途按 Enter 选字）不误触发发送
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => {
    autoResize();
    // 输入内容变化时，按钮语义（classList 图标）和 disabled 态都要重算
    syncButtonSemantics();
    syncSendEnabled();
  });

  // ─── 会话管理（标题条收敛全部入口）───
  // 相对时间（历史列表副标题，本地辅助；重复 3 次再提取 helper）
  function fmtRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff) || diff < 0) return '';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} 天前`;
    return iso.slice(0, 10);
  }
  // 渲染历史菜单（对 session_list_data 的应答）：复用 treedd 组件——
  // 条目为 .treedd__item（id=sessionId，点击走 initDropdowns 选择委托加载会话并收起）；
  // 内嵌垃圾桶（span，点击 stopPropagation 阻断选择委托，仅发 delete_session，菜单保持展开）；
  // 空态为非 item 文本（委托不命中，纯展示）。
  function renderHistoryMenu(
    sessions: { sessionId: string; title: string; updatedAt: string }[],
  ): void {
    historyMenu.textContent = '';
    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-history__empty';
      empty.textContent = '暂无历史会话，新建会话后自动归档到此';
      historyMenu.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      const item = document.createElement('button');
      item.className = 'treedd__item';
      item.dataset.treeddId = s.sessionId; // treedd 选择委托据此回调 __historyOnSelect
      item.setAttribute('role', 'menuitem');
      const titleEl = document.createElement('span');
      titleEl.className = 'session-history__item-title';
      titleEl.textContent = s.title; // textContent 防注入
      const timeEl = document.createElement('span');
      timeEl.className = 'session-history__item-time';
      timeEl.textContent = fmtRelativeTime(s.updatedAt);
      // 删除用 span 而非 button：treedd__item 本身是 button，HTML 规范 button 内不可嵌套 button
      const delBtn = document.createElement('span');
      delBtn.className = 'session-history__item-del';
      delBtn.title = '删除会话';
      delBtn.setAttribute('role', 'button');
      delBtn.setAttribute('aria-label', '删除会话');
      delBtn.innerHTML = getIconSvg('trash', 14, 14);
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻断冒泡到 menu 的选择委托，仅触发删除（菜单保持展开可连续删）
        vscode.postMessage({ type: 'delete_session', sessionId: s.sessionId });
      });
      item.append(titleEl, timeEl, delBtn);
      historyMenu.appendChild(item);
    }
  }
  // 标题条按钮：改名笔 / 新建「＋」（分叉统一收敛到消息底部——任意 LLM 回答处可分叉，标题条不再冗余入口）
  renameSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'rename_request' }));
  newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'new_session' }));
  // 历史按钮：开合由 treedd 管理（initDropdowns），本层只负责「打开时请求最新列表」——
  // 二者协作不耦合（SSOT 单一职责：treedd 管交互状态、本层管数据）
  historyBtn.addEventListener('click', () => vscode.postMessage({ type: 'session_list' }));

  // 任务常驻条（合并单轨）：点击头部展开/收起锚定浮层；浮层轻交互——
  // 点击浮层外区域收起（非 modal：看进度时需同时看正文，故不遮罩全屏）
  const planBarHead = document.getElementById('planBarHead');
  planBarHead?.addEventListener('click', () => {
    setPlanBarExpanded(!planBarExpanded);
  });
  document.addEventListener('click', (e) => {
    const bar = getPlanBarEl();
    if (planBarExpanded && bar && !bar.contains(e.target as Node)) {
      setPlanBarExpanded(false);
    }
  });

  // 空状态示例提问 chips：点击填入输入框并聚焦（ui-redesign.md §6.1 空状态引导）。
  // 事件委托于 document，兼容 renderEmptySuggestions 动态渲染的 chips（角色切换后新增元素）。
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
        currentSkill = { name: id, disabled: !!found.disabled };
        updateSkillPickerLabel();
      } else if (id === '__clear_skill') {
        currentSkill = null;
        updateSkillPickerLabel();
      }
    },
  });

  /** 更新 Skill 选择器标签 + 输入框上方 chip（Grok 式）：
   * 入口触发器 ⚡（accent 边框表示已启用）+ 菜单内 is-active 高亮 + title/aria 兜底；
   * 输入框上方由 renderSkillChip 呈现「名称 + × 可移除」的状态 chip。 */
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

  /** Grok 式：在输入框上方构建/清空「名称 + × 可移除」的技能 chip。
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
    const chip = document.createElement('span');
    chip.className = 'skill-chip';
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
  }

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
   * `disabled` 随行带出：下拉项据此弱化 + 标注「已禁用」，chip 据此提示 —— 纯显示，不拦截。 */
  let skillOptions: { name: string; disabled?: boolean }[] = [];
  // 初始化 Skill 选择器选项：先放「不使用 Skill + 分隔线」，具体清单由 skills_loaded 动态填充
  if (skillPickerMenu) {
    skillPickerMenu.innerHTML = '';
    const clearItem = document.createElement('div');
    clearItem.className = 'treedd__item';
    clearItem.textContent = '未选择技能';
    clearItem.title =
      '未挂载任何技能，进行普通对话（技能需从下方显式选择；提示词提及技能名不会自动加载）';
    clearItem.dataset.treeddId = '__clear_skill';
    skillPickerMenu.appendChild(clearItem);
    const divider = document.createElement('div');
    divider.className = 'treedd__divider';
    skillPickerMenu.appendChild(divider);
    updateSkillPickerLabel();
  }

  /**
   * 「（准备中）」预告行注销（生命周期契约：每条预告行**要么升级、要么注销**，不许常驻）。
   *
   * 预告行（tool_pending，瞬态轨）的宿命只有两个出口：① tool_start 到达 → 升级执行态
   * （upgradePendingToolRow）；② 所属批的 tool_start **永不到达** → 此处注销。触发集 =
   * 批宿命已定的全部落点：`step_boundary`（截断批/重试孤儿在此注销——continue 型迭代落盘点）；
   * 提问定型（ask 挂起批不发 step_boundary，其宿命在提问 UI 渲染时已定）；用户输入
   * （插话/新轮打断在途批，[TOOL_ABORTED] 同源）。轮收尾/中断由整树重建天然注销（finalizeRound
   * 拆过程容器），不重复挂钩。不注销的后果 = 运行时残留无内容的幽灵折叠块、散在任务项折叠块外。
   */
  function dropStalePendingToolRows(): void {
    messages.querySelectorAll('.round-block__tool.is-tool-pending').forEach((row) => row.remove());
  }

  // 提问卡渲染（真源 = turn_update.state 的 waiting/ask）
  // 职责与原 need_clarify 分支等价：优先内联块（renderAskInline 挂问答交互行下），
  // 无锚点时降级底部 clarifyBar 异常兜底。questions 来自 turn_update.state.questions
  //（宿主 postTurnUpdate 投影派生，非独立消息载荷）。
  function renderAskPhase(questions: PendingQuestionDto[]): void {
    // 挂起批次收口：提问定型 = 本批工具不再执行，未升级预告行退场（幽灵块防残留）
    dropStalePendingToolRows();
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
  updateEmptyState();
  updateRoleBadge(); // 输入区角色徽章（首屏可能有历史推送的角色名）
  updateEmptyStateRole(); // P3：空状态文案随当前角色生长（首屏可能已有角色推送）
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
    if (activityTimer !== null) window.clearTimeout(activityTimer);
  }

  return { dispose };
}
