/**
 * chatView — 对话面板 webview 运行时脚本（阶段 B P2-1）
 *
 * 由 chatPanel.ts 的 buildHtml 内联 <script> 迁移而来：以工厂函数 createChatView
 * 接收依赖（acquireVsCodeApi / window）并初始化全部交互，替代原「字符串注入脚本」。
 * 消除全局污染（window.ToolCard / __xxx 全局回调 → 模块 import + 显式回调映射），
 * 同时具备可测性（依赖注入，可传入 mock window/jsdom）。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/chatView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src 'self'）。
 */
import type {
  ExtensionToWebviewMessage,
  MemoryRecallItemDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
// ThinkingPhase 纯类型导入，仅编译期用（esbuild 剥离，不影响 bundle）
import type { ThinkingPhase } from '@zooique/memora';
import { fmtTime } from '../helpers/fmtTime.js';
import { forceScrollToBottom, scrollToBottom, trackScroll } from '../helpers/scrollToBottom.js';
import { renderMarkdown } from '../helpers/renderMarkdown.js';
import { ToolCard } from '../components/toolCard.js';
import { initDropdowns } from '../components/dropdown.js';

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
 * 空状态示例提问集（SSOT，MVP 2026-08-16）
 *
 * ROLE_SUGGESTION_SETS 按角色显示名特化示例提问：命中展示专属示例，未命中回退通用。
 * showcase 角色（方案设计师）展示"种子收敛"引导——让用户一键体验 memora 最吸引人的
 * 「给模糊想法 → 引导收敛最小单元」设计魅力；其余角色保持通用打磨引导，
 * 避免为每条角色特化造成维护成本（新增 showcase 角色时在此追加映射即可）。
 */
const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { prompt: '帮我审阅当前文档的架构合理性', label: '审阅架构' },
  { prompt: '帮我精简文档中的冗余表达', label: '精简表达' },
  { prompt: '检查文档与代码实现是否一致', label: '对齐实现' },
];

const ROLE_SUGGESTION_SETS: Record<string, Suggestion[]> = {
  方案设计师: [
    { prompt: '我想做一个个人知识库，帮我设计一个方案', label: '设计知识库' },
    { prompt: '我想做一个记忆系统，帮我找出最小单元', label: '设计记忆系统' },
    { prompt: '我想做一个待办工具，帮我找出最小功能', label: '找最小单元' },
  ],
};

/**
 * 初始化对话面板 webview 交互（替代原内联 <script>）
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createChatView({ acquireVsCodeApi, window }: ChatViewDeps): void {
  const document = window.document;
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages') as HTMLElement;
  const emptyState = document.getElementById('emptyState') as HTMLElement;
  // 空状态标题/提示（P3，2026-08-15 空状态角色化）：随激活角色包动态生成，切换角色不产生定位错位
  const emptyTitle = document.getElementById('emptyTitle') as HTMLElement;
  const emptyHint = document.getElementById('emptyHint') as HTMLElement;
  // 空状态示例提问容器（showcase 角色特化引导，MVP 2026-08-16）：由脚本按激活角色动态填充
  const emptySuggestions = document.getElementById('emptySuggestions') as HTMLElement;
  // 会话标题条（ADR-024 会话标题层 + 2026-08-17 会话管理重构）——顶部展示当前会话标题，
  // 主动可见识别当前会话；左侧改名笔、右侧新建「＋」+ 历史下拉（会话导航全量收敛于此）
  const sessionTitleText = document.getElementById('sessionTitleText') as HTMLElement;
  const renameSessionBtn = document.getElementById('renameSessionBtn') as HTMLButtonElement;
  const newSessionBtn = document.getElementById('newSessionBtn') as HTMLButtonElement;
  // 历史记录下拉（SSOT 剪枝 v2）：复用 treedd 组件（trigger=历史按钮），
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
  const skillPickerMenu = skillPicker ? skillPicker.querySelector<HTMLElement>('.treedd__menu') : null;
  const skillPickerTrigger = skillPicker ? skillPicker.querySelector<HTMLElement>('.treedd__trigger') : null;
  // Grok 式技能 chip 行：输入框上方展示当前已选 Skill（名称 + × 可移除）
  const skillChipRow = document.getElementById('skillChips') as HTMLElement | null;
  let currentSkill: { name: string } | null = null;
  // 活动状态区（三合一：P0 错误 / P1 低扰 单条主状态 + P2 指标折叠详情）
  const activityBar = document.getElementById('activityBar') as HTMLElement;
  const activityDetail = document.getElementById('activityDetail') as HTMLElement;
  const activityList = document.getElementById('activityList') as HTMLElement;
  const activityMetrics = document.getElementById('activityMetrics') as HTMLElement;
  // Phase 1（2026-08-17 召回可展开）：活动详情内「本次召回」明细区（name/source/score 列表）
  const recallDetail = document.getElementById('recallDetail') as HTMLElement;
  const inputBar = document.getElementById('inputBar') as HTMLElement;
  const clarifyBar = document.getElementById('clarifyBar') as HTMLElement;
  const clarifyText = document.getElementById('clarifyText') as HTMLElement;
  const clarifyOptions = document.getElementById('clarifyOptions') as HTMLElement;
  const clarifyInput = document.getElementById('clarifyInput') as HTMLInputElement;
  const clarifySend = document.getElementById('clarifySend') as HTMLButtonElement;
  // 当前角色显示名（AI 消息头部标签 + 空状态标题共用；由 chat_role_pack 填充）
  let currentRoleName = '';
  // 底部模型下拉框（用 extraClass=model-picker 修饰）
  const modelPicker = document.querySelector<HTMLElement>('.model-picker');
  const modelPickerMenu = modelPicker ? modelPicker.querySelector<HTMLElement>('.treedd__menu') : null;
  const modelPickerTrigger = modelPicker ? modelPicker.querySelector<HTMLElement>('.treedd__trigger') : null;

  // 当前角色只读徽章（输入区左侧，展示角色名让用户感知当前定位；切换入口在独立「角色」视图）
  const roleBadge = document.getElementById('currentRoleBadge') as HTMLElement | null;
  // Phase 4 E2：工具权限徽章（输入区角色徽章旁，展示工具模式与能力列表）
  const capabilityBadge = document.getElementById('currentCapabilityBadge') as HTMLElement | null;

  // 流式锚点（SSOT，排雷 P0-1）：当前正在流式接收的 assistant 消息元素。
  // 追加目标用「不变锚点」而非 messages 最后一个元素——工具卡片/其他节点插入
  // 不会改变锚点，避免一次回复（含工具调用）被拆成多条消息。
  let activeAssistantEl: HTMLElement | null = null;

  // 流式状态（Markdown 渲染 + 光标，2026-08-16 吸收养分）：
  //   streamingActive — 是否正在接收本轮流式（首个 chunk 置 true，done/interrupted 复位）；
  //   streamingRaw — 本轮流式累积的原始文本（流结束后一次性渲染 Markdown + 供复制）。
  // 用独立状态而非复用 activeAssistantEl：区分「流式进行中」（需光标 + 结束时渲染）
  // 与「一次性 assistant 消息」（历史回放，直接渲染 Markdown）。
  let streamingActive = false;
  let streamingRaw = '';

  // G3 断点续跑提示条：检测到持久化暂停检查点时展示，用户点击「从断点续跑」恢复
  let restoreBanner: HTMLElement | null = null;

  /** 消息区顶部状态块插入协议（P1-0，2026-08-24）：
   * 需用户决策的检查点横幅（restoreBanner）恒在需感知的任务看板（planBoard）之上，
   * 避免后 prepend 者盖住先者导致「续跑」入口被遮挡。 */
  function prependStatusBlock(el: HTMLElement): void {
    if (restoreBanner && el !== restoreBanner) {
      messages.insertBefore(el, restoreBanner.nextSibling);
    } else if (planBoard && el !== planBoard) {
      messages.insertBefore(el, planBoard);
    } else {
      messages.prepend(el);
    }
  }

  /** 移除断点续跑提示条（恢复成功 / 用户关闭 / 切换会话时调用） */
  function removeRestoreBanner(): void {
    restoreBanner?.remove();
    restoreBanner = null;
  }

  /**
   * 展示断点续跑提示条（checkpoint_available / checkpoint_result 失败时）
   *
   * @param text 提示文案
   * @param withRestore 是否展示「从断点续跑」按钮（可恢复时 true；失败时仅展示错误 + 关闭）
   */
  function showRestoreBanner(text: string, withRestore: boolean): void {
    removeRestoreBanner();
    restoreBanner = document.createElement('div');
    restoreBanner.className = 'checkpoint-banner';
    restoreBanner.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.className = 'checkpoint-banner-text';
    label.textContent = text;
    restoreBanner.appendChild(label);
    if (withRestore) {
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'checkpoint-banner-btn';
      restoreBtn.textContent = '从断点续跑';
      restoreBtn.addEventListener('click', () => vscode.postMessage({ type: 'checkpoint_restore' }));
      restoreBanner.appendChild(restoreBtn);
    }
    const closeBtn = document.createElement('button');
    closeBtn.className = 'checkpoint-banner-close';
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭';
    closeBtn.setAttribute('aria-label', '关闭提示');
    closeBtn.addEventListener('click', removeRestoreBanner);
    restoreBanner.appendChild(closeBtn);
    // 插到消息区顶部状态栈（P1-0 协议：检查点横幅恒在任务看板之上），与历史重放同步可见
    prependStatusBlock(restoreBanner);
  }

  // 当前 Provider 列表（由 chat_providers 消息填充）
  let currentProviders: { name: string; displayName: string }[] = [];
  let currentActive: string | undefined;

  /**
   * 任务看板（H4 任务驱动多步闭环 · 最小可视化，2026-08-23）
   *
   * 动态创建并 prepend 到消息区顶部（与断点续跑提示条同点位模式）。收到 plan_update 时
   * 创建/更新；清空/新会话时移除。只读展示内核 checkpoint.plan，不参与 LLM 执行。
   */
  let planBoard: HTMLElement | null = null;

  /** 移除任务看板（清空/切换会话时调用，避免跨会话残留） */
  function removePlanBoard(): void {
    planBoard?.remove();
    planBoard = null;
  }

  /** 渲染/刷新任务看板（收到 plan_update 消息时调用）
   * @param steps 计划的步骤快照（按 order 已排序） */
  function renderPlanBoard(steps: { id: string; description: string; status: 'pending' | 'active' | 'done' | 'blocked'; order: number }[]): void {
    if (steps.length === 0) {
      removePlanBoard();
      return;
    }
    if (!planBoard) {
      planBoard = document.createElement('div');
      planBoard.className = 'plan-board';
      planBoard.setAttribute('role', 'region');
      planBoard.setAttribute('aria-label', '任务进度');
      // 插到消息区顶部状态栈（P1-0 协议：任务看板恒在检查点横幅之下），与历史重放/新轮计划同步可见
      prependStatusBlock(planBoard);
    }
    // 标题行：任务进度 N/M
    const doneCount = steps.filter((s) => s.status === 'done').length;
    let header = planBoard.querySelector(':scope .plan-board-header') as HTMLElement;
    if (!header) {
      header = document.createElement('div');
      header.className = 'plan-board-header';
      planBoard.appendChild(header);
    }
    header.textContent = `任务进度：${doneCount}/${steps.length}`;
    // 步骤列表：全量重建（简单确定性——步骤量小，重建成本可忽略；避免增量 diff 复杂化）
    const list = planBoard.querySelector(':scope .plan-board-list') as HTMLElement;
    if (list) list.remove();
    const ul = document.createElement('ul');
    ul.className = 'plan-board-list';
    for (const step of steps) {
      const li = document.createElement('li');
      li.className = `plan-step plan-step-${step.status}`;
      // 步骤序号（order+1 展示为 1 起）+ 描述；textContent 防注入
      li.textContent = `${step.order + 1}. ${step.description}`;
      ul.appendChild(li);
    }
    planBoard.appendChild(ul);
  }
  // 当前角色包列表（由 chat_role_packs 消息填充；description 供空状态提示副文案）。
  // 角色切换已独立到「角色」视图（2026-08-17），本面板仅消费角色名用于展示，不再承载切换。
  let currentRolePacks: { name: string; displayName: string; description?: string }[] = [];
  // P1（2026-08-15 记忆附着可见）：最近一轮结束时的附着记忆条数（metrics.fingerprints 提供）。
  // 流式结束后给 AI 回复补「基于 N 条记忆」弱标签，让记忆附着主动可见（memora 差异化价值）。
  let lastAttachedMemoryCount: number | undefined;

  // 思考折叠块（ui-redesign.md §7.1）：生成中/自审查的过程性反馈，不落库不重放
  // details 元素：以 HTMLDetailsElement 承载 open 属性（折叠/展开态）
  let thoughtEl: HTMLDetailsElement | null = null;
  // 一键到底按钮（2026-08-17 吸底优化）：用户上滚阅读时浮现，点击回到底部
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
  // 日期分隔线：跨天合并视图在日期交界插入分组（ui-redesign.md §4.1 ②）
  let lastShownDate: string | undefined;

  /** 本地时区 YYYY-MM-DD 日期键 */
  function toDateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  }

  /** 确保思考折叠块存在并返回（过程透明，不落库不重放） */
  function ensureThoughtBlock(): HTMLDetailsElement {
    if (thoughtEl && thoughtEl.isConnected) return thoughtEl;
    const tb = document.createElement('details');
    tb.className = 'thought-block';
    const summary = document.createElement('summary');
    const dot = document.createElement('span');
    dot.className = 'thought-block__dot';
    const label = document.createElement('span');
    label.className = 'thought-block__label';
    summary.appendChild(dot);
    summary.appendChild(label);
    tb.appendChild(summary);
    messages.appendChild(tb);
    thoughtEl = tb;
    scrollToBottom(messages);
    return tb;
  }

  /** 更新思考折叠块：label 标题 + 可选 body 内容 + 思考中/展开态 */
  function setThoughtLabel(
    label: string,
    opts: { thinking?: boolean; open?: boolean; body?: string } = {},
  ): void {
    const tb = ensureThoughtBlock();
    tb.classList.toggle('is-thinking', opts.thinking ?? false);
    tb.open = opts.open ?? false;
    const labelEl = tb.querySelector('.thought-block__label') as HTMLElement;
    if (labelEl) labelEl.textContent = label;
    if (opts.body !== undefined) {
      let bodyEl = tb.querySelector('.thought-block__body') as HTMLElement | null;
      if (!bodyEl) {
        bodyEl = document.createElement('div');
        bodyEl.className = 'thought-block__body';
        tb.appendChild(bodyEl);
      }
      bodyEl.textContent = opts.body;
    }
  }

  /**
   * P2（2026-08-15 执行轨迹）：把思考折叠块从单行文案升级为三阶段执行轨迹
   *
   * Agent 闭环 = Prepare(召回) → Act(打磨，含工具) → Reflect(归档)，三阶段即天然轨迹。
   * 用 ✓ 完成 / ● 进行中 / ○ 待执行 呈现，让用户一眼看懂 Agent 当前执行到哪一步
   * （对齐 Agent UI「执行过程可见」趋势）。纯前端从 thinking phase 聚合，不改内核协议。
   * 工具调用保持独立卡片（Tertiary 层级），不塞进轨迹，避免信息过载。
   */
  function renderTrace(phase: ThinkingPhase): void {
    // 三阶段轨迹：召回记忆 → 理解打磨 → 归档记忆（对应闭环 Prepare/Act/Reflect）
    // llm_calling 归属于 Act 阶段（理解打磨），与 processing 共享同一轨迹位置
    const steps: { label: string; state: 'done' | 'active' | 'pending' }[] = [
      { label: '召回记忆', state: 'pending' },
      { label: '理解打磨', state: 'pending' },
      { label: '归档记忆', state: 'pending' },
    ];
    // 外循环阶段（planning/step/reporting）归入 Act 阶段展示，避免出现未知阶段占位
    const phaseIndex: Record<string, number> = {
      recalling: 0,
      llm_calling: 1,
      processing: 1,
      planning: 1,
      step: 1,
      reporting: 1,
      archiving: 2,
    };
    const idx = phaseIndex[phase];
    steps.forEach((s, i) => {
      // 当前阶段之前的步骤已完成，当前进行中，之后待执行
      s.state = i < idx ? 'done' : i === idx ? 'active' : 'pending';
    });
    const tb = ensureThoughtBlock();
    // 轨迹容器：首次创建挂到思考块，之后复用（textContent 构建防注入）
    let trace = tb.querySelector('.thought-block__trace') as HTMLElement | null;
    if (!trace) {
      trace = document.createElement('div');
      trace.className = 'thought-block__trace';
      tb.appendChild(trace);
    }
    trace.textContent = '';
    steps.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'trace-step ' + s.state;
      const mark = document.createElement('span');
      mark.className = 'trace-step__mark';
      mark.setAttribute('aria-hidden', 'true');
      // ✓ 完成 / ● 进行中（呼吸）/ ○ 待执行
      mark.textContent = s.state === 'done' ? '✓' : s.state === 'active' ? '●' : '○';
      const label = document.createElement('span');
      label.className = 'trace-step__label';
      label.textContent = s.label;
      row.appendChild(mark);
      row.appendChild(label);
      trace.appendChild(row);
    });
    // A3（2026-08-24）：summary 行追加 Phase X/3 进度计数——用户一眼知道 Agent 执行到第几阶段
    // 先剥离旧计数再追加，防止重复追加（同一段轨迹多次 render 时）
    const total = steps.length;
    const current = Math.min(idx, total - 1) + 1;
    const labelEl = tb.querySelector('.thought-block__label') as HTMLElement | null;
    if (labelEl) {
      const baseText = labelEl.textContent?.replace(/\s*\(\d+\/\d+\)\s*$/, '') || '';
      labelEl.textContent = `${baseText} (${current}/${total})`;
    }
    // 轨迹默认折叠：执行进度不是对话主体，不默认撑开挤压内容（对齐 VS Code Chat
    // 「Completed N steps」折叠惯例 + 大厂 AI Chat「默认不展开思考」）。
    // 用户可点击 summary 展开查看三阶段进度（主动可见仍保留，仅不强制展开）。
    tb.open = false;
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
    const label =
      key === today ? `${md} · 今天` : key === yesterday ? `${md} · 昨天` : md;
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

  /** 调度归档停滞兜底：超时后折叠思考块并停止呼吸（与 setStatus('done') 同构） */
  function scheduleArchivingFallback(): void {
    clearArchivingFallback();
    archivingFallbackTimer = setTimeout(() => {
      archivingFallbackTimer = undefined;
      if (thoughtEl && thoughtEl.isConnected) {
        thoughtEl.classList.remove('is-thinking');
        thoughtEl.open = false;
      }
    }, ARCHIVING_STALL_MS);
  }

  // 切换 LLM 运行状态：thinking → 发送按钮切换为「停止」方块（loading 类驱动图标切换），
  // 输入框保持可用（支持插话）；done 恢复发送按钮；paused 切换为「继续」按钮。
  // SSOT 收敛：身份条已删，生成中状态由思考折叠块（过程可见）+ 发送按钮（可操作）承载。
  function setStatus(state: 'thinking' | 'done' | 'paused'): void {
    if (state === 'thinking') {
      // 生成中：展示「思考中…」折叠块（过程透明，ui-redesign.md §7.1）
      setThoughtLabel('思考中…', { thinking: true });
    } else if (state === 'paused') {
      // 暂停中：折叠思考块并提示已暂停（可通过「继续」按钮恢复）
      clearArchivingFallback();
      if (thoughtEl && thoughtEl.isConnected) {
        thoughtEl.classList.remove('is-thinking');
        thoughtEl.open = false;
      }
    } else {
      // 结束：折叠思考块并停止呼吸（保留折叠态，不落库不重放）
      clearArchivingFallback();
      if (thoughtEl && thoughtEl.isConnected) {
        thoughtEl.classList.remove('is-thinking');
        thoughtEl.open = false;
      }
    }
    if (state === 'thinking') {
      send.classList.add('loading');
      send.classList.remove('paused');
      send.setAttribute('title', '停止生成');
      send.setAttribute('aria-label', '停止生成');
      // Gap A：生成中暴露「暂停」软控制，与「停止」并列（暂停落检查点可恢复，停止丢弃）
      if (pauseBtn) pauseBtn.hidden = false;
      // 生成中不禁用输入框：用户可输入新消息 → Enter 插话（不打断当前生成）。
      // 发送按钮此时承担「停止」职责，插话走 Enter 发送。
    } else if (state === 'paused') {
      // 暂停中：按钮切为「继续」语义（▶ 图标）——用户点击即 post resume 消息恢复执行
      send.classList.remove('loading');
      send.classList.add('paused');
      send.setAttribute('title', '继续生成');
      send.setAttribute('aria-label', '继续生成');
      if (pauseBtn) pauseBtn.hidden = true; // 已暂停，收回暂停入口
    } else {
      send.classList.remove('loading');
      send.classList.remove('paused');
      send.setAttribute('title', '发送 (Enter)');
      send.setAttribute('aria-label', '发送');
      if (pauseBtn) pauseBtn.hidden = true;
      // 输入框全程不禁用，无需恢复；仅当用户焦点已回落到 body（如刚完成其他操作）
      // 时才恢复输入焦点，避免 done 时强制 focus 打断用户正在进行的操作（对抗评估 P1-4）
      if (document.activeElement === document.body) input.focus();
    }
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
   * 无角色名时隐藏徽章（保持输入区干净）；textContent 赋值防注入。
   */
  function updateRoleBadge(): void {
    if (!roleBadge) return;
    if (!currentRoleName) {
      roleBadge.hidden = true;
      return;
    }
    roleBadge.hidden = false;
    roleBadge.textContent = currentRoleName;
  }

  /**
   * Phase 4 E2：更新工具权限徽章（角色能力面可见性）
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
   * P3（2026-08-15 空状态角色化）：空状态标题/提示随激活角色包动态生成
   *
   * 原空状态文案硬编码「开始打磨你的设计文档」（doc-review 定位），切换角色包后错位。
   * 改为标题用角色显示名、提示用角色定位描述（manifest.description，可选），随角色生长。
   * 示例提问 chips 由 renderEmptySuggestions 随 showcase 角色动态渲染（MVP 2026-08-16）。
   */
  function updateEmptyStateRole(): void {
    const name = currentRoleName || 'AI';
    emptyTitle.textContent = '开始与 ' + name + ' 对话';
    // 角色定位描述优先；无描述时回退默认引导文案（textContent 赋值防注入）
    const activePack = currentRolePacks.find((p) => p.displayName === currentRoleName);
    emptyHint.textContent =
      activePack?.description || '在下方输入你的想法，或点击示例提问快速开始';
    // 示例提问随 showcase 角色特化（方案设计师展示"种子收敛"引导，其余回退通用）
    renderEmptySuggestions(name);
  }

  /** 空状态示例提问 Chips：随激活角色动态渲染（SSOT，事件委托兼容动态元素）。
   *
   * 命中 ROLE_SUGGESTION_SETS 的角色展示专属示例（showcase，如方案设计师的"种子收敛"引导，
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
   * 渲染 Follow-up 建议（2026-08-17，T2：回复后关联推荐）
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
  // 此处统一以 messages 为滚动容器，与 toolCard 共用同一 helper（SSOT 剪枝去重）。
  // 原局部 scrollToBottom + scrollRafPending 已收敛到 helpers。

  // ─── 下拉选择器渲染工厂（SSOT，剪枝收敛） ───
  // 原 renderModelPicker / renderRolePicker 是两套几乎相同的「清空菜单 → 遍历建项 →
  // 更新触发器」实现；角色选择器已独立到「角色」视图（2026-08-17），此处收敛为单一渲染器：
  // picker 通过 { menu, trigger, items, activeName, 文案 } 配置声明差异（对齐 §四.2 声明式工厂）。

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
    // P0-1 防注入：名称来自用户配置/角色包，禁止 innerHTML 拼接，一律 createElement + textContent
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
  // 返回创建的 .msg 元素，供调用方作为流式锚点（排雷 P0-1）。
  // 跨天合并时先插入日期分隔线（ui-redesign.md §4.1 ②）；AI 消息带头像身份。
  function append(role: 'user' | 'assistant' | 'error', text: string, ts?: string): HTMLElement {
    // 日期分隔线：仅日期交界插入，先于本条消息（textContent 构建防注入）
    renderDateDivider(ts);
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'assistant') {
      // AI 消息：复用骨架构建（label + content + body + footer），
      // 一次性消息（历史回放）直接渲染 Markdown（吸收养分，代码块/列表/表格可读）
      const { body } = buildAssistantShell(div, ts);
      // 原始文本存于 .msg 的 dataset（流式/历史共用，复制按钮据此复制完整原始 Markdown 源）
      div.dataset.rawText = text;
      body.innerHTML = renderMarkdown(text);
      // 历史回放同样做代码块增强（语言标签 + 复制按钮）
      enhanceCodeBlocks(body);
    } else {
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = text;
      div.appendChild(body);
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      // 用户消息复制按钮：复制历史消息文本
      if (role === 'user') {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'msg-copy';
        copyBtn.textContent = '复制';
        copyBtn.title = '复制消息';
        copyBtn.addEventListener('click', () => copyText(text));
        footer.appendChild(copyBtn);
      }
      const t = fmtTime(ts);
      if (t) {
        const timeEl = document.createElement('span');
        timeEl.className = 'msg-time';
        timeEl.textContent = t;
        footer.appendChild(timeEl);
      }
      div.appendChild(footer);
    }
    // 流式锚点跟随最新 assistant 消息（SSOT：单一锚点，append/chunk 共用）
    if (role === 'assistant') activeAssistantEl = div;
    messages.appendChild(div);
    scrollToBottom(messages);
    updateEmptyState();
    return div;
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
   * @returns body 元素（供调用方填充内容）
   */
  function buildAssistantShell(div: HTMLElement, ts?: string): { body: HTMLElement } {
    // 顶部身份标签（角色/模型名）：展示加载角色包的显示名（currentRoleName），未加载时默认「AI」
    const label = document.createElement('div');
    label.className = 'msg-ai-label';
    const labelText = document.createElement('span');
    labelText.className = 'msg-ai-label__name';
    labelText.textContent = currentRoleName || 'AI';
    label.appendChild(labelText);
    div.appendChild(label);
    const content = document.createElement('div');
    content.className = 'msg-content';
    const body = document.createElement('div');
    body.className = 'msg-body';
    content.appendChild(body);
    const footer = document.createElement('div');
    footer.className = 'msg-footer';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制消息';
    // 复制按钮读取 .msg.dataset.rawText（原始 Markdown 源）；流式结束更新后即复制完整文本
    copyBtn.addEventListener('click', () => copyText(div.dataset.rawText ?? ''));
    footer.appendChild(copyBtn);
    // 删除按钮（2026-08-16 对话闭环管理）：AI 消息承载「删除问答闭环」入口——删了答也删问。
    // 携带该条 AI 消息的 timestamp 作锚点，host 端确认后 truncate-from-turn（删该问答及之后所有）。
    // 无 ts（如流式未完成即被清空）时禁用，避免删除锚点失效。
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'msg-delete';
    deleteBtn.textContent = '删除';
    deleteBtn.title = '删除该问答及之后所有对话';
    deleteBtn.disabled = !ts;
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
    content.appendChild(footer);
    div.appendChild(content);
    // 记录消息 timestamp 供删除锚点（dataset.ts 供删除按钮读取）
    div.dataset.ts = ts ?? '';
    return { body };
  }

  /**
   * 开始一轮流式：创建新的 assistant 消息（纯文本 body + 光标 ▋），并置流式状态
   *
   * 首个 chunk 到达时调用（streamingActive 为 false 时）。流式期间按 markdown 增量
   * 渲染（节流）+ 末尾闪烁光标；流结束后由 finalizeStreaming 收敛（去光标 + 代码块增强）。
   *
   * @param ts 本轮流式第一条 chunk 的时间戳
   */
  function beginStreaming(ts?: string): void {
    renderDateDivider(ts);
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const { body } = buildAssistantShell(div, ts);
    // 流式期间：is-streaming 类驱动 CSS ::after 闪烁光标（markdown 由增量渲染填充）
    body.classList.add('is-streaming');
    activeAssistantEl = div;
    streamBodyRendered = false;
    messages.appendChild(div);
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

  /** 把当前累积的流式原文渲染为 Markdown（写 body.innerHTML，消毒后安全） */
  function renderStreamBody(): void {
    if (!streamingActive || !activeAssistantEl || !activeAssistantEl.isConnected) return;
    const body = activeAssistantEl.querySelector(':scope .msg-body') as HTMLElement | null;
    if (!body) return;
    body.innerHTML = renderMarkdown(streamingRaw);
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
    if (!streamingActive || !activeAssistantEl || activeAssistantEl.isConnected === false) return;
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
    }
    const body = activeAssistantEl.querySelector(':scope .msg-body') as HTMLElement | null;
    if (body) {
      body.classList.remove('is-streaming');
      body.innerHTML = renderMarkdown(streamingRaw);
      // 最终渲染后做代码块增强（语言标签 + 复制按钮）
      enhanceCodeBlocks(body);
    }
    // 复制源更新为完整原始文本（.msg.dataset.rawText 供复制按钮读取）
    activeAssistantEl.dataset.rawText = streamingRaw;
    streamingActive = false;
    streamingRaw = '';
    streamBodyRendered = false;
  }

  // 自审查轮过程性提示：内核在自审查开始前 emit selfReview（交叉审核观察 A），
  // 渲染进「思考折叠块」让用户看见 Agent 正在复核产出（ui-redesign.md §7.1）。
  // 仅运行时显示，不持久化、不重放；结束后保留折叠态（setStatus done 收敛）。
  function appendSelfReview(round: number): void {
    setThoughtLabel(`思考过程 · ${round} 步`, {
      thinking: true,
      open: true, // 自审查时展开显示步骤
      body: `自审查轮 ${round}：正在复核本轮产出…`,
    });
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
    // 详情折叠区有内容即显示（含指标）；无历史但仅有指标时也显示
    activityDetail.hidden =
      activityHistory.length === 0 && activityMetrics.hidden && recallDetail.hidden;
  }

  /** Phase 1（2026-08-17 召回可展开）：渲染活动详情「本次召回」明细区
   *
   * 主状态条「已召回 N 条」仅即时反馈，具体来源进活动详情折叠区（不占主条、
   * 不打断 P0 错误保护）；每条展示 name + source + score。空数组隐藏明细区
   * （新轮 recalled 清空上轮，避免跨轮残留）。
   */
  function renderRecallDetail(items: MemoryRecallItemDto[]): void {
    recallDetail.textContent = '';
    recallDetail.hidden = items.length === 0;
    if (items.length === 0) {
      renderActivityDetail();
      return;
    }
    const title = document.createElement('div');
    title.className = 'recall-detail__title';
    title.textContent = '本次召回 ' + items.length + ' 条';
    recallDetail.appendChild(title);
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'recall-detail__row';
      const name = document.createElement('span');
      name.className = 'recall-detail__name';
      name.textContent = it.name || it.id;
      const meta = document.createElement('span');
      meta.className = 'recall-detail__meta';
      meta.textContent = it.source + ' · ' + Math.round(it.score * 100) + '%';
      row.appendChild(name);
      row.appendChild(meta);
      recallDetail.appendChild(row);
    }
    renderActivityDetail();
  }

  /**
   * 显示主状态条（P0 错误 / P1 低扰）
   *
   * 优先级：P0 显示期间 P1 不覆盖（错误优先保护，P1 仅记历史）；新 P0 覆盖旧 P0。
   * 停留时长按档位分级——error 醒目停留更久，info 低扰短暂（对齐排雷雷-4 语义分离）。
   *
   * A2（2026-08-24）：支持可选 action 按钮——当宿主标记错误为「可重试」时，
   * action.label 显示按钮文案，action.onClick 绑定重试回调。当前宿主暂未接入，
   * 框架先行就绪，保持 backward compatible：不传 action 时行为与原实现完全一致。
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
    activityTimer = window.setTimeout(() => {
      activityBar.hidden = true;
      delete activityBar.dataset.level;
    }, level === 'error' ? 8000 : 2500);
  }

  /**
   * 渲染活动指标详情（P2：§13.x 透明面板 + §5.2.1 指纹可见）
   *
   * 指纹（系统提示 hash 前 12 位 + 附着记忆条数）+ 累计指标（LLM / 召回命中率 /
   * 工具失败 / 截断）。textContent 赋值防注入；指标只进详情折叠区，不占用主状态条。
   */
  function renderMetrics(msg: Extract<ExtensionToWebviewMessage, { type: 'metrics' }>): void {
    const fp = msg.fingerprints;
    // P1（2026-08-15 记忆附着可见）：缓存本轮附着记忆数，供 AI 回复底部「基于 N 条记忆」弱标签
    if (typeof fp.attachedMemoryCount === 'number') {
      lastAttachedMemoryCount = fp.attachedMemoryCount;
    }
    const lines = [
      // 指纹行：只显示 hash 与计数，不显示内容（可追溯性边界）
      '本轮指纹：' +
        (fp.systemPromptHash ? '系统提示 ' + fp.systemPromptHash : '系统提示 -') +
        (typeof fp.attachedMemoryCount === 'number' ? ' · 附着记忆 ' + fp.attachedMemoryCount + ' 条' : ''),
      // 累计指标行
      '累计：LLM ' + msg.metrics.llmCallCount + ' 次 · 召回命中 ' +
        Math.round(msg.metrics.recallHitRate * 100) + '% · 工具失败 ' +
        msg.metrics.toolFailureCount + ' · 截断 ' + msg.metrics.truncationCount,
      // D（alignment-iteration.md）：token 用量 + 记忆衰减（可选字段，缺省不显示）
      'Tokens：' +
        (typeof msg.metrics.llmTokenIn === 'number' ? '入 ' + msg.metrics.llmTokenIn : '入 -') +
        ' / ' +
        (typeof msg.metrics.llmTokenOut === 'number' ? '出 ' + msg.metrics.llmTokenOut : '出 -') +
        (typeof msg.metrics.decayRunCount === 'number'
          ? ' · 记忆衰减 ' + msg.metrics.decayRunCount + ' 次'
          : ''),
      // B9 可观测补齐：最近操作流（span 标签新→旧，指标区末尾渲染，缺省不显示）
      ...(msg.trace && msg.trace.length > 0
        ? ['操作流：', ...msg.trace.map((t) => '  › ' + t.label)]
        : []),
      // G6 安全/装配透明：路径守卫审计概要（有审计事件才显示；basename 路径）
      ...(msg.securityAudit && msg.securityAudit.total > 0
        ? [
            '安全审计 ' + msg.securityAudit.total + ' 次 · 拒绝 ' + msg.securityAudit.denied +
              (msg.securityAudit.recent.length > 0
                ? ' · 最近：' + msg.securityAudit.recent
                    .map((r) => r.type + ' ' + r.path + (r.reason ? ' (' + r.reason + ')' : ''))
                    .join(', ')
                : ''),
          ]
        : []),
    ];
    activityMetrics.textContent = lines.join('\n');
    activityMetrics.hidden = false;
    renderActivityDetail();
    // P1（2026-08-15 记忆附着可见）：本轮流式结束 → 给最后一条 AI 回复补记忆附着弱标签
    applyMemoryTag();
  }

  /**
   * P1（2026-08-15 记忆附着可见）：在最后一条 AI 回复底部补「基于 N 条记忆」弱标签
   *
   * memora 的差异化价值是记忆，但「附着记忆 N 条」此前只出现在活动详情折叠区（低可见）。
   * 每轮 metrics 到达（流式结束）后，给本轮最后一条 assistant 消息补弱标签：
   * 主动可见、不打扰（灰字小字号靠左），让用户直观感知「这条回复基于哪些记忆」。
   * footer 内已存在 memory-tag 则跳过（一轮只补一次，防 metrics 多次触发重复）。
   */
  function applyMemoryTag(): void {
    if (lastAttachedMemoryCount === undefined) return;
    // 优先定位流式锚点（本轮最后一条 AI 回复），锚点失效时回退最后一条 assistant 消息
    const target =
      activeAssistantEl && activeAssistantEl.isConnected
        ? activeAssistantEl
        : (messages.querySelector('.msg.assistant:last-of-type') as HTMLElement | null);
    if (!target) return;
    const footer = target.querySelector(':scope .msg-footer') as HTMLElement | null;
    if (!footer || footer.querySelector('.memory-tag')) return;
    const tag = document.createElement('span');
    tag.className = 'memory-tag';
    tag.textContent = '基于 ' + lastAttachedMemoryCount + ' 条记忆';
    footer.prepend(tag); // 信息性标签靠左（margin-right:auto），复制/时间戳保持靠右
  }

  // 处理 extension → webview 消息（流式渲染 / 状态机 / 工具卡片 / 下拉数据）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'status') {
      setStatus(msg.state);
    } else if (msg.type === 'thinking') {
      // B（alignment-iteration.md）：思考阶段 → 更新思考折叠块文案（真实 phase，非笼统"思考中"）
      // 阶段文案映射：recalling=召回 / llm_calling=调用模型 / processing=处理 / planning=规划 /
      // step=分步执行 / reporting=收尾汇报 / archiving=归档（外循环阶段重放收敛到主标签）
      const thoughtLabels: Record<ThinkingPhase, string> = {
        recalling: '召回记忆中…',
        llm_calling: '调用模型中…',
        processing: '处理中…',
        planning: '规划中…',
        step: '分步执行中…',
        reporting: '收尾汇报中…',
        archiving: '归档记忆中…',
      };
      setThoughtLabel(thoughtLabels[msg.phase] ?? '思考中…', { thinking: true });
      // P2（2026-08-15 执行轨迹）：同步渲染三阶段执行轨迹（✓/●/○），执行过程可见
      renderTrace(msg.phase);
      // 归档停滞兜底：archiving 激活即调度超时折叠；其他 phase（新轮次/回溯）清除定时器
      if (msg.phase === 'archiving') scheduleArchivingFallback();
      else clearArchivingFallback();
    } else if (msg.type === 'user') {
      // 无缝插话（缺口 B）：生成中收到用户补充 → 结束当前流式助手块（复位锚点与流式态），
      // 使后续 chunk 经 beginStreaming 开新助手块、置于本用户消息之后，保证消息排序正确。
      if (streamingActive) {
        streamingActive = false;
        activeAssistantEl = null;
        streamingRaw = '';
      }
      append('user', msg.text, msg.ts);
    } else if (msg.type === 'assistant') {
      append('assistant', msg.text, msg.ts);
    } else if (msg.type === 'chunk') {
      // 流式追加：目标 = 活动 assistant 锚点（SSOT，排雷 P0-1），而非 messages 最后一个元素。
      // 工具卡片等节点插入不改变锚点，保证同一条回复不被拆成多段。
      // guardrailBlocked 标记：护栏阻断文案已由内核 content 承载（[输入/输出被护栏阻断：rule]），
      // 此处不再弹硬编码 banner——避免双份提示 + 输入/输出语义错位（排雷 2026-08-17）。
      // 字段仍随 chunk 透传，供未来结构化消费（eval / 日志）。
      // 首个 chunk：开始一轮新流式（beginStreaming 创建新消息 + 置 streamingActive），
      // 避免追加到上一条历史 AI 消息（activeAssistantEl 可能仍指向旧锚点）
      if (!streamingActive) {
        beginStreaming(msg.ts);
        streamingActive = true;
        streamingRaw = '';
      }
      const target = activeAssistantEl ? activeAssistantEl.querySelector(':scope .msg-body') : null;
      if (target) {
        streamingRaw += msg.content;
        // 流式增量渲染：首个 chunk 立即渲染（TTFT 即时反馈），后续 150ms 节流重渲染。
        // 相比旧的「纯文本节点追加 + 结束一次性渲染」，用户实时看到 markdown 成形
        // （列表/代码块不再显示 **、``` 原始记号），对齐 TraeWork 对话流。
        if (!streamBodyRendered) renderStreamBody();
        else scheduleStreamRender();
      }
      scrollToBottom(messages);
    } else if (msg.type === 'handoff') {
      // 衔接决策：仅 loop 渲染「自动续跑」提示条（wait/end 静默；雷-4 低频）
      showActivity('info', 'Agent 将自动续跑…');
    } else if (msg.type === 'retry') {
      // LLM 失败重试 → 低扰提示条（活动透明，对齐 UX 基线）
      showActivity('info', `LLM 调用重试 ${msg.attempt}/${msg.maxRetries}…`);
    } else if (msg.type === 'paused') {
      // Agent 暂停（输入待定/迭代边界软暂停）→ 提示条
      showActivity('info', 'Agent 已暂停');
    } else if (msg.type === 'checkpoint_available') {
      // G3 断点续跑：检测到持久化暂停检查点，展示「从断点续跑」提示条
      showRestoreBanner('检测到上次暂停的会话，可继续', true);
    } else if (msg.type === 'checkpoint_result') {
      // G3 断点续跑结果：ok 移除提示条（host 已重放历史）；失败展示错误（保留关闭按钮）
      if (msg.ok) {
        removeRestoreBanner();
      } else {
        showRestoreBanner(msg.message ?? '断点恢复失败', false);
      }
    } else if (msg.type === 'capability_badge') {
      // Phase 4 E2：角色能力徽章 → 更新工具权限展示
      updateCapabilityBadge(msg.toolMode, msg.capabilities);
    } else if (msg.type === 'loop_count') {
      // Phase 4 E1：自动续跑计数 → 提示条显示当前轮次
      showActivity('info', `Agent 自动续跑 ${msg.current}/${msg.max}`);
    } else if (msg.type === 'metrics') {
      // 活动指标（P2：§13.x 透明面板 + §5.2.1 指纹可见）：每轮结束后刷新详情折叠区
      renderMetrics(msg);
    } else if (msg.type === 'error') {
      append('error', msg.message);
    } else if (msg.type === 'done') {
      // 本轮流式结束：清除归档停滞兜底定时器 + 兜底终结所有残留「执行中」工具卡片，
      // 避免 tool_start 后流异常/中断时卡片永远停在 spinner（对抗评估 P1-1）。
      clearArchivingFallback();
      // error 后必跟 done，此处统一收敛；切换日期清空消息区后无 is-running 卡片，调用幂等无副作用。
      ToolCard.settleRunning(messages, '已中断');
      // 流式收尾：一次性渲染 Markdown + 移除光标（吸收养分，结束前保持纯文本+光标）
      finalizeStreaming();
    } else if (msg.type === 'interrupted') {
      // 用户主动停止（mvp-scope 打断能力）：清除归档兜底定时器 + 兜底终结残留
      // 「执行中」工具卡片 + 低扰提示「已停止生成」，区分于正常 done。
      clearArchivingFallback();
      // 兜底终结残留「执行中」工具卡片（P1-1）+ 流式收尾（取消 ≠ 丢弃，保留已生成内容）
      ToolCard.settleRunning(messages, '已中断');
      finalizeStreaming();
      showActivity('info', '已停止生成');
    } else if (msg.type === 'suggestions') {
      // T2 Follow-up 建议：回复结束后「下一步可探索」chips（点击填入输入框并聚焦）
      renderFollowUpSuggestions(msg.items);
    } else if (msg.type === 'prefill_input') {
      // 角色 handoff 上下文传递：填入输入框并聚焦，不自动发送（用户可编辑后回车）
      input.value = msg.text;
      input.style.height = 'auto';
      input.focus();
      autoResize();
    } else if (msg.type === 'need_clarify') {
      clarifyText.textContent =
        'Agent 需要你确认：' + msg.questions.map((q) => q.question).join('；');
      clarifyInput.value = '';
      clarifyOptions.textContent = '';
      msg.questions.forEach((q) => {
        (q.options || []).forEach((opt) => {
          const b = document.createElement('button');
          b.className = 'opt-btn';
          b.textContent = opt;
          b.addEventListener('click', () => {
            clarifyInput.value = opt;
            clarifyInput.focus();
          });
          clarifyOptions.appendChild(b);
        });
      });
      clarifyBar.classList.add('visible');
      inputBar.hidden = true;
      clarifyInput.focus();
    } else if (msg.type === 'memory') {
      if (msg.action === 'recalled') {
        // 新轮召回开始：清空上轮明细并隐藏（避免跨轮残留），再给即时反馈
        renderRecallDetail([]);
        showActivity('info', '已召回 ' + msg.count + ' 条记忆');
      } else if (msg.action === 'recalled_items') {
        // Phase 1（2026-08-17 召回可展开）：明细到达 → 渲染活动详情「本次召回」区
        renderRecallDetail(msg.items);
      } else if (msg.action === 'added') {
        // 利用协议已携带的 detail.name 展示具体沉淀项（对抗评估 P2-6），
        // 避免数据跨进程传输后在 UI 层被丢弃；无 name 时回退通用文案
        showActivity('info', '已沉淀：' + (msg.detail?.name || '1 条记忆'));
      }
    } else if (msg.type === 'tool_start') {
      ToolCard.show(messages, msg.toolCallId, msg.name, msg.args);
    } else if (msg.type === 'tool_result') {
      ToolCard.update(messages, msg.toolCallId, msg.name, msg.ok, msg.summary);
    } else if (msg.type === 'plan_update') {
      // H4 任务驱动多步闭环：LLM 更新任务表 → 刷新任务看板（renderPlanBoard 自建/更新容器）
      renderPlanBoard(msg.steps);
    } else if (msg.type === 'polish_result') {
      // H5 文本润色结果：ok=true 替换消息内容；ok=false 提示失败
      const msgEl = messages.querySelector(`.msg[data-msg-id="${msg.msgId}"]`) as HTMLElement | null;
      if (msgEl) {
        msgEl.classList.remove('polishing');
        const body = msgEl.querySelector(':scope .msg-body');
        if (body && msg.ok && msg.text) {
          body.textContent = msg.text;
          (msgEl as HTMLElement).dataset.rawText = msg.text;
        }
      }
      if (!msg.ok && msg.message) {
        showActivity('info', `润色失败：${msg.message}`);
      }
    } else if (msg.type === 'polish_input_result') {
      // 输入框润色结果：ok=true 替换输入框内容；ok=false 提示失败
      if (msg.ok && msg.text) {
        input.value = msg.text;
        autoResize();
      }
      // 恢复润色按钮状态（图标按钮，无需恢复文本）
      if (polishBtn) {
        polishBtn.classList.remove('loading');
      }
      if (!msg.ok && msg.message) {
        showActivity('info', `润色失败：${msg.message}`);
      }
    } else if (msg.type === 'self_review') {
      appendSelfReview(msg.round);
    } else if (msg.type === 'clear_ok') {
      // 清空消息区须同时清 type=msg 消息、.tool-card 工具卡片、.self-review 自审查提示、
      // .thought-block 思考折叠块、.date-divider 日期分隔线与 .followup 建议块
      // （对抗评估 P1-1/P1-4）：不仅挑 .msg 会让切换历史/清空后旧过程性节点残留 DOM，污染重放视图。
      // 不替换 messages 全部子节点（保留 #emptyState 占位）。
      messages.querySelectorAll('.msg, .tool-card, .self-review, .thought-block, .date-divider, .followup').forEach((el) => el.remove());
      // G3：清空/切换会话时移除断点续跑提示条（避免切换到非断点会话后残留）
      removeRestoreBanner();
      // H4：清空/切换会话时移除任务看板（避免旧计划残留污染新会话）
      removePlanBoard();
      // 流式锚点失效：清空/重放后由下次 append 重建（排雷 P0-1）
      activeAssistantEl = null;
      // 流式状态复位：清空后不再累积/渲染半截流（下次 chunk 会 beginStreaming 重建）
      streamingActive = false;
      streamingRaw = '';
      if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = undefined;
      }
      streamBodyRendered = false;
      // 过程性状态复位：归档兜底定时器清除 + 思考块引用失效 + 日期分隔线重新计算
      // （重放从新日期开始）
      clearArchivingFallback();
      thoughtEl = null;
      lastShownDate = undefined;
      // Phase 1：清空活动详情「本次召回」明细区（切会话/清空后不残留上轮召回来源）
      renderRecallDetail([]);
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
      // 历史会话列表（2026-08-17 会话管理重构 v2）：渲染到 treedd 历史下拉菜单
      renderHistoryMenu(msg.sessions);
    } else if (msg.type === 'chat_providers') {
      currentProviders = msg.providers || [];
      currentActive = msg.activeName;
      renderModelPicker();
      // SSOT 收敛：身份条已删，模型名由输入区 model-picker 触发器单一展示（renderModelPicker 内更新）
    } else if (msg.type === 'chat_role_pack') {
      // textContent 赋值防注入。角色名供 AI 消息头部标签 + 空状态标题 + 输入区角色徽章共用
      // （角色切换已独立到「角色」视图，2026-08-17）
      currentRoleName = msg.rolePack;
      // 输入区左侧徽章：展示当前角色（只读状态，让用户感知当前定位）
      updateRoleBadge();
      // P3（2026-08-15 空状态角色化）：角色切换 → 空状态标题/提示随角色生长（避免定位错位）
      updateEmptyStateRole();
    } else if (msg.type === 'chat_role_packs') {
      // 角色包列表（description 供空状态提示副文案）；切换入口已独立到「角色」视图（2026-08-17）
      currentRolePacks = msg.packs || [];
      // 若当前角色名未同步到列表（如 displayName 未收录），回退为激活角色的显示名
      if (!currentRoleName && msg.activeName) {
        const activePack = currentRolePacks.find((p) => p.name === msg.activeName);
        if (activePack) currentRoleName = activePack.displayName;
      }
      // 回退补齐后同步徽章（chat_role_packs 可能先于 chat_role_pack 到达）
      updateRoleBadge();
    } else if (msg.type === 'skills_loaded') {
      // 动态技能清单（SSOT 收紧，2026-08-25）：与设置面板同一来源，重建下拉列表
      skillOptions = msg.skills.map((s) => ({ name: s.name }));
      if (skillPickerMenu) {
        skillPickerMenu.innerHTML = '';
        const clearItem = document.createElement('div');
        clearItem.className = 'treedd__item';
        clearItem.textContent = '不使用 Skill';
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
          skillPickerMenu.appendChild(item);
        }
      }
      updateSkillPickerLabel();
    } else if (msg.type === 'notice') {
      showActivity(msg.level, msg.message);
    } else if (msg.type === 'goal_drift_detected') {
      // 目标漂移检测：展示原目标 vs 新目标 + 相似度，供用户确认或忽略
      const pct = Math.round(msg.similarity * 100);
      const levelLabel = msg.level === 'drift' ? '严重偏离' : '需要确认';
      showActivity('info', `目标漂移（${levelLabel}，相似度 ${pct}%）：${msg.newGoal}`);
    }
  });

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
    // 暂停态且输入为空 → 视为「继续」动作，恢复暂停点之后的执行（用户未输入新请求）
    const isPaused = send.getAttribute('title') === '继续生成';
    if (isPaused && !text) {
      vscode.postMessage({ type: 'resume' });
      return;
    }
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    input.style.overflowY = 'hidden';
    // 构建消息：选中技能传技能名（SSOT 收紧，host 按名走内核 buildSystemPrompt，取消前端硬编码提示）
    const payload: WebviewToExtensionMessage = { type: 'send' as const, text };
    if (currentSkill) {
      (payload as { skillName?: string }).skillName = currentSkill.name;
    }
    vscode.postMessage(payload);
  }
  // 发送按钮：空闲点击 = 发送；生成中点击 = 停止（按钮已切换为停止方块，
  // mvp-scope 打断能力）；暂停中点击 = 继续（恢复 Agent 执行，Phase 4 暂停/恢复）。
  // 生成中插话走 Enter（见下方 keydown，不经此分支）。
  send.addEventListener('click', () => {
    if (send.classList.contains('loading')) {
      // thinking 态：按钮承担「停止」职责
      vscode.postMessage({ type: 'stop' });
    } else if (send.getAttribute('title') === '继续生成') {
      // paused 态：按钮承担「继续」职责，恢复暂停点之后的执行
      vscode.postMessage({ type: 'resume' });
    } else {
      sendMessage();
    }
  });
  // 暂停按钮（Gap A）：仅生成中可见，点击发 pause 消息——host 调 agent.pause() 软暂停
  // 当前流（落检查点、可经「继续」恢复），区别于「停止」的丢弃语义。
  pauseBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'pause' });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', autoResize);

  // ─── 会话管理（2026-08-17 会话管理重构 v2，标题条收敛全部入口）───
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
  function renderHistoryMenu(sessions: { sessionId: string; title: string; updatedAt: string }[]): void {
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
      delBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻断冒泡到 menu 的选择委托，仅触发删除（菜单保持展开可连续删）
        vscode.postMessage({ type: 'delete_session', sessionId: s.sessionId });
      });
      item.append(titleEl, timeEl, delBtn);
      historyMenu.appendChild(item);
    }
  }
  // 标题条按钮：改名笔 / 分叉 / 新建「＋」
  renameSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'rename_request' }));
  const forkSessionBtn = document.getElementById('forkSessionBtn') as HTMLButtonElement;
  forkSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'fork_session' }));
  newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'new_session' }));
  // 历史按钮：开合由 treedd 管理（initDropdowns），本层只负责「打开时请求最新列表」——
  // 二者协作不耦合（SSOT 单一职责：treedd 管交互状态、本层管数据）
  historyBtn.addEventListener('click', () => vscode.postMessage({ type: 'session_list' }));

  // 空状态示例提问 chips：点击填入输入框并聚焦（ui-redesign.md §6.1 空状态引导）。
  // 事件委托于 document，兼容 renderEmptySuggestions 动态渲染的 chips（角色切换后新增元素）。
  document.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.suggestion-chip');
    if (!chip) return;
    const prompt = chip.dataset.prompt || '';
    input.value = prompt;
    input.style.height = 'auto';
    input.focus();
    autoResize();
  });

  // 下拉菜单：显式回调映射替代原 window.__xxx 全局函数名（去全局污染）
  // 键名与 buildDropdownHtml 的 data-on-select 属性值一一对应。
  // toolbar 剪枝后为模型选择器（角色切换独立到「角色」视图，2026-08-17）
  initDropdowns(document, {
    __modelPickerOnSelect: (id) => vscode.postMessage({ type: 'chat_set_provider', name: id }),
    // 历史下拉：条目（.treedd__item）点击 → 加载该会话（host 切入并回放，SSOT 剪枝 v2）
    __historyOnSelect: (id) => vscode.postMessage({ type: 'switch_session', sessionId: id }),
    // Skill 下拉：选择真实技能名后设为当前 skill（SSOT 收紧，与设置面板同一清单；发送时传技能名走内核）
    __skillPickerOnSelect: (id) => {
      const found = skillOptions.some((s) => s.name === id);
      if (found) {
        currentSkill = { name: id };
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
        // 无 Skill 时高亮「不使用 Skill」（__clear_skill），选中时高亮对应项
        const on = currentSkill ? it.dataset.treeddId === currentSkill.name : it.dataset.treeddId === '__clear_skill';
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
    const icon = document.createElement('span');
    icon.className = 'skill-chip__icon';
    icon.textContent = '⚡';
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = currentSkill.name;
    chip.appendChild(name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.textContent = '×';
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

  /** 动态技能清单（SSOT 收紧，2026-08-25）：不再硬编码预设，由 host 推 skills_loaded 填充，与设置面板同一来源 */
  let skillOptions: { name: string }[] = [];
  // 初始化 Skill 选择器选项：先放「不使用 Skill + 分隔线」，具体清单由 skills_loaded 动态填充
  if (skillPickerMenu) {
    skillPickerMenu.innerHTML = '';
    const clearItem = document.createElement('div');
    clearItem.className = 'treedd__item';
    clearItem.textContent = '不使用 Skill';
    clearItem.dataset.treeddId = '__clear_skill';
    skillPickerMenu.appendChild(clearItem);
    const divider = document.createElement('div');
    divider.className = 'treedd__divider';
    skillPickerMenu.appendChild(divider);
    updateSkillPickerLabel();
  }

  // 主动提问回答：提交并续跑
  function sendClarifyAnswer(): void {
    const text = clarifyInput.value.trim();
    if (!text) return;
    clarifyInput.value = '';
    clarifyBar.classList.remove('visible');
    inputBar.hidden = false;
    vscode.postMessage({ type: 'clarify_answer', text });
  }
  clarifySend.addEventListener('click', sendClarifyAnswer);
  clarifyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendClarifyAnswer();
  });

  // 首屏刷新
  updateEmptyState();
  updateRoleBadge(); // 输入区角色徽章（首屏可能有历史推送的角色名）
  updateEmptyStateRole(); // P3：空状态文案随当前角色生长（首屏可能已有角色推送）
  renderModelPicker();

  // 通知 extension：脚本已就绪、监听器已注册，可安全回放会话
  // （消除折叠/展开重建 HTML 时，消息在监听器注册前到达而被丢弃的竞态）
  vscode.postMessage({ type: 'ready' });
}
