/**
 * 杂项委托群：CommandPalette / InputArea / SuggestionCard / ScrollControl /
 * DateNav / SearchMessages / Clipboard / PanelRouter / Onboarding / Memory 导航
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
import type { ConfigSuggestionPayload } from '../../../preload.js';

/** 杂项委托群方法签名（供 UIManager interface extends 类型合并） */
export interface MiscDelegations {
  openCommandPalette(): void;
  refreshTokenUsage(): void;
  showSuggestion(suggestion: ConfigSuggestionPayload): void;
  scrollToBottom(): void;
  forceScrollToBottom(): void;
  updateMaximizeButton(maximized: boolean): void;
  onDateNavJump(cb: (date: string) => void): void;
  updateDateNavAvailableDates(dates: string[], counts?: Map<string, number>): void;
  setDateNavCurrentDate(date: string): void;
  onDateNavDelete(cb: (date: string) => void): void;
  onBackToToday(cb: () => void): void;
  onSearchResultClick(cb: (date: string, session: string) => void): void;
  showClipboardConfirmDialog(content: string): Promise<void>;
  handleQuickRecordTrigger(): Promise<void>;
  handleRecallMemoryTrigger(): Promise<void>;
  prefillChatInput(text: string): void;
  shouldShowOnboarding(hasProviders: boolean): boolean;
  showOnboardingDialog(): void;
  scrollToMemory(id: string): void;
}

/** 杂项委托群实现——纯透传到各子模块 */
export const miscDelegations: MiscDelegations = {
  openCommandPalette(this: UIManager): void {
    this.commandPaletteManager.open();
  },
  refreshTokenUsage(this: UIManager): void {
    void this.chatCoordinator.inputAreaManager.refreshTokenUsage();
  },
  showSuggestion(this: UIManager, suggestion: ConfigSuggestionPayload): void {
    this.chatCoordinator.suggestionCard.showSuggestion(suggestion);
  },
  scrollToBottom(this: UIManager): void {
    this.scrollController.scrollToBottom();
  },
  forceScrollToBottom(this: UIManager): void {
    this.scrollController.forceScrollToBottom();
  },
  updateMaximizeButton(this: UIManager, maximized: boolean): void {
    // HEAL-12：委托到 WindowControlsController（原 PanelRouter.updateMaximizeButton）
    this.windowControlsController.updateMaximizeButton(maximized);
  },
  onDateNavJump(this: UIManager, cb: (date: string) => void): void {
    this.dateNavManager.onDateNavJump(cb);
  },
  updateDateNavAvailableDates(this: UIManager, dates: string[], counts?: Map<string, number>): void {
    this.dateNavManager.updateAvailableDates(dates, counts);
  },
  setDateNavCurrentDate(this: UIManager, date: string): void {
    this.dateNavManager.setCurrentDate(date);
  },
  onDateNavDelete(this: UIManager, cb: (date: string) => void): void {
    this.dateNavManager.onDateNavDelete(cb);
  },
  onBackToToday(this: UIManager, cb: () => void): void {
    this.dateNavManager.onBackToToday(cb);
  },
  onSearchResultClick(this: UIManager, cb: (date: string, session: string) => void): void {
    this.searchMessagesManager.onResultClick(cb);
  },
  async showClipboardConfirmDialog(this: UIManager, content: string): Promise<void> {
    await this.clipboardManager.showClipboardConfirmDialog(content);
  },
  async handleQuickRecordTrigger(this: UIManager): Promise<void> {
    // HEAL-12：委托到 GlobalShortcutDispatcher（原 PanelRouter.handleQuickRecordTrigger）
    await this.globalShortcutDispatcher.handleQuickRecordTrigger();
  },
  async handleRecallMemoryTrigger(this: UIManager): Promise<void> {
    // HEAL-12：委托到 GlobalShortcutDispatcher（原 PanelRouter.handleRecallMemoryTrigger）
    await this.globalShortcutDispatcher.handleRecallMemoryTrigger();
  },
  prefillChatInput(this: UIManager, text: string): void {
    this.chatCoordinator.inputAreaManager.setValue(text);
  },
  shouldShowOnboarding(this: UIManager, hasProviders: boolean): boolean {
    return this.onboardingManager.shouldShowOnboarding(hasProviders);
  },
  showOnboardingDialog(this: UIManager): void {
    this.onboardingManager.showOnboardingDialog();
  },
  scrollToMemory(this: UIManager, id: string): void {
    this.memoryPanel.scrollToMemory(id);
  },
};
