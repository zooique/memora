/**
 * Settings 域二级协调器
 *
 * 封装设置相关的 3 个子模块：
 * - settingsPanelManager（LLM 配置、精灵行为、项目设定）
 * - settingsManagerPanel（角色/规则/技能文件 CRUD）
 * - currentConfig（缓存当前 SpriteConfig，供 getArchiveMode 查询）
 *
 * 设计原则（对齐 ChatCoordinator / MemoryCoordinator / PerceptionCoordinator 模式）：
 * - 纯状态容器 + cleanup 集中清理（不持有业务逻辑，业务逻辑仍在 UIManager + mixin）
 * - 字段公开暴露，settingsModalDelegations / miscDelegations mixin 直接读写
 * - 初始化仍在 UIManager 构造函数（settingsPanelManager 依赖 SettingsPanelHost 反向注入）
 *
 * 集成点：
 * - UIManager 持有 settingsCoordinator 实例并挂载到 this.settingsCoordinator
 * - settingsModalDelegations.ts 通过 this.settingsCoordinator.settingsPanelManager 等访问
 * - UIManager.cleanup() 调用 settingsCoordinator.cleanup() 集中清理
 */

import type { SettingsPanelManager } from '../panels/settingsPanelManager.js';
import type { SettingsManagerPanelManager } from '../panels/settingsManagerPanel.js';
import type { SpriteConfigForm } from '../types.js';

/**
 * Settings 域二级协调器类
 *
 * 集中管理设置相关的 3 个子模块，避免分散在 UIManager 中。
 */
export class SettingsCoordinator {
  /** 设置面板管理器（LLM 配置、精灵行为、项目设定），UIManager 构造函数初始化 */
  settingsPanelManager!: SettingsPanelManager;
  /** 精灵设定面板管理器（角色/规则/技能文件 CRUD），UIManager 构造函数初始化 */
  settingsManagerPanel!: SettingsManagerPanelManager;
  /** 缓存当前 SpriteConfig（供 getArchiveMode 查询），UIManager 读写 */
  currentConfig: SpriteConfigForm | null = null;

  /**
   * 集中清理 2 个子模块资源
   *
   * UIManager.cleanup() 调用，确保事件监听器等正确释放。
   */
  cleanup(): void {
    this.settingsPanelManager.cleanup();
    this.settingsManagerPanel.cleanup();
  }
}
