/**
 * 滚动到底部 — 纯 DOM 工具（SSOT 剪枝：消除 chatView / toolCard 两处重复实现）
 *
 * 流式渲染时每 chunk/卡片插入都可能触发滚动，用 requestAnimationFrame 合并为每帧
 * 一次，避免读写交错强制 reflow。rAF 回调幂等（scrollTop 赋值相同值），同帧多次
 * 调用天然合并，无需额外节流标志。
 *
 * 从容器 ownerDocument 派生 window，不引入全局 document/window 引用（与依赖注入的
 * 环境隔离策略统一，可 jsdom 测试）。
 *
 * @param container 滚动容器（如消息区 / 工具卡片的父容器）
 */
export function scrollToBottom(container: HTMLElement): void {
  container.ownerDocument.defaultView?.requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}