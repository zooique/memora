/**
 * 跨层共享常量（零依赖）
 *
 * 设计原则：
 * - 本文件只放纯值常量，禁止引入 Node.js 内置模块或任何运行时依赖
 * - 允许被所有层（shared/sprite/storage/electron/renderer）安全导入
 * - 真理源位于 shared 层，sprite/constants.ts re-export 保持调用方不变
 */

// ─── 路径常量 ──────────────────────────────────────────

/**
 * Sprite 宿主目录名（Agent 级共享根目录）
 *
 * 所有 sprite 宿主持久化路径的真理源：~/{SPRITE_HOME_DIR_NAME}/
 * - data/       用户记忆（memora.db）
 * - config/     Agent 级配置（rules/skills/personas）
 * - config.json LLM 配置
 * - sprite.json 精灵配置
 *
 * storage 层（spriteConfigStore.ts）和 sprite 层均从本模块导入此常量，
 * 避免跨层路径漂移。sprite/constants.ts 保留 re-export 保持调用方不变。
 */
export const SPRITE_HOME_DIR_NAME = '.memora-sprite';
