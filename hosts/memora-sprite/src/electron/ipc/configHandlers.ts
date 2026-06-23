/**
 * 配置与角色 IPC 处理器
 *
 * 职责：
 *   1. 获取/更新精灵配置（CONFIG_GET / CONFIG_UPDATE）
 *   2. 角色列表/切换/模式管理（PERSONA_LIST / PERSONA_SWITCH / PERSONA_MODE / PERSONA_MODE_GET）
 *
 * CONFIG_UPDATE 含副作用：静默模式切换时同步托盘状态 + 重建菜单。
 */

import { ipcMain } from 'electron';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from '../ipcChannels.js';
import { DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { SpriteConfigKey } from '../../sprite/spriteConfig.js';
import { safeHandle } from './types.js';
import type { IpcContext } from './types.js';

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
