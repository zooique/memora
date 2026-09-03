/**
 * chatView — 对话面板 webview 运行时脚本（阶段 B P2-1）
 *
 * 由 chatPanel.ts 的 buildHtml 内联 <script> 迁移而来：以工厂函数 createChatView
 * 接收依赖（acquireVsCodeApi / window）并初始化全部交互，替代原「字符串注入脚本」。
 * 消除全局污染（window.__xxx 全局回调 → 模块 import + 显式回调映射），
 * 同时具备可测性（依赖注入，可传入 mock window/jsdom）。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/chatView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src 'self'）。
 */
import type {
  ExtensionToWebviewMessage,
  PlanStepDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
// ProcessThinkingPhase 纯类型导入，仅编译期用（esbuild 剥离，不影响 bundle）
import type { ProcessEvent, ProcessThinkingPhase } from '@zooique/memora';
import { fmtTime } from '../helpers/fmtTime.js';
import { fmtTokens, fmtCompactTokens } from '../helpers/fmtTokens.js';
import { forceScrollToBottom, scrollToBottom, trackScroll } from '../helpers/scrollToBottom.js';
import { renderMarkdown } from '../helpers/renderMarkdown.js';
import { initDropdowns } from '../components/dropdown.js';
import { createIcon, getIconSvg, populateIcons } from './icons.js';

/** 任务步骤状态 → 中文标签（状态枚举固定，缺一即编译报错，无需运行时兜底） */
const STEP_STATUS_LABEL: Record<PlanStepDto['status'], string> = {
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

  // 统一图标填充：将 HTML 中 data-icon 属性的元素替换为 Trae 风格 SVG 图标
  populateIcons(document.body);

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
  const inputBar = document.getElementById('inputBar') as HTMLElement;
  const clarifyBar = document.getElementById('clarifyBar') as HTMLElement;
  const clarifyText = document.getElementById('clarifyText') as HTMLElement;
  const clarifyOptions = document.getElementById('clarifyOptions') as HTMLElement;
  const clarifyInput = document.getElementById('clarifyInput') as HTMLInputElement;
  const clarifySend = document.getElementById('clarifySend') as HTMLButtonElement;
  // 当前角色显示名（AI 消息头部标签 + 空状态标题共用；由 chat_role_pack 填充）
  let currentRoleName = '';
  // 当前模型名（AI 消息头部标签显示；由模型选择变化时更新）
  let currentModelName = '';
  // 当前角色性格特征（traits，可选；由 chat_role_pack 填充，供徽章/顶栏展示）
  let currentRoleTraits: Record<string, number> | undefined;
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

  /** 渲染/刷新任务看板（收到 plan_update 消息时调用） */
  function renderPlanBoard(steps: PlanStepDto[]): void {
    if (steps.length === 0) {
      removePlanBoard();
      return;
    }
    if (!planBoard) {
      planBoard = document.createElement('div');
      planBoard.className = 'plan-board';
      planBoard.setAttribute('role', 'region');
      planBoard.setAttribute('aria-label', '任务进度');
      // 插到消息区顶部状态栈（协议：任务看板恒在检查点横幅之下），与历史重放/新轮计划同步可见
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
      // 任务节点折叠：每步一个 details，summary = 序号+描述+状态徽标；展开后展示该步骤已完成的
      // 执行闭环摘要（stepRounds，来自 checkpoint.roundLog 关联）
      const item = document.createElement('details');
      item.className = `plan-step plan-step-${step.status}`;
      item.open = false;
      const summary = document.createElement('summary');
      summary.className = 'plan-step-summary';
      const label = document.createElement('span');
      label.className = 'plan-step-title';
      // 步骤序号（order+1 展示为 1 起）+ 描述；textContent 防注入
      label.textContent = `${step.order + 1}. ${step.description}`;
      summary.appendChild(label);
      const badge = document.createElement('span');
      badge.className = 'plan-step-badge';
      badge.textContent = STEP_STATUS_LABEL[step.status];
      summary.appendChild(badge);
      item.appendChild(summary);
      const rounds = step.stepRounds;
      if (rounds.length > 0) {
        const body = document.createElement('div');
        body.className = 'plan-step-rounds';
        for (const r of rounds) {
          const row = document.createElement('div');
          row.className = 'plan-step-round';
          row.textContent = r.summary;
          body.appendChild(row);
        }
        item.appendChild(body);
      }
      ul.appendChild(item);
    }
    planBoard.appendChild(ul);
  }
  // 当前角色包列表（由 chat_role_packs 消息填充；description 供空状态提示副文案）。
  // 角色切换已独立到「角色」视图（2026-08-17），本面板仅消费角色名用于展示，不再承载切换。
  let currentRolePacks: { name: string; displayName: string; description?: string }[] = [];
  // P1（2026-08-15 记忆附着可见）：最近一轮结束时的附着记忆条数（metrics.fingerprints 提供）。
  // 流式结束后给 AI 回复补「基于 N 条记忆」弱标签，让记忆附着主动可见（memora 差异化价值）。
  let lastAttachedMemoryCount: number | undefined;

  // ─── 过程事件（ProcessEvent）渲染（v1.5 单形态）──────────────
  // 渲染真理源 = 当前轮 events[]（currentEvents）：运行时 process_event 增量与重放
  // replay_events 整批都汇入同一数组，由 renderRoundBlock 统一渲染（SSOT：无第二套卡片 DOM）。
  // round-block 挂在本轮首个 assistant 块上（插话产生的后续同 roundId 块不再挂）。

  /** 本轮过程事件缓冲（渲染唯一真相源，运行时与重放同源） */
  let currentEvents: ProcessEvent[] = [];
  /** 本轮身份（meta 事件写入）：该轮 AI 消息挂的角色/模型标签（与会话级 chat_role_pack 分离） */
  let currentRoundMeta: { role: string; llm: string } | undefined;
  /** 当前轮 round-block 容器（挂在本轮首个 assistant 块；null = 正文块尚未创建） */
  let roundBlockEl: HTMLDetailsElement | null = null;
  /** round-block 已挂载的 assistant 块（重放去重判定：roundId 首次出现才挂） */
  let roundBlockHostEl: HTMLElement | null = null;
  /** 流式骨架块（TTFT 前即时反馈，吸收 Claude Code #81659 / 骨架屏最佳实践）
   *
   * meta 到达即创建「AI 回复骨架」：标签（角色·模型）+ round-block 运行状态，
   * 首 token 到达前用户即可见「谁在回答 + 正在做什么」；首个 text chunk 复用此块，
   * 不新建第二条消息（正文流入同一块）。
   */
  let flowShellEl: HTMLElement | null = null;
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

  /** thinking 阶段 → 中文标签（对齐内核 ThinkingPhase，Webview 展示面） */
  function phaseLabel(phase: ProcessThinkingPhase): string {
    const map: Record<ProcessThinkingPhase, string> = {
      recalling: '召回记忆中…',
      llm_calling: '调用模型中…',
      processing: '处理中…',
      planning: '规划中…',
      step: '分步执行中…',
      reporting: '收尾汇报中…',
      archiving: '归档记忆中…',
    };
    return map[phase] ?? '思考中…';
  }

  /**
   * 工具 → 行动叙述生成器（SSOT：任务过程文字化）
   *
   * 对齐 Trae「执行过程」的工程侧人话渲染（"调用了 X 技能 / 浏览了 N 个网页"）：
   * 由工具名 + args 关键参数确定性生成「读取文件：path」式叙述，零 LLM 成本。
   * 参数名与 src/agent/builtinTools.ts（ToolDefinition.parameters）一一对应。
   * 兜底纪律：未收录工具 / 参数缺失 / args 非 JSON 均回退原生工具名（角色包自定义工具零遗漏）；
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

  /** 工具行动叙述：命中映射且参数齐备 → 人话描述；否则回退原生工具名（未知工具零遗漏） */
  function toolActionLabel(name: string, argsRaw: string | undefined): string {
    return TOOL_ACTION_LABELS[name]?.(parseToolArgs(argsRaw)) ?? name;
  }

  /** 工具动作分型（收尾叙述句的分组依据，语义与 TOOL_ACTION_LABELS 对齐） */
  type ToolActionType = 'read' | 'search' | 'write' | 'run' | 'other';

  /** 工具名 → 动作分型（未收录归 other） */
  function toolActionType(name: string): ToolActionType {
    if (name === 'read_file' || name === 'read_skill' || name === 'read_resource' || name === 'trace_summary' || name === 'web_fetch')
      return 'read';
    if (name === 'web_search' || name === 'search_project' || name === 'search_memories' || name === 'list_dir' || name === 'list_sessions' || name === 'list_resources' || name === 'list_skills')
      return 'search';
    if (name === 'write_file' || name === 'delete_file' || name === 'register_work' || name === 'task_table_write' || name === 'task_table_update')
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

  /** 事件统计：工具（含分型）/ 记忆 / 审查（运行时与重放同一函数，SSOT 杜绝两处算法）。
   * 分型计数供收尾叙述句「执行 N 步工具（读取 x · 搜索 y）」使用 */
  function countEvents(events: ProcessEvent[]): {
    tools: number;
    reads: number;
    searches: number;
    writes: number;
    runs: number;
    others: number;
    memories: number;
    reviews: number;
  } {
    const toolTypes = events
      .filter((e) => e.type === 'tool_start')
      .map((e) => toolActionType((e as Extract<ProcessEvent, { type: 'tool_start' }>).payload.name));
    return {
      tools: toolTypes.length,
      reads: toolTypes.filter((t) => t === 'read').length,
      searches: toolTypes.filter((t) => t === 'search').length,
      writes: toolTypes.filter((t) => t === 'write').length,
      runs: toolTypes.filter((t) => t === 'run').length,
      others: toolTypes.filter((t) => t === 'other').length,
      memories: events.reduce((sum, e) => (e.type === 'recall' ? sum + e.payload.memories.length : sum), 0),
      reviews: events.filter((e) => e.type === 'self_review').length,
    };
  }

  /**
   * 创建流式骨架块（meta 到达即调用，TTFT 前即时反馈）
   *
   * 骨架 = 空正文的 assistant 块（label 已用本轮身份 currentRoundMeta）+ round-block（运行状态）。
   * 首个 text chunk 到达时由正文流复用此块，不新建第二条消息（见 chunk 分支）。
   */
  function prepareFlowShell(): void {
    // 清理异常路径可能残留的旧骨架（正常路径下 meta 每次新轮都会先清除引用）
    flowShellEl?.remove();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    // 流式未完成：footer 初始隐藏（is-pending 由 buildAssistantShell 加类），finalize 时展示
    buildAssistantShell(div, new Date().toISOString(), undefined, { pending: true });
    activeAssistantEl = div;
    streamBodyRendered = false;
    messages.appendChild(div);
    flowShellEl = div;
    // 挂载任务过程折叠区（meta 已在 currentEvents 首条）：进行中实时展开投影过程事件
    renderRoundBlock(currentEvents, false);
    scrollToBottom(messages);
    updateEmptyState();
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
    // 插入点：.msg-ai-label 之后、.msg-body（报告正文）之前
    const label = host.querySelector(':scope > .msg-ai-label');
    const msgBody = host.querySelector(':scope > .msg-body');
    if (msgBody) {
      host.insertBefore(rb, msgBody);
    } else if (label) {
      label.after(rb);
    } else {
      host.prepend(rb);
    }
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
    listEl.querySelectorAll('.round-block__row, .round-block__tool, .round-block__pre').forEach((el) => el.remove());
    const titleEl = section.querySelector('.round-block__section-title') as HTMLElement;
    const count = listEl.children.length;
    titleEl.textContent = `${title}${count > 0 ? ` (${count})` : ''}`;
    return { titleEl, listEl };
  }

  /**
   * 过程叙述父块（建议 A，2026-09-02）：LLM 一段行动叙述 = 一个可折叠父块——
   * summary 显示首行摘要（截断），展开看全文；其紧随的 tool_start/tool_result 嵌套进块内
   * .round-block__narrate-tools 子容器，实现「文字与对应调用一一顺序成对显示」，
   * 而非叙述与工具各自独立成段（旧 P2 结构）。返回父块 el 与内部工具子容器。
   */
  function createNarrateGroup(
    ev: Extract<ProcessEvent, { type: 'narrate' }>,
    openByDefault = false,
  ): {
    el: HTMLDetailsElement;
    toolContainer: HTMLElement;
  } {
    const row = document.createElement('details');
    row.className = 'round-block__narrate';
    // 展开态（2026-09-02 拍板）：运行中（增量投影）默认展开——嵌套工具行实时可见，
    // 保持旧结构「工具状态直显」体验；收尾/回放（finalize 重建）默认收起，与 round-block 一致
    row.open = openByDefault;
    // seq 锚点：进行中增量追加去重（renderRoundBlock 每次事件到达全量扫描）
    row.dataset.seq = String(ev.seq);
    const summary = document.createElement('summary');
    const text = ev.payload.content.trim();
    summary.textContent = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const body = document.createElement('div');
    body.className = 'round-block__narrate-body';
    body.textContent = text;
    const toolContainer = document.createElement('div');
    toolContainer.className = 'round-block__narrate-tools';
    row.append(summary, body, toolContainer);
    return { el: row, toolContainer };
  }

  /** 取「前序最近 narrate」父块：seq 小于给定工具 seq 且最大者（无则 null → 工具落顶层/首个） */
  function precedingNarrateEl(details: HTMLElement, toolSeq: number): HTMLDetailsElement | null {
    const cands = Array.from(details.querySelectorAll<HTMLDetailsElement>('.round-block__narrate')).filter(
      (el) => Number(el.dataset.seq) < toolSeq,
    );
    if (cands.length === 0) return null;
    cands.sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq));
    return cands[cands.length - 1]!;
  }

  /** 按 seq 顺序插入 narrate 父块（避免每次事件到达时整体重排导致闪烁/展开态丢失） */
  function insertNarrateInOrder(details: HTMLElement, el: HTMLDetailsElement, seq: number): void {
    const existing = Array.from(details.querySelectorAll<HTMLDetailsElement>('.round-block__narrate')).filter(
      (e) => e !== el,
    );
    const next = existing.find((e) => Number(e.dataset.seq) > seq);
    if (next) {
      details.insertBefore(el, next);
    } else {
      const phase = details.querySelector('.round-block__phase');
      if (phase) phase.after(el);
      else details.appendChild(el);
    }
  }

  /**
   * 工具调用行（tool_start 配对 tool_result）——二级嵌套折叠：summary = 名称(状态) 常显，
   * args + result 摘要折叠进 body，避免工具详情抢占报告主体。失败工具默认展开（错误应直接可见）。
   * 宿主容器：建议 A 分组后为 narrate 父块的 .round-block__narrate-tools；无前序叙述时直挂
   * round-block__details 顶层。
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
  function findRunningTool(events: ProcessEvent[]): Extract<ProcessEvent, { type: 'tool_start' }> | null {
    const starts = events.filter((e): e is Extract<ProcessEvent, { type: 'tool_start' }> => e.type === 'tool_start');
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
  function toolRowStatus(
    result: Extract<ProcessEvent, { type: 'tool_result' }> | undefined,
  ): { label: string; open: boolean; running: boolean } {
    if (!result) return { label: '进行中', open: true, running: true };
    if (result.payload.blocked === true) return { label: '已拦截', open: true, running: false };
    return result.payload.ok
      ? { label: '成功', open: false, running: false }
      : { label: '失败', open: true, running: false };
  }

  function renderToolRow(listEl: HTMLElement, start: Extract<ProcessEvent, { type: 'tool_start' }>, events: ProcessEvent[]): void {
    const result = events.find(
      (e): e is Extract<ProcessEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.payload.toolCallId === start.payload.toolCallId,
    );
    const { label: status, open, running } = toolRowStatus(result);
    const row = document.createElement('details');
    row.className = 'round-block__tool';
    // 增量追加去重锚点：通过 toolCallId 定位已渲染的工具行（流式进行中增量追加）
    row.dataset.toolCallId = start.payload.toolCallId;
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
    listEl.appendChild(row);
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
  }

  /**
   * 工具行状态局部更新：tool_result 到达时，定位已渲染的工具行更新 状态/展开/结果摘要。
   * （进行中工具行已由增量追加创建，result 后到只需原地更新，不重建 DOM）
   *
   * @param container 工具行所在的小节容器（.round-block__section-list）
   * @param result    tool_result 事件
   */
  function updateToolRowState(container: HTMLElement, result: Extract<ProcessEvent, { type: 'tool_result' }>): void {
    container.querySelectorAll<HTMLDetailsElement>(`.round-block__tool[data-tool-call-id="${result.payload.toolCallId}"]`).forEach((row) => {
      const { label: status, open, running } = toolRowStatus(result);
      // TS-11 结构化管理：仅更新状态标签 span 文本（不动整体 summary，保留 label / elapsed 子节点）
      const statusEl = row.querySelector('.round-block__tool-status');
      if (statusEl) statusEl.textContent = ` (${status})`;
      row.open = open;
      // TS-11b：result 已到达 → 移除进行中态（恢复普通行样式）
      row.classList.toggle('is-tool-running', running);
      // TS-11c：工具已出结果 → 移除该行等待时长标签（瞬态退场，不再刷新）
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
   * @param events    当前轮全部过程事件
   * @param finalize  是否为本轮收尾
   */
  function renderRoundBlock(events: ProcessEvent[], finalize: boolean): void {
    const rb = ensureRoundBlock();
    if (!rb) return; // 正文块未创建（meta 先到）：挂载推迟到正文块出现时再补一次（beginStreaming）
    // summary：统计摘要（计数 + 耗时）
    const summary = rb.querySelector('.round-block__summary') as HTMLElement;
    if (summary) {
      summary.textContent = '';
      const dot = document.createElement('span');
      dot.className = 'round-block__dot';
      dot.setAttribute('aria-hidden', 'true');
      summary.appendChild(dot);
      const stats = countEvents(events);
      const parts: string[] = [];
      // 工具叙述句：分型计数（读取 x · 搜索 y …）→ 收起态也能看懂"它做了什么"；
      // other 类（未知自定义工具/空间整理）不进叙述句，避免标签误导，仅计入总数
      if (stats.tools > 0) {
        const subtypeParts: string[] = [];
        if (stats.reads > 0) subtypeParts.push(`读取 ${stats.reads}`);
        if (stats.searches > 0) subtypeParts.push(`搜索 ${stats.searches}`);
        if (stats.writes > 0) subtypeParts.push(`写入 ${stats.writes}`);
        if (stats.runs > 0) subtypeParts.push(`运行 ${stats.runs}`);
        parts.push(
          subtypeParts.length > 0 ? `执行 ${stats.tools} 步工具（${subtypeParts.join(' · ')}）` : `工具×${stats.tools}`,
        );
      }
      if (stats.memories > 0) parts.push(`召回 ${stats.memories} 条记忆`);
      if (stats.reviews > 0) parts.push(`审查 ${stats.reviews} 次`);
      const metrics = events.find((e): e is Extract<ProcessEvent, { type: 'metrics' }> => e.type === 'metrics');
      if (metrics) parts.unshift(`耗时 ${fmtDuration(metrics.payload.durationMs)}`);
      const label = document.createElement('span');
      label.className = 'round-block__stats';
      label.textContent = parts.length > 0 ? parts.join(' · ') : '任务过程';
      summary.appendChild(label);
      rb.classList.toggle('is-running', !finalize);
    }
    // 展开态：进行中自动展开（任务过程实时可见），完成自动收起（只留摘要，报告干净）
    rb.open = !finalize;
    const details = rb.querySelector('.round-block__details') as HTMLElement;
    if (!details) return;
    // ── 进行中（finalize=false）：实时相位行 + 工具行增量追加（不重建 details 防闪烁） ──
    if (!finalize) {
      // 实时相位行：details 顶部单条「当前正在做什么」。
      // TS-11a 优先级：进行中工具（tool_start 已到、tool_result 未达）→ 执行叙述；
      // 否则按最新 thinking 相位展示（原逻辑）。
      const runningTool = findRunningTool(events);
      const thinking = [...events].reverse().find((e) => e.type === 'thinking');
      let phaseRow = details.querySelector('.round-block__phase') as HTMLDivElement | null;
      if (runningTool) {
        if (!phaseRow) {
          phaseRow = document.createElement('div');
          phaseRow.className = 'round-block__phase';
          details.prepend(phaseRow);
        }
        phaseRow.classList.add('is-tool');
        phaseRow.textContent = `正在执行：${toolActionLabel(runningTool.payload.name, runningTool.payload.args)}`;
      } else if (thinking) {
        if (!phaseRow) {
          phaseRow = document.createElement('div');
          phaseRow.className = 'round-block__phase';
          details.prepend(phaseRow);
        }
        phaseRow.classList.remove('is-tool');
        phaseRow.textContent = phaseLabel(thinking.payload.phase);
      } else {
        phaseRow?.remove();
      }
      // 过程叙述 + 工具调用（建议 A：narrate 父块，工具嵌套子项，一一对应顺序显示）
      const narrates = events
        .filter((e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate')
        .sort((a, b) => a.seq - b.seq);
      // 1) 确保每段 narrate 父块存在（按 seq 顺序插入，data-seq 去重防重复渲染；运行中默认展开）
      for (const n of narrates) {
        if (!details.querySelector(`.round-block__narrate[data-seq="${n.seq}"]`)) {
          const { el } = createNarrateGroup(n, true);
          insertNarrateInOrder(details, el, n.seq);
        }
      }
      // 2) 工具调用：归属「前序最近 narrate」的 .round-block__narrate-tools 子容器；
      //    tool_start 未渲染则追加，tool_result 原地更新状态（嵌套行 data-tool-call-id 去重）
      const hasTool = events.some((e) => e.type === 'tool_start' || e.type === 'tool_result');
      if (hasTool) {
        for (const e of events) {
          if (e.type === 'tool_start') {
            const start = e as Extract<ProcessEvent, { type: 'tool_start' }>;
            const parent = precedingNarrateEl(details, start.seq);
            const container = parent
              ? (parent.querySelector('.round-block__narrate-tools') as HTMLElement)
              : details;
            if (!container.querySelector(`.round-block__tool[data-tool-call-id="${start.payload.toolCallId}"]`)) {
              renderToolRow(container, start, events);
            }
          } else if (e.type === 'tool_result') {
            updateToolRowState(details, e as Extract<ProcessEvent, { type: 'tool_result' }>);
          }
        }
      }
      return;
    }
    // ── 完成（finalize=true）：全量渲染所有小节（展开供查阅） ──
    // 实时相位行是进行中专属（details 直接子元素，非小节），收尾先移除
    details.querySelector('.round-block__phase')?.remove();
    // 全量重建前清理增量产物：section（轨迹/召回等）、narrate 父块（含嵌套工具）、
    // 以及无前序 narrate 时落在 details 顶层的工具行（旧结构依赖工具 section 清理，新结构需显式移除防重复渲染）
    details.querySelectorAll('.round-block__section, .round-block__narrate, .round-block__tool').forEach((el) => el.remove());
    // § 过程叙述 + 工具调用（建议 A：narrate 父块，工具嵌套子项，一一对应顺序显示）
    const narrates = events
      .filter((e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate')
      .sort((a, b) => a.seq - b.seq);
    const toolStarts = events
      .filter((e): e is Extract<ProcessEvent, { type: 'tool_start' }> => e.type === 'tool_start')
      .sort((a, b) => a.seq - b.seq);
    const groupToolContainers = new Map<number, HTMLElement>(); // narrate seq → 嵌套工具容器
    for (const n of narrates) {
      const { el, toolContainer } = createNarrateGroup(n);
      details.appendChild(el);
      groupToolContainers.set(n.seq, toolContainer);
    }
    for (const t of toolStarts) {
      // 归属「前序最近 narrate」（纯函数从 events 计算，不依赖 DOM 顺序）
      const preceding = [...narrates].reverse().find((n) => n.seq < t.seq);
      const container = preceding ? groupToolContainers.get(preceding.seq)! : details;
      renderToolRow(container, t, events);
    }
    // § 过程轨迹（thinking 阶段时间线）
    const thinking = events.filter((e): e is Extract<ProcessEvent, { type: 'thinking' }> => e.type === 'thinking');
    if (thinking.length > 0) {
      const { listEl } = sectionOf(details, '过程轨迹');
      thinking.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = phaseLabel(e.payload.phase);
        listEl.appendChild(row);
      });
    }
    // § 召回记忆 (N)
    const recalls = events.filter((e): e is Extract<ProcessEvent, { type: 'recall' }> => e.type === 'recall');
    const recallItems = recalls.flatMap((e) => e.payload.memories);
    if (recallItems.length > 0) {
      const { listEl } = sectionOf(details, '召回记忆');
      recallItems.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        const name = document.createElement('span');
        name.className = 'round-block__recall-name';
        name.textContent = m.name || m.id;
        const metaEl = document.createElement('span');
        metaEl.className = 'round-block__recall-meta';
        metaEl.textContent = `${m.source} · ${Math.round(m.score * 100)}%`;
        row.append(name, metaEl);
        listEl.appendChild(row);
      });
    }
    // § 已沉淀 (N)
    const added = events.filter((e): e is Extract<ProcessEvent, { type: 'memory_added' }> => e.type === 'memory_added');
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
    const reviews = events.filter((e): e is Extract<ProcessEvent, { type: 'self_review' }> => e.type === 'self_review');
    const reviewTexts = events.filter((e): e is Extract<ProcessEvent, { type: 'text_self_review' }> => e.type === 'text_self_review');
    if (reviews.length > 0 || reviewTexts.length > 0) {
      const { listEl } = sectionOf(details, '自审查输出');
      reviews.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = `自审查轮 ${e.payload.round}`;
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
    const aborted = events.find((e): e is Extract<ProcessEvent, { type: 'aborted' }> => e.type === 'aborted');
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
    const metrics = events.find((e): e is Extract<ProcessEvent, { type: 'metrics' }> => e.type === 'metrics');
    if (metrics) {
      const { listEl } = sectionOf(details, '执行指标');
      const lines = [
        `耗时：${fmtDuration(metrics.payload.durationMs)}`,
        `Tokens：入 ${metrics.payload.tokenIn} / 出 ${metrics.payload.tokenOut}`,
        `召回记忆：${metrics.payload.recallCount} 条`,
        `工具失败：${metrics.payload.toolFailureCount} 次`,
        `完成：${metrics.payload.success ? '是' : '否（中断/失败）'}`,
      ];
      lines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'round-block__row';
        row.textContent = line;
        listEl.appendChild(row);
      });
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

  // 切换 LLM 运行状态：thinking → 发送按钮切换为「停止」方块（loading 类驱动图标切换），
  // 输入框保持可用（支持插话）；done 恢复发送按钮；paused 切换为「继续」按钮。
  // SSOT 收敛：身份条已删，生成中状态由 round-block（过程可见）+ 发送按钮（可操作）承载。
  function setStatus(state: 'thinking' | 'done' | 'paused'): void {
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
    // 状态切换影响发送按钮可用性（生成中/暂停语义下恒可用，见 syncSendEnabled）
    syncSendEnabled();
    // 会话导航类控件运行时锁：thinking/paused（运行时）禁用，done（非运行时）恢复
    updateSessionControlsLock(state !== 'done');
  }

  /**
   * 同步发送按钮可用态：仅「发送」语义（空闲态）下输入为空则禁用；
   * 「停止」（loading）/「继续」（paused）承担其他职责，始终可用（支持空输入继续/停止）。
   * 调用点 = 一切输入内容/按钮状态变化处：input 事件、程序化预填/清空（不触发 input 事件）、setStatus。
   */
  function syncSendEnabled(): void {
    if (send.classList.contains('loading') || send.classList.contains('paused')) {
      send.disabled = false;
      return;
    }
    send.disabled = !input.value.trim();
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
  function updateSessionControlsLock(locked: boolean): void {
    sessionControlsLocked = locked;
    newSessionBtn.disabled = locked;
    historyBtn.disabled = locked;
    document
      .querySelectorAll<HTMLButtonElement>('.msg-delete-icon')
      .forEach((b) => {
        b.disabled = locked || !b.dataset.ts;
      });
  }

  // ─── 回答等待指示器（③ 等待反馈，2026-08-29）─────────────────
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

  /**
   * LLM 未配置时的空态 onboarding（UX-1，2026-09-01）
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
  // 此处统一以 messages 为滚动容器（SSOT 剪枝去重）。
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

  function append(role: 'user' | 'assistant' | 'error', text: string, ts?: string, roundId?: string): HTMLElement {
    // 日期分隔线：仅日期交界插入，先于本条消息（textContent 构建防注入）
    renderDateDivider(ts);
    if (role === 'assistant') {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      // AI 消息：复用骨架构建（label + content + body + footer），
      // 一次性消息（历史回放）直接渲染 Markdown（吸收养分，代码块/列表/表格可读）
      const { body } = buildAssistantShell(div, ts, roundId);
      // 原始文本存于 .msg 的 dataset（流式/历史共用，复制按钮据此复制完整原始 Markdown 源）
      div.dataset.rawText = text;
      body.innerHTML = renderMarkdown(text);
      // 历史回放同样做代码块增强（语言标签 + 复制按钮）
      enhanceCodeBlocks(body);
      // 流式锚点跟随最新 assistant 消息（SSOT：单一锚点，append/chunk 共用）
      activeAssistantEl = div;
      messages.appendChild(div);
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
   * 追加问答闭环内交互输入折叠块（TS-9）——「用户提问 / 用户补充」
   *
   * 折叠展示交互输入（主动提问回答 / 补充），归属当前问答闭环不分裂新轮：
   * 默认收起（details 原生折叠），头部显示类型标签 + 预览，展开可见全文。
   * 与普通 user 气泡区别：不携带 hover 操作区、归为一类轻量交互记录。
   *
   * @param text 输入全文
   * @param ts 时间戳（日期分隔线）
   * @param kind 交互类型（question-answer=提问回答 / supplement=补充）
   */
  function appendInteractiveInput(
    text: string,
    ts: string | undefined,
    kind: 'question-answer' | 'supplement',
  ): void {
    renderDateDivider(ts);
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper';
    const details = document.createElement('details');
    details.className = 'msg user is-interactive';
    details.dataset.kind = kind;
    const summary = document.createElement('summary');
    summary.className = 'msg-interactive-summary';
    const label = document.createElement('span');
    label.className = 'msg-interactive-label';
    label.textContent = kind === 'question-answer' ? '用户提问' : '用户补充';
    const preview = document.createElement('span');
    preview.className = 'msg-interactive-preview';
    preview.textContent = text.length > 60 ? text.slice(0, 60) + '…' : text;
    summary.appendChild(label);
    summary.appendChild(preview);
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text;
    details.appendChild(summary);
    details.appendChild(body);
    wrapper.appendChild(details);
    messages.appendChild(wrapper);
    scrollToBottom(messages);
    updateEmptyState();
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
    // 删除按钮（2026-08-16 对话闭环管理）：AI 消息承载「删除问答闭环」入口——删了答也删问。
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
   */
  function beginStreaming(ts?: string): void {
    renderDateDivider(ts);
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const { body } = buildAssistantShell(div, ts, undefined, { pending: true });
    // 流式期间：is-streaming 类驱动 CSS ::after 闪烁光标（markdown 由增量渲染填充）
    body.classList.add('is-streaming');
    activeAssistantEl = div;
    streamBodyRendered = false;
    messages.appendChild(div);
    // 挂载任务过程折叠区（meta 已先到）：进行中实时展开投影过程事件
    renderRoundBlock(currentEvents, false);
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
    // 单容器结构：正文 = 该轮唯一 .msg-body（报告正文），收尾一次终渲染 + 去光标 + 代码块增强
    const body = activeAssistantEl.querySelector(':scope .msg-body') as HTMLElement | null;
    if (body) {
      body.classList.remove('is-streaming');
      body.innerHTML = renderMarkdown(streamingRaw);
      enhanceCodeBlocks(body);
    }
    // 回答完毕：展示底部操作行（复制/分叉/删除 + 时间戳）——完整内容已定稿，操作才有效
    activeAssistantEl.querySelector<HTMLElement>('.msg-footer')?.classList.remove('is-pending');
    // 复制源更新为完整原始文本（.msg.dataset.rawText 供复制按钮读取）
    activeAssistantEl.dataset.rawText = streamingRaw;
    streamingActive = false;
    streamingRaw = '';
    streamBodyRendered = false;
  }

  /**
   * 本轮问答闭环结束后回填 roundId：启用该条 AI 消息的分叉按钮（任意 LLM 回答可分叉）。
   *
   * 流式创建时 roundId 未知 → 按钮初始禁用；host 在 done / interrupted 消息上携带本轮 roundId，
   * 此处写入 dataset.roundId 并解除禁用。分叉按钮点击读 dataset（SSOT 单一读取点），回填即生效。
   */
  function commitRoundId(roundId?: string): void {
    if (!roundId || !activeAssistantEl) return;
    activeAssistantEl.dataset.roundId = roundId;
    const forkBtn = activeAssistantEl.querySelector<HTMLButtonElement>('.msg-fork-icon');
    if (forkBtn) forkBtn.disabled = false;
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
      // D（alignment-iteration.md）：token 用量（可选字段，缺省不显示）
      'Tokens：' +
        (typeof msg.metrics.llmTokenIn === 'number' ? '入 ' + msg.metrics.llmTokenIn : '入 -') +
        ' / ' +
        (typeof msg.metrics.llmTokenOut === 'number' ? '出 ' + msg.metrics.llmTokenOut : '出 -'),
      // ④（2026-08-29）：预算分配构成（可选字段，缺省不显示）——窗口内空间如何被 锚点/对话层/记忆 cap 瓜分
      ...(msg.metrics.budget
        ? [
            '预算：可用 ' + fmtCompactTokens(msg.metrics.budget.availableTokens) +
              ' · 锚点 ' + fmtCompactTokens(msg.metrics.budget.anchorTokens) +
              ' · 对话层 ' + fmtCompactTokens(msg.metrics.budget.dialogueBudgetTokens) +
              ' · 记忆 cap ' + fmtCompactTokens(msg.metrics.budget.memoryLayerCapTokens) +
              ' · 剩余 ' + fmtCompactTokens(msg.metrics.budget.remainingTokens),
          ]
        : []),
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
    lines.push(`角色包/系统设定：${fmtTokens(occ.rolePackBaseTokens)}（占窗口 ${pctOf(occ.rolePackBaseTokens)}）`);
    lines.push(`记忆摘要：${occ.memoryCount} 条 · ${fmtTokens(occ.memoryTokens)}（${pctOf(occ.memoryTokens)}）`);
    lines.push(`完整对话：${occ.dialogueCount} 条 · ${fmtTokens(occ.dialogueTokens)}（${pctOf(occ.dialogueTokens)}）`);
    lines.push(`当前输入锚点：${fmtTokens(occ.inputAnchorTokens)}（${pctOf(occ.inputAnchorTokens)}）`);
    lines.push(`输出预留：${fmtTokens(occ.outputReserveTokens)}（${pctOf(occ.outputReserveTokens)}）`);
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
  function renderOccupancyLimit(providers: ChatProviderItem[], activeName: string | undefined): void {
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
        memoryTokens: 0,
        memoryCount: 0,
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

  // 处理 extension → webview 消息（流式渲染 / 状态机 / 单一过程事件 / 下拉数据）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'status') {
      setStatus(msg.state);
    } else if (msg.type === 'process_event') {
      // 运行时单形态渲染投影（v1.5）：一律汇入当前轮 events[] 由 renderRoundBlock 渲染。
      // meta 为本轮首条 → 开新轮（清缓冲 + 挂载就绪）；瞬时「已召回/已沉淀」提示由事件本地派生
      const ev = msg.event;
      if (ev.type === 'meta') {
        // 新轮开始：清空当前轮缓冲与 round-block 引用，随即建流式骨架（TTFT 前即时反馈）
        clearPendingWait(); // 骨架接管：移除 meta 前的回答等待指示器
        clearToolElapsed(); // TS-11c：切轮清工具等待计时（瞬态，防跨轮残留）
        currentEvents = [];
        roundBlockEl = null;
        roundBlockHostEl = null;
        clearArchivingFallback();
        currentRoundMeta = { role: ev.payload.role, llm: ev.payload.llm };
        currentEvents.push(ev);
        prepareFlowShell();
      } else {
        if (ev.type === 'recall') {
          // 瞬时反馈：本轮召回 N 条（与折叠区 § 召回记忆同一数据源）
          showActivity('info', `已召回 ${ev.payload.memories.length} 条记忆`);
        } else if (ev.type === 'memory_added') {
          showActivity('info', `已沉淀：${ev.payload.name || ev.payload.id}`);
        } else if (ev.type === 'thinking') {
          // 归档停滞兜底：archiving 激活即调度超时收起呼吸点
          if (ev.payload.phase === 'archiving') {
            scheduleArchivingFallback();
          }
          // 回答等待指示器（③ 等待反馈）：meta 前（无骨架）补可见反馈——文案随
          // 相位更新（召回/处理/规划…）+ 等待秒数，避免「发送后无反应」
          if (!roundBlockEl && ev.payload.phase !== 'archiving') {
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
        // 任务过程折叠区随流同步刷新（进行中增量：实时相位 + 工具追加）
        renderRoundBlock(currentEvents, false);
      }
    } else if (msg.type === 'replay_events') {
      // 重放整批（v1.5）：同一渲染路径——整批汇入 events[]，一次性渲染 summary + details
      clearPendingWait(); // 重放为历史渲染，等待指示器不适用
      currentEvents = [...msg.events];
      // meta 优先写入本轮身份（供该轮 assistant 正文标签；host 已保证 meta 先于正文到达）
      const metaEv = msg.events.find((e): e is Extract<ProcessEvent, { type: 'meta' }> => e.type === 'meta');
      if (metaEv) {
        currentRoundMeta = { role: metaEv.payload.role, llm: metaEv.payload.llm };
      }
      // 重放整批：任务过程折叠区（含工具/思考/召回/审查/metrics）一次性渲染（finalize=true，收起态）
      renderRoundBlock(currentEvents, true);
    } else if (msg.type === 'user') {
      // 无缝插话（缺口 B）：生成中收到用户补充 → 结束当前流式助手块（复位锚点与流式态），
      // 使后续 chunk 经 beginStreaming 开新助手块、置于本用户消息之后，保证消息排序正确。
      if (streamingActive) {
        // 打断旧流必须同时移除旧块流式光标（is-streaming ▋）——否则旧块光标残留闪烁：
        // 该块只是"被打断的半截回答"，不再有新 chunk，finalizeStreaming 也不会再被调用
        activeAssistantEl?.querySelector<HTMLElement>(':scope .msg-body')?.classList.remove('is-streaming');
        if (streamRenderTimer) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = undefined;
        }
        streamingActive = false;
        activeAssistantEl = null;
        streamingRaw = '';
      }
      // 插话/回答开新轮：清残留骨架 + 等待指示器（下一轮重新初始化）
      flowShellEl?.remove();
      flowShellEl = null;
      clearPendingWait();
      // TS-9：带 kind 的交互输入（主动提问回答/补充）→ 折叠块渲染，归属当前问答闭环；
      // 普通新闭环输入保持原全字段气泡
      if (msg.kind) {
        appendInteractiveInput(msg.text, msg.ts, msg.kind);
      } else {
        append('user', msg.text, msg.ts);
      }
    } else if (msg.type === 'assistant') {
      append('assistant', msg.text, msg.ts, msg.roundId);
      // 历史回放正文块创建后补挂任务过程折叠区（meta/replay_events 若先于正文到达，此处才挂得上）
      renderRoundBlock(currentEvents, true);
    } else if (msg.type === 'chunk') {
      // 主回答流：流式追加：目标 = 活动 assistant 锚点（SSOT，排雷 P0-1），而非 messages 最后一个元素。
      // 自审查输出不再走 chunk（host 已按 text_self_review 过程事件转发，渲染进折叠区）。
      // guardrailBlocked 标记：护栏阻断文案已由内核 content 承载（[输入/输出被护栏阻断：rule]），
      // 此处不再弹硬编码 banner——避免双份提示 + 输入/输出语义错位（排雷 2026-08-17）。
      // 首个 chunk：若骨架已由 meta 建立（TTFT 前即时反馈）→ 复用该块开启正文流，否则新建
      if (!streamingActive) {
        clearPendingWait(); // 正文开启：等待指示器退场（骨架已接管）
        if (flowShellEl) {
          // 复用骨架：正文流入同一块（不新建第二条 assistant 消息）
          streamingActive = true;
          streamingRaw = '';
          const body = flowShellEl.querySelector(':scope .msg-body');
          body?.classList.add('is-streaming');
          flowShellEl = null; // 已转化为正文块，后续插话/新轮不再特殊处理
        } else {
          beginStreaming(msg.ts);
          streamingActive = true;
          streamingRaw = '';
        }
      }
      // 报告正文持续流式写入：正文 = 该轮唯一 .msg-body（单容器结构，不被工具事件切碎）
      const target = activeAssistantEl ? activeAssistantEl.querySelector(':scope .msg-body') as HTMLElement | null : null;
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
      // 衔接决策（SSOT 收紧后 loop 已由宿主归一为 wait，语意让位用户）：
      // wait 静默（等用户输入，输入框已随 done 恢复）；end 低扰提示任务已收尾。
      // 不渲染"将自动续跑"——自主循环由内核在单次 chat() 内消费预算，宿主不再二次进入。
      if (msg.decision === 'end') {
        showActivity('info', '任务已完成，可开始下一项');
      }
      // loop / wait 均静默处理
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
    } else if (msg.type === 'metrics') {
      // 活动指标（P2：§13.x 透明面板 + §5.2.1 指纹可见）：每轮结束后刷新详情折叠区
      renderMetrics(msg);
    } else if (msg.type === 'context_occupancy') {
      // ④ 预算可视化：更新输入区常驻上下文占用条
      updateContextOccupancy(msg.occupancy);
    } else if (msg.type === 'error') {
      clearPendingWait(); // 失败即收尾，等待指示器退场
      append('error', msg.message);
    } else if (msg.type === 'done') {
      // 本轮流式结束：清除归档停滞兜底定时器 + 骨架引用（已定型为正文/异常块）
      clearPendingWait();
      clearArchivingFallback();
      flowShellEl = null;
      // 顺序关键：先收起任务过程折叠区（完成态全量渲染 + 自动收起），再 finalizeStreaming 关流式光标
      renderRoundBlock(currentEvents, true);
      finalizeStreaming();
      // 回填本轮 roundId（启用该回答的分叉按钮；host done 消息携带）
      commitRoundId(msg.roundId);
    } else if (msg.type === 'interrupted') {
      // 用户主动停止（mvp-scope 打断能力）：清除归档兜底定时器 + 低扰提示「已停止生成」
      // 等待指示器同步收尾（③ 排雷补漏 2026-08-30）：done/error 均清，唯独中断漏清——
      // 残留的 pending-wait 会悬挂「已等待 Ns」且 1s 定时器空转，直到下次用户输入才被清掉。
      clearPendingWait();
      clearToolElapsed(); // TS-11c：中断同样清工具等待计时（防定时器残留空转）
      clearArchivingFallback();
      flowShellEl = null;
      // 同 done 顺序纪律：先收起任务过程折叠区，再关流式
      renderRoundBlock(currentEvents, true);
      finalizeStreaming();
      // 打断也可能产生部分回答：同样回填 roundId，允许从该轮分叉
      commitRoundId(msg.roundId);
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
      syncSendEnabled(); // 程序化预填不触发 input 事件，须手动同步
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
        syncSendEnabled(); // 程序化回填不触发 input 事件，须手动同步
      }
      // 恢复润色按钮状态（图标按钮，无需恢复文本）
      if (polishBtn) {
        polishBtn.classList.remove('loading');
      }
      if (!msg.ok && msg.message) {
        showActivity('info', `润色失败：${msg.message}`);
      }
    } else if (msg.type === 'clear_ok') {
      // 清空消息区须同时清 .msg、.msg-wrapper（用户消息外层壳）、.round-block、.date-divider、.followup
      // ——漏清 .msg-wrapper 会让切换/新建会话后残留空壳块，污染重放视图。
      // 不替换 messages 全部子节点（保留 #emptyState 占位）。
      messages.querySelectorAll('.msg, .msg-wrapper, .round-block, .date-divider, .followup').forEach((el) => el.remove());
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
      // 过程事件状态复位：归档兜底定时器清除 + round-block 引用失效 + 骨架清除 + 本轮缓冲清空 +
      // 本轮身份保留给会话级标签回退（chat_role_pack 随后推送）+ 日期分隔线重新计算
      clearArchivingFallback();
      roundBlockEl = null;
      roundBlockHostEl = null;
      flowShellEl = null;
      currentEvents = [];
      lastShownDate = undefined;
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
      // 更新当前模型名（用于 AI 消息头部标签展示）
      if (currentActive) {
        const activeProvider = currentProviders.find(p => p.name === currentActive);
        currentModelName = activeProvider?.displayName || currentActive;
      }
      renderModelPicker();
      // ④ 预算可视化：按当前选中 LLM 的上下文上限实时渲染占用条容量（首轮对话前即有真实上限）
      renderOccupancyLimit(currentProviders, currentActive);
      // UX-1（2026-09-01）：无 Provider 时空态切换为「去配置模型」引导（首次使用关键路径，
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
      // （角色切换已独立到「角色」视图，2026-08-17）
      currentRoleName = msg.rolePack;
      currentRoleTraits = msg.traits;
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
    syncSendEnabled(); // 宿主可能早退（Agent 未就绪/无会话）不转 thinking，清空后须立即禁用
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
  // 暂停按钮（Gap A）：仅生成中可见，点击发 pause 消息——host 调 agent.requestPause()
  // 迭口边界软暂停当前流（落检查点、可经「继续」恢复），区别于「停止」的丢弃语义。
  pauseBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'pause' });
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
    syncSendEnabled(); // 用户输入实时重算发送按钮可用性（空输入禁用）
  });

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
    syncSendEnabled(); // 程序化回填不触发 input 事件，须手动同步
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
}
