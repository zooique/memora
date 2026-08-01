/**
 * Token 用量指示器组件
 *
 * 职责（封装 InputAreaManager 中 Token 用量指示器的 DOM 操作）：
 * - 管理 Token 用量 DOM 元素引用（usage/text/fill）
 * - 渲染空状态（0/窗口）、正常用量、错误状态
 * - 用量颜色分级（正常/警告/危险）与紧凑态切换
 * - hover tooltip 展示输入/输出 token 分解
 *
 * 与现有 HTML 模板的关系：
 * - 用量指示器 DOM 元素已存在于 index.html 模板中（#token-usage 等）
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素（模板部分），仅 nullify 引用
 *
 * 对齐 ARCH-COMP-1 阶段 4 方案：
 * - Manager 持有 Component 实例，调用 mount/showEmpty/showUsage/showError 方法
 * - Manager 的 refreshTokenUsage 调用 Component 的 DOM 操作方法
 * - 业务逻辑（IPC 获取 metrics、计算 contextWindow）保留在 Manager
 */

import { Component } from '../base/component.js';
// formatTokenCount 统一 token 数量格式化（UX-12：小写 k 后缀，shared/numberUtils 真理源）
import { formatTokenCount } from '../../../../shared/numberUtils.js';

// ─── 组件选项 ──────────────────────────────────────────────

/** TokenUsageComponent 配置（当前无跨模块关注点注入，保留接口供后续扩展） */
export interface TokenUsageOptions {
  // 预留扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * Token 用量指示器组件
 *
 * 由 InputAreaManager 持有实例，替代原有 3 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #token-usage / #token-usage-text / #token-usage-fill。
 * 提供空状态、正常用量、错误状态的渲染方法。
 */
export class TokenUsageComponent extends Component<TokenUsageOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** Token 用量容器（控制紧凑态/错误态切换 + tooltip 承载） */
  private usageEl: HTMLElement | null = null;
  /** Token 用量文本（显示「已用/总量」或 '--'） */
  private textEl: HTMLElement | null = null;
  /** Token 进度条填充元素（宽度反映用量比例，颜色反映等级） */
  private fillEl: HTMLElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: TokenUsageOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 用量指示器 DOM 元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约，本组件不使用）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    // 查询并缓存 DOM 引用（元素可能尚未渲染，缺失时为 null，方法内部做防御）
    this.usageEl = document.getElementById('token-usage');
    this.textEl = document.getElementById('token-usage-text');
    this.fillEl = document.getElementById('token-usage-fill');
    // 设置 this.el 为 usageEl（Component 基类需要根元素锚点）
    // destroy 时会先 nullify this.el，避免基类 remove() 删除模板元素
    this.el = this.usageEl;
    return this;
  }

  /**
   * 增量更新——当前组件不使用 update 模式
   *
   * 用量操作通过 showEmpty/showUsage/showError 等显式方法完成。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  /**
   * 销毁组件——nullify 引用
   *
   * 用量元素是 HTML 模板的一部分，不删除 DOM。
   * 先 nullify this.el 防止基类 destroy() 的 el.remove() 删除模板元素，
   * 再调用 super.destroy() 清理 trackEvent 收集的事件解绑函数（本组件无事件，但保持契约一致）。
   */
  destroy(): void {
    this.usageEl = null;
    this.textEl = null;
    this.fillEl = null;
    this.el = null; // 防止 super.destroy() 移除模板元素
    super.destroy(); // 清理 _cleanups（本组件无事件，仍调用以保持基类契约）
  }

  // ─── 状态渲染 ──────────────────────────────────────────

  /**
   * 显示空状态（无用量数据时）
   *
   * 无用量数据 ≠ 未知。显示「0/窗口」比模糊的 '--' 更友好、更准确。
   * 紧凑态隐藏进度条，仅显示文本；清除历史错误标记。
   *
   * @param contextWindow 上下文窗口大小（token 数）
   */
  showEmpty(contextWindow: number): void {
    // 显示「0/窗口」，比 '--' 更准确（providerList 已取到，可算出窗口大小）
    if (this.textEl) {
      this.textEl.textContent = `0/${formatTokenCount(contextWindow)}`;
    }
    // 进度条归零
    if (this.fillEl) {
      this.fillEl.style.width = '0%';
    }
    // 紧凑态：隐藏进度条，仅显示「0/窗口」
    this.usageEl?.classList.add('token-usage-compact');
    // 空态清除历史错误标记（与失败态 '--' 区分）
    this.usageEl?.classList.remove('token-usage-error');
    // 空态语义已自明（0/窗口），清除可能残留的旧 tooltip
    this.usageEl?.setAttribute('data-tooltip', '');
  }

  /**
   * 显示正常用量
   *
   * 渲染「已用/总量」文本、进度条填充比例、颜色分级、紧凑态切换、tooltip 分解。
   *
   * @param total 已用总 token 数（输入 + 输出）
   * @param contextWindow 上下文窗口大小（token 数）
   * @param inputTokens 输入 token 数（tooltip 展示）
   * @param outputTokens 输出 token 数（tooltip 展示）
   */
  showUsage(total: number, contextWindow: number, inputTokens: number, outputTokens: number): void {
    // 格式化由 shared/numberUtils.formatTokenCount 提供（UX-12：统一小写 k 后缀）
    const windowK = formatTokenCount(contextWindow);

    // 显示「已用/总量」格式，比单独数字更有语义
    if (this.textEl) {
      this.textEl.textContent = `${formatTokenCount(total)}/${windowK}`;
    }

    // 进度条：基于上下文窗口大小计算填充比例（截断到 100%）
    const ratio = Math.min(total / contextWindow, 1);
    if (this.fillEl) {
      this.fillEl.style.width = `${Math.round(ratio * 100)}%`;

      // 用量颜色分级：正常(0-70%)/警告(70-90%)/危险(90-100%)
      this.fillEl.classList.remove('level-warning', 'level-danger');
      if (ratio >= 0.9) {
        this.fillEl.classList.add('level-danger');
      } else if (ratio >= 0.7) {
        this.fillEl.classList.add('level-warning');
      }
    }

    if (this.usageEl) {
      // 上下文相关显现：低使用时（<60%）隐藏进度条仅显示紧凑文字，高使用时（≥60%）展开进度条
      // 原理：日常对话 token 用量低，进度条信息价值有限且占用视觉空间；
      //       接近阈值时进度条提供关键预警价值，应展开。阈值 60% 早于警告级（70%），给用户缓冲。
      if (ratio < 0.6) {
        this.usageEl.classList.add('token-usage-compact');
      } else {
        this.usageEl.classList.remove('token-usage-compact');
      }

      // 成功路径清除历史错误态（防止上一次失败态残留）
      this.usageEl.classList.remove('token-usage-error');

      // hover 时展示输入/输出 token 分解（CSS ::after tooltip，与侧边栏风格统一）
      this.usageEl.setAttribute(
        'data-tooltip',
        `输入 ${formatTokenCount(inputTokens)} / 输出 ${formatTokenCount(outputTokens)} / 上下文 ${windowK}`,
      );
    }
  }

  /**
   * 显示错误状态（加载失败时）
   *
   * 失败时显示 '--' 降级，紧凑态隐藏进度条，错误态用 warning 色 + tooltip 区分「无数据」。
   */
  showError(): void {
    // 失败时显示 '--'（真正未知态，与空态「0/窗口」区分）
    if (this.textEl) {
      this.textEl.textContent = '--';
    }
    // 失败时使用紧凑态（隐藏进度条，仅显示 '--'）
    this.usageEl?.classList.add('token-usage-compact');
    // 错误态用 warning 色 + tooltip 区分「无数据」，与 quick-input 三态约定同构
    this.usageEl?.classList.add('token-usage-error');
    this.usageEl?.setAttribute('data-tooltip', '用量加载失败');
  }
}
