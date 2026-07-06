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
 * 浮动窗口拖动方案说明（浮动窗口是 80x80 的
 * alwaysOnTop + frame:false 窗口，鼠标移出窗口范围后 mousemove 停止触发，
 * 导致拖动失效。改用 PointerEvent + setPointerCapture 后，指针捕获确保
 * 鼠标移出窗口仍能持续接收 pointermove 事件，拖动可跨屏幕范围。
 *
 * 使用 Pick<ElectronAPI, ...> 提取浮动窗口所需子集，直接访问 window.electronAPI
 * （types.ts 声明全局类型，ElectronAPI 签名变更时自动同步）。
 */

import type { ElectronAPI } from '../../preload.js';
// 导入 types.js 确保 window.electronAPI 全局声明加载（float.ts 作为独立入口）
import '../types.js';
// 共享定时器跟踪器，统一管理 setTimeout/setInterval 的生命周期
import { SafeTimerTracker } from '../helpers/safeTimer.js';
// DOM 助手，提供带 tagName 校验的类型安全访问
import { getOptionalElement } from '../helpers/domHelpers.js';
// 事件监听器跟踪器（统一事件管理范式，与 modal/suggestionCard 等模块对齐）
import { EventTracker } from '../helpers/eventTracker.js';

/**
 * 浮动窗口所需的 ElectronAPI 子集（由 preload.ts 提供）
 *
 * 通过 Pick<ElectronAPI, ...> 提取子集，避免与 ElectronAPI 重复定义；
 * 未来 ElectronAPI 签名变更时，FloatElectronAPI 自动同步。
 */
export type FloatElectronAPI = Pick<
  ElectronAPI,
  | 'moveFloatWindow'
  | 'saveFloatPosition'
  | 'expandToFull'
  | 'showFloatContextMenu'
  | 'onFloatUnread'
  | 'onLastMessage'
  | 'removeLastMessageListener'
  | 'onSpriteEvent'
  | 'onThemeBroadcast'
  | 'removeThemeBroadcastListener'
>;

/** localStorage 键名：已见过拖动引导提示 */
const DRAG_HINT_SEEN_KEY = 'memora-drag-hint-seen';

/**
 * 类型守卫：判断 payload 是否包含有效的 imageUrl 字段
 *
 * 用于安全访问 formUpdate 事件的 payload.imageUrl，
 * 替代原方案对 unknown payload 的直接属性访问。
 */
function hasImageUrl(payload: unknown): payload is { imageUrl: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'imageUrl' in payload &&
    typeof (payload as Record<string, unknown>).imageUrl === 'string'
  );
}

/**
 * 类型守卫：判断 payload 是否为 presenceChanged 事件载荷（缺口 1.2）
 *
 * presenceChanged 事件由 spriteEventBridge.broadcastPresence 推送，
 * payload 结构为 { state: 'present' | 'away', awayDurationMs?: number }。
 */
function isPresencePayload(payload: unknown): payload is {
  state: 'present' | 'away';
  awayDurationMs?: number;
} {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return p.state === 'present' || p.state === 'away';
}

/** 离开时长小标签显示阈值（毫秒）：超过 5 分钟才显示"离开 N 分钟" */
const AWAY_LABEL_THRESHOLD_MS = 5 * 60 * 1000;
/** 离开时长小标签刷新间隔（毫秒）：每分钟更新一次"离开 N 分钟" */
const AWAY_LABEL_REFRESH_MS = 60_000;

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
  const sphereImage = getOptionalElement('sphere-image', 'img');
  const statusDot = document.getElementById('status-dot');
  const badge = document.getElementById('badge');
  const dragHint = document.getElementById('drag-hint');
  // 缺口 1.2：离开时长小标签（用户离开超过 5 分钟时显示）
  const awayLabel = document.getElementById('away-label');

  // 防护：关键元素缺失时静默退出（测试/非标准环境）
  if (!sphere || !statusDot || !badge) {
    return () => {}; // 空 cleanup
  }

  // 定时器跟踪器（共享工具，cleanup 时统一清理所有定时器）
  const timers = new SafeTimerTracker();
  // 事件监听器跟踪器（统一事件管理范式，替代手写 addEventListener/removeEventListener）
  const events = new EventTracker();

  // ─── 缺口 1.2：在场状态视觉反馈 ─────────────────────
  // 用户离开时球体变暗 + 灰度滤镜，statusDot 切换为月亮黄色
  // 离开超过 5 分钟时显示"离开 N 分钟"小标签，每分钟刷新
  let awayLabelTimer: ReturnType<typeof setInterval> | null = null;
  /** 离开起始时间戳（ms），null 表示当前未离开 */
  let awaySince: number | null = null;

  /** 格式化离开时长为人类可读字符串 */
  const formatAwayDuration = (ms: number): string => {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `离开 ${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    return `离开 ${hours} 小时`;
  };

  /** 启动离开时长小标签定时刷新（每分钟更新一次） */
  const startAwayLabelTimer = (): void => {
    if (awayLabelTimer !== null) return; // 已启动则跳过
    awayLabelTimer = timers.setInterval(() => {
      if (awaySince === null || !awayLabel) return;
      const elapsed = Date.now() - awaySince;
      if (elapsed >= AWAY_LABEL_THRESHOLD_MS) {
        awayLabel.textContent = formatAwayDuration(elapsed);
      }
    }, AWAY_LABEL_REFRESH_MS);
  };

  /** 停止离开时长小标签定时刷新 */
  const stopAwayLabelTimer = (): void => {
    if (awayLabelTimer !== null) {
      timers.clearSafeInterval(awayLabelTimer);
      awayLabelTimer = null;
    }
  };

  /** 应用在场状态视觉反馈 */
  const applyPresenceState = (state: 'present' | 'away', awayDurationMs?: number): void => {
    if (state === 'away') {
      sphere.classList.add('away');
      statusDot.classList.add('away');
      // 记录离开起始时间（优先用事件携带的 awayDurationMs 反推，否则用当前时间）
      awaySince = awayDurationMs ? Date.now() - awayDurationMs : Date.now();
      // 超过阈值时立即显示小标签，否则等待定时器刷新到阈值时再显示
      if (awayLabel && awayDurationMs && awayDurationMs >= AWAY_LABEL_THRESHOLD_MS) {
        awayLabel.textContent = formatAwayDuration(awayDurationMs);
        awayLabel.classList.add('visible');
      }
      startAwayLabelTimer();
    } else {
      sphere.classList.remove('away');
      statusDot.classList.remove('away');
      awaySince = null;
      if (awayLabel) {
        awayLabel.classList.remove('visible');
      }
      stopAwayLabelTimer();
    }
  };

  // ─── 首次使用拖动引导 ───────────────────────────
  // 新用户不知道浮动窗口可以拖动，首次悬停时显示引导提示。
  // 使用 localStorage 标记是否已引导过，避免重复打扰老用户。
  // 引导提示在首次拖动或单击后自动消失，不再显示。
  let hasShownDragHint = localStorage.getItem(DRAG_HINT_SEEN_KEY) === '1';
  let dragHintTimer: ReturnType<typeof setTimeout> | null = null;

  /** 显示拖动引导提示（仅首次使用时） */
  function showDragHintIfFirstTime(): void {
    if (hasShownDragHint || !dragHint) return;
    dragHint.classList.add('visible');
    // 延长到 8 秒，确保用户有足够时间阅读引导文案
    dragHintTimer = timers.setTimeout(() => {
      dragHint?.classList.remove('visible');
    }, 8000);
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
        timers.clearSafeTimeout(dragHintTimer);
        dragHintTimer = null;
      }
    }
  }

  // 球体事件处理器（命名函数，便于 cleanup 时 removeEventListener）
  const onSphereMouseLeave = () => {
    if (dragHintTimer) {
      timers.clearSafeTimeout(dragHintTimer);
      dragHintTimer = null;
    }
    if (dragHint) {
      dragHint.classList.remove('visible');
    }
  };

  // ─── 拖动检测（PointerEvent + setPointerCapture） ───
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
      // 首次拖动后标记已见过引导，不再显示
      markDragHintSeen();
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
      // 首次单击后标记已见过引导，不再显示
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

  // #sphere 添加 role="button" tabindex="0" 后，需支持 Enter/Space 触发与单击等效的操作
  const onSphereKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      markDragHintSeen();
      electronAPI.expandToFull();
    }
  };

  // 事件绑定到 sphere（而非 document），配合 setPointerCapture 确保事件不丢失
  // 统一使用 EventTracker 管理，cleanup 时一次性移除全部监听器
  // 注：EventTracker.addEventListener 签名为 EventListener (e: Event)，
  // 此处用包装函数将 Event 断言为具体事件类型，保持类型安全的同时兼容接口。
  events.addEventListener(sphere, 'pointerdown', (e) => onPointerDown(e as PointerEvent));
  events.addEventListener(sphere, 'pointermove', (e) => onPointerMove(e as PointerEvent));
  events.addEventListener(sphere, 'pointerup', (e) => onPointerUp(e as PointerEvent));
  events.addEventListener(sphere, 'contextmenu', onContextMenu);
  events.addEventListener(sphere, 'keydown', (e) => onSphereKeydown(e as KeyboardEvent));

  // ─── 未读计数监听 ──────────────────────────────────────
  electronAPI.onFloatUnread((count: number) => {
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.add('visible');
    } else {
      badge.classList.remove('visible');
    }
  });

  // ─── 最后一条助手消息预览 ──────────────────────
  // 主窗口流式输出结束后，推送最后一条助手消息到此。
  // 鼠标悬停球体时显示预览卡片，单击展开完整窗口。
  let lastMessageText = '';
  const messagePreview = document.getElementById('message-preview');
  const messagePreviewText = messagePreview?.querySelector('.message-preview-text');

  /** 显示消息预览卡片（悬停时调用） */
  const showMessagePreview = (): void => {
    if (!messagePreview || !messagePreviewText || !lastMessageText) return;
    // 截断长文本，最多显示 120 字
    const preview = lastMessageText.length > 120
      ? lastMessageText.slice(0, 120) + '...'
      : lastMessageText;
    messagePreviewText.textContent = preview;
    messagePreview.classList.add('visible');
  };

  /** 隐藏消息预览卡片（鼠标离开时调用） */
  const hideMessagePreview = (): void => {
    if (!messagePreview) return;
    messagePreview.classList.remove('visible');
  };

  // 监听主窗口推送的最后一条助手消息
  electronAPI.onLastMessage((text: string) => {
    lastMessageText = text;
  });

  // 悬停球体时显示预览
  events.addEventListener(sphere, 'mouseenter', (_e) => {
    showDragHintIfFirstTime();
    showMessagePreview();
  });
  events.addEventListener(sphere, 'mouseleave', (_e) => {
    onSphereMouseLeave();
    hideMessagePreview();
  });

  // ─── 精灵事件监听（统一注册，避免重复触发） ────────────
  // 注意：onSpriteEvent 在同一通道上多次注册会导致同一事件触发多次。
  // 此处合并主动提示弹跳 + 阶段三形态进化预留为一个监听器，按 type 分发。
  // ElectronAPI.onSpriteEvent 的 payload 是 unknown（不同事件类型有不同结构），
  // 此处使用类型守卫 hasImageUrl 安全地访问 formUpdate 事件的 imageUrl 字段。
  electronAPI.onSpriteEvent((event) => {
    // 主动提示：球体弹跳动画 + 状态点切换
    if (event.type === 'proactivePrompt') {
      sphere.classList.add('bounce');
      timers.setTimeout(() => sphere.classList.remove('bounce'), 600);

      statusDot.classList.add('active');
      // 3 秒后恢复 idle
      timers.setTimeout(() => statusDot.classList.remove('active'), 3000);
    }

    // 阶段三形态进化预留：加载生成的形态图片
    if (event.type === 'formUpdate' && hasImageUrl(event.payload) && sphereImage) {
      sphereImage.src = event.payload.imageUrl;
      sphereImage.style.display = 'block';
      if (sphereEmoji) {
        sphereEmoji.style.display = 'none';
      }
    }

    // 缺口 1.2：在场状态变化 → 球体变暗 + 离开时长小标签
    if (event.type === 'presenceChanged' && isPresencePayload(event.payload)) {
      applyPresenceState(event.payload.state, event.payload.awayDurationMs);
    }
  });

  // ─── 主题变更监听 ────────────────────────────
  // 完整窗口切换主题后，主进程通过 THEME_BROADCAST 通道通知浮动窗口，
  // 浮动窗口同步切换 data-theme 属性，确保两个窗口主题一致。
  electronAPI.onThemeBroadcast((theme) => {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  });

  // ─── 返回清理函数 ─────────────────────────────────────
  return () => {
    // 释放可能残留的指针捕获（避免窗口关闭时指针泄漏）
    if (activePointerId !== null && sphere.hasPointerCapture(activePointerId)) {
      sphere.releasePointerCapture(activePointerId);
    }
    activePointerId = null;

    // EventTracker 统一清理全部 DOM 事件监听器（7 个 sphere 监听器）
    events.cleanup();
    // 清理主题广播监听器，避免窗口关闭后回调触发到已销毁 DOM
    electronAPI.removeThemeBroadcastListener();
    // 清理最后一条消息监听器
    electronAPI.removeLastMessageListener();
    if (dragHintTimer) timers.clearSafeTimeout(dragHintTimer);
    // 缺口 1.2：清理离开时长小标签定时器
    stopAwayLabelTimer();
    timers.cleanup();
  };
}

// 在 Electron 渲染进程中自动初始化
// 直接使用 window.electronAPI（types.ts 已声明全局类型），
// 替代原方案的双重类型断言 (window as unknown as Record<string, unknown>).electronAPI。
// electronAPI 由 preload.ts 通过 contextBridge 注入到 window 对象。
if (window.electronAPI) {
  initFloatWindow(window.electronAPI);
}