/**
 * 感知面板控制器
 *
 * 从 UIManager 拆分，统一管理"感知面板"的 UI 联动。
 *
 * 职责：
 * - 感知面板展开/收起动画（150ms 过渡）
 * - 展开时主动拉取感知快照并刷新四块感知展示 + 主动提示统计
 * - 精灵状态条点击/键盘触发（Enter/Space 可访问性）
 * - 感知面板关闭按钮
 * - 三块折叠区域（运行指标 / 对话回顾 / 记忆源健康）的展开收起
 * - 仪表盘推荐记忆点击 → 跳转记忆面板显示详情（FD-ADD-REC-CLICK）
 *
 * 设计原则：
 * - 自包含事件监听器管理（EventTracker），与 UIManager 解耦
 * - 通过 PerceptionPanelHost 接口回调 UIManager，避免反向依赖
 * - init() 在 UIManager 构造完成后绑定事件，cleanup() 统一清理
 * - 与 C-5-1~C-5-4 拆分模式一致（ClipboardManager/DateNavManager 等）
 */

import { EventTracker } from '../helpers/eventTracker.js';
import type { AffectPayload, RapportPayload, ContextPayload, PatternsPayload } from '../ipcListeners.js';

/**
 * 感知面板 Host 接口
 *
 * UIManager 实现此接口，提供感知面板所需的回调能力。
 * 设计为最小化接口，避免新 Manager 直接依赖整个 UIManager。
 */
export interface PerceptionPanelHost {
  /** 触发记忆召回跳转（FD-ADD-REC-CLICK：推荐记忆点击复用） */
  triggerMemoryRecall(memoryId: string): void;
  /** 更新情感基调展示（委托 DashboardPanelManager） */
  updateAffectDisplay(affect: AffectPayload): void;
  /** 更新默契度展示（委托 DashboardPanelManager） */
  updateRapportDisplay(rapport: RapportPayload): void;
  /** 更新上下文感知展示（委托 DashboardPanelManager） */
  updateContextDisplay(context: ContextPayload): void;
  /** 更新模式检测展示（委托 DashboardPanelManager） */
  updatePatternsDisplay(payload: PatternsPayload): void;
  /** 更新主动提示统计展示（委托 DashboardPanelManager） */
  updateProactiveStatsDisplay(stats: unknown): void;
}

/**
 * 感知面板控制器类
 *
 * 职责：感知面板展开/收起 + 感知快照拉取 + 三块折叠区域 + 推荐记忆点击
 * 依赖：EventTracker（事件监听器管理）+ PerceptionPanelHost（回调 UIManager）
 * 生命周期：init() 绑定事件 → cleanup() 清理事件
 */
export class PerceptionPanelController {
  /** 事件监听器统一管理（自包含，不依赖 UIManager.events） */
  private events = new EventTracker();

  /**
   * 构造函数：注入 Host 接口
   *
   * @param host UIManager 实现的 PerceptionPanelHost 接口
   */
  constructor(private readonly host: PerceptionPanelHost) {}

  /**
   * 初始化：绑定感知面板相关事件
   *
   * 在 UIManager 构造完成后调用，避免事件触发时 Host 方法未就绪。
   */
  init(): void {
    this.bindRecommendationClick();
    this.bindStatusBarToggle();
    this.bindCloseButton();
    this.bindMetricsToggle();
    this.bindReviewToggle();
    this.bindSourceHealthToggle();
  }

  /**
   * 切换感知面板展开/收起状态
   *
   * 展开时主动拉取感知快照并刷新四块感知展示 + 主动提示统计。
   * 静默失败：拉取异常时保留 DOM 默认占位值，不阻塞面板展开。
   *
   * 由 UIManager 的 handleGlobalKeydown（Escape 键）和本控制器的状态条点击调用。
   */
  toggle(): void {
    const panel = document.getElementById('perception-panel');
    if (!panel) return;

    if (panel.classList.contains('visible')) {
      // 关闭面板（先播放动画再隐藏）
      panel.classList.add('hiding');
      panel.classList.remove('visible');
      setTimeout(() => {
        panel.classList.add('hidden');
        panel.classList.remove('hiding');
      }, 150);
    } else {
      // 打开面板
      panel.classList.remove('hidden', 'hiding');
      panel.classList.add('visible');
      // 主动拉取感知快照并刷新四块感知展示
      // 静默失败：拉取异常时保留 DOM 默认占位值，不阻塞面板展开
      void window.electronAPI
        .getPerceptionSnapshot()
        .then((snapshot) => {
          if (!snapshot) return;
          if (snapshot.affect) this.host.updateAffectDisplay(snapshot.affect);
          if (snapshot.rapport) this.host.updateRapportDisplay(snapshot.rapport);
          if (snapshot.context) this.host.updateContextDisplay(snapshot.context);
          if (snapshot.patterns) this.host.updatePatternsDisplay({ patterns: snapshot.patterns });
          // 缺口 G+H：主动提示统计（接受率 + 生效冷却，与 affect/rapport 同源推导）
          this.host.updateProactiveStatsDisplay(snapshot.proactiveStats ?? null);
        })
        .catch(() => {
          /* silent fail：保持默认值 */
        });
    }
  }

  /**
   * 关闭感知面板（仅动画，不拉取快照）
   *
   * 由 UIManager 的 handleGlobalKeydown（Escape 键）和本控制器的关闭按钮调用。
   */
  close(): void {
    const panel = document.getElementById('perception-panel');
    if (!panel) return;
    panel.classList.add('hiding');
    panel.classList.remove('visible');
    setTimeout(() => {
      panel.classList.add('hidden');
      panel.classList.remove('hiding');
    }, 150);
  }

  /**
   * 清理事件监听器
   *
   * 由 UIManager.cleanup() 调用，确保感知面板相关事件全部解绑。
   */
  cleanup(): void {
    this.events.cleanup();
  }

  // ─── 私有方法：事件绑定 ─────────────────────────────────

  /**
   * 绑定仪表盘推荐记忆点击事件（FD-ADD-REC-CLICK）
   *
   * 事件委托，复用 host.triggerMemoryRecall 跳转到记忆面板显示详情。
   */
  private bindRecommendationClick(): void {
    const recList = document.getElementById('recommendation-list');
    if (!recList) return;
    this.events.addEventListener(recList, 'click', (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('[data-action="view-recommendation"]');
      if (item) {
        const memoryId = item.dataset.memoryId ?? '';
        if (memoryId) {
          this.host.triggerMemoryRecall(memoryId);
        }
      }
    });
  }

  /**
   * 绑定精灵状态条点击/键盘事件（展开/收起感知面板）
   *
   * 键盘可访问性：Enter/Space 触发展开/收起。
   */
  private bindStatusBarToggle(): void {
    const spriteStatusBar = document.getElementById('sprite-status-bar');
    if (!spriteStatusBar) return;
    this.events.addEventListener(spriteStatusBar, 'click', () => this.toggle());
    this.events.addEventListener(spriteStatusBar, 'keydown', (e: Event) => {
      if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  /**
   * 绑定感知面板关闭按钮
   */
  private bindCloseButton(): void {
    const panelClose = document.querySelector('.perception-panel-close');
    if (!panelClose) return;
    this.events.addEventListener(panelClose as HTMLElement, 'click', () => this.close());
  }

  /**
   * 绑定运行指标折叠/展开
   */
  private bindMetricsToggle(): void {
    const metricsToggle = document.getElementById('perception-metrics-toggle');
    if (!metricsToggle) return;
    this.events.addEventListener(metricsToggle, 'click', () => {
      const grid = document.getElementById('perception-metrics-grid');
      const arrow = document.getElementById('perception-metrics-arrow');
      if (grid) grid.classList.toggle('hidden');
      if (arrow) arrow.classList.toggle('expanded');
    });
  }

  /**
   * 绑定对话回顾折叠/展开（与运行指标拆分为独立折叠区）
   */
  private bindReviewToggle(): void {
    const reviewToggle = document.getElementById('perception-review-toggle');
    if (!reviewToggle) return;
    this.events.addEventListener(reviewToggle, 'click', () => {
      const review = document.getElementById('perception-review');
      const arrow = document.getElementById('perception-review-arrow');
      if (review) review.classList.toggle('hidden');
      if (arrow) arrow.classList.toggle('expanded');
    });
  }

  /**
   * 绑定记忆源健康折叠/展开（缺口 E：与运行指标/对话回顾一致的折叠交互）
   */
  private bindSourceHealthToggle(): void {
    const sourceHealthToggle = document.getElementById('source-health-toggle');
    if (!sourceHealthToggle) return;
    this.events.addEventListener(sourceHealthToggle, 'click', () => {
      const list = document.getElementById('source-health-list');
      const arrow = document.getElementById('source-health-arrow');
      if (list) list.classList.toggle('hidden');
      if (arrow) arrow.classList.toggle('expanded');
    });
  }
}
