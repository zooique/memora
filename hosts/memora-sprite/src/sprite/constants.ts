/**
 * 精灵公共常量（零依赖）
 *
 * 设计原则：
 * - 本文件只放纯值常量，禁止引入 Node.js 内置模块或任何运行时依赖
 * - 允许被渲染进程（Electron sandbox / 浏览器环境）安全导入
 * - 业务配置相关的常量请放到 spriteConfig.ts，不要反向依赖
 */

// ─── 时间常量（毫秒） ──────────────────────────────────

/** 毫秒/秒转换常量（供 sprite 核心和 UI 层共享，DRY） */
export const MS_PER_SECOND = 1_000;

/** 毫秒/分钟转换常量（供 sprite 核心和 UI 层共享，DRY） */
export const MS_PER_MINUTE = 60_000;

/** 毫秒/小时转换常量（供 sprite 核心和 UI 层共享，DRY） */
export const MS_PER_HOUR = 3_600_000;

/** 毫秒/天转换常量（供 sprite 核心和 UI 层共享，DRY） */
export const MS_PER_DAY = 86_400_000;

/** 毫秒/周转换常量（供 sprite 核心和 UI 层共享，DRY） */
export const MS_PER_WEEK = 604_800_000;

// ─── 业务默认值常量 ────────────────────────────────────

/** 记忆列表默认上限（MemoryInspector.list / MemoryController.list 全量获取时使用） */
export const DEFAULT_LIST_LIMIT = 1000;

/** JSONL 日志默认最大保留条数（审计日志 / 追踪日志，超出时从头截断） */
export const DEFAULT_MAX_ENTRIES = 1000;

// ─── Toast 时长常量（毫秒） ───────────────────────────

/** Toast 短暂显示时长（如"已复制到剪贴板"等轻量反馈） */
export const TOAST_SHORT_MS = 2_000;

/** Toast 常规显示时长（如"已切换到项目 X"等操作反馈） */
export const TOAST_NORMAL_MS = 3_000;

/** Toast 较长显示时长（如错误提示、汇总信息等需要用户阅读的内容） */
export const TOAST_LONG_MS = 4_000;

/**
 * 获取本地日期字符串 YYYY-MM-DD
 *
 * 会话 ID 使用日期前缀，必须用本地日期而非 UTC，
 * 否则东八区用户在凌晨 0-8 点创建的会话会被归入前一天。
 * 供主进程（ipcHandlers）和渲染进程（renderer）共享，消除重复定义。
 */
export function getLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
