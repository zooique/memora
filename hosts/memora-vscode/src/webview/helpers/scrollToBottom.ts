/**
 * 滚动到底部 — 纯 DOM 工具（webview 各渲染路径共用单一实现）
 *
 * 智能吸底（对齐 TraeWork 对话流「上滚阅读时不被新内容拽走」）：
 *   - 每个容器维护「吸底」状态（用户是否停留在底部附近），由滚动事件 trackScroll 更新；
 *   - scrollToBottom 仅在「吸底」时真正滚到底——用户上滚翻历史时新内容不再反复拽走；
 *   - 用户滚回底部后吸底状态恢复，新内容继续自动吸底；
 *   - 吸底判定在 DOM 变更「之前」的滚动事件里记录，天然解决「新增超高消息后 scrollHeight
 *     已增长导致判不到底部」的时序陷阱（记录的是变更前的状态）。
 *   - ⚠ 局限：吸底标记**仅由滚动事件**刷新；内容高度变更（展开/收起折叠块、工具流式增删、
 *     长气泡展开、中断轮重建）不派发 scroll 事件却改变「是否真在底部」的真值 → 标记与实际
 *     位置脱节（用户可双向错：展开思考后不吸底 / 收起后位置漂移）。followIfPinned 供
 *     MutationObserver 订阅方在「任意高度变更」后调用，只读既有吸底意图、不重算变更后几何，
 *     闭合该整类缺口（逻辑仍收口于此文件，SSOT）。
 *
 * rAF 节流：流式渲染时每 chunk/卡片插入都可能触发滚动，用 requestAnimationFrame 合并为
 * 每帧一次，避免读写交错强制 reflow。rAF 回调幂等（scrollTop 赋值相同值），同帧多次
 * 调用天然合并，无需额外节流标志。
 *
 * ⚠ **唯一的同步例外** = `jumpToBottom`（一键到底按钮）：不包 rAF。用户点击是低频单次动作，
 * 无节流必要；且它需要**同步返回**重算后的吸底标记供调用方立即显隐按钮（既有测试在 click 后
 * 同步断言 scrollTop 与 hidden ⇒ 包 rAF 会破坏该契约）。四个导出语义互不取代，见各自 jsdoc。
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
 * 内容高度变更后保持吸底（由 MutationObserver 等订阅方在 DOM 变更后调用）
 *
 * 读取**既有**吸底意图（trackScroll 在用户滚动时记录、默认吸底），吸底则 rAF 滚到底、
 * 返回该意图供调用方显隐「一键到底」按钮。读取的是变更**前**记录的意图、不依据变更**后**
 * 的几何重算——既避开「新增超高消息后 scrollHeight 已增长导致判不到底部」的时序陷阱，
 * 又闭合「展开/收起折叠块、工具流式、长气泡展开、中断重建等高度变化不派发 scroll 事件、
 * 吸底标记与实际位置脱节」这一整类缺口（单点收口，不复制吸底逻辑）。
 *
 * 与 scrollToBottom 的分工：scrollToBottom 由各个内容写入路径在「自己刚改完高度」后显式
 * 调用；本函数由订阅方在「任意高度变更（含自己不知道的变更）」后统一调用，二者都只读
 * 既有吸底标记、都不重算几何，互不冲突、合并于 rAF。订阅方负责 rAF 去抖（避免流式期
 * 每字符变更都派发一帧）。
 *
 * @param container 滚动容器（如消息区）
 * @returns 是否吸底（true=已在底部附近，调用方据此隐藏「一键到底」按钮）
 */
export function followIfPinned(container: HTMLElement): boolean {
  const sticky = isSticky(container);
  if (sticky) {
    container.ownerDocument.defaultView?.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
  return sticky;
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

/**
 * 一键到底：无条件滚到底部，并按滚动后的**实际几何**重算吸底标记返回（同步，不经 rAF）
 *
 * 与另三个导出的分工（**四者互不取代，勿合并**）：
 *   - `scrollToBottom`：受**既有**吸底标记裁决 —— 用户上滚阅读时静默，不打断阅读；
 *   - `followIfPinned`：读取既有意图、不重算几何，供 MutationObserver 在任意高度变更后调用；
 *   - `forceScrollToBottom`：**预设** sticky=true 再滚 —— 用于容器内容被整体换掉
 *     （旧阅读位置对新内容无意义）；
 *   - **本函数**：**不预设** —— 先滚，再按实际结果重算并返回。预设会掩盖「没真滚到底」
 *     的情形（容器不可滚动 / 高度塌缩 / 布局尚未生效），本函数如实返回 ⇒ 没到底就继续显示按钮。
 *
 * **为何必须显式重算而非等 scroll 事件**：程序化赋值 `scrollTop` 是否派发 scroll 事件、
 * 何时派发，在异步 / 平滑滚动形态下不确定 ⇒ 标记更新必须有显式调用点（jsdom 完全不派发，
 * 故既有测试在 click 后同步断言，本函数保持同步即为守住该契约）。
 *
 * @param container 滚动容器（如消息区）
 * @returns 重算后是否吸底（false = 没真到底，调用方应继续显示「一键到底」按钮）
 */
export function jumpToBottom(container: HTMLElement): boolean {
  container.scrollTop = container.scrollHeight;
  return trackScroll(container);
}
