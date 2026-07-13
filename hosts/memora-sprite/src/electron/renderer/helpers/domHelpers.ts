/**
 * DOM 工具函数模块
 *
 * 职责：
 * - 提供类型安全的 DOM 元素获取函数
 * - 核心元素缺失时抛出明确错误，可选元素缺失时降级
 * - 通用 DOM 操作（清空容器、按钮 loading 状态、时间格式化）
 *
 * 设计原则：
 * - 在初始化阶段即发现 HTML 与 TS 不同步问题，避免运行时静默失败
 * - 核心元素与可选元素分离，单个面板缺失不阻塞整个 UI
 */
import { MemoraError, ErrorCode } from '../../../sprite/errors.js';
// formatTimeAgo 时间常量替换（统一引用 constants.ts 真理源）
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../../../sprite/constants.js';

/**
 * 获取必需的 DOM 元素，若缺失或标签名不匹配则抛出明确错误
 *
 * 在初始化阶段即发现 HTML 与 TS 不同步问题，避免运行时静默失败。
 *
 * **仅用于核心交互元素**（消息区、输入框、发送按钮、停止按钮）。
 * 非核心元素请使用 `getOptionalElement`，避免单个面板缺失导致整个 UI 崩溃。
 *
 * @param id 元素 id
 * @param tagName 期望的 HTML 标签名
 * @returns 类型安全的 DOM 元素
 */
export function getRequiredElement<T extends keyof HTMLElementTagNameMap>(
  id: string,
  tagName: T,
): HTMLElementTagNameMap[T] {
  const el = document.getElementById(id);
  if (!el) {
    throw new MemoraError(ErrorCode.INITIALIZATION_FAILED, `[UIManager] 必需的 DOM 元素 #${id} 未找到，UI 无法初始化`);
  }
  // 运行时标签名校验：使用 tagName 字符串比较（兼容 JSDOM 等无 DOM 构造函数的环境）
  if (el.tagName.toLowerCase() !== tagName) {
    throw new MemoraError(
      ErrorCode.INITIALIZATION_FAILED,
      `[UIManager] DOM 元素 #${id} 类型不匹配，期望 <${tagName}>，实际 <${el.tagName.toLowerCase()}>`,
    );
  }
  return el as HTMLElementTagNameMap[T];
}

/**
 * 获取可选的 DOM 元素，缺失时 warn 并返回 null（不阻塞其他功能）
 *
 * 当 HTML 与 TS 不同步时，缺失的功能降级而非整个 UI 崩溃。
 *
 * @param id 元素 id
 * @param tagName 期望的 HTML 标签名
 * @returns 类型安全的 DOM 元素或 null
 */
export function getOptionalElement<T extends keyof HTMLElementTagNameMap>(
  id: string,
  tagName: T,
): HTMLElementTagNameMap[T] | null {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[UIManager] 可选的 DOM 元素 #${id} 未找到，相关功能将降级`);
    return null;
  }
  // 运行时标签名校验
  if (el.tagName.toLowerCase() !== tagName) {
    console.warn(
      `[UIManager] DOM 元素 #${id} 类型不匹配，期望 <${tagName}>，实际 <${el.tagName.toLowerCase()}>，相关功能将降级`,
    );
    return null;
  }
  return el as HTMLElementTagNameMap[T];
}

/**
 * 安全清空 DOM 容器（单次 API 调用）
 *
 * 使用 Element.replaceChildren() 替代 while + removeChild 循环，
 * 浏览器内部优化为一次 reflow，避免长列表逐个移除阻塞主线程。
 * 供 ui.ts 和 memoryController.ts 等需要清空 DOM 的模块共享。
 *
 * @param el 要清空的 DOM 元素
 */
export function clearElement(el: Element): void {
  el.replaceChildren();
}

// ─── HTML 转义 ─────────────────────────────────────────

/**
 * HTML 特殊字符转义（防 XSS）
 *
 * 将 4 类 HTML 特殊字符（& < > "）替换为对应实体，用于 innerHTML 拼接前的文本预处理。
 * 单引号（'）不转义：HTML 实体转义主要防标签注入，单引号在属性值中若已用双引号包裹则无需转义。
 *
 * @param text 原始文本
 * @returns 转义后的安全文本（可安全用于 innerHTML 拼接）
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── 面板加载态 ─────────────────────────────────────────

/**
 * 在指定容器中显示加载态
 *
 * 创建居中旋转圆环 + 文字提示，清空容器后插入加载元素。
 * 使用 clearElement 统一清空模式，避免 DOM 操作不一致。
 *
 * @param container 目标容器元素
 * @param text 加载提示文字（默认 "加载中..."）
 */
export function showPanelLoading(container: Element, text = '加载中...'): void {
  clearElement(container);
  const wrapper = document.createElement('div');
  wrapper.className = 'panel-loading';

  const spinner = document.createElement('span');
  spinner.className = 'panel-loading-spinner';

  const label = document.createElement('span');
  label.textContent = text;

  wrapper.appendChild(spinner);
  wrapper.appendChild(label);
  container.appendChild(wrapper);
}

// ─── 时间格式化 ─────────────────────────────────────────

/**
 * U5 统一相对时间格式化（合并原 formatRelativeTime + formatMemoryTime）
 *
 * 将任意日期字符串（ISO 8601 或 YYYY-MM-DD）转换为人类可读的相对时间：
 * - 1 分钟内 → "刚刚"
 * - 1 小时内 → "X 分钟前"
 * - 24 小时内 → "X 小时前"
 * - 7 天内 → "X 天前"
 * - 更早 → "MM-DD" 格式
 *
 * @param dateStr 日期字符串（支持 ISO 8601 和 YYYY-MM-DD 格式）
 * @returns 格式化后的相对时间文本
 */
export function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  // Invalid Date 防御：new Date('not-a-date') 返回 Invalid Date 但不抛异常，
  // 后续 getTime()/getMonth() 返回 NaN 会导致输出 "NaN-NaN" 等错误格式。
  // 显式检测并降级为原始字符串，与 formatTimestamp/formatClock 降级语义对齐。
  if (Number.isNaN(date.getTime())) return dateStr;
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / MS_PER_MINUTE);
  const diffHour = Math.floor(diffMs / MS_PER_HOUR);
  const diffDay = Math.floor(diffMs / MS_PER_DAY);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  // 更早：返回 MM-DD 格式
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}-${d}`;
}

/**
 * 剪枝：统一时间戳格式化（当天 HH:MM / 昨天 HH:MM / 非当天 MM-DD HH:MM）
 *
 * 合并 chatPanelManager.formatTimestamp 和 ipcListeners 中的手写时间格式化。
 * 解析失败时返回原始字符串（防御性降级）。
 *
 * @param isoString ISO 8601 时间字符串
 * @returns 当天返回 "HH:MM"，昨天返回 "昨天 HH:MM"，更早返回 "MM-DD HH:MM"
 */
export function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  // Invalid Date 防御：new Date 非法字符串不抛异常，返回 Invalid Date。
  // 显式检测 date.getTime() 为 NaN 时降级返回原始字符串，确保降级分支可达。
  if (Number.isNaN(date.getTime())) return isoString;
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  if (isToday) {
    return time;
  }

  // 昨天判断：将当前日期回退一天，比较日期字符串
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (isYesterday) {
    return `昨天 ${time}`;
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day} ${time}`;
}

/**
 * 剪枝：统一时钟格式化（HH:MM）
 *
 * 合并 ipcListeners 中审计日志的手写 getHours/getMinutes + padStart 逻辑。
 *
 * @param isoString ISO 8601 时间字符串
 * @returns "HH:MM" 格式的时间文本
 */
export function formatClock(isoString: string): string {
  const date = new Date(isoString);
  // Invalid Date 防御：同 formatTimestamp，显式检测确保降级分支可达。
  if (Number.isNaN(date.getTime())) return isoString;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 格式化日期为 YYYY-MM-DD 键（本地日期）
 *
 * 从 dateNavManager.formatDate / memoryPanelManager.formatDateKey
 * 等 3 处重复实现中提取的通用工具。
 * 与 getLocalDate() 的区别：getLocalDate 返回"今天"的日期，
 * 本函数接受任意 Date 对象。
 *
 * @param date Date 对象
 * @returns YYYY-MM-DD 字符串（本地日期）
 */
export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── 按钮状态管理 ─────────────────────────────────────────

/**
 * U6 设置按钮 loading 状态（从 UIManager 提取的通用工具方法）
 *
 * 异步操作进行中时禁用按钮并显示 loading 文本，防止用户重复点击。
 * 操作完成后恢复按钮原始状态。
 *
 * @param buttonId 按钮 DOM ID
 * @param loading 是否处于 loading 状态
 * @param loadingText loading 时显示的文本（可选，默认在原文本前加 "..."）
 */
export function setButtonLoading(buttonId: string, loading: boolean, loadingText?: string): void {
  const el = document.getElementById(buttonId);
  if (!(el instanceof HTMLButtonElement)) return;
  setButtonLoadingEl(el, loading, loadingText);
}

/**
 * 基于元素引用的按钮 loading 状态设置
 *
 * 与 setButtonLoading 功能相同，但接受元素引用而非 ID，
 * 适用于动态创建的按钮（如 profilePanelManager 中的 confirm/reject/delete 按钮）。
 *
 * @param el 按钮元素引用
 * @param loading 是否处于 loading 状态
 * @param loadingText loading 时显示的文本（可选，默认在原文本前加 "..."）
 */
export function setButtonLoadingEl(el: HTMLButtonElement, loading: boolean, loadingText?: string): void {
  if (loading) {
    // 保存原始文本到 dataset，用于恢复
    if (!el.dataset.originalText) {
      el.dataset.originalText = el.textContent ?? '';
    }
    el.disabled = true;
    el.textContent = loadingText ?? `${el.dataset.originalText}...`;
  } else {
    el.disabled = false;
    el.textContent = el.dataset.originalText ?? el.textContent ?? '';
    delete el.dataset.originalText;
  }
}

/**
 * 检查是否还有浮层处于打开状态
 *
 * 用于命令面板/搜索弹窗/模态弹窗关闭时有条件恢复 body overflow：
 * 仅当没有其他浮层打开时才恢复 overflow，避免关闭一个浮层时错误恢复另一个的 overflow:hidden。
 * 调用时机应在浮层自身已隐藏之后，因此无需排除自身。
 *
 * @returns 是否还有浮层打开
 */
export function hasOtherOpenOverlays(): boolean {
  return document.querySelectorAll('.modal:not(.hidden), .command-palette:not(.hidden), .search-messages-modal:not(.hidden)').length > 0;
}

// ─── 空状态工厂 ─────────────────────────────────────────

/**
 * 空状态配置选项
 */
export interface EmptyStateOptions {
  /** 面板前缀（如 'memory'），用于生成修饰类 '{prefix}-empty-state'，不传则只用通用 .empty-state */
  panelPrefix?: string;
  /** 图标 HTML（SVG 字符串），不传则不渲染图标 */
  iconHtml?: string;
  /** 主标题（必需） */
  title: string;
  /** 副标题，不传则不渲染 */
  subtitle?: string;
  /** CTA 按钮文本，不传则不渲染按钮 */
  ctaText?: string;
  /** CTA 按钮点击回调，与 ctaText 配合使用 */
  ctaOnClick?: () => void;
}

/**
 * 创建标准空状态 DOM 元素（五元组结构）
 *
 * 从 memoryPanelManager / profilePanelManager / searchMessagesManager 等 6+ 文件
 * 重复的空状态构建代码中提取（ADR-017 枝叶层 2 次提取原则）。
 *
 * DOM 结构：
 *   <div class="empty-state {panel}-empty-state">
 *     <div class="empty-icon">{iconHtml}</div>      ← 可选
 *     <div class="empty-title">{title}</div>
 *     <div class="empty-subtitle">{subtitle}</div>   ← 可选
 *     <button class="empty-action-btn btn-secondary">{ctaText}</button>  ← 可选
 *   </div>
 *
 * 事件绑定说明：
 * - CTA 按钮用 addEventListener 绑定，适用于临时元素（每次渲染重新创建）
 * - 若需统一事件清理（如 this.events.addEventListener），调用方可在获取容器后
 *   通过 container.querySelector('.empty-action-btn') 重新绑定
 *
 * @param options 空状态配置
 * @returns 空状态容器元素（已包含所有子元素，可直接 appendChild）
 */
export function createEmptyState(options: EmptyStateOptions): HTMLElement {
  const { panelPrefix, iconHtml, title, subtitle, ctaText, ctaOnClick } = options;

  // 容器：通用基类 + 面板修饰类
  const empty = document.createElement('div');
  empty.className = panelPrefix
    ? `empty-state ${panelPrefix}-empty-state`
    : 'empty-state';

  // 图标（可选）
  if (iconHtml) {
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.innerHTML = iconHtml;
    empty.appendChild(icon);
  }

  // 标题（必需）
  const titleEl = document.createElement('div');
  titleEl.className = 'empty-title';
  titleEl.textContent = title;
  empty.appendChild(titleEl);

  // 副标题（可选）
  if (subtitle) {
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'empty-subtitle';
    subtitleEl.textContent = subtitle;
    empty.appendChild(subtitleEl);
  }

  // CTA 按钮（可选）
  if (ctaText) {
    const ctaBtn = document.createElement('button');
    ctaBtn.className = 'empty-action-btn btn-secondary';
    ctaBtn.textContent = ctaText;
    if (ctaOnClick) {
      ctaBtn.addEventListener('click', ctaOnClick);
    }
    empty.appendChild(ctaBtn);
  }

  return empty;
}
