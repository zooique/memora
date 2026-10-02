/**
 * 滚动到底部 — 纯 DOM 工具（webview 各渲染路径共用单一实现）
 *
 * 智能吸底（对齐 TraeWork 对话流「上滚阅读时不被新内容拽走」）：
 *   - 每个容器维护「吸底」状态（用户是否停留在底部附近），由滚动事件 trackScroll 更新；
 *   - scrollToBottom 仅在「吸底」时真正滚到底——用户上滚翻历史时新内容不再反复拽走；
 *   - 用户滚回底部后吸底状态恢复，新内容继续自动吸底；
 *   - 吸底判定在 DOM 变更「之前」的滚动事件里记录，天然解决「新增超高消息后 scrollHeight
 *     已增长导致判不到底部」的时序陷阱（记录的是变更前的状态）。
 *
 * rAF 节流：流式渲染时每 chunk/卡片插入都可能触发滚动，用 requestAnimationFrame 合并为
 * 每帧一次，避免读写交错强制 reflow。rAF 回调幂等（scrollTop 赋值相同值），同帧多次
 * 调用天然合并，无需额外节流标志。
 *
 * 从容器 ownerDocument 派生 window，不引入全局 document/window 引用（与依赖注入的
 * 环境隔离策略统一，可 jsdom 测试）。
 */

/** 吸底判定阈值：距底部不足该像素视为「停留在底部」 */
const STICKY_THRESHOLD = 48;

/** 各容器的吸底状态（用户是否停留在底部，由 trackScroll 维护；默认视为吸底） */
const stickyMap = new WeakMap<HTMLElement, boolean>();

/** 容器当前是否吸底（未记录过视为吸底——用户初始即在底部） */
function isSticky(container: HTMLElement): boolean {
  return stickyMap.get(container) ?? true;
}

/**
 * 滚动事件处理器：更新容器的吸底状态
 *
 * 由 chatView 的滚动监听调用（同时驱动「一键到底」按钮显隐）。记录的是本次滚动后
 * 的状态，后续 scrollToBottom 依据它决定是否自动吸底。
 *
 * @param container 滚动容器（如消息区）
 * @returns 是否吸底（便于调用方据此显隐「一键到底」按钮）
 */
export function trackScroll(container: HTMLElement): boolean {
  const pinned =
    container.scrollHeight - container.scrollTop - container.clientHeight <= STICKY_THRESHOLD;
  stickyMap.set(container, pinned);
  return pinned;
}

/**
 * 滚动到底部 — 仅当容器「吸底」时执行（上滚阅读时自动忽略）
 *
 * 流式渲染/卡片插入的收尾调用：容器吸底才滚到底部，否则静默（用户在上滚看历史）。
 * 吸底状态在 DOM 变更前的滚动事件中已记录，此处读取即可正确区分「该不该吸底」。
 *
 * @param container 滚动容器（如消息区 / 工具卡片的父容器）
 */
export function scrollToBottom(container: HTMLElement): void {
  container.ownerDocument.defaultView?.requestAnimationFrame(() => {
    if (!isSticky(container)) return; // 用户已上滚 → 不自动吸底，避免被拽走
    container.scrollTop = container.scrollHeight;
  });
}

/**
 * 强制滚动到底部并复位吸底标记 —— 视图复位类场景使用
 *
 * 与 scrollToBottom 的分工：后者按当前吸底标记裁决（用户上滚阅读历史时静默，
 * 不打断阅读）；本函数无条件把标记复位为吸底并滚到底，用于**容器内容被整体
 * 换掉**的时刻——旧内容的阅读位置对新内容没有意义，不该延续。
 *
 * 两类调用场景：
 *   - 历史会话回放完成：多条消息逐条渲染，rAF 节流叠加吸底判定可能让最终位置
 *     停在历史顶部而非最新消息；
 *   - 清空 / 切换会话：容器高度塌缩时，若用户此前已停在顶部则 scrollTop 不变、
 *     不派发 scroll 事件，吸底标记不会自动恢复，须在此显式复位。
 *
 * @param container 滚动容器（如消息区）
 */
export function forceScrollToBottom(container: HTMLElement): void {
  container.ownerDocument.defaultView?.requestAnimationFrame(() => {
    // 重置吸底状态为 true（强制吸底后，后续新内容仍会自动滚到底部）
    stickyMap.set(container, true);
    container.scrollTop = container.scrollHeight;
  });
}
