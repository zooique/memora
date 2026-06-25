/**
 * 精灵事件桥 — Sprite 事件到渲染层的翻译层
 *
 * 职责：
 *   1. 订阅 Sprite 事件（sprite.on）
 *   2. 将事件通过 IPC 推送到渲染进程（MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT）
 *   3. 处理主动提示的特殊逻辑（托盘脉冲 + 系统通知 + 未读计数）
 *
 * 设计原则（P2-DESIGN-4）：
 *   7 个简单转发事件（memoryNoticed / insightGained / personaChanged /
 *   projectSwitched / skillMatched / memoryRecalled / decayCompleted）
 *   通过类型安全的 forwardSimpleEvent 泛型函数逐个注册，
 *   消除重复的 registerSpriteEvent + sendSpriteEventIfVisible 模板代码。
 *
 *   proactivePrompt 保留显式处理（含托盘脉冲 + 系统通知 + 未读计数等副作用）。
 */

import { Notification } from 'electron';
import { logger, toError } from 'memora';
import type { Sprite, SpriteEventMap } from '../sprite/sprite.js';
import { MAIN_TO_RENDERER_CHANNELS } from './ipc/channels.js';
import type { WindowManager } from './windows/windowManager.js';
import type { WindowStateManager } from './windows/windowState.js';
import type { TrayManager } from './trayIcon.js';

/**
 * 精灵事件桥依赖
 *
 * 由 main.ts 注入，避免直接访问全局变量。
 */
export interface SpriteEventBridgeDeps {
  /** Sprite 实例 */
  sprite: Sprite;
  /** 窗口管理器（获取完整窗口引用） */
  windowManager: WindowManager;
  /** 窗口状态管理器（主动提示点击时切换到完整窗口） */
  windowStateManager: WindowStateManager;
  /** 托盘管理器（主动提示时脉冲） */
  trayManager: TrayManager | null;
  /** 增加未读计数（完整窗口不可见时累积） */
  incrementUnreadCount: () => void;
}

/**
 * 精灵事件订阅者列表（用于 Agent 重新初始化前取消订阅）
 */
const spriteEventUnsubscribers: Array<() => void> = [];

/**
 * 类型安全的简单事件转发注册
 *
 * 泛型 K 约束 eventName 为 SpriteEventMap 合法键，
 * toPayload 的参数类型自动推导为 SpriteEventMap[K]，无需类型断言。
 * 替代原 SIMPLE_EVENT_FORWARDERS 映射表 + never 类型 + as 断言的反模式。
 *
 * @param deps 依赖
 * @param eventName 事件名
 * @param toPayload 将事件载荷转为渲染层可用的 Record
 */
function forwardSimpleEvent<K extends keyof SpriteEventMap>(
  deps: SpriteEventBridgeDeps,
  eventName: K,
  toPayload: (e: SpriteEventMap[K]) => Record<string, unknown>,
): void {
  registerSpriteEvent(deps, eventName, (e) => {
    sendSpriteEventIfVisible(deps, eventName, toPayload(e));
  });
}

/**
 * 向完整窗口发送精灵事件（若窗口可见）
 *
 * 仅在完整窗口存在且可见时发送，避免窗口隐藏或销毁时调用 webContents.send 抛错。
 *
 * @param deps 依赖
 * @param type 事件类型（对应 SpriteEventMap 的 key）
 * @param payload 事件载荷
 * @param silent 是否静默（默认 true，仅 proactivePrompt 为 false）
 */
function sendSpriteEventIfVisible(
  deps: SpriteEventBridgeDeps,
  type: string,
  payload: Record<string, unknown>,
  silent = true,
): void {
  const fullWindow = deps.windowManager.getFullWindow();
  // 同时检查 isVisible 和 !isMinimized：macOS 上最小化的窗口 isVisible 可能仍为 true
  if (
    fullWindow &&
    !fullWindow.isDestroyed() &&
    fullWindow.isVisible() &&
    !fullWindow.isMinimized()
  ) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
      type,
      payload,
      silent,
    });
  }
}

/**
 * QC-R2-01 通用精灵事件注册 helper
 *
 * 统一"定义回调 → sprite.on 注册 → 推送取消订阅"模式。
 *
 * 类型安全：通过泛型 K 约束 eventName 必须是 SpriteEventMap 的合法键，
 * handler 的参数类型自动推导为 SpriteEventMap[K]。
 *
 * @param deps 依赖
 * @param eventName 事件名（对应 SpriteEventMap 的 key）
 * @param handler 事件回调
 */
function registerSpriteEvent<K extends keyof SpriteEventMap>(
  deps: SpriteEventBridgeDeps,
  eventName: K,
  handler: (e: SpriteEventMap[K]) => void,
): void {
  deps.sprite.on(eventName, handler);
  spriteEventUnsubscribers.push(() => deps.sprite.off(eventName, handler));
}

/**
 * 订阅精灵事件，实现方案 §6.6 主动提示分发逻辑：
 * - 托盘脉冲（始终执行）
 * - 系统通知（非静默模式）
 * - 窗口内提示（非静默 + 窗口可见）
 *
 * 取消订阅机制：Agent 重新初始化前调用 unsubscribeSpriteEvents()，
 * 避免旧 sprite 实例的监听器残留导致同一事件触发多次。
 *
 * @param deps 依赖
 */
export function setupSpriteEventListeners(deps: SpriteEventBridgeDeps): void {
  // 先取消旧订阅（防止 reinitAgent 时重复注册）
  unsubscribeSpriteEvents();

  // 主动提示：托盘脉冲 + 系统通知 + 窗口内提示（保留显式处理，含复杂副作用）
  registerSpriteEvent(deps, 'proactivePrompt', ({ prompt, silent }) => {
    // 始终执行：托盘切换为 active 状态（蓝色 + 脉冲）
    deps.trayManager?.setState('active');

    // 非静默模式：系统通知（检查系统是否支持，避免不支持时崩溃）
    if (!silent && Notification.isSupported()) {
      const notification = new Notification({
        title: 'Memora 精灵',
        body: prompt,
      });
      notification.on('click', () => {
        deps.windowStateManager.transition('full');
      });
      notification.show();
    }

    // 非静默模式 + 完整窗口可见：窗口内提示
    if (!silent) {
      sendSpriteEventIfVisible(deps, 'proactivePrompt', { prompt, silent }, silent);

      // P2-FLOW-12 浮动窗口主动提示未读徽章
      // 完整窗口不可见时，用户无法看到 banner，需在浮动窗口徽章上累积未读计数
      const fullWindow = deps.windowManager?.getFullWindow();
      if (fullWindow && !fullWindow.isVisible()) {
        deps.incrementUnreadCount();
      }
    }
  });

  // 7 个简单转发事件：逐个类型安全注册（替代原映射表 + for 循环）
  // 记忆新增 → 仪表盘计数 +1
  forwardSimpleEvent(deps, 'memoryNoticed', () => ({}));
  // 洞察提取 → 仪表盘计数 +1
  forwardSimpleEvent(deps, 'insightGained', () => ({}));
  // 角色切换 → 顶栏角色标签更新
  forwardSimpleEvent(deps, 'personaChanged', (e) => ({ from: e.from, to: e.to }));
  // 项目切换 → 渲染层通知
  forwardSimpleEvent(deps, 'projectSwitched', (e) => ({
    from: e.from,
    to: e.to,
    projectName: e.projectName,
  }));
  // 技能匹配 → 渲染层通知
  forwardSimpleEvent(deps, 'skillMatched', (e) => ({ skill: e.skill, score: e.score }));
  // 记忆召回 → 渲染层通知（每次对话触发，按需展示"想起 X 条"）
  forwardSimpleEvent(deps, 'memoryRecalled', (e) => ({ count: e.count, query: e.query }));
  // 衰减完成 → 渲染层通知（24h 节流避免每小时噪音，节流由渲染层控制）
  forwardSimpleEvent(deps, 'decayCompleted', (e) => ({ decayedCount: e.decayedCount }));
}

/** 取消所有精灵事件订阅（Agent 重新初始化前调用） */
export function unsubscribeSpriteEvents(): void {
  for (const unsubscribe of spriteEventUnsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      // 旧 sprite 实例可能已关闭，忽略取消订阅错误
      logger.warn({ error: toError(error) }, '[unsubscribeSpriteEvents] 取消订阅失败');
    }
  }
  spriteEventUnsubscribers.length = 0;
}
