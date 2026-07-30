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
 * 依赖渲染层 setTimeout，托盘模式下（完整窗口未加载）定时器丢失，
 * 导致精灵永久静默。现在主进程在 silentModeExpiresAt 变更时管理定时器，
 * 确保无论渲染层是否运行都能自动恢复。
 */

import { ipcMain, shell } from 'electron';
import { logger } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from './channels.js';
import { DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { SpriteConfig, SpriteConfigKey } from '../../sprite/spriteConfig.js';
import { throwingHandle, requireSprite } from './types.js';
import { isValidPersonaName, isValidShortcutConfig } from './inputValidation.js';
import type { IpcContext } from './types.js';
// ConfigFileType：设定文件类型联合（'persona' | 'rule' | 'skill'），用于 CONFIG_FILE_* 统一 handler
import type { ConfigFileType } from '../../sprite/configFileManager.js';

/**
 * 主进程静默模式恢复定时器
 *
 * 主进程统一管理静默模式恢复，确保托盘模式下也能自动恢复。
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

  // 同步路径在 handler 调用栈内，用 requireSprite 取一次实例缓存复用
  const sprite = requireSprite(ctx);
  const config = sprite.getConfig();
  if (!config.silentMode || !config.silentModeExpiresAt) return;

  const expiresAtMs = new Date(config.silentModeExpiresAt).getTime();
  // 防御非法日期字符串（用户手编 sprite.json 写入 "invalid" 等）：
  // getTime() 返回 NaN，NaN <= 0 为 false 会跳过立即关闭分支，
  // setTimeout(..., NaN) 被视为 0 触发高频循环 CPU 占满
  if (!Number.isFinite(expiresAtMs)) {
    logger.warn(
      { silentModeExpiresAt: config.silentModeExpiresAt },
      '[scheduleSilentRecovery] silentModeExpiresAt 不是有效日期，立即关闭静默模式',
    );
    sprite.updateConfig('silentMode', false);
    sprite.updateConfig('silentModeExpiresAt', null);
    ctx.trayManager?.setState('idle');
    ctx.trayManager?.updateMenu();
    return;
  }

  const remainingMs = expiresAtMs - Date.now();

  if (remainingMs <= 0) {
    // 已过期：立即关闭静默模式
    sprite.updateConfig('silentMode', false);
    sprite.updateConfig('silentModeExpiresAt', null);
    ctx.trayManager?.setState('idle');
    ctx.trayManager?.updateMenu();
    return;
  }

  // 设置主进程定时器，到期后自动恢复
  // 延迟回调脱离 handler 调用栈，用可选链取最新 Sprite 实例（reinitAgent 后旧实例可能已关闭），
  // Sprite 未就绪时静默跳过（恢复逻辑下次配置变更时再次触发）
  silentRecoveryTimer = setTimeout(() => {
    silentRecoveryTimer = null;
    ctx.getSprite()?.updateConfig('silentMode', false);
    ctx.getSprite()?.updateConfig('silentModeExpiresAt', null);
    ctx.trayManager?.setState('idle');
    ctx.trayManager?.updateMenu();
  }, remainingMs);
}

/**
 * 应用配置变更的主进程副作用
 *
 * 统一处理 CONFIG_UPDATE 和 CONFIG_UPDATE_BATCH 的副作用逻辑：
 *   - silentMode 切换：同步托盘状态 + 重建菜单（确保勾选状态一致）
 *   - silentModeExpiresAt 变更：管理主进程恢复定时器
 *   - shortcuts 变更：热更新全局快捷键（带二次校验）
 *
 * 提取理由（ADR-017 枝叶层 2 次提取原则）：
 *   CONFIG_UPDATE（单 key）与 CONFIG_UPDATE_BATCH（批量）的副作用逻辑完全一致，
 *   仅判断方式不同（`key === X` vs `'X' in updates`）。统一为 changes 入参，
 *   单 key 调用时构造 `{ [key]: value }` 传入，消除两处重复实现。
 *
 * @param ctx IPC 上下文（提供 trayManager / shortcutManager）
 * @param changes 已应用的配置变更（key → value），仅包含实际变更的键
 */
function applyConfigSideEffects(ctx: IpcContext, changes: Partial<SpriteConfig>): void {
  // silentMode 切换时同步托盘状态 + 重建菜单（确保勾选状态一致）
  // 重建托盘菜单以反映静默模式勾选状态（通过设置面板/IPC 切换时菜单不会自动更新）
  if ('silentMode' in changes) {
    if (changes.silentMode === true) {
      ctx.trayManager?.setState('sleeping');
    } else {
      ctx.trayManager?.setState('idle');
    }
    ctx.trayManager?.updateMenu();
  }

  // silentModeExpiresAt 变更时管理主进程恢复定时器
  if ('silentModeExpiresAt' in changes) {
    scheduleSilentRecovery(ctx);
  }

  // shortcuts 变更时热更新全局快捷键（全量替换配置）
  // 二次校验避免 updateConfig/updateConfigBatch 静默忽略非法值时副作用误触发
  if ('shortcuts' in changes && ctx.shortcutManager && isValidShortcutConfig(changes.shortcuts)) {
    ctx.shortcutManager.setConfig(changes.shortcuts);
  }
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
    throwingHandle('获取配置失败', () => ({ config: requireSprite(ctx).getConfig() }), ErrorCode.CONFIG_LOAD_FAILED),
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
        return { updated: false, error: `非法配置键：${key}` };
      }
      requireSprite(ctx).updateConfig(key, value);
      // 委托统一的副作用处理：构造单 key 变更对象传入 applyConfigSideEffects
      applyConfigSideEffects(ctx, { [key]: value } as Partial<SpriteConfig>);
      return { updated: true };
    } catch (error) {
      // 错误返回包含 error 字段，与非法配置键路径返回结构一致
      const message = error instanceof Error ? error.message : '更新配置失败';
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: message });
      return { updated: false, error: message };
    }
  });

  /**
   * 批量更新配置（事务性）
   *
   * 主进程在单个事务内完成全部更新（原子性 + 单次持久化 + 副作用去重），
   * 避免多次串行 CONFIG_UPDATE 调用产生的半更新状态。
   *
   * 副作用处理：委托 applyConfigSideEffects，与 CONFIG_UPDATE handler 行为一致。
   */
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_UPDATE_BATCH,
    async (_event, updates: Record<string, unknown>) => {
      try {
        // 委托给 Sprite.updateConfigBatch：内部完成副本校验 → 原子应用 → 单次持久化 → 副作用去重
        const result = requireSprite(ctx).updateConfigBatch(updates as Partial<SpriteConfig>);

        // 应用失败：直接返回错误，不触发任何主进程侧副作用
        if (!result.updated) {
          return result;
        }

        // 委托统一的副作用处理（与 CONFIG_UPDATE handler 对齐）
        applyConfigSideEffects(ctx, updates as Partial<SpriteConfig>);

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
    throwingHandle('列出角色失败', () => ({ personas: requireSprite(ctx).listPersonas() })),
  );

  /**
   * 切换角色（P0-2 用户体验打磨：三段式判断 + reason 字段）
   *
   * 判断顺序（排雷雷点 1/2/3 修复）：
   *   1. 名称合法性校验（防路径遍历）→ reason='invalid'
   *   2. 角色存在性校验（前置避免锁定期间无法区分）→ reason='not_found'
   *   3. 锁定状态查询（前置避免前后名比较推断）→ reason='locked' + unlockAt
   *   4. 调用 switchPersona（捕获 chatBusyError）→ reason='busy'
   *   5. 同名幂等路径（switched=true，name 为当前激活角色）
   *
   * 返回值扩展（向后兼容，reason/unlockAt 可选）：
   *   { switched: true, name }                     — 切换成功（含同名幂等）
   *   { switched: false, name: null, reason: 'invalid' }   — 名称非法
   *   { switched: false, name: null, reason: 'not_found' } — 角色不存在
   *   { switched: false, name: 当前角色, reason: 'locked', unlockAt } — 锁定中
   *   { switched: false, name: null, reason: 'busy' }      — 对话进行中
   */
  ipcMain.handle(IPC_CHANNELS.PERSONA_SWITCH, async (_event, name: string) => {
    try {
      // 1. 名称合法性校验（防路径遍历）
      if (!isValidPersonaName(name)) {
        return { switched: false, name: null, reason: 'invalid' as const };
      }

      // 缓存 Sprite 实例：本 handler 内多次调用，统一取一次避免重复调用 getter
      const sprite = requireSprite(ctx);

      // 2. 角色存在性前置校验（锁定期间 switchPersona 直接返回 prompt，无法区分存在性）
      const personaList = sprite.listPersonas();
      const exists = personaList.some((p) => p.name === name);
      if (!exists) {
        return { switched: false, name: null, reason: 'not_found' as const };
      }

      // 3. 锁定状态前置查询（避免前后名比较推断的误判，排雷雷点 1）
      const lockStatus = sprite.getPersonaSwitchLockStatus();
      if (lockStatus.locked) {
        const currentName = sprite.activePersona;
        return {
          switched: false,
          name: currentName,
          reason: 'locked' as const,
          unlockAt: lockStatus.unlockAt,
        };
      }

      // 4. 调用 switchPersona（捕获对话进行中异常，排雷雷点 3）
      try {
        const result = sprite.switchPersona(name);
        if (result === null) {
          // 角色不存在降级路径（理论上 step 2 已拦截，此处防御性兜底）
          return { switched: false, name: null, reason: 'not_found' as const };
        }
        // 切换成功（含同名幂等），name 为当前激活角色名
        const afterName = sprite.activePersona;
        return { switched: true, name: afterName };
      } catch (innerError) {
        // 对话进行中：Agent.switchPersona 抛 chatBusyError（title='对话繁忙'）
        if (innerError instanceof Error && innerError.message === '对话繁忙') {
          return { switched: false, name: null, reason: 'busy' as const };
        }
        throw innerError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '切换角色失败';
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '切换角色失败' });
      return { switched: false, name: null, reason: 'unknown' as const, error: message };
    }
  });

  /** 设置角色匹配模式 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE, async (_event, mode: 'auto' | 'manual') =>
    // MIND2-C1：写操作改用 throwingHandle——内核异常（requireSprite / setPersonaMode 失败）re-throw
    // 业务校验失败（mode 非法）保持返回 set:false（业务态）
    throwingHandle('设置角色模式失败', () => {
      // 运行期校验（TS 类型在编译期擦除，恶意渲染进程可传任意值）
      // 仅允许 'auto' / 'manual'，其他值一律拒绝（业务校验）
      if (mode !== 'auto' && mode !== 'manual') {
        return { set: false };
      }
      return { set: requireSprite(ctx).setPersonaMode(mode) };
    }),
  );

  /** 查询当前角色匹配模式（对齐 CLI /mode 查询能力） */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE_GET, async () =>
    throwingHandle('查询角色模式失败', () => ({ mode: requireSprite(ctx).personaMode })),
  );

  // ─── 设定文件 CRUD（精灵设定面板 Epic 3 · I2） ─────────────
  //
  // HEAL-21：LIST/READ/DELETE 三类合并为 CONFIG_FILE_* 统一入口（8 通道 → 3 通道）
  // SAVE 三通道独立保留：PERSONA_SAVE_FILE/RULE_SAVE/SKILL_INSTALL（因 SKILL_INSTALL 返回
  // SkillInstallResult 含 hotReloaded/hotReloadError，与 ConfigFileOperationResult 结构不同）
  //
  // 统一委托 sprite.readConfigFile/deleteConfigFile/listConfigFiles，这些 wrapper 内部已封装：
  // 文件层操作（configFileManager）+ 内核层联动（同步 SQLite + 内存 + system prompt）。
  // 通过 type 参数区分 persona/rule/skill，三类文件共用同一套 wrapper 实现（H2 集中化设计）。
  //
  // 错误处理：sprite wrapper 不抛错（返回值含 success/error），throwingHandle 仅作防御兜底。

  /**
   * 列出指定类型的设定文件（HEAL-21 合并自 RULE_LIST + SKILL_LIST）
   *
   * payload: type: 'rule' | 'skill'（'persona' 不支持，角色列表走 PERSONA_LIST 通道）
   * 返回值: ConfigFileEntry[]（按 mtime 降序）
   */
  ipcMain.handle(IPC_CHANNELS.CONFIG_FILE_LIST, async (_event, type: 'rule' | 'skill') =>
    throwingHandle(`列出${type === 'rule' ? '规则' : '技能'}文件失败`, () =>
      requireSprite(ctx).listConfigFiles(type),
    ),
  );

  /**
   * 读取设定文件内容（HEAL-21 合并自 PERSONA_READ_FILE + RULE_READ + SKILL_READ）
   *
   * payload: type: ConfigFileType, name: string
   * 返回值: ConfigFileEntry | null（文件不存在返回 null）
   */
  ipcMain.handle(IPC_CHANNELS.CONFIG_FILE_READ, async (_event, type: ConfigFileType, name: string) =>
    throwingHandle(`读取${type === 'persona' ? '角色' : type === 'rule' ? '规则' : '技能'}文件失败`, () =>
      requireSprite(ctx).readConfigFile(type, name),
    ),
  );

  /**
   * 删除设定文件（HEAL-21 合并自 PERSONA_DELETE_FILE + RULE_DELETE + SKILL_DELETE）
   *
   * payload: type: ConfigFileType, name: string
   * 返回值: ConfigFileOperationResult（文件不存在时 success=false）
   */
  ipcMain.handle(IPC_CHANNELS.CONFIG_FILE_DELETE, async (_event, type: ConfigFileType, name: string) =>
    throwingHandle(`删除${type === 'persona' ? '角色' : type === 'rule' ? '规则' : '技能'}文件失败`, () =>
      requireSprite(ctx).deleteConfigFile(type, name),
    ),
  );

  /** 保存角色文件（新增/更新合并，携带 name + content） */
  ipcMain.handle(IPC_CHANNELS.PERSONA_SAVE_FILE, async (_event, name: string, content: string) =>
    throwingHandle('保存角色文件失败', () => requireSprite(ctx).saveConfigFile('persona', name, content)),
  );

  /** 保存规则文件（新增/更新合并，携带 name + content） */
  ipcMain.handle(IPC_CHANNELS.RULE_SAVE, async (_event, name: string, content: string) =>
    throwingHandle('保存规则文件失败', () => requireSprite(ctx).saveConfigFile('rule', name, content)),
  );

  /**
   * 打开配置文件目录（personas/skills/rules 所在目录）
   *
   * 技能编辑时的辅助功能：复杂技能可跳转到文件目录手动编辑。
   */
  ipcMain.handle(IPC_CHANNELS.CONFIG_DIR_OPEN, async () => {
    try {
      const configDir = requireSprite(ctx).configDirValue;
      if (!configDir) {
        return { success: false, error: '配置目录未设置' };
      }
      await shell.openPath(configDir);
      return { success: true, error: null };
    } catch (error) {
      return { success: false, error: `打开目录失败: ${(error as Error).message}` };
    }
  });
}
