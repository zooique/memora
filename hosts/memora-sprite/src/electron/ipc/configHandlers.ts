/**
 * 配置与角色 IPC 处理器
 *
 * 职责：
 *   1. 获取/更新精灵配置（CONFIG_GET / CONFIG_UPDATE）
 *   2. 角色列表/切换/模式管理（PERSONA_LIST / PERSONA_SWITCH / PERSONA_MODE / PERSONA_MODE_GET）
 *
 * CONFIG_UPDATE 含副作用：静默模式切换时同步托盘状态 + 重建菜单。
 *
 * 静默模式恢复定时器从渲染层移至主进程。
 * 原实现依赖渲染层 setTimeout，托盘模式下（完整窗口未加载）定时器丢失，
 * 导致精灵永久静默。现在主进程在 silentModeExpiresAt 变更时管理定时器，
 * 确保无论渲染层是否运行都能自动恢复。
 */

import { ipcMain } from 'electron';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from './channels.js';
import { DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { SpriteConfig, SpriteConfigKey, ShortcutConfig } from '../../sprite/spriteConfig.js';
import { safeHandle } from './types.js';
import { isValidPersonaName } from './inputValidation.js';
import type { IpcContext } from './types.js';

/**
 * 主进程静默模式恢复定时器
 *
 * 替代渲染层的 silentRecoveryTimer，确保托盘模式下也能自动恢复。
 * 当 silentModeExpiresAt 变更时启动/重置此定时器。
 */
let silentRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 安排静默模式自动恢复
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
    // 使用 DEFAULT_SPRITE_CONFIG 作为 fallback，避免空对象类型断言。
    safeHandle('获取配置失败', { config: DEFAULT_SPRITE_CONFIG }, () => ({ config: ctx.sprite.getConfig() }), ErrorCode.CONFIG_LOAD_FAILED),
  );

  /**
   * 校验配置键是否属于 SpriteConfig
   */
  function isSpriteConfigKey(key: string): key is SpriteConfigKey {
    return key in DEFAULT_SPRITE_CONFIG;
  }

  /**
   * 校验 shortcuts 配置结构（运行时类型守卫）
   *
   * sprite.updateConfig 内部用 applyConfigField 校验 shortcuts，但校验失败时不抛错
   * 仅忽略更新。此处副作用触发前需二次校验，避免 ShortcutManager 配置与 Sprite
   * 配置不一致（updateConfig 静默忽略非法值时，副作用不应执行）。
   */
  function isValidShortcutConfig(value: unknown): value is ShortcutConfig {
    if (typeof value !== 'object' || value === null) return false;
    const s = value as { enabled?: unknown; accelerators?: unknown };
    return (
      typeof s.enabled === 'boolean' &&
      typeof s.accelerators === 'object' &&
      s.accelerators !== null &&
      !Array.isArray(s.accelerators) &&
      Object.values(s.accelerators as Record<string, unknown>).every((v) => typeof v === 'string')
    );
  }

  /** 更新配置项 */
  ipcMain.handle(IPC_CHANNELS.CONFIG_UPDATE, async (_event, key: string, value: unknown) => {
    try {
      if (!isSpriteConfigKey(key)) {
        return { updated: false, error: `非法配置键：${key}` };
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

      // silentModeExpiresAt 变更时管理主进程恢复定时器
      if (key === 'silentModeExpiresAt') {
        scheduleSilentRecovery(ctx);
      }

      // Phase 3.3：shortcuts 变更时热更新全局快捷键（全量替换配置）
      // 二次校验避免 updateConfig 静默忽略非法值时副作用误触发
      if (key === 'shortcuts' && ctx.shortcutManager && isValidShortcutConfig(value)) {
        ctx.shortcutManager.setConfig(value);
      }

      return { updated: true };
    } catch (error) {
      // QC-CFG-03 修复：错误返回包含 error 字段，与非法配置键路径返回结构一致
      // 原实现仅返回 { updated: false }，调用方无法区分"配置键非法"与"更新失败"
      const message = error instanceof Error ? error.message : '更新配置失败';
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: message });
      return { updated: false, error: message };
    }
  });

  /**
   * QC-CONFIG-01 批量更新配置（事务性）
   *
   * 替代 onConfigSave 中 10 次串行 CONFIG_UPDATE 调用。主进程在单个事务内
   * 完成全部更新（原子性 + 单次持久化 + 副作用去重），避免半更新状态。
   *
   * 副作用处理：silentMode / silentModeExpiresAt 与 CONFIG_UPDATE handler 保持
   * 一致——批量应用成功后，按 key 是否出现在 updates 中触发对应副作用。
   */
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_UPDATE_BATCH,
    async (_event, updates: Record<string, unknown>) => {
      try {
        // 委托给 Sprite.updateConfigBatch：内部完成副本校验 → 原子应用 → 单次持久化 → 副作用去重
        const result = ctx.sprite.updateConfigBatch(updates as Partial<SpriteConfig>);

        // 应用失败：直接返回错误，不触发任何主进程侧副作用
        if (!result.updated) {
          return result;
        }

        // ─── 主进程侧副作用（与 CONFIG_UPDATE handler 对齐） ───
        // silentMode 切换时同步托盘状态 + 重建菜单（确保勾选状态一致）
        if ('silentMode' in updates) {
          if (updates.silentMode === true) {
            ctx.trayManager?.setState('sleeping');
          } else {
            ctx.trayManager?.setState('idle');
          }
          ctx.trayManager?.updateMenu();
        }

        // silentModeExpiresAt 变更时管理主进程恢复定时器
        if ('silentModeExpiresAt' in updates) {
          scheduleSilentRecovery(ctx);
        }

        // Phase 3.3：shortcuts 变更时热更新全局快捷键（全量替换配置）
        // 二次校验避免 updateConfigBatch 静默忽略非法值时副作用误触发
        if ('shortcuts' in updates && ctx.shortcutManager && isValidShortcutConfig(updates.shortcuts)) {
          ctx.shortcutManager.setConfig(updates.shortcuts);
        }

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : '批量更新配置失败';
        errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: message });
        return { updated: false, error: message };
      }
    },
  );

  // ─── 角色相关 ────────────────────────────────────────────

  /** 列出所有角色 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_LIST, async () =>
    safeHandle('列出角色失败', { personas: [] }, () => ({ personas: ctx.sprite.listPersonas() })),
  );

  /** 切换角色 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_SWITCH, async (_event, name: string) =>
    safeHandle('切换角色失败', { switched: false, name: null }, () => {
      // FOUNDATION-SEAL Phase 3 轮2：校验角色名称白名单字符 + 长度，防路径遍历
      if (!isValidPersonaName(name)) {
        return { switched: false, name: null };
      }
      const result = ctx.sprite.switchPersona(name);
      return { switched: result !== null, name: result };
    }),
  );

  /** 设置角色匹配模式 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE, async (_event, mode: 'auto' | 'manual') =>
    safeHandle('设置角色模式失败', { set: false }, () => {
      // 运行期校验（TS 类型在编译期擦除，恶意渲染进程可传任意值）
      // 仅允许 'auto' / 'manual'，其他值一律拒绝
      if (mode !== 'auto' && mode !== 'manual') {
        return { set: false };
      }
      return { set: ctx.sprite.setPersonaMode(mode) };
    }),
  );

  /** IX-07 查询当前角色匹配模式（对齐 CLI /mode 查询能力） */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE_GET, async () =>
    safeHandle('查询角色模式失败', { mode: 'auto' }, () => ({ mode: ctx.sprite.personaMode })),
  );
}
