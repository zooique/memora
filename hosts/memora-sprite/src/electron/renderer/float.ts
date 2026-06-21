/**
 * 浮动窗口脚本 — 精灵球体交互逻辑
 *
 * 从 float.html 内联 <script> 提取，职责：
 * - 拖动检测（pointerdown / pointermove / pointerup + setPointerCapture）
 * - 首次使用拖动引导提示（localStorage）
 * - 右键菜单
 * - 未读计数监听
 * - 精灵事件监听（主动提示弹跳 + 形态进化预留）
 *
 * 返回 cleanup 函数供调用方在窗口关闭时清理事件监听器和定时器。
 *
 * P1-2 修复：原方案使用 mousemove 监听 document，但浮动窗口是 80x80 的
 * alwaysOnTop + frame:false 窗口，鼠标移出窗口范围后 mousemove 停止触发，
 * 导致拖动失效。改用 PointerEvent + setPointerCapture 后，指针捕获确保
 * 鼠标移出窗口仍能持续接收 pointermove 事件，拖动可跨屏幕范围。
 */

/** 浮动窗口所需的 ElectronAPI 子集（由 preload.ts 提供） */
export interface FloatElectronAPI {
  startFloatDrag(): void;
  moveFloatWindow(dx: number, dy: number): void;
  saveFloatPosition(): void;
  expandToFull(): void;
  showFloatContextMenu(): void;
  onFloatUnread(cb: (count: number) => void): void;
  onSpriteEvent(cb: (event: { type: string; payload: { prompt?: string; imageUrl?: string; silent?: boolean } }) => void): void;
}

/** localStorage 键名：已见过拖动引导提示 */
const DRAG_HINT_SEEN_KEY = 'memora-drag-hint-seen';

/**
 * 初始化浮动窗口交互逻辑
 *
 * @param electronAPI - preload.ts 暴露的 ElectronAPI 对象
 * @returns 清理函数，调用后移除所有事件监听器并清除定时器
 */
export function initFloatWindow(electronAPI: FloatElectronAPI): () => void {
  // ─── DOM 引用 ─────────────────────────────────────────
  const sphere = document.getElementById('sphere');
  const sphereEmoji = document.getElementById('sphere-emoji');
  const sphereImage = document.getElementById('sphere-image') as HTMLImageElement | null;
  const statusDot = document.getElementById('status-dot');
  const badge = document.getElementById('badge');
  const dragHint = document.getElementById('drag-hint');

  // 防护：关键元素缺失时静默退出（测试/非标准环境）
  if (!sphere || !statusDot || !badge) {
    return () => {}; // 空 cleanup
  }

  // 定时器追踪（用于 cleanup 时统一清理）
  const activeTimers: ReturnType<typeof setTimeout>[] = [];

  /** 安全的 setTimeout 包装，自动追踪定时器 */
  function safeSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      fn();
      // 执行后从追踪列表中移除
      const idx = activeTimers.indexOf(timer);
      if (idx !== -1) activeTimers.splice(idx, 1);
    }, ms);
    activeTimers.push(timer);
    return timer;
  }

  // ─── FD-06 首次使用拖动引导 ───────────────────────────
  // 新用户不知道浮动窗口可以拖动，首次悬停时显示引导提示。
  // 使用 localStorage 标记是否已引导过，避免重复打扰老用户。
  // 引导提示在首次拖动或单击后自动消失，不再显示。
  let hasShownDragHint = localStorage.getItem(DRAG_HINT_SEEN_KEY) === '1';
  let dragHintTimer: ReturnType<typeof setTimeout> | null = null;

  /** 显示拖动引导提示（仅首次使用时） */
  function showDragHintIfFirstTime(): void {
    if (hasShownDragHint || !dragHint) return;
    dragHint.classList.add('visible');
    // 5 秒后自动隐藏（避免长时间遮挡）
    dragHintTimer = safeSetTimeout(() => {
      dragHint?.classList.remove('visible');
    }, 5000);
  }

  /** 标记已见过引导提示（首次拖动或单击后调用） */
  function markDragHintSeen(): void {
    if (!hasShownDragHint) {
      hasShownDragHint = true;
      localStorage.setItem(DRAG_HINT_SEEN_KEY, '1');
      if (dragHint) {
        dragHint.classList.remove('visible');
      }
      if (dragHintTimer) {
        clearTimeout(dragHintTimer);
        dragHintTimer = null;
      }
    }
  }

  // 球体事件处理器（命名函数，便于 cleanup 时 removeEventListener）
  const onSphereMouseLeave = () => {
    if (dragHintTimer) {
      clearTimeout(dragHintTimer);
      dragHintTimer = null;
    }
    if (dragHint) {
      dragHint.classList.remove('visible');
    }
  };

  sphere.addEventListener('mouseenter', showDragHintIfFirstTime);
  sphere.addEventListener('mouseleave', onSphereMouseLeave);

  // ─── 拖动检测（P1-2 修复：PointerEvent + setPointerCapture） ───
  // 原方案使用 document mousemove，但浮动窗口是 80x80 alwaysOnTop + frame:false
  // 窗口，鼠标移出窗口范围后 mousemove 停止触发，导致拖动失效。
  // 改用 PointerEvent + setPointerCapture：在 pointerdown 时将指针捕获到 sphere 元素，
  // 后续 pointermove/pointerup 即使鼠标移出窗口也能持续触发，实现跨屏幕拖动。
  let isDragging = false;
  let startX = 0;  // 拖动起始 screenX（用于判断是否超过阈值）
  let startY = 0;  // 拖动起始 screenY
  let lastScreenX = 0;  // 上一次 pointermove 的 screenX（用于计算增量）
  let lastScreenY = 0;  // 上一次 pointermove 的 screenY
  let activePointerId: number | null = null;  // 当前捕获的指针 ID（用于 cleanup 时释放）

  // 命名函数引用（便于 cleanup 时 removeEventListener）
  const onPointerDown = (e: PointerEvent) => {
    // 仅处理左键（button=0）或触摸（pointerType=touch）
    if (e.button !== 0) return;
    isDragging = false;
    startX = e.screenX;
    startY = e.screenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    activePointerId = e.pointerId;
    // 捕获指针：确保后续 pointermove/pointerup 即使鼠标移出窗口也能触发
    sphere.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    // 仅处理当前捕获的指针（避免多点触控干扰）
    if (activePointerId !== e.pointerId) return;
    if (e.buttons !== 1) return; // 只处理左键按下（兼容鼠标）
    const dx = e.screenX - startX;
    const dy = e.screenY - startY;

    // 阈值判断：移动超过 3px 才认为是拖动（避免单击误判）
    if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      isDragging = true;
      sphere.classList.add('dragging');
      // FD-06 首次拖动后标记已见过引导，不再显示
      markDragHintSeen();
      // 通知主进程开始拖动（设置 isDragging 标志），否则后续 moveFloatWindow 会被忽略
      electronAPI.startFloatDrag();
    }

    if (isDragging) {
      // 计算增量并移动窗口
      const moveDx = e.screenX - lastScreenX;
      const moveDy = e.screenY - lastScreenY;
      if (moveDx !== 0 || moveDy !== 0) {
        electronAPI.moveFloatWindow(moveDx, moveDy);
      }
      lastScreenX = e.screenX;
      lastScreenY = e.screenY;
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    // 仅处理当前捕获的指针
    if (activePointerId !== e.pointerId) return;
    // 释放指针捕获
    if (sphere.hasPointerCapture(e.pointerId)) {
      sphere.releasePointerCapture(e.pointerId);
    }
    activePointerId = null;

    if (isDragging) {
      // 拖动结束，保存位置
      sphere.classList.remove('dragging');
      electronAPI.saveFloatPosition();
    } else {
      // 非拖动 → 单击 → 展开为完整窗口
      // FD-06 首次单击后标记已见过引导，不再显示
      markDragHintSeen();
      electronAPI.expandToFull();
    }
    isDragging = false;
  };

  // 右键菜单处理器
  const onContextMenu = (e: Event) => {
    e.preventDefault();
    electronAPI.showFloatContextMenu();
  };

  // 事件绑定到 sphere（而非 document），配合 setPointerCapture 确保事件不丢失
  sphere.addEventListener('pointerdown', onPointerDown);
  sphere.addEventListener('pointermove', onPointerMove);
  sphere.addEventListener('pointerup', onPointerUp);
  sphere.addEventListener('contextmenu', onContextMenu);

  // ─── 未读计数监听 ──────────────────────────────────────
  electronAPI.onFloatUnread((count: number) => {
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.add('visible');
    } else {
      badge.classList.remove('visible');
    }
  });

  // ─── 精灵事件监听（统一注册，避免重复触发） ────────────
  // 注意：onSpriteEvent 在同一通道上多次注册会导致同一事件触发多次。
  // 此处合并主动提示弹跳 + 阶段三形态进化预留为一个监听器，按 type 分发。
  electronAPI.onSpriteEvent((event) => {
    // 主动提示：球体弹跳动画 + 状态点切换
    if (event.type === 'proactivePrompt') {
      sphere.classList.add('bounce');
      safeSetTimeout(() => sphere.classList.remove('bounce'), 600);

      statusDot.classList.add('active');
      // 3 秒后恢复 idle
      safeSetTimeout(() => statusDot.classList.remove('active'), 3000);
    }

    // 阶段三形态进化预留：加载生成的形态图片
    if (event.type === 'formUpdate' && event.payload?.imageUrl && sphereImage) {
      sphereImage.src = event.payload.imageUrl;
      sphereImage.style.display = 'block';
      if (sphereEmoji) {
        sphereEmoji.style.display = 'none';
      }
    }
  });

  // ─── 返回清理函数 ─────────────────────────────────────
  return () => {
    // 释放可能残留的指针捕获（避免窗口关闭时指针泄漏）
    if (activePointerId !== null && sphere.hasPointerCapture(activePointerId)) {
      sphere.releasePointerCapture(activePointerId);
    }
    activePointerId = null;

    sphere.removeEventListener('pointerdown', onPointerDown);
    sphere.removeEventListener('pointermove', onPointerMove);
    sphere.removeEventListener('pointerup', onPointerUp);
    sphere.removeEventListener('contextmenu', onContextMenu);
    sphere.removeEventListener('mouseenter', showDragHintIfFirstTime);
    sphere.removeEventListener('mouseleave', onSphereMouseLeave);
    if (dragHintTimer) clearTimeout(dragHintTimer);
    activeTimers.forEach(clearTimeout);
    activeTimers.length = 0;
  };
}

// 在 Electron 渲染进程中自动初始化
// electronAPI 由 preload.ts 通过 contextBridge 注入到 window 对象
const api = (window as unknown as Record<string, unknown>).electronAPI;
if (api) {
  initFloatWindow(api as FloatElectronAPI);
}