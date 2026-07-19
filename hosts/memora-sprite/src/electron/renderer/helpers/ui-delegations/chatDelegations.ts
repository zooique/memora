/**
 * Chat 委托群 + ProactiveBanner 委托 + StartupSummary 委托 + Archive 委托 + Toast 委托
 *
 * 从 ui.ts 提取的薄委托方法群，通过 mixin 模式注入 UIManager.prototype。
 * 所有方法均为纯透传，不夹带业务逻辑（ADR-SP-015 §4）。
 *
 * 设计原则：
 * - 每个方法的 this 类型声明为 UIManager，以访问组合持有的子模块实例
 * - 方法签名与 ui.ts 原始声明完全一致，保持外部契约不变
 */

// STEP9-IMPORTS-01 反向 type-only 引用：编译期擦除，禁止改为 value import（否则与 ui 形成运行时循环依赖）
import type { UIManager } from '../../ui.js';
import type { Message, ToastType, ToastOptions } from '../../types.js';

/** Chat 委托群方法签名（供 UIManager interface extends 类型合并） */
export interface ChatDelegations {
  appendMessage(message: Message): HTMLElement;
  appendMilestoneBanner(text: string): void;
  updateStreamingMessage(messageId: string, text: string): void;
  finishStreamingMessage(messageId: string): void;
  setMemoryRecall(messageId: string, memories: Array<{ id: string; name: string; score: number; source: string }>): void;
  showThinkingPhase(messageId: string, phase: string): void;
  showTruncationNotice(messageId: string, count: number): void;
  showToolStart(messageId: string, toolCallId: string, name: string, args?: string): void;
  updateToolResult(messageId: string, toolCallId: string, name: string, ok: boolean, summary?: string): void;
  startStreaming(messageId: string): void;
  stopAllStreaming(): void;
  clearMessages(): void;
  appendMessages(messages: Message[], prepend?: boolean): void;
  showLoadMore(remaining: number, onClick: () => void): void;
  hideLoadMore(): void;
  showLoadEarlierDay(onClick: () => void): void;
  injectErrorToStreamingMessages(errorText: string): void;
  markStreamingAborted(messageId: string, reason: string): void;
  showEmptyState(): void;
  hideEmptyState(): void;
  onSuggestionClick(cb: (text: string) => void): void;
  onErrorRetry(cb: () => void): void;
  showProactiveBanner(text: string, isMilestone?: boolean, triggers?: string[]): void;
  hideProactiveBanner(): void;
  initProactiveBannerButtons(handlers: {
    onView: (triggers: string[]) => void;
    onLater: () => void;
    onSilent: () => void;
    onDisable?: () => void;
  }): void;
  showStartupSummary(summary: {
    totalMemories: number;
    totalInsights: number;
    skillCount: number;
    decay: { runCount: number; totalDecayedCount: number } | null;
    perception: { warmth: number; rapportLevel: string; rapportDescription: string } | null;
    healthStatus: 'healthy' | 'warning' | 'critical' | null;
  }): void;
  showArchiveButton(): void;
  showToast(message: string, type?: ToastType, duration?: number, options?: ToastOptions): void;
}

/** Chat 委托群实现——纯透传到 chatPanel / proactiveBanner / toastManager */
export const chatDelegations: ChatDelegations = {
  appendMessage(this: UIManager, message: Message): HTMLElement {
    return this.chatPanel.appendMessage(message);
  },
  appendMilestoneBanner(this: UIManager, text: string): void {
    this.chatPanel.appendMilestoneBanner(text);
  },
  updateStreamingMessage(this: UIManager, messageId: string, text: string): void {
    this.chatPanel.updateStreamingMessage(messageId, text);
  },
  finishStreamingMessage(this: UIManager, messageId: string): void {
    this.chatPanel.finishStreamingMessage(messageId);
  },
  setMemoryRecall(this: UIManager, messageId: string, memories: Array<{ id: string; name: string; score: number; source: string }>): void {
    this.chatPanel.setMemoryRecall(messageId, memories);
  },
  showThinkingPhase(this: UIManager, messageId: string, phase: string): void {
    this.chatPanel.showThinkingPhase(messageId, phase);
  },
  showTruncationNotice(this: UIManager, messageId: string, count: number): void {
    this.chatPanel.showTruncationNotice(messageId, count);
  },
  showToolStart(this: UIManager, messageId: string, toolCallId: string, name: string, args?: string): void {
    this.chatPanel.showToolStart(messageId, toolCallId, name, args);
  },
  updateToolResult(this: UIManager, messageId: string, toolCallId: string, name: string, ok: boolean, summary?: string): void {
    this.chatPanel.updateToolResult(messageId, toolCallId, name, ok, summary);
  },
  startStreaming(this: UIManager, messageId: string): void {
    this.chatPanel.startStreaming(messageId);
  },
  stopAllStreaming(this: UIManager): void {
    this.chatPanel.stopAllStreaming();
  },
  clearMessages(this: UIManager): void {
    this.chatPanel.clearMessages();
  },
  appendMessages(this: UIManager, messages: Message[], prepend?: boolean): void {
    this.chatPanel.appendMessages(messages, prepend);
  },
  showLoadMore(this: UIManager, remaining: number, onClick: () => void): void {
    this.chatPanel.showLoadMore(remaining, onClick);
  },
  hideLoadMore(this: UIManager): void {
    this.chatPanel.hideLoadMore();
  },
  showLoadEarlierDay(this: UIManager, onClick: () => void): void {
    this.chatPanel.showLoadEarlierDay(onClick);
  },
  injectErrorToStreamingMessages(this: UIManager, errorText: string): void {
    this.chatPanel.injectErrorToStreamingMessages(errorText);
  },
  markStreamingAborted(this: UIManager, messageId: string, reason: string): void {
    this.chatPanel.markStreamingAborted(messageId, reason);
  },
  showEmptyState(this: UIManager): void {
    this.chatPanel.showEmptyState();
  },
  hideEmptyState(this: UIManager): void {
    this.chatPanel.hideEmptyState();
  },
  onSuggestionClick(this: UIManager, cb: (text: string) => void): void {
    this.chatPanel.onSuggestionClick(cb);
  },
  onErrorRetry(this: UIManager, cb: () => void): void {
    this.chatPanel.onErrorRetry(cb);
  },
  showProactiveBanner(this: UIManager, text: string, isMilestone = false, triggers: string[] = []): void {
    this.proactiveBanner.showProactiveBanner(text, isMilestone, triggers);
  },
  hideProactiveBanner(this: UIManager): void {
    this.proactiveBanner.hideProactiveBanner();
  },
  initProactiveBannerButtons(this: UIManager, handlers: {
    onView: (triggers: string[]) => void;
    onLater: () => void;
    onSilent: () => void;
    onDisable?: () => void;
  }): void {
    this.proactiveBanner.initProactiveBannerButtons(handlers);
  },
  showStartupSummary(this: UIManager, summary: {
    totalMemories: number;
    totalInsights: number;
    skillCount: number;
    decay: { runCount: number; totalDecayedCount: number } | null;
    perception: { warmth: number; rapportLevel: string; rapportDescription: string } | null;
    healthStatus: 'healthy' | 'warning' | 'critical' | null;
  }): void {
    this.chatPanel.showStartupSummary(summary);
  },
  showArchiveButton(this: UIManager): void {
    this.chatPanel.showArchiveButton();
  },
  showToast(this: UIManager, message: string, type: ToastType = 'info', duration?: number, options?: ToastOptions): void {
    this.toastManager.showToast(message, type, duration, options);
  },
};
