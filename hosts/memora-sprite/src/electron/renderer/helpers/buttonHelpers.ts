/**
 * 按钮事件绑定 helper
 *
 * 职责：
 * - 封装"按钮点击 → loading 状态 → 异步操作 → 恢复"的标准模式
 * - 配合 EventTracker 统一事件清理，避免内存泄漏
 *
 * 设计原则：
 * - 不替代 domHelpers.setButtonLoadingEl（原子工具），而是组合使用
 * - 仅提取"重复 2+ 次的按钮绑定模式"（ADR-017 枝叶层 2 次提取原则）
 */

import type { EventTracker } from './eventTracker.js';
import { setButtonLoadingEl } from './domHelpers.js';

/**
 * 绑定"刷新按钮"的标准点击 → loading → 异步操作模式
 *
 * 替代散落在 auditPanelManager / workProjectionPanelManager / profilePanelManager
 * / settingsPanelManager 的重复代码块：
 *
 * ```ts
 * if (this.refreshBtn) {
 *   this.events.addEventListener(this.refreshBtn, 'click', async () => {
 *     setButtonLoadingEl(this.refreshBtn!, true, '刷新中...');
 *     try {
 *       await handler();
 *     } finally {
 *       setButtonLoadingEl(this.refreshBtn!, false);
 *     }
 *   });
 * }
 * ```
 *
 * 工作流程：
 * 1. 按钮为 null 时静默返回（兼容可选元素缺失场景）
 * 2. 通过 EventTracker 绑定 click 事件（cleanup 时统一清理）
 * 3. 点击时进入 loading 状态（按钮禁用 + 文本切换）
 * 4. 执行异步操作
 * 5. 无论成功/失败，finally 恢复按钮原始状态
 *
 * @param btn 目标按钮，null 时静默忽略
 * @param events EventTracker 实例（用于事件清理）
 * @param handler 异步操作回调（如 this.load()）
 * @param loadingText loading 时显示的文本，默认"刷新中..."
 */
export function bindRefreshButton(
  btn: HTMLButtonElement | null,
  events: EventTracker,
  handler: () => Promise<void>,
  loadingText = '刷新中...',
): void {
  // 按钮缺失时静默返回，避免调用方需要重复 if 判断
  if (!btn) return;
  events.addEventListener(btn, 'click', async () => {
    setButtonLoadingEl(btn, true, loadingText);
    try {
      await handler();
    } finally {
      setButtonLoadingEl(btn, false);
    }
  });
}
