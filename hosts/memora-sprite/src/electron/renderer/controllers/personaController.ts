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

import type { UIManager } from '../ui.js';
import { createIpcErrorHandler, reportError } from '../helpers/errorHelpers.js';

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
   *
   * P0-2 用户体验打磨：根据 IPC 返回的 reason 字段区分失败原因，
   * 让用户知道为什么没反应（锁定/对话中/角色不存在/名称非法），
   * 而非笼统的"切换角色失败"。
   */
  function setupPersonaSelector(): void {
    uiManager.onPersonaSwitch(async (name: string) => {
      try {
        const result = await window.electronAPI.switchPersona(name);
        // 切换成功：更新 UI + success toast
        if (result.switched && result.name) {
          uiManager.updateActivePersona(result.name);
          // 同名幂等也走成功路径（用户主动选择当前角色不应提示失败）
          uiManager.showToast(`已切换到角色：${result.name}`, 'success');
          return;
        }

        // 按 reason 分支显示具体原因（P0-2 核心：信息可见性）
        switch (result.reason) {
          case 'locked': {
            // 锁定中：展示剩余锁定时长（unlockAt 为 ms epoch 时间戳）
            const unlockAt = result.unlockAt ?? 0;
            const remainingMs = Math.max(0, unlockAt - Date.now());
            const remainingMin = Math.ceil(remainingMs / 60_000);
            uiManager.showToast(
              `切换过于频繁，已临时锁定，约 ${remainingMin} 分钟后恢复`,
              'warning',
            );
            return;
          }
          case 'busy':
            // 对话进行中：提示用户等待
            uiManager.showToast('对话进行中，请等待当前对话结束后再切换角色', 'warning');
            return;
          case 'not_found':
            // 角色不存在：提示用户检查角色列表
            uiManager.showToast(`角色 "${name}" 不存在，请检查角色列表`, 'warning');
            return;
          case 'invalid':
            // 名称非法：通常不会从 UI 触发，但保留兜底
            uiManager.showToast('角色名称包含非法字符', 'warning');
            return;
          case 'unknown':
          default:
            // 未知异常：走错误处理（含日志上报）
            handleIpcError('onPersonaSwitch', new Error(result.error ?? '切换角色失败'), '切换角色失败');
            return;
        }
      } catch (error) {
        // IPC 异常（如主进程未响应）：走错误处理
        handleIpcError('onPersonaSwitch', error, '切换角色失败');
      }
    });

    // 角色匹配模式变更：实时持久化 + 更新标签
    // IPC 成功后主动同步 badge + 单选按钮状态，确保 UI 与主进程一致；
    //       IPC 失败时回滚到旧模式，避免 UI 显示新模式但主进程仍为旧模式
    uiManager.onPersonaModeChange(async (mode: string) => {
      // 回调触发时 settingsPanelManager 已更新 currentPersonaMode 为新模式，
      // 需在 IPC 调用前保存旧模式用于失败回滚
      const previousMode = mode === 'manual' ? 'auto' : 'manual';
      try {
        const validMode = mode === 'manual' ? 'manual' : 'auto';
        const { set } = await window.electronAPI.setPersonaMode(validMode);
        if (set) {
          // 防御性同步——确认 badge + 单选按钮状态与持久化值一致
          uiManager.updatePersonaModeBadge(validMode);
          uiManager.setPersonaMode(validMode);
          uiManager.showToast(`角色匹配模式已切换为：${mode === 'auto' ? '自动' : '手动'}`, 'success');
        } else {
          // IPC 拒绝切换，回滚 UI 到旧模式
          uiManager.updatePersonaModeBadge(previousMode);
          uiManager.setPersonaMode(previousMode);
          uiManager.showToast('角色匹配模式切换失败', 'error');
        }
      } catch (error) {
        // IPC 异常，回滚 UI 到旧模式
        uiManager.updatePersonaModeBadge(previousMode);
        uiManager.setPersonaMode(previousMode);
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

      // 加载当前角色匹配模式并更新标签
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
