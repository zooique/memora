/**
 * Persona + Theme 委托群
 *
 * 从 ui.ts 提取的薄委托方法群，通过 mixin 模式注入 UIManager.prototype。
 * 所有方法均为纯透传到 PersonaPanelManager / ThemeManager / SettingsPanelManager，
 * 不夹带业务逻辑（ADR-SP-015 §4）。
 *
 * 设计原则：
 * - 每个方法的 this 类型声明为 UIManager，以访问组合持有的子模块实例
 * - 方法签名与 ui.ts 原始声明完全一致，保持外部契约不变
 */

// STEP9-IMPORTS-01 反向 type-only 引用：编译期擦除，禁止改为 value import（否则与 ui 形成运行时循环依赖）
import type { UIManager } from '../../ui.js';
import type { PersonaItem } from '../../types.js';

/** Persona + Theme 委托群方法签名（供 UIManager interface extends 类型合并） */
export interface PersonaThemeDelegations {
  renderPersonaDropdown(personas: PersonaItem[]): void;
  updateActivePersona(name: string): void;
  updatePersonaModeBadge(mode: string): void;
  onPersonaSwitch(cb: (name: string) => void): void;
  onMemoryRecallClick(cb: (memoryId: string) => void): void;
  triggerMemoryRecall(memoryId: string): void;
  onArchiveModeChange(cb: (mode: 'full' | 'insights-only' | 'manual') => void): void;
  onThemeChange(cb: (theme: 'light' | 'dark', source: 'user' | 'system') => void): void;
  getThemeMode(): 'light' | 'dark' | 'auto';
  setTheme(theme: 'light' | 'dark' | 'auto'): void;
  syncThemeRadios(theme: 'light' | 'dark' | 'auto'): void;
}

/** Persona + Theme 委托群实现——纯透传到 personaPanel / themeManager / settingsPanelManager / chatPanel */
export const personaThemeDelegations: PersonaThemeDelegations = {
  renderPersonaDropdown(this: UIManager, personas: PersonaItem[]): void {
    this.personaPanel.renderPersonaDropdown(personas);
  },
  updateActivePersona(this: UIManager, name: string): void {
    this.personaPanel.updateActivePersona(name);
  },
  updatePersonaModeBadge(this: UIManager, mode: string): void {
    this.personaPanel.updatePersonaModeBadge(mode);
  },
  onPersonaSwitch(this: UIManager, cb: (name: string) => void): void {
    this.personaPanel.onPersonaSwitch(cb);
  },
  onMemoryRecallClick(this: UIManager, cb: (memoryId: string) => void): void {
    this.personaPanel.onMemoryRecallClick(cb);
    this.chatPanel.setMemoryRecallClickCallback(cb);
  },
  triggerMemoryRecall(this: UIManager, memoryId: string): void {
    this.personaPanel.triggerMemoryRecallClick(memoryId);
  },
  onArchiveModeChange(this: UIManager, cb: (mode: 'full' | 'insights-only' | 'manual') => void): void {
    this.settingsPanelManager.onArchiveModeChange(cb);
  },
  onThemeChange(this: UIManager, cb: (theme: 'light' | 'dark', source: 'user' | 'system') => void): void {
    this.themeManager.onThemeChange(cb);
  },
  getThemeMode(this: UIManager): 'light' | 'dark' | 'auto' {
    return this.themeManager.getThemeMode();
  },
  setTheme(this: UIManager, theme: 'light' | 'dark' | 'auto'): void {
    this.themeManager.setTheme(theme);
  },
  syncThemeRadios(this: UIManager, theme: 'light' | 'dark' | 'auto'): void {
    this.themeManager.syncThemeRadios(theme);
  },
};
