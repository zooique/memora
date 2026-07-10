/**
 * 快速输入补全管理器 — Phase 2 补全能力
 *
 * 职责：
 *   1. 监听输入框内容变化，防抖触发补全请求
 *   2. 并行调用 searchMemories + searchSessionMessages 两个 IPC
 *   3. 合并去重 + 按相关度排序，取 Top-5 候选
 *   4. 渲染候选列表，支持 ↓↑ 键盘导航 + Tab 确认回填
 *   5. 取消上一次未完成的请求（避免乱序）
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
 */
import type { ElectronAPI } from '../../preload.js';

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

/** 防抖延迟（ms）—— 输入停止后等待多久触发补全 */
const DEBOUNCE_MS = 300;
/** 最小触发字符数 —— 少于此值不触发补全（避免空查询） */
const MIN_QUERY_LENGTH = 2;
/** 最大候选数量 */
const MAX_CANDIDATES = 5;
/** 候选项预览文本最大长度（防止过长候选项撑爆浮窗） */
const PREVIEW_MAX_LENGTH = 80;

/**
 * 快速输入补全管理器
 *
 * 使用方式：
 *   1. new QuickInputCompletion(inputField, listEl, api)
 *   2. 用户输入时自动触发补全
 *   3. 用户 Tab 选择候选项时触发 onSelect 回调
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
  /** 候选项选择回调（Tab 确认时触发，参数为选中的候选项文本） */
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
   * 监听 input 事件（防抖触发补全）和 keydown 事件（↓↑ 导航 + Tab 确认）。
   */
  init(): void {
    // 输入事件：防抖触发补全
    this.inputField.addEventListener('input', this.handleInput);
    // 键盘事件：↓↑ 导航 + Tab 确认（Enter/Esc 由 quickInput.ts 处理）
    this.inputField.addEventListener('keydown', this.handleKeyDown);
  }

  /**
   * 注册候选项选择回调
   *
   * 用户按 Tab 或点击候选项时触发，参数为选中的候选项文本。
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
   * 键盘事件处理器（↓↑ 导航 + Tab 确认）
   *
   * - ArrowDown：选中下一项（循环到顶部）
   * - ArrowUp：选中上一项（循环到底部）
   * - Tab：确认当前选中项，回填到输入框
   */
  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.candidates.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.candidates.length;
      this.updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + this.candidates.length) % this.candidates.length;
      this.updateSelection();
    } else if (e.key === 'Tab') {
      if (this.selectedIndex >= 0 && this.selectedIndex < this.candidates.length) {
        e.preventDefault();
        // selectedIndex 已在条件中校验合法范围，索引访问安全，用 ! 断言正视契约
        const selected = this.candidates[this.selectedIndex]!;
        this.onSelectCallback?.(selected.text);
        this.clearCandidates();
      }
    }
  };

  /**
   * 获取补全候选（并行调用两个 IPC）
   *
   * 使用递增 requestId 取消乱序响应：若发起新请求时旧请求未返回，
   * 旧响应的 requestId 与 lastRequestId 不匹配，直接丢弃。
   */
  private async fetchCandidates(query: string): Promise<void> {
    const requestId = ++this.lastRequestId;

    try {
      // 并行调用两个搜索 IPC，单个失败时降级为空候选（补全是辅助功能，不阻断主流程）
      const [memoriesResult, messagesResult] = await Promise.all([
        this.api.searchMemories(query).catch((err) => {
          console.warn('[QuickInputCompletion] searchMemories 失败，降级为空候选', err);
          return { hits: [] };
        }),
        this.api.searchSessionMessages({ keyword: query, limit: 20 }).catch((err) => {
          console.warn('[QuickInputCompletion] searchSessionMessages 失败，降级为空候选', err);
          return { results: [] };
        }),
      ]);

      // 请求已过期（用户已输入新内容），丢弃旧响应
      if (requestId !== this.lastRequestId) return;

      const candidates = this.mergeCandidates(memoriesResult.hits, messagesResult.results);
      this.renderCandidates(candidates);
    } catch (error) {
      console.error('[QuickInputCompletion] 获取补全候选失败:', error);
      this.clearCandidates();
    }
  }

  /**
   * 合并两个数据源的候选结果
   *
   * - 记忆搜索结果：取 contentPreview，标记"记忆"，score 用原值
   * - 对话搜索结果：取 content（截断），标记"对话"，score 按 1-递减顺序估算
   * - 去重：相同文本（trim 后）只保留 score 较高的
   * - 排序：score 降序
   * - 截断：取 Top-5
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

    // 记忆搜索结果：结构化洞察/偏好
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
    // score 按 1-递减估算：第一条 0.9，第二条 0.85，依此类推
    messages.forEach((m, idx) => {
      const text = m.content?.trim();
      if (!text) return;
      // 过滤 assistant 回复（用户补全不需要 AI 说过的话）
      if (m.role === 'assistant') return;
      candidates.push({
        text: this.truncate(text, PREVIEW_MAX_LENGTH),
        sourceLabel: '对话',
        score: Math.max(0.5, 0.9 - idx * 0.05),
      });
    });

    // 去重：相同文本只保留 score 较高的
    const seen = new Map<string, CompletionItem>();
    for (const c of candidates) {
      const key = c.text.slice(0, 40).toLowerCase();
      const existing = seen.get(key);
      if (!existing || c.score > existing.score) {
        seen.set(key, c);
      }
    }

    // 排序：score 降序，取 Top-5
    return Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES);
  }

  /**
   * 渲染候选列表
   *
   * 每个候选项包含：来源标签 + 文本预览。
   * 选中态通过 CSS 类 `selected` 控制。
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

    // 显示列表
    this.listEl.classList.remove('hidden');
    this.onListChangeCallback?.(true);
  }

  /**
   * 更新选中态样式
   *
   * 清除所有候选项的 selected 类，给当前选中项添加。
   */
  private updateSelection(): void {
    const items = this.listEl.querySelectorAll('.completion-item');
    items.forEach((el, idx) => {
      el.classList.toggle('selected', idx === this.selectedIndex);
    });
  }

  /**
   * 清空候选列表
   *
   * 清空 DOM、重置状态、隐藏列表容器、通知窗口收起高度。
   */
  private clearCandidates(): void {
    this.candidates = [];
    this.selectedIndex = -1;
    this.listEl.innerHTML = '';
    this.listEl.classList.add('hidden');
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
