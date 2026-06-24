/**
 * 角色控制器 — 角色选择器业务逻辑
 *
 * 职责：
 * - 设置角色切换回调（调用主进程切换角色 + 更新 UI）
 * - 设置角色匹配模式变更回调（持久化模式 + 更新标签）
 * - 加载角色列表和当前匹配模式
 *
 * 设计原则：
 * - 接收 UIManager 实例，不持有模块级状态
 * - 角色匹配模式：auto（自动）/ manual（手动），实时持久化
 */

import type { UIManager } from './ui.js';
import { createIpcErrorHandler, reportError } from './helpers/errorHelpers.js';

/**
 * 创建角色控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 角色控制器接口（设置回调、加载列表）
 */
export function createPersonaController(uiManager: UIManager) {
  /** IPC 错误处理函数（绑定 uiManager） */
  const handleIpcError = createIpcErrorHandler(uiManager);

  /**
   * 设置角色选择器回调
   *
   * 包含角色切换（调用主进程 + 更新 UI + toast 反馈）
   * 和角色匹配模式变更（持久化 + 更新标签）。
   */
  function setupPersonaSelector(): void {
    uiManager.onPersonaSwitch(async (name: string) => {
      try {
        const { switched, name: activeName } = await window.electronAPI.switchPersona(name);
        if (switched && activeName) {
          uiManager.updateActivePersona(activeName);
          // IX-06 操作反馈走 toast
          uiManager.showToast(`已切换到角色：${activeName}`, 'success');
        }
      } catch (error) {
        handleIpcError('onPersonaSwitch', error, '切换角色失败');
      }
    });

    // IX-07 角色匹配模式变更：实时持久化 + 更新标签
    uiManager.onPersonaModeChange(async (mode: string) => {
      try {
        const validMode = mode === 'manual' ? 'manual' : 'auto';
        const { set } = await window.electronAPI.setPersonaMode(validMode);
        if (set) {
          uiManager.showToast(`角色匹配模式已切换为：${mode === 'auto' ? '自动' : '手动'}`, 'success');
        } else {
          uiManager.showToast('角色匹配模式切换失败', 'error');
        }
      } catch (error) {
        handleIpcError('onPersonaModeChange', error, '设置角色模式失败');
      }
    });
  }

  /**
   * 加载角色列表
   *
   * 从主进程加载角色列表，渲染下拉菜单，更新当前角色显示，
   * 并加载当前角色匹配模式更新标签。
   */
  async function loadPersonaList(): Promise<void> {
    try {
      const { personas } = await window.electronAPI.listPersonas();
      uiManager.renderPersonaDropdown(personas);

      // 更新当前角色显示
      const active = personas.find(p => p.active);
      if (active) {
        uiManager.updateActivePersona(active.name);
      }

      // IX-07 加载当前角色匹配模式并更新标签
      try {
        const { mode } = await window.electronAPI.getPersonaMode();
        uiManager.updatePersonaModeBadge(mode);
        uiManager.setPersonaMode(mode);
      } catch (modeErr) {
        reportError('loadPersonaList-mode', modeErr);
      }
    } catch (error) {
      // 角色列表加载失败：侧边栏非面板，使用 toast 通知
      reportError('loadPersonaList', error);
      uiManager.showToast('加载角色列表失败，请检查连接后重试', 'error');
    }
  }

  return {
    setupPersonaSelector,
    loadPersonaList,
  };
}
