/**
 * 剪贴板保护面板管理器
 *
 * 从 UIManager 拆分（约 61 行），统一管理"剪贴板三重保护"的 UI 联动。
 *
 * 职责：
 * - 被动检测到剪贴板变化时，显示带"分析"按钮的 Toast，由用户主动触发分析
 * - 内容通过敏感检测后，弹出确认对话框供用户预览并决定是否存为记忆
 *
 * 设计原则：
 * - 依赖注入：通过构造函数接收 ToastManager / ModalManager 引用，
 *   与 UIManager 共享同一实例，行为与拆分前完全一致
 * - 无事件监听器（不直接绑定 DOM 事件），无需 EventTracker
 * - 提供空 cleanup() 与其他 Manager 保持统一生命周期接口
 */

import type { ToastManager } from '../components/toast.js';
import type { ModalManager } from '../components/modal.js';

/**
 * 剪贴板保护面板管理器类
 *
 * 职责：被动检测剪贴板变化 → 用户确认 → 存为记忆
 * 依赖：ToastManager（显示提示）、ModalManager（确认对话框）
 * 生命周期：无事件监听器，cleanup() 为空实现
 */
export class ClipboardManager {
  /**
   * 构造函数：注入共享的 Toast / Modal 管理器实例
   *
   * @param toastManager Toast 通知管理器（用于显示提示和成功 toast）
   * @param modalManager 模态框管理器（用于显示确认对话框）
   */
  constructor(
    /** 共享的 Toast 管理器实例（与 UIManager 同一引用） */
    private readonly toastManager: ToastManager,
    /** 共享的 Modal 管理器实例（与 UIManager 同一引用） */
    private readonly modalManager: ModalManager,
  ) {}

  /**
   * 显示剪贴板变化 Toast（带"分析"按钮）
   *
   * 被动检测到剪贴板变化时调用，显示 info Toast 提示用户。
   * 用户点击"分析"按钮后触发主动分析（读取内容 + 敏感检测 + 护栏检查）。
   * 不自动消失，让用户有时间决定是否分析。
   */
  showClipboardChangedToast(): void {
    this.toastManager.showToast('剪贴板有新内容', 'info', 0, {
      actionLabel: '分析',
      onAction: () => {
        // 用户点击"分析"按钮，调用主进程读取并检测剪贴板内容
        void window.electronAPI.clipboardAnalyze();
      },
    });
  }

  /**
   * 显示剪贴板内容确认对话框
   *
   * 内容通过敏感检测和护栏检查后调用，展示内容预览供用户确认。
   * 用户确认后通过 MEMORIES_ADD 通道写入记忆。
   *
   * @param content 剪贴板内容（已通过检测）
   */
  async showClipboardConfirmDialog(content: string): Promise<void> {
    // 构建内容预览 DOM（防 XSS，使用 textContent）
    const container = document.createElement('div');
    container.className = 'write-confirm-info';

    const contentP = document.createElement('p');
    const contentLabel = document.createElement('strong');
    contentLabel.textContent = '内容：';
    contentP.appendChild(contentLabel);
    // 截断过长内容，避免对话框过大
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
    const codeEl = document.createElement('code');
    codeEl.textContent = preview;
    contentP.appendChild(codeEl);
    container.appendChild(contentP);

    const confirmed = await this.modalManager.showConfirmDialog({
      title: '将剪贴板内容存为记忆？',
      message: '',
      messageNodes: [container],
      confirmText: '存为记忆',
      cancelText: '取消',
    });

    if (confirmed) {
      // 用户确认后，通过 MEMORIES_ADD 写入记忆
      await window.electronAPI.addMemory({
        content,
        source: 'clipboard',
        name: `剪贴板记忆 ${new Date().toLocaleString()}`,
      });
      this.toastManager.showToast('已存为记忆', 'success');
    }
  }

  /**
   * 清理资源
   *
   * ClipboardManager 不持有事件监听器，无需实际清理。
   * 提供空实现以与其他 Manager 保持统一的生命周期接口。
   */
  cleanup(): void {
    // 无需清理——Toast / Modal 实例由 UIManager 持有，由其统一 cleanup
  }
}
