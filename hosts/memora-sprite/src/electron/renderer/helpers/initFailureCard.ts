/**
 * UI 初始化失败错误卡片 — 独立于 UIManager 的错误提示渲染
 *
 * 职责：
 * - 在 UIManager 构造函数预检核心元素失败时，向 document.body 渲染红色错误卡片
 * - 独立于 UIManager 自身，避免半初始化状态下访问 null 引发的二次错误
 *
 * 设计原则：
 * - inline style 避免依赖 CSS 文件加载状态；颜色使用 var(--token, fallback) 形式，
 *   CSS 已加载时自动适配双主题，未加载时回退到 fallback 硬编码值保证可用
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
  // 构建错误提示卡片（var(--token, fallback) 兼顾主题适配与 CSS 未加载场景）
  const errorCard = document.createElement('div');
  errorCard.style.cssText = [
    'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
    'max-width:560px', 'width:90%', 'padding:24px 28px',
    // 背景复用 --red-10（浅红错误态背景），边框复用 --red（语义红色）
    'background:var(--red-10, #fef2f2)', 'border:1px solid var(--red, #dc2626)', 'border-radius:8px',
    // 主文字色复用 --text 保证双主题可读性（原 #7f1d1d 为浅色主题深红，深色主题下对比度不足）
    'color:var(--text, #7f1d1d)', 'font-family:system-ui,sans-serif', 'font-size:14px',
    // 阴影复用 --red-20（红色半透明），与边框色调一致
    'line-height:1.6', 'box-shadow:0 8px 32px var(--red-20, rgba(220,38,38,0.2))',
    'z-index:9999',
  ].join(';');
  // 标题
  const title = document.createElement('h2');
  title.textContent = 'UI 初始化失败';
  // 标题色复用 --red（语义红色，双主题自动适配）
  title.style.cssText = 'margin:0 0 12px 0;font-size:18px;color:var(--red, #991b1b);';
  errorCard.appendChild(title);
  // 错误信息
  const msg = document.createElement('p');
  msg.textContent = errorMessage;
  // 错误信息背景复用 --red-20（红色半透明背景，与卡片背景层次区分）
  msg.style.cssText = 'margin:0 0 16px 0;font-family:ui-monospace,monospace;background:var(--red-20, #fee2e2);padding:8px 12px;border-radius:4px;word-break:break-all;';
  errorCard.appendChild(msg);
  // 排查建议
  const hints = document.createElement('p');
  hints.innerHTML = '<strong>可能原因：</strong><br>• HTML 元素 ID 缺失或拼写错误（开发阶段引入）<br>• 构建产物未刷新（请尝试重启开发服务器或重新构建）<br>• index.html 与 ui.ts 不同步（最近修改未生效）';
  // 排查建议文字色复用 --text（与卡片主文字色一致，保证可读性）
  hints.style.cssText = 'margin:0;font-size:13px;color:var(--text, #7f1d1d);';
  errorCard.appendChild(hints);
  // 挂载到 body（清空已有错误卡片，避免重复）
  document.querySelectorAll('#ui-init-failure-card').forEach((el) => el.remove());
  errorCard.id = 'ui-init-failure-card';
  document.body.appendChild(errorCard);
}
