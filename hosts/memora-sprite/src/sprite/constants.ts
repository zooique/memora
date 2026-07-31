/**
 * 精灵公共常量（零依赖）
 *
 * 设计原则：
 * - 本文件只放纯值常量，禁止引入 Node.js 内置模块或任何运行时依赖
 * - 允许被渲染进程（Electron sandbox / 浏览器环境）安全导入
 * - 业务配置相关的常量请放到 spriteConfig.ts，不要反向依赖
 * - SPRITE_HOME_DIR_NAME 真理源在 shared/constants.ts，本模块 re-export 保持调用方不变
 */

// formatDateKey 本地日期格式化（从 shared 层导入——本文件是跨层共享文件，被渲染进程 value-import）
// 渲染进程是浏览器环境，无法解析裸模块标识符 'memora'，因此跨层共享文件必须从 shared/ 导入
// shared/dateUtils.ts 是渲染进程侧的 formatDateKey 真理源（ADR-017 枝叶层 2 次提取）
import { formatDateKey } from '../shared/dateUtils.js';

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

// ─── 路径常量 ──────────────────────────────────────────

// SPRITE_HOME_DIR_NAME 真理源在 shared/constants.ts，re-export 保持调用方导入路径不变
export { SPRITE_HOME_DIR_NAME } from '../shared/constants.js';

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

// ─── UI 反馈超时常量（毫秒） ─

/** 写入确认超时（agentListeners），超时后自动拒绝写入操作 */
export const CONFIRMATION_TIMEOUT_MS = 30_000;

/** 会话切换前归档超时（sessionHandlers），超时后降级为后台继续跑不阻塞切换 */
export const ARCHIVE_TIMEOUT_MS = 5_000;

/** 主动提示托盘重置超时（spriteEventBridge），超时后重置托盘图标未读计数 */
export const PROACTIVE_TRAY_RESET_MS = 30_000;

/** 仪表盘脉冲动画间隔（dashboardPanelManager），脉冲动画刷新频率 */
export const DASHBOARD_PULSE_MS = 300;

/** 仪表盘刷新防抖间隔（memoryController），连续事件合并窗口 */
export const DASHBOARD_DEBOUNCE_MS = 300;

/**
 * 获取本地日期字符串 YYYY-MM-DD
 *
 * 委托 shared/dateUtils.ts:formatDateKey(new Date())，消除重复实现。
 * 保留此函数名以维持 9 处调用方导入路径不变。
 *
 * 会话 ID 使用日期前缀，必须用本地日期而非 UTC，
 * 否则东八区用户在凌晨 0-8 点创建的会话会被归入前一天。
 * 供主进程（ipcHandlers）和渲染进程（renderer）共享。
 */
export function getLocalDate(): string {
  return formatDateKey(new Date());
}
