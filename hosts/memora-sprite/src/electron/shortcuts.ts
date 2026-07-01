/**
 * 全局快捷键管理器 — 系统级快捷键注册/注销/热更新
 *
 * 职责（Phase 3.3）：
 *   1. 注册系统级全局快捷键（应用未聚焦时也生效）
 *   2. 快捷键动作分发（toggle-window / quick-record / recall-memory）
 *   3. 配置热更新（不重启应用即可修改快捷键）
 *   4. 注册失败通知（快捷键被其他应用占用时提示用户）
 *
 * 设计原则：
 *   - 快捷键动作是开放字符串，非枚举（遵循 ADR-004 基元驱动）
 *   - 依赖注入 globalShortcut 接口，便于单元测试 mock
 *   - 应用退出时必须注销所有快捷键（Electron 规范）
 *
 * 集成点：
 *   - main.ts：应用启动时创建并 registerAll，before-quit 时 unregisterAll
 *   - spriteConfig.ts：shortcuts 配置字段持久化
 *   - windowManager.ts：toggleWindow() 方法供 toggle-window 动作调用
 */
import type { GlobalShortcut } from 'electron';
import { logger } from 'memora';
// 从配置层导入类型（单一真理源，避免类型重复定义）
import type { ShortcutConfig } from '../sprite/spriteConfig.js';
// 从配置层导入默认配置（单一真理源，避免默认值重复）
import { DEFAULT_SPRITE_CONFIG } from '../sprite/spriteConfig.js';

// 重新导出类型，保持外部 API 不变（测试和消费方仍从 shortcuts.ts 导入）
export type { ShortcutConfig };

/** 快捷键动作类型（开放字符串，非枚举，遵循 ADR-004） */
export type ShortcutAction = string;

/** 默认快捷键动作常量（供引用，不限制扩展） */
export const SHORTCUT_ACTIONS = {
  /** 唤起/隐藏精灵窗口（tray ↔ full 切换） */
  TOGGLE_WINDOW: 'toggle-window',
  /** 快速记录（迷你输入框，Phase 3.3 第二批） */
  QUICK_RECORD: 'quick-record',
  /** 召回记忆（搜索面板，Phase 3.3 第二批） */
  RECALL_MEMORY: 'recall-memory',
} as const;

/** 快捷键管理器构造选项 */
export interface ShortcutManagerOptions {
  /** 快捷键配置 */
  config: ShortcutConfig;
  /** 动作回调映射（由 main.ts 注入） */
  handlers: Partial<Record<string, () => void>>;
}

/**
 * 全局快捷键管理器
 *
 * 通过依赖注入 globalShortcut 接口实现可测试性。
 * 生产环境传入 Electron 的 globalShortcut 模块，测试环境传入 mock。
 */
export class ShortcutManager {
  /** Electron globalShortcut 模块（依赖注入） */
  private readonly globalShortcut: GlobalShortcut;
  /** 当前配置 */
  private config: ShortcutConfig;
  /** 动作回调映射 */
  private handlers: Partial<Record<string, () => void>>;
  /** 已注册的快捷键（action → accelerator，用于注销和热更新） */
  private registered: Map<string, string> = new Map();

  constructor(
    globalShortcut: GlobalShortcut,
    options: ShortcutManagerOptions,
  ) {
    this.globalShortcut = globalShortcut;
    this.config = options.config;
    this.handlers = options.handlers;
  }

  /**
   * 注册所有配置的快捷键
   *
   * 遍历 accelerators 映射，为每个动作注册对应的加速器。
   * 注册失败（被其他应用占用）时记录日志，不中断后续注册。
   * enabled=false 时跳过所有注册。
   */
  registerAll(): void {
    if (!this.config.enabled) {
      logger.info('全局快捷键已禁用，跳过注册');
      return;
    }

    for (const [action, accelerator] of Object.entries(this.config.accelerators)) {
      this.registerOne(action, accelerator);
    }
  }

  /**
   * 注销所有已注册的快捷键
   *
   * 应用退出时必须调用，否则快捷键残留占用系统资源。
   */
  unregisterAll(): void {
    for (const [action, accelerator] of this.registered) {
      try {
        this.globalShortcut.unregister(accelerator);
      } catch (err) {
        logger.warn({ action, accelerator, err: String(err) }, '注销快捷键失败');
      }
    }
    this.registered.clear();
  }

  /**
   * 热更新单个快捷键
   *
   * 配置变更时调用，先注销旧快捷键再注册新快捷键。
   * 不需要重启应用即可生效。
   *
   * @param action 动作名称
   * @param newAccelerator 新的加速器字符串
   * @returns 是否注册成功（false 表示被占用或格式错误）
   */
  updateShortcut(action: string, newAccelerator: string): boolean {
    // 先注销旧的
    const oldAccelerator = this.registered.get(action);
    if (oldAccelerator) {
      try {
        this.globalShortcut.unregister(oldAccelerator);
      } catch (err) {
        logger.warn({ action, oldAccelerator, err: String(err) }, '注销旧快捷键失败');
      }
      this.registered.delete(action);
    }

    // 更新配置
    this.config.accelerators[action] = newAccelerator;

    // 注册新的（enabled=false 时不注册）
    if (!this.config.enabled) {
      return true;
    }

    return this.registerOne(action, newAccelerator);
  }

  /**
   * 启用/禁用总开关
   *
   * 禁用时注销所有快捷键，启用时重新注册所有快捷键。
   *
   * @param enabled 是否启用
   */
  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) return;
    this.config.enabled = enabled;

    if (enabled) {
      this.registerAll();
    } else {
      this.unregisterAll();
    }
  }

  /**
   * 全量替换配置并重新注册（热更新批量场景）
   *
   * 用于配置批量更新（如设置面板保存快捷键配置）：先注销所有已注册快捷键，
   * 再用新配置重新注册。相比逐个调用 updateShortcut，避免 N 次注销/注册的抖动。
   *
   * 行为：
   *   1. unregisterAll（清空已注册映射）
   *   2. 用 newConfig 替换内部 config（深拷贝 accelerators 避免外部引用污染）
   *   3. 若 enabled=true 则 registerAll；否则保持注销状态
   *
   * @param newConfig 新的快捷键配置
   */
  setConfig(newConfig: ShortcutConfig): void {
    // 先注销所有已注册快捷键，避免新旧 accelerator 残留
    this.unregisterAll();
    // 深拷贝 accelerators，避免外部引用污染内部状态
    this.config = {
      enabled: newConfig.enabled,
      accelerators: { ...newConfig.accelerators },
    };
    // enabled=true 时重新注册所有快捷键；false 时保持注销状态
    if (this.config.enabled) {
      this.registerAll();
    }
  }

  /**
   * 获取当前配置（只读副本）
   *
   * 供外部持久化或调试查看。
   */
  getConfig(): Readonly<ShortcutConfig> {
    return {
      enabled: this.config.enabled,
      accelerators: { ...this.config.accelerators },
    };
  }

  /**
   * 注册单个快捷键（内部方法）
   *
   * @param action 动作名称
   * @param accelerator 加速器字符串
   * @returns 是否注册成功
   */
  private registerOne(action: string, accelerator: string): boolean {
    const handler = this.handlers[action];
    if (!handler) {
      logger.warn({ action }, '快捷键动作未注册处理器，跳过');
      return false;
    }

    try {
      const success = this.globalShortcut.register(accelerator, handler);
      if (success) {
        this.registered.set(action, accelerator);
        logger.info({ action, accelerator }, '全局快捷键已注册');
      } else {
        // 注册失败：快捷键被其他应用占用
        logger.warn({ action, accelerator }, '全局快捷键注册失败，可能被其他应用占用');
      }
      return success;
    } catch (err) {
      logger.error({ action, accelerator, err: String(err) }, '全局快捷键注册异常');
      return false;
    }
  }
}

/**
 * 默认快捷键配置
 *
 * 从 DEFAULT_SPRITE_CONFIG.shortcuts 派生（单一真理源）。
 * 独立导出便于测试和引用。
 */
export const DEFAULT_SHORTCUT_CONFIG: ShortcutConfig = {
  enabled: true,
  accelerators: DEFAULT_SPRITE_CONFIG.shortcuts!.accelerators,
};
