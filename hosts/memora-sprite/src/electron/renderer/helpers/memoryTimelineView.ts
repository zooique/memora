/**
 * 记忆时间线视图辅助（从 memoryPanelManager.ts 提取）
 *
 * 职责：
 *   渲染按天分组的记忆时间线视图。涵盖：
 *   - 时间线容器整体渲染（空状态 + 日期分组 + 降序排序）
 *   - 单个时间线记忆项 DOM 构建（时间点 + 名称 + source + 时间 + 预览）
 *   - 日期标签格式化（今天 / 昨天 / 具体日期）
 *
 * 提取原因：
 *   memoryPanelManager.ts 1534 行，时间线视图相关方法（3 个）
 *   形成完整子系统，约 190 行，相对独立，适合提取为接受 context 的纯函数模块。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 MemoryTimelineContext 注入
 *   - 记忆列表和搜索关键词通过 context 传入（状态所有权归 MemoryPanelManager）
 *   - 文本高亮通过回调委托给 manager，避免逻辑重复
 *   - formatDateLabel 是纯函数，直接使用 domHelpers.formatDateKey
 *   - 不使用 @ts-ignore 或 as any，遵循现有代码风格
 *
 * 先例：
 *   参照 memoryGraphPanel.ts / memoryDetailPanel.ts 的 context 注入模式
 */

import { clearElement, formatDateKey, createEmptyState } from './domHelpers.js';
// getSourceColorClass 是从 helpers/sourceColor 导出的纯函数（模块级，非实例方法）
import { getSourceColorClass } from './sourceColor.js';
import type { MemoryListItem } from '../types.js';

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/**
 * 时间线视图渲染所需的上下文
 *
 * 由 MemoryPanelManager 构建并传入。设计为接口而非直接传入 manager 实例，
 * 避免运行时循环依赖并便于独立测试。
 */
export interface MemoryTimelineContext {
  /** 完整记忆列表（按 createdAt 分组为日期节点） */
  readonly allMemories: MemoryListItem[];
  /** 当前搜索关键词（空字符串表示不高亮） */
  readonly currentSearchQuery: string;
  /**
   * 高亮文本中的搜索关键词
   *
   * 将匹配关键词的部分用 <mark> 标签包裹，已做 HTML 转义处理防止 XSS。
   * 由 manager 提供（复用其私有 highlightText 实现，避免逻辑重复）。
   *
   * @param text 原始文本
   * @param query 搜索关键词
   * @returns 带 <mark> 高亮的 HTML 字符串
   */
  highlightText(text: string, query: string): string;
}

// ─── 时间线渲染主入口 ────────────────────────────────────

/**
 * 渲染时间线视图（按天分组记忆）
 *
 * 将缓存的记忆列表按 createdAt 分组为日期节点，
 * 以垂直时间线形式展示，每条记忆显示为时间线上的一个节点。
 * 支持搜索高亮和 source 颜色区分。
 *
 * 容器查找：通过 document.getElementById('memory-timeline-container') 获取
 * （与 renderRecycleBinList 一致的查找模式）。
 *
 * @param ctx 时间线渲染上下文
 */
export function renderTimeline(ctx: MemoryTimelineContext): void {
  const container = document.getElementById('memory-timeline-container');
  if (!container) return;

  // 无记忆数据时显示空状态（createEmptyState 工厂统一结构）
  if (ctx.allMemories.length === 0) {
    clearElement(container);
    const empty = createEmptyState({
      panelPrefix: 'timeline',
      iconHtml: '<svg class="icon"><use href="#icon-hourglass"/></svg>',
      title: '暂无时间线数据',
      subtitle: '开始对话后，记忆将按时间自动组织',
    });
    container.appendChild(empty);
    return;
  }

  // 清空容器（复用 clearElement 统一 DOM 操作模式）
  clearElement(container);

  // 按天分组记忆（以 createdAt 日期为键）
  const groups = new Map<string, MemoryListItem[]>();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const mem of ctx.allMemories) {
    const date = mem.createdAt ? new Date(mem.createdAt) : new Date();
    const dateKey = formatDateKey(date);
    const existing = groups.get(dateKey);
    if (existing) {
      existing.push(mem);
    } else {
      groups.set(dateKey, [mem]);
    }
  }

  // 按日期降序排序（今天 → 昨天 → 更早）
  const sortedDates = Array.from(groups.keys()).sort((a, b) => b.localeCompare(a));

  // 渲染时间线容器
  const timeline = document.createElement('div');
  timeline.className = 'timeline';

  for (const dateKey of sortedDates) {
    const items = groups.get(dateKey)!;
    const dateObj = new Date(dateKey);

    // 日期标签
    const dateLabel = formatDateLabel(dateObj, today, yesterday);

    // 日期组
    const group = document.createElement('div');
    group.className = 'timeline-group';

    // 日期头：圆点 + 日期文字 + 条目计数（createElement 替代 innerHTML 拼接）
    const header = document.createElement('div');
    header.className = 'timeline-date-header';

    const dotSpan = document.createElement('span');
    dotSpan.className = 'timeline-date-dot';
    header.appendChild(dotSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'timeline-date-text';
    textSpan.textContent = dateLabel;
    header.appendChild(textSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'timeline-date-count';
    countSpan.textContent = `${items.length} 条`;
    header.appendChild(countSpan);

    group.appendChild(header);

    // 该日期下的记忆列表
    const itemList = document.createElement('div');
    itemList.className = 'timeline-items';

    for (const mem of items) {
      const item = createTimelineItem(mem, ctx);
      itemList.appendChild(item);
    }

    group.appendChild(itemList);
    timeline.appendChild(group);
  }

  container.appendChild(timeline);
}

// ─── 时间线项 DOM 构建 ────────────────────────────────────

/**
 * 创建单个时间线记忆项 DOM 元素（renderTimeline 的辅助方法）
 *
 * 包含时间点圆点、名称、source 标签、时间和预览。
 * 与 memory-item 一致支持键盘可访问性（Tab 聚焦 + 回车查看）。
 *
 * @param mem 记忆列表项数据
 * @param ctx 时间线渲染上下文（提供搜索关键词和高亮回调）
 * @returns 完整的时间线项 DOM 元素
 */
export function createTimelineItem(mem: MemoryListItem, ctx: MemoryTimelineContext): HTMLElement {
  const item = document.createElement('div');
  item.className = 'timeline-item';
  item.dataset.id = mem.id;
  item.setAttribute('data-action', 'view-memory');
  item.setAttribute('data-memory-id', mem.id);
  // 键盘可访问性（与 memory-item 一致，支持 Tab 聚焦 + 回车查看）
  item.setAttribute('tabindex', '0');
  item.setAttribute('role', 'button');
  item.setAttribute('aria-label', `查看记忆：${mem.name}`);

  // 时间点
  const timeDot = document.createElement('div');
  timeDot.className = 'timeline-item-dot flex-shrink-0';
  item.appendChild(timeDot);

  // 记忆内容
  const content = document.createElement('div');
  content.className = 'timeline-item-content';

  const nameEl = document.createElement('div');
  nameEl.className = 'timeline-item-name text-truncate';
  nameEl.innerHTML = ctx.highlightText(mem.name, ctx.currentSearchQuery);
  content.appendChild(nameEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'timeline-item-meta';
  const sourceTag = document.createElement('span');
  sourceTag.className = `source-tag source-${getSourceColorClass(mem.source)}`;
  sourceTag.textContent = mem.source;
  metaEl.appendChild(sourceTag);

  if (mem.createdAt) {
    const timeEl = document.createElement('span');
    timeEl.className = 'timeline-item-time';
    timeEl.textContent = new Date(mem.createdAt).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    metaEl.appendChild(timeEl);
  }
  content.appendChild(metaEl);

  const previewEl = document.createElement('div');
  previewEl.className = 'timeline-item-preview text-truncate';
  previewEl.innerHTML = ctx.highlightText(mem.contentPreview, ctx.currentSearchQuery);
  content.appendChild(previewEl);

  item.appendChild(content);
  return item;
}

// ─── 日期标签格式化（纯函数） ───────────────────────────────

/**
 * 格式化日期标签（今天 / 昨天 / 具体日期）
 *
 * 纯函数：仅依赖入参，不访问任何外部状态。
 *
 * @param date 待格式化的日期
 * @param today 当前日期（用于判断"今天"）
 * @param yesterday 昨天日期（用于判断"昨天"）
 * @returns 本地化日期标签字符串
 */
export function formatDateLabel(date: Date, today: Date, yesterday: Date): string {
  const dateKey = formatDateKey(date);
  const todayKey = formatDateKey(today);
  const yesterdayKey = formatDateKey(yesterday);

  if (dateKey === todayKey) return '今天';
  if (dateKey === yesterdayKey) return '昨天';

  const options: Intl.DateTimeFormatOptions = {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  };
  return date.toLocaleDateString('zh-CN', options);
}
