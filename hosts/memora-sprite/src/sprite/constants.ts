/**
 * 精灵公共常量（零依赖）
 *
 * 设计原则：
 * - 本文件只放纯值常量，禁止引入 Node.js 内置模块或任何运行时依赖
 * - 允许被渲染进程（Electron sandbox / 浏览器环境）安全导入
 * - 业务配置相关的常量请放到 spriteConfig.ts，不要反向依赖
 */

/** 毫秒/分钟转换常量（供 sprite 核心和 UI 层共享，DRY） */
export const MS_PER_MINUTE = 60_000;

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
