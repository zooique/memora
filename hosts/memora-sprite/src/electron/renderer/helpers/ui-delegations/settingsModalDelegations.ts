/**
 * Settings / Profile / WorkProjection / Audit / Modal / PanelError / SkillDrop 委托群
 *
 * 从 ui.ts 提取的薄委托方法群，通过 mixin 模式注入 UIManager.prototype。
 * 所有方法均为纯透传，不夹带业务逻辑（ADR-SP-015 §4）。
 *
 * 设计原则：
 * - 每个方法的 this 类型声明为 UIManager，以访问组合持有的子模块实例
 * - 方法签名与 ui.ts 原始声明完全一致，保持外部契约不变
 */

import type { UIManager } from '../../ui.js';
import type { SpriteConfigForm, ConfirmDialogOptions } from '../../types.js';

/** Settings / Profile / Modal / PanelError / SkillDrop 委托群方法签名（供 UIManager interface extends 类型合并） */
export interface SettingsModalDelegations {
  loadUserProfile(): Promise<void>;
  loadWorkProjections(): Promise<void>;
  loadAuditLog(): Promise<void>;
  setClearAuditLogCallback(cb: () => Promise<void>): void;
  setConfirmProfileCallback(cb: (id: string) => Promise<void>): void;
  setRejectProfileCallback(cb: (id: string) => Promise<void>): void;
  onProviderChanged(): void;
  loadEmbeddingConfig(data: { embedding: { model: string; baseUrl: string; apiKey: string } | null }): void;
  loadProjectsToForm(projects: Array<{ name: string; path: string }>, selectedPath: string): void;
  setPersonaMode(mode: string): void;
  collectConfigFromForm(): SpriteConfigForm;
  onConfigSave(cb: (config: SpriteConfigForm) => Promise<boolean>): void;
  resetSettingsFormDirty(): void;
  isSettingsDirty(): boolean;
  updateAgentStatusIndicator(status: 'ready' | 'error' | 'unknown', message?: string): void;
  showPanelError(panelId: string, message: string, retryCallback?: () => void): void;
  hidePanelError(panelId: string): void;
  showSettingsError(message: string, retryCallback?: () => void): void;
  hideSettingsError(): void;
  showModal(modalId: string): void;
  hideModal(modalId: string): void;
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  showInputDialog(options: {
    title?: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    maxLength?: number;
    required?: boolean;
  }): Promise<string | null>;
  onSkillInstalled(callback: () => void): void;
  handleSkillDrop(files: File[]): Promise<void>;
  handleSkillFileSelect(): void;
}

/** Settings / Profile / Modal / PanelError / SkillDrop 委托群实现——纯透传到各子模块 */
export const settingsModalDelegations: SettingsModalDelegations = {
  async loadUserProfile(this: UIManager): Promise<void> {
    await this.profilePanel.load();
  },
  async loadWorkProjections(this: UIManager): Promise<void> {
    await this.workProjectionPanel.load();
  },
  async loadAuditLog(this: UIManager): Promise<void> {
    await this.auditPanel.load();
  },
  setClearAuditLogCallback(this: UIManager, cb: () => Promise<void>): void {
    this.auditPanel.setClearAuditLogCallback(cb);
  },
  setConfirmProfileCallback(this: UIManager, cb: (id: string) => Promise<void>): void {
    this.profilePanel.setConfirmProfileCallback(cb);
  },
  setRejectProfileCallback(this: UIManager, cb: (id: string) => Promise<void>): void {
    this.profilePanel.setRejectProfileCallback(cb);
  },
  onProviderChanged(this: UIManager): void {
    void this.inputAreaManager.loadProviderSelector();
  },
  loadEmbeddingConfig(this: UIManager, data: { embedding: { model: string; baseUrl: string; apiKey: string } | null }): void {
    this.settingsPanelManager.loadEmbeddingConfig(data);
  },
  loadProjectsToForm(this: UIManager, projects: Array<{ name: string; path: string }>, selectedPath: string): void {
    this.settingsPanelManager.loadProjectsToForm(projects, selectedPath);
  },
  setPersonaMode(this: UIManager, mode: string): void {
    this.settingsPanelManager.setPersonaMode(mode);
  },
  collectConfigFromForm(this: UIManager): SpriteConfigForm {
    return this.settingsPanelManager.collectConfigFromForm();
  },
  onConfigSave(this: UIManager, cb: (config: SpriteConfigForm) => Promise<boolean>): void {
    this.settingsPanelManager.onConfigSave(cb);
  },
  resetSettingsFormDirty(this: UIManager): void {
    this.settingsPanelManager.resetFormDirty();
  },
  isSettingsDirty(this: UIManager): boolean {
    return this.settingsPanelManager.isDirty();
  },
  updateAgentStatusIndicator(this: UIManager, status: 'ready' | 'error' | 'unknown', message?: string): void {
    this.settingsPanelManager.updateAgentStatusIndicator(status, message);
  },
  showPanelError(this: UIManager, panelId: string, message: string, retryCallback?: () => void): void {
    this.panelErrorBannerManager.showPanelError(panelId, message, retryCallback);
  },
  hidePanelError(this: UIManager, panelId: string): void {
    this.panelErrorBannerManager.hidePanelError(panelId);
  },
  showSettingsError(this: UIManager, message: string, retryCallback?: () => void): void {
    this.panelErrorBannerManager.showPanelError('settings', message, retryCallback);
  },
  hideSettingsError(this: UIManager): void {
    this.panelErrorBannerManager.hidePanelError('settings');
  },
  showModal(this: UIManager, modalId: string): void {
    this.modalManager.showModal(modalId);
  },
  hideModal(this: UIManager, modalId: string): void {
    this.modalManager.hideModal(modalId);
  },
  showConfirmDialog(this: UIManager, options: ConfirmDialogOptions): Promise<boolean> {
    return this.modalManager.showConfirmDialog(options);
  },
  showInputDialog(this: UIManager, options: {
    title?: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    maxLength?: number;
    required?: boolean;
  }): Promise<string | null> {
    return this.modalManager.showInputDialog(options);
  },
  onSkillInstalled(this: UIManager, callback: () => void): void {
    this.skillDropManager.onSkillInstalled(callback);
  },
  async handleSkillDrop(this: UIManager, files: File[]): Promise<void> {
    await this.skillDropManager.handleSkillDrop(files);
  },
  handleSkillFileSelect(this: UIManager): void {
    this.skillDropManager.handleSkillFileSelect();
  },
};
