/**
 * 主题初始化脚本注入器
 *
 * 在页面 did-start-loading 时同步读取 localStorage 并设置 data-theme 属性，
 * 避免页面加载初期的 FOUC（Flash of Unstyled Content）闪烁。
 * 注入失败时静默降级为默认浅色主题（不影响功能可用性）。
 */

import type { WebContents } from 'electron';
import { logger, toError } from 'memora';

/**
 * 注入主题初始化脚本到指定 WebContents
 *
 * 在页面开始加载时执行，同步读取 localStorage 的 'memora-theme' 值，
 * 如果为 'dark' 则立即设置 data-theme 属性。
 *
 * @param webContents 目标窗口的 WebContents 实例
 */
export function injectThemeScript(webContents: WebContents): void {
  webContents.on('did-start-loading', () => {
    if (webContents.isDestroyed()) return;

    webContents
      .executeJavaScript(`
        (function() {
          try {
            var theme = localStorage.getItem('memora-theme');
            if (theme === 'dark') {
              document.documentElement.setAttribute('data-theme', 'dark');
            }
          } catch (e) {
            // localStorage 不可用时降级为默认浅色主题
          }
        })();
      `)
      .catch((err: unknown) => {
        // 注入失败时静默降级为默认浅色主题（不影响功能可用性）
        // P1：补充 logger.debug 提升可观测性，便于生产环境排查主题注入异常
        logger.debug({ err: toError(err).message }, '主题注入失败，降级为默认浅色主题');
      });
  });
}
