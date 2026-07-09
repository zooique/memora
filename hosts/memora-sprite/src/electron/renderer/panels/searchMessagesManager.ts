/**
 * 对话内容搜索管理器 — 跨会话关键词检索
 *
 * 职责：
 * - 管理搜索弹窗的打开/关闭（按钮点击 + Ctrl+Shift+F 快捷键）
 * - 输入防抖触发搜索（300ms），调用 IPC 跨所有会话检索匹配消息
 * - 按日期倒序分组渲染结果，关键词高亮
 * - 点击结果项触发跳转回调（切换到对应日期的会话）
 * - Esc 关闭、点击遮罩关闭
 *
 * 设计原则：
 * - 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理
 * - 与 UIManager 解耦，通过回调接口通信
 * - 搜索逻辑防抖，避免高频 IPC 调用
 * - 关键词高亮前先 escapeHtml，防止 XSS
 *
 * 与命令面板（CommandPaletteManager）的关系：
 * - 复用相同的居中浮层视觉模式（fixed inset 0 + dialog）
 * - 但结构独立：命令面板搜命令，搜索弹窗搜对话内容
 * - 两者互斥，不会同时打开（z-index 相同，但打开一个时另一个已关闭）
 */
import { EventTracker } from '../helpers/eventTracker.js';
import { clearElement, escapeHtml, formatClock, formatDateKey } from '../helpers/domHelpers.js';

/** 输入防抖时长（毫秒）—— 避免每键入一个字符就触发一次 IPC 搜索 */
const DEBOUNCE_MS = 300;
/** 最小关键词长度 —— 少于 2 个字符时不触发搜索，避免无意义的全量扫描 */
const MIN_KEYWORD_LENGTH = 2;
/** 搜索结果上限 —— 单用户本地 SQLite，50 条足够定位近期内容 */
const SEARCH_LIMIT = 50;

/** 单条搜索结果（与 preload searchSessionMessages 返回结构对齐） */
interface SearchResultItem {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 会话名（如 main） */
  session: string;
  /** 角色（user/assistant/system） */
  role: string;
  /** 消息内容 */
  content: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
}

/**
 * 对话内容搜索管理器类
 *
 * 生命周期：init() 绑定事件 → cleanup() 清理事件 + 回调 + 定时器
 */
export class SearchMessagesManager {
  /** 事件监听器跟踪器 */
  private events = new EventTracker();
  /** 搜索弹窗根元素 */
  private modalEl: HTMLElement | null = null;
  /** 搜索输入框 */
  private inputEl: HTMLInputElement | null = null;
  /** 搜索结果容器 */
  private resultsEl: HTMLElement | null = null;
  /** 防抖定时器句柄 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前是否打开 */
  private isOpen = false;
  /** 上一次搜索的关键词（用于避免重复搜索） */
  private lastKeyword = '';
  /** 搜索中状态标记（防止并发请求） */
  private isSearching = false;
  /** 结果点击回调（由 renderer.ts 注册，跳转到对应日期的会话） */
  private resultClickCallback: ((date: string, session: string) => void) | null = null;

  /**
   * 初始化事件监听器
   *
   * 绑定搜索按钮点击、全局 Ctrl+Shift+F 快捷键、输入防抖、
   * 遮罩点击关闭、Esc 关闭、结果项点击事件委托。
   * 在 UIManager 构造完成后调用。
   */
  init(): void {
    // 绑定 DOM 元素
    this.modalEl = document.getElementById('search-messages-modal');
    this.inputEl = document.getElementById('search-messages-input') as HTMLInputElement | null;
    this.resultsEl = document.getElementById('search-messages-results');

    if (!this.modalEl || !this.inputEl || !this.resultsEl) {
      console.warn('[SearchMessages] 搜索弹窗 DOM 元素缺失，功能降级');
      return;
    }

    // 搜索按钮点击 → 打开弹窗
    const searchBtn = document.getElementById('btn-search-messages');
    if (searchBtn) {
      this.events.addEventListener(searchBtn, 'click', () => {
        this.open();
      });
    }

    // 全局快捷键 Ctrl+Shift+F → 打开/关闭搜索弹窗
    this.events.addEventListener(document, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if ((ke.ctrlKey || ke.metaKey) && ke.shiftKey && (ke.key === 'f' || ke.key === 'F')) {
        ke.preventDefault();
        if (this.isOpen) {
          this.close();
        } else {
          this.open();
        }
      }
    });

    // 输入防抖触发搜索
    this.events.addEventListener(this.inputEl, 'input', () => {
      this.scheduleSearch();
    });

    // 输入框键盘事件：Esc 关闭
    this.events.addEventListener(this.inputEl, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') {
        ke.preventDefault();
        this.close();
      }
    });

    // 点击遮罩层关闭（仅当点击目标是遮罩本身时）
    this.events.addEventListener(this.modalEl, 'click', (e) => {
      if (e.target === this.modalEl) {
        this.close();
      }
    });

    // 结果项点击事件委托（避免每条结果单独绑定监听器）
    this.events.addEventListener(this.resultsEl, 'click', (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('.search-messages-item[data-date]');
      if (item) {
        const date = item.dataset.date;
        const session = item.dataset.session;
        if (date && session && this.resultClickCallback) {
          this.close();
          this.resultClickCallback(date, session);
        }
      }
    });
  }

  /**
   * 打开搜索弹窗
   *
   * 清空输入和结果，聚焦输入框，阻止背景滚动。
   */
  open(): void {
    if (!this.modalEl || !this.inputEl || !this.resultsEl) return;

    this.modalEl.classList.remove('hidden');
    this.isOpen = true;
    this.lastKeyword = '';

    // 清空输入和结果（初始显示空状态提示）
    this.inputEl.value = '';
    this.renderEmpty('输入关键词搜索对话内容');
    this.inputEl.focus();

    // 阻止背景滚动
    document.body.style.overflow = 'hidden';
  }

  /**
   * 关闭搜索弹窗
   *
   * 隐藏弹窗，清空输入和结果，取消待执行的防抖定时器，恢复背景滚动。
   */
  close(): void {
    if (!this.modalEl) return;

    this.modalEl.classList.add('hidden');
    this.isOpen = false;
    this.lastKeyword = '';

    // 取消待执行的防抖搜索
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // 清空输入（避免下次打开时残留）
    if (this.inputEl) {
      this.inputEl.value = '';
    }

    // 恢复背景滚动
    document.body.style.overflow = '';
  }

  /**
   * 注册搜索结果点击回调
   *
   * @param cb 回调函数（接收 date 和 session 参数，由 renderer.ts 注册跳转逻辑）
   */
  onResultClick(cb: (date: string, session: string) => void): void {
    this.resultClickCallback = cb;
  }

  /**
   * 调度防抖搜索
   *
   * 输入变化后延迟 DEBOUNCE_MS 触发搜索，避免高频 IPC 调用。
   * 每次输入都会重置定时器，确保只在用户停止输入后触发一次。
   */
  private scheduleSearch(): void {
    // 取消上一次的防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // 弹窗已关闭时不调度搜索
    if (!this.isOpen) return;

    this.debounceTimer = setTimeout(() => {
      this.performSearch();
    }, DEBOUNCE_MS);
  }

  /**
   * 执行搜索
   *
   * 从输入框读取关键词，校验最小长度后调用 IPC 搜索。
   * 搜索期间显示加载状态，搜索完成渲染结果。
   * 关键词与上次相同时跳过（避免重复搜索）。
   */
  private async performSearch(): Promise<void> {
    if (!this.inputEl || !this.resultsEl) return;
    if (this.isSearching) return; // 防止并发请求

    const keyword = this.inputEl.value.trim();

    // 关键词过短时显示提示
    if (keyword.length < MIN_KEYWORD_LENGTH) {
      this.lastKeyword = '';
      this.renderEmpty('请输入至少 2 个字符');
      return;
    }

    // 关键词未变化时跳过
    if (keyword === this.lastKeyword) return;
    this.lastKeyword = keyword;

    // 显示加载状态
    this.renderLoading();

    try {
      this.isSearching = true;
      const { results } = await window.electronAPI.searchSessionMessages({
        keyword,
        limit: SEARCH_LIMIT,
      });
      // 弹窗可能在等待期间被关闭，关闭后不再渲染
      if (!this.isOpen) return;
      this.renderResults(results, keyword);
    } catch (error) {
      console.error('[SearchMessages] 搜索失败:', error);
      if (this.isOpen) {
        this.renderEmpty('搜索失败，请重试');
      }
    } finally {
      this.isSearching = false;
    }
  }

  /**
   * 渲染搜索结果
   *
   * 按日期倒序分组，每条结果显示角色徽章 + 时间 + 内容片段（关键词高亮）。
   *
   * @param results 搜索结果列表
   * @param keyword 搜索关键词（用于高亮）
   */
  private renderResults(results: SearchResultItem[], keyword: string): void {
    if (!this.resultsEl) return;

    clearElement(this.resultsEl);

    if (results.length === 0) {
      this.renderEmpty('无匹配结果');
      return;
    }

    // 按日期分组（倒序），同一日期下的消息按时间倒序
    const grouped = new Map<string, SearchResultItem[]>();
    for (const item of results) {
      const group = grouped.get(item.date) ?? [];
      group.push(item);
      grouped.set(item.date, group);
    }

    const sortedDates = Array.from(grouped.keys()).sort((a, b) => b.localeCompare(a));
    // 使用本地日期（formatDateKey）而非 UTC（toISOString），避免凌晨时区偏差
    const today = formatDateKey(new Date());
    const yesterday = formatDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

    for (const date of sortedDates) {
      // 日期分组标题
      const header = document.createElement('div');
      header.className = 'search-messages-group';
      let label = date;
      if (date === today) {
        label = `今天 · ${date}`;
      } else if (date === yesterday) {
        label = `昨天 · ${date}`;
      }
      header.textContent = label;
      this.resultsEl.appendChild(header);

      // 该日期下的所有匹配消息
      const items = grouped.get(date) ?? [];
      for (const item of items) {
        this.resultsEl.appendChild(this.createResultItem(item, keyword));
      }
    }
  }

  /**
   * 创建单条搜索结果项
   *
   * @param item 搜索结果数据
   * @param keyword 搜索关键词（用于高亮）
   * @returns 结果项 DOM 元素
   */
  private createResultItem(item: SearchResultItem, keyword: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'search-messages-item';
    el.setAttribute('role', 'option');
    el.dataset.date = item.date;
    el.dataset.session = item.session;

    // 头部：角色徽章 + 时间
    const header = document.createElement('div');
    header.className = 'search-messages-item-header';

    const roleBadge = document.createElement('span');
    roleBadge.className = `search-messages-role ${item.role}`;
    roleBadge.textContent = item.role === 'user' ? '我' : item.role === 'assistant' ? '精灵' : item.role;
    header.appendChild(roleBadge);

    const time = document.createElement('span');
    time.className = 'search-messages-time';
    time.textContent = formatClock(item.timestamp);
    header.appendChild(time);

    el.appendChild(header);

    // 内容片段（关键词高亮）
    const content = document.createElement('div');
    content.className = 'search-messages-content';
    content.innerHTML = this.highlightKeyword(item.content, keyword);
    el.appendChild(content);

    return el;
  }

  /**
   * 高亮关键词
   *
   * 先对原文做 escapeHtml 防止 XSS，再用正则替换关键词为 <mark> 标签。
   * 支持空格分隔的多关键词（每个词独立高亮）。
   *
   * @param text 原始文本
   * @param keyword 搜索关键词
   * @returns 高亮后的 HTML（已转义，可安全用于 innerHTML）
   */
  private highlightKeyword(text: string, keyword: string): string {
    // 先转义，防止内容中的 HTML 标签被解析
    const safe = escapeHtml(text);
    const terms = keyword.split(/\s+/).filter(Boolean);
    let result = safe;
    for (const term of terms) {
      // 转义正则特殊字符
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escaped})`, 'gi');
      // 在已转义的文本上替换（& < > " 已被转义，关键词中的这些字符也会被转义，匹配安全）
      result = result.replace(regex, '<mark>$1</mark>');
    }
    return result;
  }

  /**
   * 渲染空状态
   *
   * @param message 提示文字
   */
  private renderEmpty(message: string): void {
    if (!this.resultsEl) return;
    clearElement(this.resultsEl);
    const empty = document.createElement('div');
    empty.className = 'search-messages-empty';
    empty.textContent = message;
    this.resultsEl.appendChild(empty);
  }

  /**
   * 渲染加载状态
   */
  private renderLoading(): void {
    if (!this.resultsEl) return;
    clearElement(this.resultsEl);
    const loading = document.createElement('div');
    loading.className = 'search-messages-loading';
    loading.textContent = '搜索中...';
    this.resultsEl.appendChild(loading);
  }

  /**
   * 清理资源
   *
   * 清理事件监听器、防抖定时器、回调引用，恢复背景滚动。
   */
  cleanup(): void {
    this.events.cleanup();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.isOpen) {
      document.body.style.overflow = '';
      this.isOpen = false;
    }
    this.resultClickCallback = null;
    this.modalEl = null;
    this.inputEl = null;
    this.resultsEl = null;
    this.lastKeyword = '';
  }
}
