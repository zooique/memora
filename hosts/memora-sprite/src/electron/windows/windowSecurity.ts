/**
 * BrowserWindow 安全防护工具
 *
 * 职责：
 *   - 阻止 webContents 导航到外部 URL（防止 XSS 后跳转恶意页面获取 IPC 权限）
 *   - 拦截 window.open 调用（防止新窗口逃逸）
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - 从 3 处散落的 `will-navigate + setWindowOpenHandler` 模式中提取
 *   - windowManager.ts / floatWindow.ts / quickInputWindow.ts 共 3 处
 *   - 安全相关逻辑必须集中维护，避免遗漏
 *
 * 架构位置：
 *   - 位于 electron/windows/ 层，仅约束 BrowserWindow 安全防护
 *   - Electron 专属，不跨层共享
 */

import type { BrowserWindow } from 'electron';

/**
 * 为 BrowserWindow 注册安全防护
 *
 * - will-navigate：仅允许导航到当前 URL（刷新），阻止跳转到外部 URL
 * - setWindowOpenHandler：拒绝所有 window.open 调用
 *
 * @param win 目标 BrowserWindow 实例
 */
export function applyWindowSecurity(win: BrowserWindow): void {
  // 拦截外部导航：仅允许导航到当前 URL（页面刷新），阻止跳转到恶意页面
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
    }
  });
  // 拦截新窗口打开：拒绝所有 window.open 调用（防止新窗口逃逸）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
