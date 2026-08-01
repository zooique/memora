// @vitest-environment jsdom
/**
 * CompletionStatsComponent 单元测试（HEAL-17 Phase B 试点）
 *
 * 验证由 CompletionStatsRenderer 升级而来的 Component 子类的生命周期契约：
 * - mount 仅构建一次骨架 + 首屏数据，导出/重置按钮仅绑定一次
 * - update 增量刷新（度量卡 value/hint 原地更新，趋势/事件区结构变更局部重建），不重建骨架
 * - destroy 移除 wrapper + 解绑监听，且幂等
 * - 重置按钮点击触发 onResetStats 回调
 *
 * 通过 vi.mock 隔离 CompletionMetrics 单例，避免依赖 localStorage 真实数据。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 隔离补全统计埋点单例（hoist 变量供 mock 工厂引用）
const h = vi.hoisted(() => {
  const mockMetrics = {
    getAggregated: vi.fn(),
    getRecentEvents: vi.fn(),
    getDailyAggregated: vi.fn(),
    clear: vi.fn(),
  };
  return { mockMetrics };
});

vi.mock('../../../../electron/renderer/helpers/completionMetrics.js', () => ({
  getCompletionMetrics: vi.fn(() => h.mockMetrics),
}));

// 注意：必须在 vi.mock 之后 import（mock 工厂已被 hoist）
import { CompletionStatsComponent } from '../../../../electron/renderer/components/data/completionStatsComponent.js';
import type { CompletionAggregated } from '../../../../electron/renderer/helpers/completionMetrics.js';

/** 默认聚合数据（用于断言度量卡展示值） */
const DEFAULT_AGG: CompletionAggregated = {
  totalShown: 10,
  totalAdopted: 4,
  adoptionRate: 0.4,
  top1HitRate: 0.5,
  avgAdoptedPosition: 1.25,
  totalChatTurns: 20,
  activationRate: 0.5,
  recallMoments: 3,
};

beforeEach(() => {
  // 重置 DOM 与 mock 实现（每次提供干净的静态挂载点 + 默认数据）
  document.body.innerHTML = '<div id="completion-stats-bar" class="completion-stats-bar hidden"></div>';
  h.mockMetrics.getAggregated.mockReturnValue({ ...DEFAULT_AGG });
  h.mockMetrics.getRecentEvents.mockReturnValue([]);
  h.mockMetrics.getDailyAggregated.mockReturnValue([]);
  vi.clearAllMocks();
  // clearAllMocks 会清空 mockReturnValue，需重设默认
  h.mockMetrics.getAggregated.mockReturnValue({ ...DEFAULT_AGG });
  h.mockMetrics.getRecentEvents.mockReturnValue([]);
  h.mockMetrics.getDailyAggregated.mockReturnValue([]);
});

describe('CompletionStatsComponent 生命周期', () => {
  it('mount：构建骨架（标题 + 3 按钮 + 6 度量卡）并填充首屏数据', () => {
    const comp = new CompletionStatsComponent({ host: { showToast: vi.fn() } });
    comp.mount('#completion-stats-bar');

    // 根 wrapper 挂载到静态容器
    expect(document.querySelector('#completion-stats-bar .completion-stats-component')).not.toBeNull();
    // 标题
    expect(document.querySelector('.completion-stats-title')?.textContent).toBe('补全统计');
    // 3 个按钮：导出(primary) / 重置统计(secondary) / 关闭(panel-close-btn)
    expect(document.querySelectorAll('.completion-stats-actions button').length).toBe(3);
    expect(document.getElementById('btn-close-completion-stats')).not.toBeNull();
    // 6 张度量卡
    expect(document.querySelectorAll('.stat-card').length).toBe(6);

    // 度量卡 value 与聚合数据一致（顺序：激活率/召回时刻/采纳率/Top-1/平均位置/展示数）
    const values = Array.from(document.querySelectorAll('.stat-card__value')).map((e) => e.textContent);
    expect(values[0]).toBe('50.0%'); // 激活率
    expect(values[1]).toBe('3'); // 召回时刻
    expect(values[2]).toBe('40.0%'); // 采纳率
    expect(values[3]).toBe('50.0%'); // Top-1
    expect(values[4]).toBe('1.25'); // 平均位置
    expect(values[5]).toBe('10'); // 展示数
  });

  it('update：增量刷新度量卡 value，不重建骨架（仍 6 张卡）', () => {
    const comp = new CompletionStatsComponent({});
    comp.mount('#completion-stats-bar');
    const cardCountBefore = document.querySelectorAll('.stat-card').length;

    // 改变聚合数据后增量刷新
    h.mockMetrics.getAggregated.mockReturnValue({
      ...DEFAULT_AGG,
      totalShown: 100,
      totalAdopted: 50,
      adoptionRate: 0.5,
      top1HitRate: 0.8,
      avgAdoptedPosition: 0,
      totalChatTurns: 200,
      activationRate: 0.5,
      recallMoments: 10,
    });
    comp.update();

    expect(document.querySelectorAll('.stat-card').length).toBe(cardCountBefore); // 骨架未重建
    const values = Array.from(document.querySelectorAll('.stat-card__value')).map((e) => e.textContent);
    expect(values[0]).toBe('50.0%'); // 激活率不变
    expect(values[1]).toBe('10'); // 召回时刻更新
    expect(values[2]).toBe('50.0%'); // 采纳率 50/100
    expect(values[3]).toBe('80.0%'); // Top-1 更新
    expect(values[4]).toBe('0.00'); // 平均位置（totalAdopted>0 → toFixed(2)）
    expect(values[5]).toBe('100'); // 展示数更新
  });

  it('onResetStats：点击"重置统计"按钮触发回调', () => {
    const cb = vi.fn();
    const comp = new CompletionStatsComponent({});
    comp.mount('#completion-stats-bar');
    comp.onResetStats(cb);

    const resetBtn = Array.from(document.querySelectorAll('.completion-stats-actions button'))
      .find((b) => b.textContent === '重置统计') as HTMLButtonElement | undefined;
    expect(resetBtn).toBeDefined();
    resetBtn!.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('destroy：移除 wrapper 且幂等（重复调用不抛错）', () => {
    const comp = new CompletionStatsComponent({});
    comp.mount('#completion-stats-bar');
    expect(document.querySelector('.completion-stats-component')).not.toBeNull();

    comp.destroy();
    expect(document.querySelector('.completion-stats-component')).toBeNull();
    expect(comp.isDestroyed()).toBe(true);

    // 幂等：再次 destroy 不应抛错
    expect(() => comp.destroy()).not.toThrow();
  });

  it('事件流区：无事件显示空状态，有事件渲染对应条数', () => {
    const comp = new CompletionStatsComponent({});
    comp.mount('#completion-stats-bar');
    // 默认空事件：empty-state 直接挂入 events-section（与原子渲染器一致，无 .completion-stats-events 包裹）
    expect(document.querySelector('.completion-stats-events-section .empty-state')).not.toBeNull();

    const now = new Date().toISOString();
    h.mockMetrics.getRecentEvents.mockReturnValue([
      { type: 'shown', queryLen: 5, queryHash: 'x', shownCount: 3, totalCandidatesCount: 5, timestamp: now },
      { type: 'adopted', queryLen: 5, queryHash: 'x', adoptedPosition: 0, adoptedTextHash: 'y', timestamp: now },
      { type: 'chat-turn', timestamp: now },
      { type: 'recall-moment', recallCount: 2, timestamp: now },
    ]);
    comp.update();
    expect(document.querySelectorAll('.completion-stats-event-item').length).toBe(4);
    expect(document.querySelector('.completion-stats-events-title')?.textContent).toContain('4 条事件');
  });

  it('趋势区：无数据显示空状态，有数据显示对应柱组', () => {
    const comp = new CompletionStatsComponent({});
    comp.mount('#completion-stats-bar');
    expect(document.querySelector('.completion-stats-trend .empty-state')).not.toBeNull();

    h.mockMetrics.getDailyAggregated.mockReturnValue([
      { date: '2026-07-24', shown: 5, adopted: 2, chatTurns: 3, activationRate: 0.6, recallMoments: 1 },
      { date: '2026-07-25', shown: 0, adopted: 0, chatTurns: 0, activationRate: 0, recallMoments: 0 },
      { date: '2026-07-26', shown: 8, adopted: 3, chatTurns: 4, activationRate: 0.5, recallMoments: 0 },
    ]);
    comp.update();
    expect(document.querySelectorAll('.completion-stats-trend-bar-group').length).toBe(3);
  });
});
