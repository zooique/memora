/**
 * 单轨 chip 行的共用行为 — 边缘渐隐 + 纵向滚轮转横向
 *
 * 为什么外置（2026-10-28）：这两个函数原本内嵌在 `createChatView` 闭包里，只服务技能行与
 * 引用行。图片附件行（`#imageChips`）需要**完全相同**的行为，而 chatView 已顶到 `max-lines`
 * 闸门（6715 行，只降不升）⇒ 与其复制第三份，不如把这段内聚行为搬到 helper 由三行共用。
 * 行为零改动：函数体逐字节照搬，只把「技能行与引用行共用」的注释更新为三行共用。
 */

/**
 * 单轨附件行的边缘状态同步（**唯一写入点**，技能行 / 引用行 / 图片行共用）
 *
 * 只做一件事：按当前滚动位置给容器切 `is-overflow-start/end` 类，CSS 据此渐隐。
 * 渐隐是单轨方案下「这一侧还有 chip」的唯一可见线索——滚动条已隐藏，不渐隐等于让人猜。
 * `+1` 容差：Windows 125% 缩放下 `scrollLeft` 常带 0.5~1px 亚像素误差，严格比较会让
 * 渐隐在贴边时闪一下。
 */
export function syncRowEdges(row: HTMLElement | null): void {
  if (!row) return;
  const max = row.scrollWidth - row.clientWidth;
  row.classList.toggle('is-overflow-start', row.scrollLeft > 1);
  row.classList.toggle('is-overflow-end', max > 1 && row.scrollLeft < max - 1);
}

/**
 * 给附件行绑定单轨滚动行为（HOST-CTX-10）
 *
 * 纵向滚轮 → 横向滚动：滚动条已隐藏，鼠标用户没有别的横向手势可用（触控板用户仍走原生
 * 横向手势，`deltaX` 不拦）。**只在真的溢出时才拦截**——常态（一两个 chip 装得下）绝不
 * `preventDefault`，否则用户把光标停在附件行上就滚不动对话，属于无理由劫持。
 */
export function bindSingleTrackRow(row: HTMLElement | null): void {
  if (!row) return;
  row.addEventListener('scroll', () => syncRowEdges(row), { passive: true });
  row.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaY === 0 || row.scrollWidth <= row.clientWidth) return; // 无溢出 / 横向手势：交还原生
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    },
    { passive: false }, // 要 preventDefault，不能是 passive
  );
}
