/**
 * 配置与角色 IPC 处理器
 *
 * 职责：
 *   1. 获取/更新精灵配置（CONFIG_GET / CONFIG_UPDATE）
 *   2. 角色列表/切换/模式管理（PERSONA_LIST / PERSONA_SWITCH / PERSONA_MODE / PERSONA_MODE_GET）
 *
 * CONFIG_UPDATE 含副作用：静默模式切换时同步托盘状态 + 重建菜单。
 *
 * QC-SPRITE-02 修复：静默模式恢复定时器从渲染层移至主进程。
 * 原实现依赖渲染层 setTimeout，托盘模式下（完整窗口未加载）定时器丢失，
 * 导致精灵永久静默。现在主进程在 silentModeExpiresAt 变更时管理定时器，
 * 确保无论渲染层是否运行都能自动恢复。
 */

import { ipcMain } from 'electron';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from './channels.js';
import { DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { SpriteConfigKey } from '../../sprite/spriteConfig.js';
import { safeHandle } from './types.js';
import type { IpcContext } from './types.js';

/**
 * 主进程静默模式恢复定时器（QC-SPRITE-02）
 *
 * 替代渲染层的 silentRecoveryTimer，确保托盘模式下也能自动恢复。
 * 当 silentModeExpiresAt 变更时启动/重置此定时器。
 */
let silentRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 安排静默模式自动恢复（QC-SPRITE-02）
 *
 * 根据 silentModeExpiresAt 计算剩余时间并设置主进程定时器。
 * 到期后自动关闭 silentMode 并清理相关状态。
 *
 * @param ctx IPC 上下文（用于更新配置和托盘状态）
 */
export function scheduleSilentRecovery(ctx: IpcContext): void {
  // 清除已有定时器（避免多个定时器叠加）
  if (silentRecoveryTimer !== null) {
    clearTimeout(silentRecoveryTimer);
    silentRecoveryTimer = null;
  }

  const config = ctx.sprite.getConfig();
  if (!config.silentMode || !config.silentModeExpiresAt) return;

  const expiresAtMs = new Date(config.silentModeExpiresAt).getTime();
  const remainingMs = expiresAtMs - Date.now();

  if (remainingMs <= 0) {
    // 已过期：立即关闭静默模式
    ctx.sprite.updateConfig('silentMode', false);
    ctx.sprite.updateConfig('silentModeExpiresAt', null);
    ctx.trayManager?.setState('idle');
    ctx.trayManager?.updateMenu();
    return;
  }

  // 设置主进程定时器，到期后自动恢复
  silentRecoveryTimer = setTimeout(() => {
    silentRecoveryTimer = null;
    ctx.sprite.updateConfig('silentMode', false);
    ctx.sprite.updateConfig('silentModeExpiresAt', null);
    ctx.trayManager?.setState('idle');
    ctx.trayManager?.updateMenu();
  }, remainingMs);
}

/**
 * 注册配置与角色 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerConfigHandlers(ctx: IpcContext): void {
  // ─── 配置相关 ────────────────────────────────────────────

  /** 获取精灵配置 */
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () =>
    // P2-010 修复：使用 DEFAULT_SPRITE_CONFIG 作为 fallback，避免空对象类型断言。
    safeHandle('获取配置失败', { config: DEFAULT_SPRITE_CONFIG }, () => ({ config: ctx.sprite.getConfig() }), ErrorCode.CONFIG_LOAD_FAILED),
  );

  /**
   * 校验配置键是否属于 SpriteConfig
   */
  function isSpriteConfigKey(key: string): key is SpriteConfigKey {
    return key in DEFAULT_SPRITE_CONFIG;
  }

  /** 更新配置项 */
  ipcMain.handle(IPC_CHANNELS.CONFIG_UPDATE, async (_event, key: string, value: unknown) => {
    try {
      if (!isSpriteConfigKey(key)) {
        return { success: false, error: `非法配置键：${key}` };
      }
      ctx.sprite.updateConfig(key, value);

      // 静默模式切换时同步托盘状态 + 重建菜单（确保勾选状态一致）
      if (key === 'silentMode') {
        if (value === true) {
          ctx.trayManager?.setState('sleeping');
        } else {
          ctx.trayManager?.setState('idle');
        }
        // 重建托盘菜单以反映静默模式勾选状态（通过设置面板/IPC 切换时菜单不会自动更新）
        ctx.trayManager?.updateMenu();
      }

      // QC-SPRITE-02：silentModeExpiresAt 变更时管理主进程恢复定时器
      if (key === 'silentModeExpiresAt') {
        scheduleSilentRecovery(ctx);
      }

      return { updated: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '更新配置失败' });
      return { updated: false };
    }
  });

  // ─── 角色相关 ────────────────────────────────────────────

  /** 列出所有角色 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_LIST, async () =>
    safeHandle('列出角色失败', { personas: [] }, () => ({ personas: ctx.sprite.listPersonas() })),
  );

  /** 切换角色 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_SWITCH, async (_event, name: string) =>
    safeHandle('切换角色失败', { switched: false, name: null }, () => {
      const result = ctx.sprite.switchPersona(name);
      return { switched: result !== null, name: result };
    }),
  );

  /** 设置角色匹配模式 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE, async (_event, mode: 'auto' | 'manual') =>
    safeHandle('设置角色模式失败', { set: false }, () => ({ set: ctx.sprite.setPersonaMode(mode) })),
  );

  /** IX-07 查询当前角色匹配模式（对齐 CLI /mode 查询能力） */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE_GET, async () =>
    safeHandle('查询角色模式失败', { mode: 'auto' }, () => ({ mode: ctx.sprite.personaMode })),
  );
}
