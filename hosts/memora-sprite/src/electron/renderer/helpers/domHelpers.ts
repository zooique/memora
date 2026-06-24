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
    throw new Error(`[UIManager] 必需的 DOM 元素 #${id} 未找到，UI 无法初始化`);
  }
  // 运行时标签名校验：使用 tagName 字符串比较（兼容 JSDOM 等无 DOM 构造函数的环境）
  if (el.tagName.toLowerCase() !== tagName) {
    throw new Error(
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
 * 安全清空 DOM 容器（while + removeChild 模式）
 *
 * 使用 while + removeChild 替代 innerHTML = ''，
 * 避免事件监听器残留和 XSS 一致性问题。
 * 供 ui.ts 和 memoryController.ts 等需要清空 DOM 的模块共享。
 *
 * @param el 要清空的 DOM 元素
 */
export function clearElement(el: Element): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
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
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

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
 * H3 剪枝：统一时间戳格式化（当天 HH:MM / 非当天 MM-DD HH:MM）
 *
 * 合并 chatPanelManager.formatTimestamp 和 ipcListeners 中的手写时间格式化。
 * 解析失败时返回原始字符串（防御性降级）。
 *
 * @param isoString ISO 8601 时间字符串
 * @returns 当天返回 "HH:MM"，非当天返回 "MM-DD HH:MM"
 */
export function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const time = `${hh}:${mm}`;

    if (isToday) {
      return time;
    }
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${time}`;
  } catch {
    return isoString;
  }
}

/**
 * H3 剪枝：统一时钟格式化（HH:MM）
 *
 * 合并 ipcListeners 中审计日志的手写 getHours/getMinutes + padStart 逻辑。
 *
 * @param isoString ISO 8601 时间字符串
 * @returns "HH:MM" 格式的时间文本
 */
export function formatClock(isoString: string): string {
  try {
    const date = new Date(isoString);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return isoString;
  }
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
