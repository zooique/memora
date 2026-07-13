/**
 * UI 初始化失败错误卡片 — 独立于 UIManager 的错误提示渲染
 *
 * 职责：
 * - 在 UIManager 构造函数预检核心元素失败时，向 document.body 渲染红色错误卡片
 * - 独立于 UIManager 自身，避免半初始化状态下访问 null 引发的二次错误
 *
 * 设计原则：
 * - 样式通过 CSS 类名（.ui-init-failure-card 等，定义在 base.css）应用，符合 CSP style-src 'self' 约束
 * - CSS 类内颜色使用 var(--token, fallback) 形式：CSS 已加载时自动适配双主题，
 *   未加载时回退到 fallback 硬编码值保证可用
 * - 错误仍然会 rethrow，让上层（renderer.ts DOMContentLoaded）的 catch 也能感知
 */

/**
 * 渲染 UIManager 初始化失败错误提示到 document.body
 *
 * 在 UIManager 构造函数预检核心元素失败时调用，独立于 UIManager 自身，
 * 避免半初始化状态下访问 null 引发的二次错误。
 *
 * 显示内容：醒目红色错误卡片 + 错误信息 + 排查建议（HTML 与 TS 不同步、构建未刷新等）。
 * 错误仍然会 rethrow，让上层（renderer.ts DOMContentLoaded）的 catch 也能感知。
 *
 * @param err 构造函数抛出的错误（通常是 MemoraError INITIALIZATION_FAILED）
 */
export function renderInitFailureToBody(err: unknown): void {
  // 提取错误信息（MemoraError 有 message 字段，普通 Error 同样）
  const errorMessage = err instanceof Error ? err.message : String(err);
  // 构建错误提示卡片：样式由 base.css 中 .ui-init-failure-card 等类提供
  // CSS 类内 var(--token, fallback) 兼顾主题适配与 CSS 未加载场景
  const errorCard = document.createElement('div');
  errorCard.className = 'ui-init-failure-card';
  // 标题
  const title = document.createElement('h2');
  title.className = 'ui-init-failure-title';
  title.textContent = 'UI 初始化失败';
  errorCard.appendChild(title);
  // 错误信息
  const msg = document.createElement('p');
  msg.className = 'ui-init-failure-msg';
  msg.textContent = errorMessage;
  errorCard.appendChild(msg);
  // 排查建议
  const hints = document.createElement('p');
  hints.className = 'ui-init-failure-hints';
  hints.innerHTML = '<strong>可能原因：</strong><br>• HTML 元素 ID 缺失或拼写错误（开发阶段引入）<br>• 构建产物未刷新（请尝试重启开发服务器或重新构建）<br>• index.html 与 ui.ts 不同步（最近修改未生效）';
  errorCard.appendChild(hints);
  // 挂载到 body（清空已有错误卡片，避免重复）
  document.querySelectorAll('#ui-init-failure-card').forEach((el) => el.remove());
  errorCard.id = 'ui-init-failure-card';
  document.body.appendChild(errorCard);
}
