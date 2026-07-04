/**
 * 快捷键默认配置共享模块
 *
 * 职责：
 *   提供 ShortcutConfig 类型定义和 DEFAULT_SHORTCUTS 默认值常量，
 *   作为 sprite/ 主进程层和 electron/renderer/ 渲染进程层的单一真理源。
 *
 * 设计理由：
 *   直接让 renderer 导入 spriteConfig.ts 不可行——该模块顶部导入
 *   node:path/node:os/node:fs/memora 等 Node 运行时依赖，会污染
 *   renderer bundle 并违反 Electron sandbox 限制。
 *   因此提取到 shared/ 目录的纯类型+纯数据模块，无 Node 依赖，
 *   可被主进程和渲染进程安全导入。
 *
 * 设计原则：
 *   - 纯类型 + 纯数据，零运行时依赖（不含 node:fs 等）
 *   - ShortcutConfig 接口为真理源，spriteConfig.ts 重新导出保持向后兼容
 *   - DEFAULT_SHORTCUTS 为常量，被 DEFAULT_SPRITE_CONFIG.shortcuts 和
 *     settingsController.ts 的 fallback 共同引用
 */

/**
 * 全局快捷键配置结构（单一真理源，shortcuts.ts / main.ts 均引用此类型）
 *
 * 持久化到 sprite.json，支持热更新（不重启应用即可修改快捷键）。
 * accelerators 是 action → accelerator 映射，action 为开放字符串（遵循 ADR-004）。
 *
 * 从 sprite/spriteConfig.ts 迁移到 shared/（HC-02），spriteConfig.ts 重新导出
 * 保持向后兼容（shortcuts.ts / configHandlers.ts 等仍从 spriteConfig 导入）。
 */
export interface ShortcutConfig {
  /** 是否启用全局快捷键（总开关） */
  enabled: boolean;
  /** 动作 → 加速器字符串映射（如 { 'toggle-window': 'Ctrl+Shift+Space' }） */
  accelerators: Record<string, string>;
}

/**
 * 默认快捷键配置（单一真理源）
 *
 * 被 DEFAULT_SPRITE_CONFIG.shortcuts 和 settingsController.ts 的 fallback 共同引用，
 * 消除原先两处重复定义的"对齐"注释和静默漂移风险。
 *
 * 包含 3 个默认快捷键：
 * - toggle-window: Ctrl+Shift+Space（切换窗口显示）
 * - quick-record: Ctrl+Shift+M（快速记录）
 * - recall-memory: Ctrl+Shift+R（召回记忆）
 */
export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  enabled: true,
  accelerators: {
    'toggle-window': 'Ctrl+Shift+Space',
    'quick-record': 'Ctrl+Shift+M',
    'recall-memory': 'Ctrl+Shift+R',
  },
};
