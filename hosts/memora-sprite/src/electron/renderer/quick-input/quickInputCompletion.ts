/**
 * 快速输入补全管理器 — Phase 2 补全能力
 *
 * 职责：
 *   1. 监听输入框内容变化，防抖触发补全请求
 *   2. 并行调用 searchMemories + searchSessionMessages 两个 IPC
 *   3. 合并去重 + 按相关度排序，取 Top-5 候选
 *   4. 渲染候选列表，支持 ↓↑ 键盘导航 + ←→ 填充回填
 *   5. 取消上一次未完成的请求（避免乱序）
 *   6. 采纳反馈回路：用户采纳过的候选项获得 score boost（越用越准）
 *   7. 搜索 loading 反馈：IPC 发出后显示"搜索中..."占位，返回后自然替换
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
 * score 量纲设计：
 *   - 记忆 score：内核返回的归一化相关度（0-1）
 *   - 对话 score：起始 0.6 递减 0.05（低于记忆，对话作为兜底）
 *   - 采纳 boost：+0.1 * min(采纳次数, 3)，最多 +0.3（单次会话内有效）
 */
import type { ElectronAPI } from '../../preload.js';
// 复用渲染进程统一日志函数（双通道：console + 主进程 logger），替代本地 logCompletion
import { reportError } from '../helpers/errorHelpers.js';

/**
 * 补全管理器所需的 ElectronAPI 子集
 *
 * 仅依赖两个搜索 IPC，与 Phase 1 的 confirmQuickInput/closeQuickInput 解耦。
 */
export type CompletionElectronAPI = Pick<ElectronAPI, 'searchMemories' | 'searchSessionMessages'>;

/**
 * 补全目标元素类型
 *
 * 同时支持 quick-input 浮窗的 HTMLInputElement 和主对话输入框的 HTMLTextAreaElement。
 * 两者都有 value 属性和 input/keydown 事件，补全逻辑无差异。
 */
export type CompletionTarget = HTMLInputElement | HTMLTextAreaElement;

/** 补全候选项统一结构（合并记忆搜索 + 对话搜索结果） */
export interface CompletionItem {
  /** 候选文本（用于回填输入框） */
  text: string;
  /** 来源标签（记忆/对话） */
  sourceLabel: string;
  /** 相关度分数（0-1，用于排序） */
  score: number;
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
/** 对话候选 score 起始值（低于记忆候选，让结构化记忆优先排序） */
const MESSAGE_SCORE_BASE = 0.6;
/** 对话候选 score 每条递减量 */
const MESSAGE_SCORE_STEP = 0.05;
/** 采纳反馈 boost 上限（最多累积 3 次采纳） */
const ADOPTION_BOOST_MAX_COUNT = 3;
/** 每次采纳的 score 提升量 */
const ADOPTION_BOOST_PER_COUNT = 0.1;

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
 */
export class QuickInputCompletion {
  /** 输入框元素（input 或 textarea） */
  private inputField: CompletionTarget;
  /** 候选列表容器元素 */
  private listEl: HTMLElement;
  /** ElectronAPI 子集（搜索能力） */
  private api: CompletionElectronAPI;
  /** 候选项选择回调（←→ 填充时触发，参数为选中的候选项文本） */
  private onSelectCallback: ((text: string) => void) | null = null;
  /** 候选列表变化回调（用于通知窗口调整高度） */
  private onListChangeCallback: ((visible: boolean) => void) | null = null;

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
  /** UX-0714-4：本次合并后的候选总数（slice 前），用于判断是否需要显示"共 N 项"footer */
  private totalCandidatesCount = 0;

  /**
   * @param inputField 输入框元素（input 或 textarea）
   * @param listEl 候选列表容器元素（ul 或 div）
   * @param api ElectronAPI 子集
   */
  constructor(inputField: CompletionTarget, listEl: HTMLElement, api: CompletionElectronAPI) {
    this.inputField = inputField;
    this.listEl = listEl;
    this.api = api;
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
   * 用户按 ←→ 或点击候选项时触发，参数为选中的候选项文本。
   * 回调负责将文本回填到输入框（通常设置 inputField.value = text）。
   */
  onSelect(cb: (text: string) => void): void {
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
   * 输入事件处理器（防抖）
   *
   * 输入内容变化后等待 DEBOUNCE_MS，若期间无新输入则触发补全。
   * 输入长度 < MIN_QUERY_LENGTH 时清空候选列表。
   */
  private handleInput = (): void => {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const query = this.inputField.value.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      this.clearCandidates();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      void this.fetchCandidates(query);
    }, DEBOUNCE_MS);
  };

  /**
   * 键盘事件处理器（↓↑ 导航 + ←→ 填充）
   *
   * - ArrowDown：选中下一项（循环到顶部）
   * - ArrowUp：选中上一项（循环到底部）
   * - ArrowLeft/ArrowRight：将选中项填充到输入框（仅在已导航时拦截）
   *
   * 未用方向键导航时，←→ 不拦截，保持光标移动功能。
   * Tab 不在此处理，统一由 quickInput.ts / 主对话输入框各自处理。
   */
  private handleKeyDown = (e: KeyboardEvent): void => {
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
      this.recordAdoption(selected.text);
      this.onSelectCallback?.(selected.text);
      this.clearCandidates();
    }
  };

  /**
   * 获取补全候选（并行调用两个 IPC）
   *
   * 使用递增 requestId 取消乱序响应：若发起新请求时旧请求未返回，
   * 旧响应的 requestId 与 lastRequestId 不匹配，直接丢弃。
   *
   * UX-0714-1：IPC 发出后立即显示 loading 占位，避免用户等待时无反馈。
   * loading 期间 candidates 为空，键盘导航天然失效（handleKeyDown 检查 length===0）。
   * IPC 返回后由 renderCandidates 或 clearCandidates 自然替换 loading。
   */
  private async fetchCandidates(query: string): Promise<void> {
    const requestId = ++this.lastRequestId;
    // IPC 发出前显示 loading 占位（防抖结束后才到达此处，不会在输入过程中闪烁）
    this.showLoading();

    try {
      // 并行调用两个搜索 IPC，单个失败时降级为空候选（补全是辅助功能，不阻断主流程）
      const [memoriesResult, messagesResult] = await Promise.all([
        this.api.searchMemories(query).catch((err) => {
          // IPC 失败时降级为空候选，warn 级别上报（可降级的非致命错误）
          reportError('QuickInputCompletion:searchMemories', err, 'warn');
          return { hits: [] };
        }),
        this.api.searchSessionMessages({ keyword: query, limit: 20 }).catch((err) => {
          // IPC 失败时降级为空候选，warn 级别上报（可降级的非致命错误）
          reportError('QuickInputCompletion:searchSessionMessages', err, 'warn');
          return { results: [] };
        }),
      ]);

      // 请求已过期（用户已输入新内容），丢弃旧响应（loading 由最新请求接管）
      if (requestId !== this.lastRequestId) return;

      const candidates = this.mergeCandidates(memoriesResult.hits, messagesResult.results);
      this.renderCandidates(candidates);
    } catch (error) {
      reportError('QuickInputCompletion:fetchCandidates', error);
      this.clearCandidates();
    }
  }

  /**
   * 显示搜索 loading 占位
   *
   * IPC 发出后、返回前的过渡状态。在候选列表容器中显示"搜索中..."占位项。
   * 复用 .completion-item 类名让 onListChange 高度计算天然兼容（querySelectorAll 计数为 1）。
   * loading 期间 candidates 数组为空，键盘导航天然失效。
   * aria-hidden="true" 避免屏幕阅读器将占位项误报为可选项。
   */
  private showLoading(): void {
    this.candidates = [];
    this.selectedIndex = -1;
    // UX-0714-4：loading 期间清除 footer 标记和总数，避免 loading 项 + 残留 footer 同时出现
    this.totalCandidatesCount = 0;
    delete this.listEl.dataset.footer;
    this.listEl.innerHTML = '';

    const li = document.createElement('li');
    // 复用 completion-item 类名让高度计算兼容，额外加 loading 修饰符控制样式
    li.className = 'completion-item completion-loading';
    li.textContent = '搜索中...';
    li.setAttribute('aria-hidden', 'true');
    this.listEl.appendChild(li);

    this.showListContainer();
  }

  /**
   * 显示候选列表容器（移除 hidden + aria-expanded + 通知窗口调整高度）
   *
   * showLoading 和 renderCandidates 共用的列表显示逻辑（ADR-017 枝叶层 2 次提取）。
   */
  private showListContainer(): void {
    this.listEl.classList.remove('hidden');
    this.inputField.setAttribute('aria-expanded', 'true');
    this.onListChangeCallback?.(true);
  }

  /**
   * 合并两个数据源的候选结果
   *
   * - 记忆搜索结果：取 contentPreview，标记"记忆"，score 用原值（0-1 归一化）
   * - 对话搜索结果：取 content（截断），标记"对话"，score 按递减顺序估算（起始 0.6，低于记忆）
   * - 采纳 boost：已被用户采纳过的候选项 score 获得提升（最多 +0.3）
   * - 去重：相同文本（trim 后）只保留 score 较高的
   * - 排序：score 降序
   * - 截断：取 Top-5
   *
   * score 量纲设计：
   *   - 记忆 score 来自内核混合搜索，已经是 0-1 归一化的相关度
   *   - 对话 score 起始 0.6（低于记忆），让结构化记忆优先排序，对话作为兜底
   *   - 采纳 boost 在去重后、排序前应用，确保 boost 不影响去重逻辑
   *
   * @param memories 记忆搜索结果
   * @param messages 对话搜索结果
   * @returns 合并后的候选列表
   */
  private mergeCandidates(
    memories: Array<{ contentPreview: string; score: number; source?: string }>,
    messages: Array<{ content: string; role: string }>,
  ): CompletionItem[] {
    const candidates: CompletionItem[] = [];

    // 记忆搜索结果：结构化洞察/偏好，score 用内核返回的归一化值
    for (const m of memories) {
      const text = m.contentPreview?.trim();
      if (!text) continue;
      candidates.push({
        text: this.truncate(text, PREVIEW_MAX_LENGTH),
        sourceLabel: '记忆',
        score: m.score,
      });
    }

    // 对话搜索结果：历史消息（优先 user 角色，更贴近用户表达习惯）
    // score 起始 0.6（低于记忆），递减 0.05，最低 0.4
    messages.forEach((m, idx) => {
      const text = m.content?.trim();
      if (!text) return;
      // 过滤 assistant 回复（用户补全不需要 AI 说过的话）
      if (m.role === 'assistant') return;
      candidates.push({
        text: this.truncate(text, PREVIEW_MAX_LENGTH),
        sourceLabel: '对话',
        score: Math.max(0.4, MESSAGE_SCORE_BASE - idx * MESSAGE_SCORE_STEP),
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

    // 排序：score 降序，取 Top-5
    // UX-0714-4：记录 slice 前的总数，供 renderCandidates 判断是否追加"共 N 项"footer
    const sorted = boosted.sort((a, b) => b.score - a.score);
    this.totalCandidatesCount = sorted.length;
    return sorted.slice(0, MAX_CANDIDATES);
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
   */
  private recordAdoption(text: string): void {
    const key = this.dedupKey(text);
    const count = this.adoptedTexts.get(key) ?? 0;
    this.adoptedTexts.set(key, count + 1);
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
      this.clearCandidates();
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

      // 来源标签
      const label = document.createElement('span');
      label.className = 'completion-label';
      label.textContent = item.sourceLabel;

      // 文本预览（textContent 防 XSS）
      const text = document.createElement('span');
      text.className = 'completion-text';
      text.textContent = item.text;

      li.appendChild(label);
      li.appendChild(text);

      // 点击选择
      li.addEventListener('click', () => {
        this.selectedIndex = i;
        this.updateSelection();
        this.recordAdoption(item.text);
        this.onSelectCallback?.(item.text);
        this.clearCandidates();
      });

      // hover 高亮（同步 selectedIndex，键盘和鼠标一致）
      li.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        this.updateSelection();
      });

      this.listEl.appendChild(li);
    }

    // UX-0714-4：候选总数超过最大显示数时，在列表底部追加"共 N 项"footer
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
   */
  clear(): void {
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
    // UX-0714-4：清空时同步清除 footer 标记和总数，避免残留状态影响下次渲染
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
   * 截断文本（超长时加省略号）
   */
  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '…';
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
