/**
 * 伙伴洞察组件 — 仪表盘内"精灵对你的了解"子区域渲染
 *
 * 职责：
 * - 渲染 profile 记忆卡片网格（展示精灵对用户的了解，最多 6 张）
 * - 渲染知识缺口检测（source 类型占比 < 5% 的提醒）
 * - 渲染记忆累积趋势图（Canvas 折线图，零依赖，8 周数据）
 * - 自管理记忆数据缓存，主题切换时重绘 Canvas
 *
 * 生命周期（升级为 Component，对齐 §四.1 / §四.4）：
 * - 采纳 index.html 的静态容器 #partner-insights 为 this.el（富骨架，已含全部内部 id）
 * - mount() 时缓存全部内部引用，消除原 9 处 document.getElementById 查内部元素
 * - update() 增量刷新；趋势图按「结构变更，需重建」规则重绘 Canvas
 * - destroy() 先置 this.el=null 再 super.destroy()，避免误删共享静态容器
 *   （#partner-insights 还被 memoryViewSwitcher 直接控制显隐，销毁时不可 el.remove()）
 */

import { setIcon } from '../../helpers/icon.js';
import { clearElement, createEl, setCanvasSize } from '../../helpers/domHelpers.js';
// 渲染进程统一日志入口（替代散落的 console.error/warn）
import { reportError } from '../../helpers/errorHelpers.js';
// 文本截断工具（跨层共享，统一 ellipsis 为 '…'，ADR-017 枝叶层 2 次提取）
import { truncate } from '../../../../shared/truncate.js';
// 组件生命周期基类（HEAL-17 Phase 0）
import { Component } from '../base/Component.js';

// ─── 类型定义 ────────────────────────────────────────────

/** 伙伴洞察渲染所需的记忆数据（DashboardViewModel 的子集） */
export interface PartnerMemory {
  /** 记忆 ID（点击卡片时回传） */
  id: string;
  /** 记忆名称（卡片标题） */
  name: string;
  /** 记忆来源类型（用于知识缺口检测和颜色映射） */
  source: string;
  /** 内容预览（截断 80 字符显示） */
  contentPreview: string;
  /** 创建时间（用于趋势图按周统计，可选） */
  createdAt?: string;
}

/** 伙伴洞察组件配置（对齐 Component<P> 泛型契约；字段可选，由 update 传入） */
export interface PartnerInsightsOptions {
  /** 记忆数据（DashboardViewModel 子集） */
  memories?: PartnerMemory[];
}

// ─── 常量 ────────────────────────────────────────────────

/** 趋势图统计的周数（最近 8 周） */
const WEEK_COUNT = 8;

/** 卡片最大展示数量（避免视觉过载） */
const MAX_PROFILE_CARDS = 6;

/** 卡片内容预览最大字符数 */
const PREVIEW_MAX_LENGTH = 80;

/** 知识缺口判定阈值（占比低于此值视为缺口） */
const GAP_THRESHOLD = 0.05;

/** 知识缺口最大展示条数 */
const MAX_GAP_ITEMS = 3;

/** 已知 source 类型及其缺口中文化描述 */
const SOURCE_GAP_DESCRIPTIONS: Record<string, string> = {
  profile: '精灵还不了解你的个人信息',
  insight: '精灵还没有形成对你的洞察',
  skill: '精灵还不了解你的技能和专长',
  rule: '你还没有设定与精灵的互动规则',
  guardrail: '精灵还没有设置内容护栏',
  persona: '精灵还没有角色偏好记忆',
  session: '精灵还没有会话总结',
};

// ─── 伙伴洞察组件 ────────────────────────────────────────

/**
 * 伙伴洞察组件
 *
 * 负责仪表盘内"伙伴洞察"子区域的全部渲染逻辑。
 * 由 MemoryPanelManager 持有，通过外观方法委托调用。
 */
export class PartnerInsightsComponent extends Component<PartnerInsightsOptions> {
  /** 记忆点击回调（点击 profile 卡片时通知 controller 跳转记忆详情） */
  private onMemoryClickCallback: ((memoryId: string) => void) | null = null;

  /** 缓存最近一次渲染的记忆数据，供主题切换时重绘 Canvas（避免重新拉取） */
  private lastMemories: PartnerMemory[] = [];

  // 持久化的内部元素引用（mount 时缓存，替代 document.getElementById 查内部元素）
  private badgeEl: HTMLElement | null = null;
  private profileCardsContainer: HTMLElement | null = null;
  private gapsContainer: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private totalEl: HTMLElement | null = null;

  constructor(options: PartnerInsightsOptions = {}) {
    super(options);
  }

  // ─── 生命周期 ──────────────────────────────────────────

  /**
   * 挂载到静态容器 #partner-insights（采纳为 this.el，富骨架已含全部内部 id）
   *
   * @param container 容器元素或选择器（默认 '#partner-insights'）
   */
  mount(container: HTMLElement | string = '#partner-insights'): this {
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;

    this.el = target;
    // 缓存内部引用（§四.1：组件不应再用 getElementById 找自己的内部元素）
    this.badgeEl = this.el.querySelector<HTMLElement>('#partner-insights-badge');
    this.profileCardsContainer = this.el.querySelector<HTMLElement>('.profile-cards');
    this.gapsContainer = this.el.querySelector<HTMLElement>('.gap-list');
    this.canvas = this.el.querySelector<HTMLCanvasElement>('#partner-growth-chart');
    this.totalEl = this.el.querySelector<HTMLElement>('#partner-growth-total');

    // 首屏渲染（空数据 → 隐藏面板）
    this.update();
    return this;
  }

  /**
   * 增量更新（render 的 Component 等价物）
   *
   * @param newOptions 新配置（memories 由 holder 经渲染委托传入）
   */
  update(newOptions: Partial<PartnerInsightsOptions> = {}): this {
    if (newOptions.memories !== undefined) {
      this.options.memories = newOptions.memories;
    }
    this.renderInternal(this.options.memories ?? []);
    return this;
  }

  /**
   * 主题切换时重绘 Canvas 图表
   *
   * Canvas 2D 不会自动响应 CSS 变量变化，主题切换后需主动重绘。
   * 使用缓存的记忆数据重新渲染增长趋势图，避免重新拉取数据。
   */
  repaintOnThemeChange(): void {
    if (this.isDestroyed()) return;
    if (this.lastMemories.length > 0) {
      this.renderGrowthChart(this.lastMemories);
    }
  }

  /**
   * 注册记忆点击回调
   *
   * 点击 profile 卡片时，通知 controller 切换到记忆面板并定位到该记忆。
   */
  onMemoryClick(cb: (memoryId: string) => void): void {
    this.onMemoryClickCallback = cb;
  }

  /**
   * 销毁组件（清理回调引用 + 缓存 + 事件监听，并避免误删共享静态容器）
   */
  destroy(): void {
    this.onMemoryClickCallback = null;
    this.lastMemories = [];
    // #partner-insights 是共享静态容器（还被 memoryViewSwitcher 控制显隐），
    // 置 null 让基类 destroy() 跳过 el.remove()
    this.el = null;
    super.destroy();
  }

  // ─── 私有渲染方法（逻辑与原 PartnerInsightsRenderer 逐行等价） ──

  /**
   * 渲染伙伴洞察面板
   *
   * 包含三部分：
   * 1. Profile 记忆卡片网格（展示精灵对你的了解）
   * 2. 知识缺口检测（source 类型占比 < 5% 的提醒）
   * 3. 记忆累积趋势图（Canvas 折线图，8 周数据）
   *
   * @param memories 全量记忆列表（用于统计和趋势图）
   */
  private renderInternal(memories: PartnerMemory[]): void {
    if (!this.el) return;
    const panel = this.el;

    // 有数据时显示面板，无数据时保持隐藏（与原 render 一致：空数据不更新 lastMemories）
    if (memories.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');

    // 缓存记忆数据，供主题切换时重绘增长图表（避免重新拉取数据）
    this.lastMemories = memories;

    // 筛选 profile 记忆（精灵对你的了解）
    const profileMems = memories.filter((m) => m.source === 'profile');
    // 顶部状态徽章同步了解数（信息语义，固定青色 good）
    if (this.badgeEl) {
      this.badgeEl.textContent = `${profileMems.length} 条了解`;
    }
    if (this.profileCardsContainer) {
      this.renderProfileCards(profileMems, this.profileCardsContainer);
    }

    // 知识缺口检测
    if (this.gapsContainer) {
      this.renderKnowledgeGaps(memories, this.gapsContainer);
    }

    // 记忆累积趋势图
    this.renderGrowthChart(memories);
  }

  /**
   * 渲染 profile 记忆卡片网格
   *
   * 最多展示 6 张卡片，点击可跳转到记忆详情。
   * 使用 CSS 变量适配主题色，与项目设计系统一致。
   */
  private renderProfileCards(profileMems: PartnerMemory[], container: HTMLElement): void {
    // 清空容器（复用 clearElement 统一 DOM 操作模式）
    clearElement(container);

    if (profileMems.length === 0) {
      const empty = createEl('p', 'partner-empty-hint', '精灵还不了解你，多和它聊聊吧');
      container.appendChild(empty);
      return;
    }

    // 最多展示 6 张卡片
    const cards = profileMems.slice(0, MAX_PROFILE_CARDS);
    for (const mem of cards) {
      const card = createEl('div', 'profile-card');
      card.title = mem.contentPreview;

      // 卡片被点击时，通过回调通知 controller（事件经 trackEvent 统一清理）
      const handleClick = (): void => {
        this.onMemoryClickCallback?.(mem.id);
      };
      card.addEventListener('click', handleClick);
      this.trackEvent(() => card.removeEventListener('click', handleClick));

      // 记忆名称
      const nameEl = createEl('div', 'profile-card-name', mem.name);
      card.appendChild(nameEl);

      // 内容预览（截断 80 字符）
      const previewEl = createEl('div', 'profile-card-preview', truncate(mem.contentPreview, PREVIEW_MAX_LENGTH));
      card.appendChild(previewEl);

      container.appendChild(card);
    }
  }

  /**
   * 渲染知识缺口列表
   *
   * 检测 source 类型占比 < 5% 的类别，提示用户补充对应类型的记忆。
   * 最多展示 3 条缺口。
   */
  private renderKnowledgeGaps(memories: PartnerMemory[], container: HTMLElement): void {
    // 清空容器（复用 clearElement 统一 DOM 操作模式）
    clearElement(container);

    if (memories.length === 0) return;

    // 统计各 source 类型数量
    const total = memories.length;
    const sourceCounts: Record<string, number> = {};
    for (const mem of memories) {
      const source = mem.source || 'unknown';
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }

    // 找出占比 < 5% 的类型
    const gaps: Array<{ source: string; description: string }> = [];
    for (const [source, desc] of Object.entries(SOURCE_GAP_DESCRIPTIONS)) {
      const count = sourceCounts[source] || 0;
      if (count / total < GAP_THRESHOLD) {
        gaps.push({ source, description: desc });
      }
    }

    if (gaps.length === 0) {
      const complete = createEl('p', 'partner-empty-hint', '精灵对你的了解已经比较全面了');
      container.appendChild(complete);
      return;
    }

    // 最多展示 3 条
    for (const gap of gaps.slice(0, MAX_GAP_ITEMS)) {
      const item = createEl('div', 'gap-item');

      const icon = createEl('span', 'partner-gap-icon flex-shrink-0');
      // SVG 图标，跨平台渲染一致
      setIcon(icon, 'icon-lightbulb');

      const text = createEl('span', 'partner-gap-text', gap.description);

      item.appendChild(icon);
      item.appendChild(text);
      container.appendChild(item);
    }
  }

  /**
   * 渲染记忆累积趋势图（Canvas 折线图，零依赖）
   *
   * 按周统计记忆累积数量，绘制折线图展示增长趋势。
   * 使用 Canvas 2D API 纯手绘，不引入任何图表库。
   * 颜色通过 CSS 变量动态读取，支持亮色/暗色主题切换。
   */
  private renderGrowthChart(memories: Array<{ createdAt?: string }>): void {
    const canvas = this.canvas;
    const totalEl = this.totalEl;
    if (!(canvas instanceof HTMLCanvasElement)) {
      reportError('PartnerInsights partner-growth-chart 元素缺失', new Error('图表渲染跳过：HTMLCanvasElement 校验失败'));
      return;
    }

    // 更新总数
    if (totalEl) {
      totalEl.textContent = `${memories.length} 条`;
    }

    // 按周统计（最近 8 周：idx 0=8周前[最远]，idx 7=本周[最近]）
    const now = new Date();
    const weekLabels: string[] = [];
    const weekCounts: number[] = [];

    // 从 8 周前到本周依次初始化
    for (let weeksAgo = WEEK_COUNT - 1; weeksAgo >= 0; weeksAgo--) {
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - (weeksAgo * 7 + 6));
      const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
      weekLabels.push(label);
      weekCounts.push(0);
    }

    // 统计各周的记忆数量
    for (const mem of memories) {
      if (!mem.createdAt) continue;
      const date = new Date(mem.createdAt);
      for (let idx = 0; idx < WEEK_COUNT; idx++) {
        // weeksAgo: 7-idx（idx=0→7=8周前，idx=7→0=本周）
        const weeksAgo = WEEK_COUNT - 1 - idx;
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - (weeksAgo * 7 + 6));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() - weeksAgo * 7);
        weekEnd.setHours(23, 59, 59, 999);

        if (date >= weekStart && date <= weekEnd) {
          weekCounts[idx]!++;
          break;
        }
      }
    }

    // 计算累积值（从过去到现在累加）
    const cumulative: number[] = new Array(WEEK_COUNT);
    let runningTotal = 0;
    for (let idx = 0; idx < WEEK_COUNT; idx++) {
      runningTotal += weekCounts[idx]!;
      cumulative[idx] = runningTotal;
    }

    // Canvas 绘制
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = 120;
    const dpr = setCanvasSize(canvas, w, h);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    // 从 CSS 变量读取主题色（与项目主题系统一致，而非硬编码）
    const rootStyle = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string): string =>
      rootStyle.getPropertyValue(name).trim() || fallback;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = cssVar('--surface0', isDark ? '#1e1e2e' : '#ececee');
    const accentColor = cssVar('--accent', '#0d7377');
    // 复用设计系统的 --accent-20 令牌（浅色 rgba(13,115,119,0.1) / 深色 rgba(45,181,187,0.2)），确保主题感知
    const fillColor = cssVar('--accent-20', isDark ? 'rgba(45, 181, 187, 0.2)' : 'rgba(13, 115, 119, 0.1)');
    // --text-3 fallback 与 tokens.css 保持一致：浅色 #6a6a72 / 深色 #b5bcd6
    const textColor = cssVar('--text-3', isDark ? '#b5bcd6' : '#6a6a72');
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    // 边距
    const padding = { top: 16, right: 12, bottom: 24, left: 12 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // 计算 Y 轴范围
    const maxVal = Math.max(...cumulative, 1);
    const yMax = maxVal * 1.15; // 留 15% 顶部空间

    // 绘制网格线
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padding.top + (chartH * i / 3);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    // 计算折线数据点
    const points: Array<{ x: number; y: number }> = [];
    for (let idx = 0; idx < WEEK_COUNT; idx++) {
      const x = padding.left + (chartW * idx / (WEEK_COUNT - 1));
      const y = padding.top + chartH - (cumulative[idx]! / yMax * chartH);
      points.push({ x, y });
    }

    // 填充区域
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, padding.top + chartH);
    for (const p of points) {
      ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(points[WEEK_COUNT - 1]!.x, padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // 折线
    ctx.beginPath();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let idx = 0; idx < points.length; idx++) {
      if (idx === 0) {
        ctx.moveTo(points[idx]!.x, points[idx]!.y);
      } else {
        ctx.lineTo(points[idx]!.x, points[idx]!.y);
      }
    }
    ctx.stroke();

    // 数据点
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = accentColor;
      ctx.fill();
    }

    // X 轴标签
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    for (let idx = 0; idx < weekLabels.length; idx++) {
      const x = padding.left + (chartW * idx / (weekLabels.length - 1 || 1));
      ctx.fillText(weekLabels[idx]!, x, h - 4);
    }
  }
}
