/**
 * 快速输入补全管理器 — Phase 2 补全能力
 *
 * 职责：
 *   1. 监听输入框内容变化，防抖触发补全请求
 *   2. 并行调用 searchMemories + searchSessionMessages 两个 IPC
 *   3. 合并去重 + 按相关度排序 + 同源多样性过滤，取 Top-5 候选
 *   4. 渲染候选列表，支持 ↓↑ 键盘导航 + ←→ 填充回填
 *   5. 取消上一次未完成的请求（避免乱序）
 *   6. 采纳反馈回路：用户采纳过的候选项获得 score boost（越用越准）
 *   7. 搜索 loading 反馈：IPC 发出后显示"搜索中…"占位，返回后自然替换
 *   8. L1 source 语义感知：区分洞察/偏好/投影/对话，排除 persona/rule/skill
 *
 * 设计原则：
 *   - 纯渲染层逻辑，零内核改动、零 IPC 新增
 *   - 复用现有 searchMemories / searchSessionMessages 两个 IPC
 *   - 防抖 300ms + 最小 2 字符触发，避免高频 IPC
 *   - 候选列表为空时自动隐藏，不干扰输入
 *   - 同时服务于 quick-input 浮窗（input）和主对话输入框（textarea）
 *
 * 数据来源对比：
 *   - searchMemories：结构化记忆（洞察/偏好/规则），双通道混合搜索，含 source
 *   - searchSessionMessages：历史对话消息原文，纯 LIKE 匹配，含 role/date
 *   两者互补：记忆提供"用户是什么样的人"，对话提供"用户最近在说什么"
 *
 * L1 source 语义感知：
 *   - 记忆候选读取 source 字段，映射为中文标签（洞察/偏好/作品/记忆）
 *   - 排除 persona/rule/skill/guardrail（已在 system prompt 注入，补全候选不应重复）
 *   - 多样性过滤从"二分（记忆/对话）"升级为"多源（洞察/偏好/作品/对话）"
 *
 * score 量纲设计：
 *   - 记忆 score：内核返回的归一化相关度（0-1）
 *   - 对话 score：基于关键词匹配位置（开头 0.6 → 末尾 0.4，低于记忆，对话作为兜底）
 *   - 采纳 boost：+0.1 * min(采纳次数, 3)，最多 +0.3（通过 localStorage 跨会话持久化）
 */
import type { ElectronAPI } from '../../preload.js';
// 复用渲染进程统一日志函数（双通道：console + 主进程 logger），替代本地 logCompletion
import { reportError } from '../helpers/errorHelpers.js';
import { safeGetJSON, safeSetJSON } from '../helpers/safeStorage.js';
// 补全统计埋点（展示/采纳事件 → localStorage → 统计面板消费）
import { getCompletionMetrics } from '../helpers/completionMetrics.js';
// 文本截断工具（跨层共享，统一 ellipsis 为 '…'）
import { truncate } from '../../../shared/truncate.js';

/**
 * 补全管理器所需的 ElectronAPI 子集
 *
 * 仅依赖两个搜索 IPC，与 Phase 1 的 confirmQuickInput/closeQuickInput 解耦。
 */
export type CompletionElectronAPI = Pick<ElectronAPI, 'searchMemories' | 'searchSessionMessages' | 'boostMemory'>;

/**
 * 补全目标元素类型
 *
 * 同时支持 quick-input 浮窗的 HTMLInputElement 和主对话输入框的 HTMLTextAreaElement。
 * 两者都有 value 属性和 input/keydown 事件，补全逻辑无差异。
 */
export type CompletionTarget = HTMLInputElement | HTMLTextAreaElement;

/** 补全候选项统一结构（合并记忆搜索 + 对话搜索结果） */
export interface CompletionItem {
  /** 候选预览文本（截断到 PREVIEW_MAX_LENGTH，仅用于展示） */
  text: string;
  /** 候选全量文本（用于回填输入框，对话候选从搜索结果直取，记忆候选通过 showMemory IPC 回库查） */
  fullText?: string;
  /** 来源标签（洞察/偏好/投影/记忆/对话） */
  sourceLabel: string;
  /** 相关度分数（0-1，用于排序） */
  score: number;
  /**
   * 记忆唯一标识（仅记忆候选有，对话候选无）
   * L2 采纳反哺：用户采纳时通过此 id 调用 boostMemory 反哺内核 Memory.score
   */
  memoryId?: string;
}

/** 防抖延迟（ms） —— 输入停止后等待多久触发补全 */
const DEBOUNCE_MS = 300;
/** 最小触发字符数 —— 少于此值不触发补全（避免空查询） */
const MIN_QUERY_LENGTH = 2;
/** 最大候选数量 */
const MAX_CANDIDATES = 5;
/** 候选项预览文本最大长度（防止过长候选项撑爆浮窗） */
const PREVIEW_MAX_LENGTH = 80;
/** 候选项 DOM ID 前缀（用于 aria-activedescendant 引用） */
const COMPLETION_ITEM_ID_PREFIX = 'completion-item-';
/**
 * 单次 IPC 调用超时时间（ms）
 *
 * 内核正常响应 < 100ms，5s 阈值覆盖 SQLite FTS5 锁竞争/磁盘 IO 抖动等异常场景。
 * 超时后视为失败，走与 IPC 异常同构的降级路径（单源失败仍展示另一源结果）。
 * 符合 coding-convention-rules.md §9："DO 文件、数据库操作增加超时控制，禁止无限阻塞"。
 */
const IPC_TIMEOUT_MS = 5000;

// ─── L1 source 语义感知常量 ──────────────────────────────
/**
 * 内核 source 标签到补全展示标签的映射
 *
 * 仅映射参与补全的记忆 source（insight/profile/work-projection）。
 * persona/rule/skill/guardrail 在 EXCLUDED_SOURCES 中排除，不参与补全候选。
 * 未知 source（宿主自定义）降级为"记忆"，保持向后兼容。
 */
const SOURCE_LABEL_MAP: Readonly<Record<string, string>> = {
  insight: '洞察',
  profile: '偏好',
  'work-projection': '作品',
};
/**
 * 排除的 source 标签（不参与补全候选）
 *
 * persona/rule/skill 已在 system prompt 注入，补全候选重复会干扰用户输入；
 * guardrail 是内容护栏规则，非用户可感知的记忆类型。
 */
const EXCLUDED_SOURCES: ReadonlySet<string> = new Set([
  'persona', 'rule', 'skill', 'guardrail',
]);
/** 对话候选 score 基础值（低于记忆候选，让结构化记忆优先排序） */
const MESSAGE_SCORE_BASE = 0.6;
/** 对话候选 score 位置惩罚范围（关键词在内容末尾时最多扣 0.2，score 从 0.6 降至 0.4） */
const MESSAGE_SCORE_POSITION_PENALTY = 0.2;
/** 采纳反馈 boost 上限（最多累积 3 次采纳） */
const ADOPTION_BOOST_MAX_COUNT = 3;
/** 每次采纳的 score 提升量 */
const ADOPTION_BOOST_PER_COUNT = 0.1;
/** localStorage 键名（遵循宿主 `memora-` 前缀约定） */
const ADOPTION_STORAGE_KEY = 'memora-completion-adoptions';
/** 采纳记录最大条目数（LRU 淘汰上限，防止 localStorage 无限膨胀） */
const MAX_ADOPTION_ENTRIES = 100;
/** 同 sourceLabel 最大候选数（保证 Top-5 内至少 2 个来源，当多源共存时） */
const MAX_PER_SOURCE = 3;
/** 短查询阈值（≤此字符数视为"续写"场景，对话历史获得 boost） */
const SHORT_QUERY_THRESHOLD = 5;
/** 续写场景下对话候选的 score 提升量（让近期对话在短查询时优先于结构化记忆） */
const CONVERSATION_SHORT_QUERY_BOOST = 0.1;

/**
 * 为 Promise 包装超时（单次 IPC 调用专用）
 *
 * 超时后 Promise race 返回 timeout 标识，调用方据此判定为失败并降级。
 * 不主动 cancel 原始 Promise（IPC 无法取消），仅放弃等待结果——
 * 内核最终响应后 lastRequestId 机制会丢弃乱序响应。
 *
 * @param target 要包装的原始 Promise
 * @param ms 超时毫秒
 * @returns 解析为 { ok: true, value } 或 { ok: false }
 */
async function withTimeout<T>(target: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      target.then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), ms);
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 快速输入补全管理器
 *
 * 使用方式：
 *   1. new QuickInputCompletion(inputField, listEl, api)
 *   2. 用户输入时自动触发补全
 *   3. 用户按 ←→ 填充候选项时触发 onSelect 回调
 *   4. 窗口关闭时调用 cleanup() 清理监听器
 *
 * 支持的输入元素：HTMLInputElement（浮窗）| HTMLTextAreaElement（主输入框）
 *
 * 键盘交互约定（三键分工）：
 *   - ↓↑：导航候选项（本类处理，循环选择）
 *   - ←→：填充选中项到输入框（本类处理，仅导航后拦截）
 *   - Tab：提交/确认补全（本类不处理，由宿主自行实现）
 *         · 浮窗场景：Tab = 提交输入内容（quickInput.ts handleTab）
 *         · 主输入框场景：Tab = 确认补全文本（inputAreaManager.ts 自行处理）
 *   宿主需根据使用场景自行绑定 Tab 键行为，本类仅处理 ↓↑←→。
 */
export class QuickInputCompletion {
  /** 输入框元素（input 或 textarea） */
  private inputField: CompletionTarget;
  /** 候选列表容器元素 */
  private listEl: HTMLElement;
  /** ElectronAPI 子集（搜索能力） */
  private api: CompletionElectronAPI;
  /** 候选项选择回调（←→ 填充时触发，参数为选中的候选项完整对象） */
  private onSelectCallback: ((item: CompletionItem) => void) | null = null;
  /** 候选列表变化回调（用于通知窗口调整高度） */
  private onListChangeCallback: ((visible: boolean) => void) | null = null;
  /**
   * 最近提交历史回退提供者
   *
   * 当记忆+对话匹配候选为空时调用，返回最近提交文本数组作为回退候选。
   * 返回空数组表示无历史可回退，此时隐藏候选列表（不显示空占位）。
   * 由 quickInput.ts 注入（读取 localStorage 持久化的最近提交历史）。
   */
  private recentProvider: ((currentQuery: string) => string[]) | null = null;

  /** 防抖定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前选中的候选项索引（-1 表示无选中） */
  private selectedIndex = -1;
  /** 当前候选列表（用于键盘导航） */
  private candidates: CompletionItem[] = [];
  /** 上一次请求的序号（用于取消乱序响应） */
  private lastRequestId = 0;
  /** 采纳反馈记录（text key → 累积采纳次数，用于 boost 已被采纳的候选项） */
  private adoptedTexts = new Map<string, number>();
  /** 本次合并后的候选总数（slice 前），用于判断是否需要显示"共 N 项"footer */
  private totalCandidatesCount = 0;
  /** 当前查询文本（fetchCandidates 时缓存，供 renderCandidates/recordAdoption 计算埋点） */
  private currentQuery = '';

  /** 抑制下一次 input 事件触发的补全搜索（选中候选项填充文本后设置，避免填充触发多余搜索） */
  private suppressNextInput = false;

  /**
   * @param inputField 输入框元素（input 或 textarea）
   * @param listEl 候选列表容器元素（ul 或 div）
   * @param api ElectronAPI 子集
   */
  constructor(inputField: CompletionTarget, listEl: HTMLElement, api: CompletionElectronAPI) {
    this.inputField = inputField;
    this.listEl = listEl;
    this.api = api;
    // 从 localStorage 加载历史采纳记录，实现跨会话学习
    this.adoptedTexts = this.loadAdoptions();
  }

  /**
   * 初始化：绑定输入框事件监听器
   *
   * 监听 input 事件（防抖触发补全）和 keydown 事件（↓↑ 导航 + ←→ 填充）。
   */
  init(): void {
    // 输入事件：防抖触发补全
    this.inputField.addEventListener('input', this.handleInput);
    // 键盘事件：↓↑ 导航 + ←→ 填充（Tab 提交 / Esc 关闭由 quickInput.ts 处理）
    this.inputField.addEventListener('keydown', this.handleKeyDown);
  }

  /**
   * 注册候选项选择回调
   *
   * 用户按 ←→ 或点击候选项时触发，参数为选中的候选项完整对象。
   * 回调负责将候选项全量文本回填到输入框（优先使用 fullText，降级使用 text）。
   */
  onSelect(cb: (item: CompletionItem) => void): void {
    this.onSelectCallback = cb;
  }

  /**
   * 注册候选列表可见性变化回调
   *
   * 候选列表显示/隐藏时触发，用于通知窗口调整高度。
   */
  onListChange(cb: (visible: boolean) => void): void {
    this.onListChangeCallback = cb;
  }

  /**
   * 注册最近提交历史回退提供者（STEP-5A）
   *
   * 优先级链：匹配候选（记忆+对话）第一优先级 → 最近提交历史第二优先级 → 都无则隐藏列表。
   * 当 fetchCandidates 合并记忆+对话候选为空时，调用此提供者获取回退候选。
   *
   * @param cb 回调函数，接收当前查询文本，返回历史候选文本数组（最近在前）
   */
  onRecentFallback(cb: (currentQuery: string) => string[]): void {
    this.recentProvider = cb;
  }

  /**
   * 抑制下一次 input 事件触发的补全搜索
   *
   * 选中候选项填充文本到输入框后，input 事件会触发新的补全搜索，
   * 导致候选列表闪烁。调用此方法后，下一次 input 事件将被跳过。
   * 标志位仅生效一次，自动重置。
   */
  suppressNextSearch(): void {
    this.suppressNextInput = true;
  }

  /**
   * 输入事件处理器（防抖）
   *
   * 输入内容变化后等待 DEBOUNCE_MS，若期间无新输入则触发补全。
   * 空输入（length === 0）立即显示最近提交历史（核心场景：Tab 提交后直接用方向键选择复用）。
   * 输入长度 1 且 < MIN_QUERY_LENGTH 时清空候选列表（1 字符太短难以匹配）。
   */
  private handleInput = (): void => {
    // 选中候选项填充文本后，跳过本次 input 事件触发的补全搜索（避免候选列表闪烁）
    if (this.suppressNextInput) {
      this.suppressNextInput = false;
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const query = this.inputField.value.trim();
    if (query.length === 0) {
      // 空输入：立即显示最近提交历史（跳过防抖，Tab 提交后直接可选）
      const recentCandidates = this.buildRecentCandidates('');
      if (recentCandidates.length === 0) {
        this.clearCandidates();
        return;
      }
      this.renderCandidates(recentCandidates);
      return;
    }
    if (query.length < MIN_QUERY_LENGTH) {
      this.clearCandidates();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      void this.fetchCandidates(query);
    }, DEBOUNCE_MS);
  };

  /**
   * 构建最近提交历史候选（STEP-5A）
   *
   * 供两处复用：
   *   1. handleInput 空查询时直接显示历史（核心场景：Tab 提交后用方向键选择复用）
   *   2. fetchCandidates 匹配候选为空时回退到历史
   *
   * @param currentQuery 当前查询文本（用于排除完全相同的候选，避免用户已输入的内容作为候选）
   * @returns 历史候选数组；无历史时返回空数组
   */
  private buildRecentCandidates(currentQuery: string): CompletionItem[] {
    const recentTexts = this.recentProvider?.(currentQuery) ?? [];
    return recentTexts.map((text) => ({
      text: truncate(text, PREVIEW_MAX_LENGTH),
      fullText: text,
      sourceLabel: '最近',
      score: 0.5, // 历史候选统一低分，排序时自然靠后（与匹配候选混排时不抢位）
    }));
  }

  /**
   * 键盘事件处理器（↓↑ 导航 + ←→ 填充）
   *
   * - ArrowDown：选中下一项（循环到顶部）
   * - ArrowUp：选中上一项（循环到底部）
   * - ArrowLeft/ArrowRight：将选中项填充到输入框（仅在已导航时拦截）
   *
   * 未用方向键导航时，←→ 不拦截，保持光标移动功能。
   * Tab 不在此处理，统一由 quickInput.ts / 主对话输入框各自处理。
   *
   * 参数类型为 Event 而非 KeyboardEvent：union 类型 inputField（HTMLInputElement | HTMLTextAreaElement）
   * 在 strictFunctionTypes 下触发 addEventListener 泛型回退，EventHandler 签名需匹配 EventListener。
   * 内部通过 instanceof 收窄到 KeyboardEvent，保持类型安全。
   */
  private handleKeyDown = (e: Event): void => {
    // 收窄到 KeyboardEvent（addEventListener('keydown') 运行时保证传入 KeyboardEvent）
    if (!(e instanceof KeyboardEvent)) return;
    if (this.candidates.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.candidates.length;
      this.updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // selectedIndex 为 -1（无选中）时，ArrowUp 应跳到最后一项（循环导航）
      this.selectedIndex = this.selectedIndex < 0
        ? this.candidates.length - 1
        : (this.selectedIndex - 1 + this.candidates.length) % this.candidates.length;
      this.updateSelection();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && this.selectedIndex >= 0) {
      // 仅在用户已用 ↑↓ 导航选中候选项时，←→ 才填充
      e.preventDefault();
      const selected = this.candidates[this.selectedIndex]!;
      this.recordAdoption(selected.text, selected.memoryId);
      // 清除候选列表由回调负责（记忆候选异步填充后清除，对话候选同步填充后清除）
      this.onSelectCallback?.(selected);
    }
  };

  /**
   * 获取补全候选（并行调用两个 IPC）
   *
   * 使用递增 requestId 取消乱序响应：若发起新请求时旧请求未返回，
   * 旧响应的 requestId 与 lastRequestId 不匹配，直接丢弃。
   *
   * IPC 发出后立即显示 loading 占位，避免用户等待时无反馈。
   * 两源全失败时显示错误占位，让用户区分"无匹配"和"搜索出错"。
   *   单源失败仍展示另一源结果（部分可用优于完全不可用）。
   * loading 期间 candidates 为空，键盘导航天然失效（handleKeyDown 检查 length===0）。
   * IPC 返回后由 renderCandidates 或 showErrorPlaceholder 或 clearCandidates 替换 loading。
   */
  private async fetchCandidates(query: string): Promise<void> {
    const requestId = ++this.lastRequestId;
    // 缓存当前 query，供 renderCandidates/recordAdoption 埋点使用
    this.currentQuery = query;
    // IPC 发出前显示 loading 占位（防抖结束后才到达此处，不会在输入过程中闪烁）
    this.showLoading();

    try {
      // 跟踪两源失败状态，全失败时显示错误占位（单源失败仍展示另一源结果）
      let memoriesFailed = false;
      let messagesFailed = false;
      // 并行调用两个搜索 IPC，每个 IPC 包装超时（IPC_TIMEOUT_MS）
      // 超时与 IPC 异常同构处理：降级为空候选，单源失败仍展示另一源结果
      const [memoriesResultRaw, messagesResultRaw] = await Promise.all([
        withTimeout(this.api.searchMemories(query), IPC_TIMEOUT_MS).catch((err) => {
          // IPC 异常时降级为空候选，warn 级别上报（可降级的非致命错误）
          reportError('QuickInputCompletion:searchMemories', err, 'warn');
          memoriesFailed = true;
          return { ok: false } as const;
        }),
        withTimeout(this.api.searchSessionMessages({ keyword: query, limit: 20 }), IPC_TIMEOUT_MS).catch((err) => {
          // IPC 异常时降级为空候选，warn 级别上报（可降级的非致命错误）
          reportError('QuickInputCompletion:searchSessionMessages', err, 'warn');
          messagesFailed = true;
          return { ok: false } as const;
        }),
      ]);

      // 超时或异常：降级为空候选
      let memoriesResult: { hits: unknown[] } = { hits: [] };
      let messagesResult: { results: unknown[] } = { results: [] };
      if (memoriesResultRaw.ok) {
        memoriesResult = memoriesResultRaw.value as { hits: unknown[] };
      } else {
        // 区分超时与异常：异常已上面 catch 置 memoriesFailed=true；超时此处补上
        if (!memoriesFailed) {
          reportError('QuickInputCompletion:searchMemories', new Error('IPC timeout'), 'warn');
          memoriesFailed = true;
        }
      }
      if (messagesResultRaw.ok) {
        messagesResult = messagesResultRaw.value as { results: unknown[] };
      } else {
        if (!messagesFailed) {
          reportError('QuickInputCompletion:searchSessionMessages', new Error('IPC timeout'), 'warn');
          messagesFailed = true;
        }
      }

      // 请求已过期（用户已输入新内容），丢弃旧响应（loading 由最新请求接管）
      if (requestId !== this.lastRequestId) return;

      // 两源全失败时显示错误占位，让用户知道是搜索出错而非无匹配
      if (memoriesFailed && messagesFailed) {
        this.showErrorPlaceholder();
        return;
      }

      const candidates = this.mergeCandidates(
        query,
        memoriesResult.hits as Array<{ id: string; contentPreview: string; score: number; source?: string }>,
        messagesResult.results as Array<{ content: string; role: string }>,
      );

      // 优先级链：匹配候选（记忆+对话）为空时回退到最近提交历史
      // 匹配内容第一优先级，历史提交第二优先级，都没有则显示"无匹配"占位（状态反馈，非 bug）
      if (candidates.length === 0) {
        const recentCandidates = this.buildRecentCandidates(query);
        if (recentCandidates.length === 0) {
          // 无匹配且无历史：显示"无匹配"占位提供状态反馈
          // 保留三态占位体系（搜索中/无匹配/出错），避免用户在"搜不到"时误以为 bug
          this.showEmptyPlaceholder();
          return;
        }
        this.renderCandidates(recentCandidates);
        return;
      }

      this.renderCandidates(candidates);
    } catch (error) {
      reportError('QuickInputCompletion:fetchCandidates', error);
      this.clearCandidates();
    }
  }

  /**
   * 显示搜索错误占位（两源 IPC 全失败时）
   *
   * 与 showLoading 同构：复用 .completion-item 类名让高度计算兼容，
   * aria-hidden="true" 避免屏幕阅读器误报，candidates 为空使键盘导航失效。
   * 用户修改输入后触发新请求，自然替换错误占位。
   */
  private showErrorPlaceholder(): void {
    this.candidates = [];
    this.selectedIndex = -1;
    this.totalCandidatesCount = 0;
    delete this.listEl.dataset.footer;
    this.listEl.innerHTML = '';

    const li = document.createElement('li');
    // 复用 completion-item + completion-loading 类名（错误态视觉与 loading 同构）
    li.className = 'completion-item completion-loading completion-error';
    li.textContent = '搜索失败，修改输入重试';
    li.setAttribute('aria-hidden', 'true');
    this.listEl.appendChild(li);

    this.showListContainer();
  }

  /**
   * 显示"无匹配候选"占位（UX-QI-10）
   *
   * 两源搜索均返回空结果时显示，与 showLoading / showErrorPlaceholder 形成三态一致的占位体系：
   *   - 搜索中（showLoading）：蓝色 "搜索中…"
   *   - 无匹配（本方法）：灰色 "无匹配，换个词试试"
   *   - 搜索出错（showErrorPlaceholder）：黄色 "搜索失败，修改输入重试"
   *
   * 让用户能明确区分"还在搜" / "搜不到" / "搜出错"三种状态，
   * 而非统一表现为候选列表消失（原 clearCandidates 行为会让用户疑惑"是不是浮窗坏了"）。
   *
   * 复用 .completion-item + .completion-loading 类名让高度计算兼容（querySelectorAll 计数为 1），
   * candidates 为空使键盘导航天然失效（handleKeyDown 检查 length===0）。
   * aria-hidden="true" 避免屏幕阅读器将占位项误报为可选项。
   */
  private showEmptyPlaceholder(): void {
    this.candidates = [];
    this.selectedIndex = -1;
    this.totalCandidatesCount = 0;
    delete this.listEl.dataset.footer;
    this.listEl.innerHTML = '';

    const li = document.createElement('li');
    // 复用 completion-item + completion-loading 类名（无匹配态视觉与 loading 同构，颜色由 muted 区分）
    li.className = 'completion-item completion-loading completion-empty';
    li.textContent = '无匹配，换个词试试';
    li.setAttribute('aria-hidden', 'true');
    this.listEl.appendChild(li);

    this.showListContainer();
  }

  /**
   * 显示搜索 loading 占位
   *
   * IPC 发出后、返回前的过渡状态。在候选列表容器中显示"搜索中…"占位项。
   * 复用 .completion-item 类名让 onListChange 高度计算天然兼容（querySelectorAll 计数为 1）。
   * loading 期间 candidates 数组为空，键盘导航天然失效。
   * aria-hidden="true" 避免屏幕阅读器将占位项误报为可选项。
   */
  private showLoading(): void {
    this.candidates = [];
    this.selectedIndex = -1;
    // loading 期间清除 footer 标记和总数，避免 loading 项 + 残留 footer 同时出现
    this.totalCandidatesCount = 0;
    delete this.listEl.dataset.footer;
    this.listEl.innerHTML = '';

    const li = document.createElement('li');
    // 复用 completion-item 类名让高度计算兼容，额外加 loading 修饰符控制样式
    li.className = 'completion-item completion-loading';
    li.textContent = '搜索中…';
    li.setAttribute('aria-hidden', 'true');
    this.listEl.appendChild(li);

    this.showListContainer();
  }

  /**
   * 显示候选列表容器（移除 hidden + aria-expanded + 通知窗口调整高度）
   *
   * showLoading 和 renderCandidates 共用的列表显示逻辑。
   */
  private showListContainer(): void {
    this.listEl.classList.remove('hidden');
    this.inputField.setAttribute('aria-expanded', 'true');
    this.onListChangeCallback?.(true);
  }

  /**
   * 合并两个数据源的候选结果
   *
   * L1 source 语义感知：
   *   - 记忆候选读取 m.source 字段，映射为中文标签（洞察/偏好/作品）
   *   - 排除 persona/rule/skill/guardrail（已在 system prompt 注入，补全候选不应重复）
   *   - 多样性过滤从"二分（记忆/对话）"升级为"多源（洞察/偏好/作品/对话）"
   *
   * - 记忆搜索结果：取 contentPreview，按 source 映射标签，score 用原值（0-1 归一化）
   * - 对话搜索结果：取 content（截断），标记"对话"，score 按关键词匹配位置计算（开头高、末尾低）
   * - 采纳 boost：已被用户采纳过的候选项 score 获得提升（最多 +0.3）
   * - 去重：相同文本（trim 后）只保留 score 较高的
   * - 排序：score 降序
   * - 多样性：同 sourceLabel 最多保留 MAX_PER_SOURCE 个（防止 Top-5 来源单一）
   * - 截断：取 Top-5
   *
   * score 量纲设计：
   *   - 记忆 score 来自内核混合搜索，已经是 0-1 归一化的相关度
   *   - 对话 score 基于关键词匹配位置：在内容开头得 0.6，末尾得 0.4（低于记忆，对话作为兜底）
   *   - 意图感知：短查询（≤5 字符）视为"续写"场景，对话 score +0.1 boost（0.5-0.7），
   *     使近期对话在续写时可超越中等相关度的记忆
   *   - 采纳 boost 在去重后、排序前应用，确保 boost 不影响去重逻辑
   *
   * @param query 用户输入的查询文本（用于计算对话候选的匹配位置 score）
   * @param memories 记忆搜索结果
   * @param messages 对话搜索结果
   * @returns 合并后的候选列表
   */
  private mergeCandidates(
    query: string,
    memories: Array<{ id: string; contentPreview: string; score: number; source?: string }>,
    messages: Array<{ content: string; role: string }>,
  ): CompletionItem[] {
    const candidates: CompletionItem[] = [];

    // 记忆搜索结果：结构化洞察/偏好/投影，score 用内核返回的归一化值
    // L1 source 语义感知：读取 m.source 字段，映射为中文标签；
    // 排除 persona/rule/skill/guardrail（已在 system prompt 注入，补全候选重复会干扰输入）
    // L2 采纳反哺：保留 m.id 到 memoryId，用户采纳时通过此 id 反哺内核 score
    // 记忆候选的 fullText 不在此处设置（contentPreview 已被内核截断），
    // 选中时通过 showMemory IPC 回库查全量内容
    for (const m of memories) {
      const text = m.contentPreview?.trim();
      if (!text) continue;
      // 排除配置型记忆（persona/rule/skill/guardrail）——这些已在 system prompt 注入，
      // 出现在补全候选中会造成"系统提示"与"用户输入候选"语义重复
      if (m.source && EXCLUDED_SOURCES.has(m.source)) continue;
      // source 标签映射：insight→洞察 / profile→偏好 / work-projection→作品 / 未知→记忆
      const sourceLabel = (m.source && SOURCE_LABEL_MAP[m.source]) || '记忆';
      candidates.push({
        text: truncate(text, PREVIEW_MAX_LENGTH),
        // 记忆候选全量文本由选中时 showMemory IPC 回库查，此处不设 fullText
        sourceLabel,
        score: m.score,
        memoryId: m.id,
      });
    }

    // 对话搜索结果：历史消息（优先 user 角色，更贴近用户表达习惯）
    // score 基于关键词在内容中的匹配位置：开头高（0.6），末尾低（0.4）
    // 意图感知：短查询（≤5 字符）视为"续写"场景，对话候选获得 boost，
    //   使近期对话在续写时优先于结构化记忆（用户更可能想补全刚说过的话）
    // 对话候选的 fullText 存完整原文（m.content），选中时直接同步填充，无需回库查
    const isShortQuery = query.length <= SHORT_QUERY_THRESHOLD;
    messages.forEach((m) => {
      const text = m.content?.trim();
      if (!text) return;
      // 过滤 assistant 回复（用户补全不需要 AI 说过的话）
      if (m.role === 'assistant') return;
      // 计算关键词匹配位置：位置越靠前，相关度越高（话题核心词通常在开头）
      const matchPos = text.toLowerCase().indexOf(query.toLowerCase());
      const positionRatio = matchPos >= 0 ? matchPos / text.length : 1;
      const baseScore = Math.max(0.4, MESSAGE_SCORE_BASE - positionRatio * MESSAGE_SCORE_POSITION_PENALTY);
      const intentBoost = isShortQuery ? CONVERSATION_SHORT_QUERY_BOOST : 0;
      candidates.push({
        text: truncate(text, PREVIEW_MAX_LENGTH),
        // 对话候选全量文本：搜索结果中 m.content 已是完整原文，直接存为 fullText
        fullText: text,
        sourceLabel: '对话',
        score: baseScore + intentBoost,
      });
    });

    // 去重：相同文本只保留 score 较高的（boost 在去重后应用，避免 boost 影响去重判断）
    const seen = new Map<string, CompletionItem>();
    for (const c of candidates) {
      const key = this.dedupKey(c.text);
      const existing = seen.get(key);
      if (!existing || c.score > existing.score) {
        seen.set(key, c);
      }
    }

    // 采纳 boost：已被用户采纳过的候选项 score 获得提升
    const boosted = Array.from(seen.values()).map((c) => {
      const boost = this.getAdoptionBoost(c.text);
      return boost > 0 ? { ...c, score: c.score + boost } : c;
    });

    // 排序：score 降序
    const sorted = boosted.sort((a, b) => b.score - a.score);

    // 同源多样性过滤：每个 sourceLabel 最多保留 MAX_PER_SOURCE 个候选项，
    // 防止 Top-5 全部来自同一数据源（如全是对话历史）。贪心遍历已排序列表，
    // 优先保留高分项，同时保证来源分布均衡。
    const diversified: CompletionItem[] = [];
    const sourceCount = new Map<string, number>();
    for (const c of sorted) {
      const count = sourceCount.get(c.sourceLabel) ?? 0;
      if (count < MAX_PER_SOURCE) {
        diversified.push(c);
        sourceCount.set(c.sourceLabel, count + 1);
      }
    }

    // 记录过滤后的总数，供 renderCandidates 判断是否追加"共 N 项"footer
    this.totalCandidatesCount = diversified.length;
    return diversified.slice(0, MAX_CANDIDATES);
  }

  /**
   * 生成去重/采纳 key（文本小写化）
   *
   * 用于 mergeCandidates 去重、recordAdoption 记录、getAdoptionBoost 查找，
   * 三处共用同一 key 逻辑确保 boost 能命中已采纳的候选项。
   * 使用完整文本（已截断到 PREVIEW_MAX_LENGTH=80）而非前缀截断，避免误去重。
   */
  private dedupKey(text: string): string {
    return text.toLowerCase();
  }

  /**
   * 记录用户采纳的候选项（←→/Click 确认时调用）
   *
   * 采纳次数累积，用于下次合并候选时 boost 该候选项的 score。
   * key 与去重逻辑一致（dedupKey），确保 boost 能命中。
   * 同步写入 localStorage，实现跨会话学习。
   * 超过 MAX_ADOPTION_ENTRIES 时淘汰最低频项（近似 LRU）。
   *
   * 同时记录采纳事件到统计埋点（position 用于计算 Top-1 命中率/平均位置）。
   *
   * @param text 采纳的候选文本
   * @param memoryId 记忆 ID（可选，对话候选无）
   * @param position 采纳位置（0-based，0=Top-1）
   */
  private recordAdoption(text: string, memoryId?: string, position?: number): void {
    const key = this.dedupKey(text);
    const count = this.adoptedTexts.get(key) ?? 0;
    this.adoptedTexts.set(key, count + 1);
    // 容量治理：超出上限时淘汰最低频项（防止 localStorage 无限膨胀）
    if (this.adoptedTexts.size > MAX_ADOPTION_ENTRIES) {
      this.evictLowestFrequency();
    }
    this.saveAdoptions();
    // L2 采纳反哺内核：将用户行为反馈到内核 Memory.score（跨会话生效）
    // fire-and-forget：失败不影响补全流程（渲染层 adoptedTexts 已记录）
    if (memoryId) {
      this.boostMemoryToKernel(memoryId);
    }
    // 记录采纳事件到统计埋点（position 缺省时用 selectedIndex 兜底）
    const adoptedPosition = position ?? this.selectedIndex;
    getCompletionMetrics().recordAdoption(this.currentQuery, text, adoptedPosition);
  }

  /**
   * L2 采纳反哺内核 — 异步提升记忆 score
   *
   * 通过 IPC 调用内核 writeBoost，将用户采纳行为反馈到 Memory.score，
   * 实现"越常用越重要"的主动学习。与渲染层 adoptedTexts 互补：
   *   - adoptedTexts：即时 boost（渲染层排序 +0.1/次），仅当前设备生效
   *   - boostMemory：持久 boost（内核 score +0.05/次），跨设备/跨会话生效
   *
   * fire-and-forget：IPC 失败静默降级（渲染层 boost 仍生效）。
   */
  private boostMemoryToKernel(memoryId: string): void {
    this.api.boostMemory?.(memoryId).catch((err: unknown) => {
      // 静默降级：渲染层 adoptedTexts 已记录，内核 boost 失败不影响补全流程
      // 仅记录日志便于排查（如 IPC 通道未注册、内核存储不可用等）
      // 'warn' 级别：可降级的非致命错误，与 searchMemories/searchSessionMessages 失败降级同语义
      reportError('QuickInputCompletion:boostMemory', err, 'warn');
    });
  }

  /**
   * 淘汰最低频的采纳记录（近似 LRU）
   *
   * Map 的迭代顺序是插入顺序，重新 set 已有 key 会刷新到末尾。
   * 因此优先删除迭代中遇到的前 N 个最低频项，使总条目数回到上限以内。
   */
  private evictLowestFrequency(): void {
    // 找到最低频项的 key
    let minKey: string | null = null;
    let minCount = Infinity;
    for (const [k, c] of this.adoptedTexts) {
      if (c < minCount) {
        minCount = c;
        minKey = k;
      }
    }
    if (minKey !== null) {
      this.adoptedTexts.delete(minKey);
    }
  }

  /**
   * 从 localStorage 加载采纳记录
   *
   * 使用 safeGetJSON 统一 try-catch 静默降级（ADR-017 枝叶层 2 次提取）：
   * 隐私模式/cookie 禁用/JSON 损坏时返回 null，降级为空 Map。
   * 存储格式：JSON.stringify(Object.fromEntries(adoptedTexts))
   */
  private loadAdoptions(): Map<string, number> {
    const obj = safeGetJSON<Record<string, number> | null>(ADOPTION_STORAGE_KEY, null);
    return obj ? new Map(Object.entries(obj)) : new Map();
  }

  /**
   * 将采纳记录写入 localStorage
   *
   * 使用 safeSetJSON 统一 try-catch 静默降级。
   * 仅在 recordAdoption 时写入，避免每次 getAdoptionBoost 查询都触发 IO。
   */
  private saveAdoptions(): void {
    safeSetJSON(ADOPTION_STORAGE_KEY, Object.fromEntries(this.adoptedTexts));
  }

  /**
   * 获取候选项的采纳 boost 值
   *
   * boost = 0.1 * min(采纳次数, 3)，最多 +0.3。
   * 未被采纳过的候选项返回 0。
   */
  private getAdoptionBoost(text: string): number {
    const key = this.dedupKey(text);
    const count = this.adoptedTexts.get(key);
    if (!count) return 0;
    return Math.min(count, ADOPTION_BOOST_MAX_COUNT) * ADOPTION_BOOST_PER_COUNT;
  }

  /**
   * 获取候选项的累计采纳次数（UX-QI-06）
   *
   * 与 getAdoptionBoost 不同：返回原始次数（不受 ADOPTION_BOOST_MAX_COUNT 上限截断），
   * 供 renderCandidates 渲染"你常用这个（已采纳 N 次）"提示。
   * 未被采纳过返回 0。
   */
  private getAdoptionCount(text: string): number {
    return this.adoptedTexts.get(this.dedupKey(text)) ?? 0;
  }

  /**
   * 渲染候选列表
   *
   * 每个候选项包含：来源标签 + 文本预览。
   * 选中态通过 CSS 类 `selected` 控制。
   *
   * 候选项补 WAI-ARIA combobox with listbox 模式属性：
   * - role="option"：声明为可选候选项
   * - id="completion-item-{i}"：供 textarea 的 aria-activedescendant 引用
   * - aria-selected：同步选中态
   * 同时更新 textarea 的 aria-expanded=true 表示候选列表已展开。
   */
  private renderCandidates(candidates: CompletionItem[]): void {
    this.candidates = candidates;
    this.selectedIndex = -1;

    // 清空列表
    this.listEl.innerHTML = '';
    if (candidates.length === 0) {
      // UX-QI-10：两源搜索均返回空时显示"无匹配"占位，与 loading/error 形成三态一致的占位体系
      // 让用户能区分"搜索中" / "无匹配" / "搜索出错"三种状态，而非统一表现为列表消失
      this.showEmptyPlaceholder();
      return;
    }

    // 构建候选项 DOM（用 entries() 避免索引访问返回 T | undefined）
    for (const [i, item] of candidates.entries()) {
      const li = document.createElement('li');
      li.className = 'completion-item';
      li.dataset.index = String(i);
      // 候选项语义 + id（供 aria-activedescendant 引用）
      li.setAttribute('role', 'option');
      li.id = `${COMPLETION_ITEM_ID_PREFIX}${i}`;
      li.setAttribute('aria-selected', 'false');
      li.tabIndex = -1;

      // UX-QI-06：已采纳过的候选项加 .adopted 修饰类 + title 提示
      // 通过 adoptedTexts 记录判断（getAdoptionBoost > 0 即曾被采纳），
      // 让"越用越准"的学习行为对用户可见，强化核心差异化感知
      const adoptionCount = this.getAdoptionCount(item.text);
      if (adoptionCount > 0) {
        li.classList.add('adopted');
        li.title = `你常用这个（已采纳 ${adoptionCount} 次）`;
      }

      // 来源标签
      const label = document.createElement('span');
      label.className = 'completion-label flex-shrink-0';
      label.textContent = item.sourceLabel;

      // 文本预览：高亮匹配关键词（UX-QI-05）
      // 用户输入的 query 在候选文本中匹配的部分用 <mark> 包裹，便于一眼定位相关性
      // 大小写不敏感匹配但保留原文大小写；query 为空或未命中时降级为纯文本
      const text = document.createElement('span');
      text.className = 'completion-text text-truncate';
      this.highlightMatch(text, item.text, this.currentQuery);

      li.appendChild(label);
      li.appendChild(text);

      // UX-QI-06：已采纳候选项在文本末尾追加 ★ 标记（视觉强化"常用"信号）
      if (adoptionCount > 0) {
        const star = document.createElement('span');
        star.className = 'completion-adopted-mark flex-shrink-0';
        star.textContent = '★';
        star.setAttribute('aria-hidden', 'true');
        li.appendChild(star);
      }

      // 点击选择
      li.addEventListener('click', () => {
        this.selectedIndex = i;
        this.updateSelection();
        // 传入 position=i（点击位置），用于统计 Top-1 命中率/平均位置
        this.recordAdoption(item.text, item.memoryId, i);
        // 清除候选列表由回调负责（记忆候选异步填充后清除，对话候选同步填充后清除）
        this.onSelectCallback?.(item);
      });

      // hover 高亮（同步 selectedIndex，键盘和鼠标一致）
      li.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        this.updateSelection();
      });

      this.listEl.appendChild(li);
    }

    // 候选总数超过最大显示数时，在列表底部追加"共 N 项"footer
    // footer 不含 .completion-item 类（不参与 querySelectorAll 计数/不作为可选选项）
    // 通过 dataset.footer='true' 标记，让 quickInput.ts 的高度计算感知 footer 并预留空间
    if (this.totalCandidatesCount > MAX_CANDIDATES) {
      const footer = document.createElement('li');
      footer.className = 'completion-footer';
      footer.textContent = `共 ${this.totalCandidatesCount} 项`;
      footer.setAttribute('aria-hidden', 'true');
      this.listEl.appendChild(footer);
      this.listEl.dataset.footer = 'true';
    } else {
      delete this.listEl.dataset.footer;
    }

    // 显示列表（复用 showListContainer，枝叶层 2 次提取）
    this.showListContainer();

    // 记录展示事件（候选列表展示给用户时）
    // shownCount = candidates.length（≤5），totalCandidatesCount = slice 前总数
    getCompletionMetrics().recordShown(this.currentQuery, candidates.length, this.totalCandidatesCount);
  }

  /**
   * 在候选文本容器中高亮匹配的查询关键词（UX-QI-05）
   *
   * 将文本拆分为「前缀 + 匹配段 + 后缀」三段，匹配段用 <mark class="completion-match"> 包裹。
   * 大小写不敏感匹配（toLowerCase 比较），但保留原文大小写渲染。
   * 未命中匹配时降级为纯 textContent（与原行为一致，无 XSS 风险）。
   *
   * 仅高亮第一个匹配 occurrence，避免长文本中出现多次匹配时视觉过载。
   *
   * @param container 文本容器元素（已创建，本方法负责填充内容）
   * @param text 候选原始文本（已截断到 PREVIEW_MAX_LENGTH）
   * @param query 用户当前查询文本
   */
  private highlightMatch(container: HTMLElement, text: string, query: string): void {
    // query 为空或长度不足时降级为纯文本（与原 textContent 行为一致）
    if (!query || query.length < MIN_QUERY_LENGTH) {
      container.textContent = text;
      return;
    }
    // 大小写不敏感定位首个匹配位置
    const matchIdx = text.toLowerCase().indexOf(query.toLowerCase());
    if (matchIdx < 0) {
      // 候选文本不直接包含 query（可能来自语义搜索/对话位置匹配），降级纯文本
      container.textContent = text;
      return;
    }
    // 拆分三段：前缀 + 匹配段 + 后缀，匹配段用 <mark> 强调
    const prefix = text.slice(0, matchIdx);
    const match = text.slice(matchIdx, matchIdx + query.length);
    const suffix = text.slice(matchIdx + query.length);

    if (prefix) {
      container.appendChild(document.createTextNode(prefix));
    }
    const mark = document.createElement('mark');
    mark.className = 'completion-match';
    mark.textContent = match;
    container.appendChild(mark);
    if (suffix) {
      container.appendChild(document.createTextNode(suffix));
    }
  }

  /**
   * 更新选中态样式
   *
   * 清除所有候选项的 selected 类，给当前选中项添加。
   *
   * 同步 aria-selected 属性 + textarea 的 aria-activedescendant，
   * 使屏幕阅读器跟随键盘焦点播报当前候选项。
   */
  private updateSelection(): void {
    const items = this.listEl.querySelectorAll('.completion-item');
    items.forEach((el, idx) => {
      const selected = idx === this.selectedIndex;
      el.classList.toggle('selected', selected);
      el.setAttribute('aria-selected', selected.toString());
    });
    // 同步 aria-activedescendant 指向当前选中项（无选中时清空）
    if (this.selectedIndex >= 0) {
      this.inputField.setAttribute('aria-activedescendant', `${COMPLETION_ITEM_ID_PREFIX}${this.selectedIndex}`);
    } else {
      this.inputField.setAttribute('aria-activedescendant', '');
    }
  }

  /**
   * 清空候选列表（外部调用接口）
   *
   * 先取消待触发的防抖定时器 + 递增请求序号使进行中的异步 IPC 响应过期，
   * 再清空 DOM 和状态。防止两条竞态让候选列表在 clear 后"复活"：
   * - 竞态 A：debounceTimer 还在倒计时，到期后触发 fetchCandidates 重新渲染
   * - 竞态 B：fetchCandidates 已发起 IPC，clear 后 IPC 返回，lastRequestId 未变导致请求未过期继续渲染
   */
  clear(): void {
    // 取消待触发的防抖定时器（对应竞态 A）
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // 递增请求序号，使进行中的异步 IPC 响应过期（对应竞态 B）
    // fetchCandidates 第 394 行 if (requestId !== this.lastRequestId) return; 会丢弃旧响应
    this.lastRequestId++;
    this.clearCandidates();
  }

  /**
   * 清空候选列表
   *
   * 清空 DOM、重置状态、隐藏列表容器、通知窗口收起高度。
   *
   * 候选列表收起后同步 textarea 的 aria-expanded=false，
   * 并清空 aria-activedescendant 避免悬空引用。
   */
  private clearCandidates(): void {
    this.candidates = [];
    this.selectedIndex = -1;
    // 清空时同步清除 footer 标记和总数，避免残留状态影响下次渲染
    this.totalCandidatesCount = 0;
    delete this.listEl.dataset.footer;
    this.listEl.innerHTML = '';
    this.listEl.classList.add('hidden');
    // 候选列表收起
    this.inputField.setAttribute('aria-expanded', 'false');
    this.inputField.setAttribute('aria-activedescendant', '');
    this.onListChangeCallback?.(false);
  }

  /**
   * 清理资源（窗口关闭时调用）
   *
   * 移除事件监听器、清空定时器、清空候选列表。
   */
  cleanup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.inputField.removeEventListener('input', this.handleInput);
    this.inputField.removeEventListener('keydown', this.handleKeyDown);
    this.clearCandidates();
  }
}
