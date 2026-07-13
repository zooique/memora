/**
 * 启动摘要横幅组件 — 独立展示逻辑
 *
 * 职责：
 * - 在对话区顶部展示启动摘要横幅（记忆/洞察/技能/衰减/感知/健康聚合数据）
 * - 构建摘要卡片中的单个数据项
 * - 绑定关闭按钮事件（本次会话内不再显示）
 *
 * 设计原则：
 * - 纯函数 + 一次性 DOM 操作，无实例状态
 * - 与聊天消息渲染解耦，ChatPanelManager 通过此函数委托展示
 * - 从 chatPanelManager.ts 提取（零行为变更，纯结构重构）
 */

/**
 * 启动摘要数据结构（来自 Sprite.getStartupSummary()）
 *
 * 聚合记忆/洞察/技能/衰减/感知/健康 6 类数据，
 * 由 renderer.ts 的 loadStartupSummary() 从主进程获取后传入。
 */
export interface StartupSummaryData {
  /** 记忆总数 */
  totalMemories: number;
  /** 洞察总数 */
  totalInsights: number;
  /** 技能数量 */
  skillCount: number;
  /** 衰减统计（null 表示未运行过衰减） */
  decay: { runCount: number; totalDecayedCount: number } | null;
  /** 感知数据（null 表示未启用感知层） */
  perception: {
    warmth: number;
    rapportLevel: string;
    rapportDescription: string;
  } | null;
  /** 健康状态（null 表示未启用健康诊断） */
  healthStatus: 'healthy' | 'warning' | 'critical' | null;
}

/**
 * 在对话区顶部展示启动摘要横幅
 *
 * 聚合记忆/洞察/感知/衰减/健康数据，以横幅形态告知用户精灵当前状态。
 * 横幅位于 proactive-banner 下方、消息区上方，可关闭（本次会话内不再显示）。
 *
 * 布局：左侧精灵图标 + 中间内容区（标题 + 横向数据网格）+ 右侧关闭按钮
 *
 * 行为约束：
 * - 空状态时摘要无意义（无数据可展示），直接返回
 * - 避免重复展示（本次会话仅展示一次，已显示时跳过）
 *
 * @param summary 启动摘要数据（来自 Sprite.getStartupSummary()）
 */
export function showStartupSummary(summary: StartupSummaryData): void {
  // 空状态时摘要无意义（无数据可展示）
  if (summary.totalMemories === 0 && summary.totalInsights === 0) return;

  // 获取横幅元素
  const banner = document.getElementById('startup-banner');
  const gridEl = document.getElementById('startup-banner-grid');
  if (!banner || !gridEl) return;

  // 避免重复展示（本次会话仅展示一次）
  if (!banner.classList.contains('hidden')) return;

  // 清空网格内容
  gridEl.innerHTML = '';

  // 记忆总数
  gridEl.appendChild(buildSummaryItem('记忆', String(summary.totalMemories)));
  // 洞察总数
  gridEl.appendChild(buildSummaryItem('洞察', String(summary.totalInsights)));
  // 技能数
  gridEl.appendChild(buildSummaryItem('技能', `${summary.skillCount} 个`));
  // 衰减统计
  if (summary.decay && summary.decay.totalDecayedCount > 0) {
    gridEl.appendChild(buildSummaryItem('衰减', `${summary.decay.totalDecayedCount} 条`));
  } else {
    gridEl.appendChild(buildSummaryItem('衰减', '—'));
  }
  // 感知：温暖度
  if (summary.perception) {
    gridEl.appendChild(buildSummaryItem('温暖度', `${Math.round(summary.perception.warmth * 100)}%`));
    gridEl.appendChild(buildSummaryItem('默契度', summary.perception.rapportDescription));
  }
  // 健康状态
  if (summary.healthStatus) {
    const healthItem = buildSummaryItem('健康', '');
    const badge = document.createElement('span');
    badge.className = `startup-banner-badge ${summary.healthStatus}`;
    badge.textContent =
      summary.healthStatus === 'healthy'
        ? '良好'
        : summary.healthStatus === 'warning'
          ? '警告'
          : '严重';
    healthItem.appendChild(badge);
    gridEl.appendChild(healthItem);
  }

  // 绑定关闭按钮事件
  const closeBtn = banner.querySelector('.startup-banner-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      banner.classList.add('hidden');
    });
  }

  // 显示横幅（移除 hidden 类，触发 slideDown 动画）
  banner.classList.remove('hidden');
}

/**
 * 构建启动摘要卡片中的单个数据项
 *
 * @param label 标签文本
 * @param value 值文本
 * @returns 数据项 DOM 元素
 */
function buildSummaryItem(label: string, value: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'startup-banner-item';
  // 使用 createElement + textContent 替代 innerHTML 拼接，天然防 XSS
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  const valueSpan = document.createElement('span');
  valueSpan.className = 'startup-banner-value';
  valueSpan.textContent = value;
  item.appendChild(labelSpan);
  item.appendChild(valueSpan);
  return item;
}
