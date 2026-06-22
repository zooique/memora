/**
 * 建议卡片模块（H1：配置建议闭环）
 *
 * 职责：
 *   - 显示 AutoConfigRefiner 从对话中提取的配置建议
 *   - 提供"接受/拒绝"两个操作按钮
 *   - 接受时调用 acceptSuggestion IPC 持久化到配置文件
 *   - 拒绝时调用 rejectSuggestion IPC 记录日志
 *   - 卡片可堆叠（同时显示多条建议），用户处理后自动消失
 *
 * 设计原则：
 *   - 独立于 UIManager，通过组合方式持有（与 ProactiveBanner 同模式）
 *   - 事件监听器纳入 EventTracker 跟踪集合，cleanup 时统一清理
 *   - 卡片插入位置：#proactive-banner 之后、#messages 之前（顶部提示区）
 *   - 动画：从顶部滑入 + 淡入，操作后淡出消失
 */

import type { ConfigSuggestionPayload } from '../preload.js';
import { EventTracker } from './eventTracker.js';
import { reportError, toError } from './errorHelpers.js';
import { escapeHtml } from './domHelpers.js';

/**
 * 建议卡片管理器
 *
 * 管理 AutoConfigRefiner 推送的配置建议卡片的显示、操作和清理。
 * UIManager 通过组合持有此实例。
 */
export class SuggestionCardManager {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();
  /** 卡片容器 DOM 元素（由 init 时创建或获取） */
  private container: HTMLElement | null = null;
  /** 当前显示的卡片数量（用于限制同时显示的卡片数） */
  private readonly maxVisible = 3;

  /**
   * 初始化建议卡片管理器
   *
   * 创建卡片容器 DOM 元素（如果 HTML 中未预定义），
   * 插入到 #proactive-banner 之后、#messages 之前。
   */
  init(): void {
    // 尝试获取 HTML 中预定义的容器，否则动态创建
    let container = document.getElementById('suggestion-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'suggestion-container';
      container.className = 'suggestion-container';

      // 插入到 #proactive-banner 之后、#messages 之前
      const proactiveBanner = document.getElementById('proactive-banner');
      const messages = document.getElementById('messages');
      if (proactiveBanner && proactiveBanner.parentNode) {
        proactiveBanner.parentNode.insertBefore(container, proactiveBanner.nextSibling);
      } else if (messages && messages.parentNode) {
        messages.parentNode.insertBefore(container, messages);
      } else {
        // 兜底：追加到 body
        document.body.appendChild(container);
      }
    }
    this.container = container;
  }

  /**
   * 显示配置建议卡片
   *
   * @param suggestion 来自 AutoConfigRefiner 的配置建议
   */
  showSuggestion(suggestion: ConfigSuggestionPayload): void {
    if (!this.container) {
      console.warn('[SuggestionCard] 容器未初始化，跳过建议显示');
      return;
    }

    // 限制同时显示的卡片数量（FIFO：超出时移除最早的）
    const cards = this.container.querySelectorAll('.suggestion-card');
    if (cards.length >= this.maxVisible) {
      cards[0]?.remove();
    }

    const card = this.createCardElement(suggestion);
    this.container.appendChild(card);

    // 触发滑入动画（先设置 hidden 状态再移除，确保 transition 生效）
    requestAnimationFrame(() => {
      card.classList.remove('suggestion-card-enter');
    });
  }

  /**
   * 创建建议卡片 DOM 元素
   *
   * 卡片结构：
   *   <div class="suggestion-card suggestion-card-enter">
   *     <div class="suggestion-card-header">
   *       <span class="suggestion-card-icon">💡</span>
   *       <span class="suggestion-card-type">规则建议</span>
   *       <span class="suggestion-card-confidence">置信度 85%</span>
   *       <button class="suggestion-card-close">✕</button>
   *     </div>
   *     <div class="suggestion-card-name">TypeScript 偏好</div>
   *     <div class="suggestion-card-content">用户偏好函数式风格...</div>
   *     <div class="suggestion-card-actions">
   *       <button class="suggestion-card-btn accept">接受</button>
   *       <button class="suggestion-card-btn reject">拒绝</button>
   *     </div>
   *   </div>
   */
  private createCardElement(suggestion: ConfigSuggestionPayload): HTMLElement {
    const card = document.createElement('div');
    card.className = 'suggestion-card suggestion-card-enter';

    // 类型标签映射
    const typeLabels: Record<string, string> = {
      rule: '规则建议',
      persona: '角色建议',
      skill: '技能建议',
    };
    const typeLabel = typeLabels[suggestion.type] ?? '建议';

    // 构建卡片内容
    card.innerHTML = `
      <div class="suggestion-card-header">
        <span class="suggestion-card-icon">💡</span>
        <span class="suggestion-card-type">${typeLabel}</span>
        <span class="suggestion-card-confidence">置信度 ${Math.round(suggestion.confidence * 100)}%</span>
        <button class="suggestion-card-close" title="关闭">✕</button>
      </div>
      <div class="suggestion-card-name">${escapeHtml(suggestion.name)}</div>
      <div class="suggestion-card-content">${escapeHtml(suggestion.content)}</div>
      <div class="suggestion-card-actions">
        <button class="suggestion-card-btn accept">接受</button>
        <button class="suggestion-card-btn reject">拒绝</button>
      </div>
    `;

    // 注册事件监听器（纳入 EventTracker 统一清理）
    const closeBtn = card.querySelector<HTMLButtonElement>('.suggestion-card-close');
    const acceptBtn = card.querySelector<HTMLButtonElement>('.suggestion-card-btn.accept');
    const rejectBtn = card.querySelector<HTMLButtonElement>('.suggestion-card-btn.reject');

    if (closeBtn) {
      this.events.addEventListener(closeBtn, 'click', () => {
        this.removeCard(card);
      });
    }

    if (acceptBtn) {
      const capturedRejectBtn = rejectBtn;
      this.events.addEventListener(acceptBtn, 'click', async () => {
        acceptBtn.disabled = true;
        capturedRejectBtn && (capturedRejectBtn.disabled = true);
        acceptBtn.textContent = '处理中...';
        try {
          const result = await window.electronAPI.acceptSuggestion(suggestion);
          if (result.success) {
            this.removeCard(card);
          } else {
            // 恢复按钮状态，显示错误
            acceptBtn.disabled = false;
            capturedRejectBtn && (capturedRejectBtn.disabled = false);
            acceptBtn.textContent = '接受';
            reportError('SuggestionCard', `接受建议失败: ${result.error}`);
          }
        } catch (err) {
          acceptBtn.disabled = false;
          capturedRejectBtn && (capturedRejectBtn.disabled = false);
          acceptBtn.textContent = '接受';
          reportError('SuggestionCard', `接受建议异常: ${toError(err).message}`);
        }
      });
    }

    if (rejectBtn) {
      const capturedAcceptBtn = acceptBtn;
      this.events.addEventListener(rejectBtn, 'click', async () => {
        rejectBtn.disabled = true;
        capturedAcceptBtn && (capturedAcceptBtn.disabled = true);
        try {
          await window.electronAPI.rejectSuggestion(suggestion);
          this.removeCard(card);
        } catch (err) {
          rejectBtn.disabled = false;
          capturedAcceptBtn && (capturedAcceptBtn.disabled = false);
          reportError('SuggestionCard', `拒绝建议异常: ${toError(err).message}`);
        }
      });
    }

    return card;
  }

  /**
   * 移除卡片（带淡出动画）
   */
  private removeCard(card: HTMLElement): void {
    card.classList.add('suggestion-card-leave');
    card.addEventListener('animationend', () => {
      card.remove();
    }, { once: true });
  }

  /** 清理所有事件监听器和卡片（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.events.cleanup();
    if (this.container) {
      // 清空所有卡片
      while (this.container.firstChild) {
        this.container.removeChild(this.container.firstChild);
      }
    }
  }
}
