/**
 * 精灵事件桥 — Sprite 事件到渲染层的翻译层
 *
 * 职责：
 *   1. 订阅 Sprite 事件（sprite.on）
 *   2. 将事件通过 IPC 推送到渲染进程（MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT）
 *   3. 处理主动提示的特殊逻辑（托盘脉冲 + 系统通知 + 未读计数）
 *
 * 设计原则：
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
// P2 剪枝：主动提示托盘重置超时常量从 constants.ts 真理源导入，消除散落定义
import { PROACTIVE_TRAY_RESET_MS } from '../sprite/constants.js';

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
 * silent 默认值为 false。silent 仅控制系统通知（是否弹系统通知），
 * 渲染层 toast 显示由各 handler 自行决定（基于业务逻辑，非 silent 标志）。
 *
 * @param deps 依赖
 * @param type 事件类型（对应 SpriteEventMap 的 key）
 * @param payload 事件载荷
 * @param silent 是否静默（默认 false；proactivePrompt 通过 payload.silent 控制）
 */
function sendSpriteEventIfVisible(
  deps: SpriteEventBridgeDeps,
  type: string,
  payload: Record<string, unknown>,
  silent = false,
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
 * 通用精灵事件注册 helper
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

  /**
   * 主动提示托盘状态自动复位定时器
   *
   * proactivePrompt 将托盘设为 active 后，若渲染进程不发送 PROACTIVE_PROMPT_SHOWN
   * （窗口不可见/崩溃/逻辑遗漏），托盘会永久卡在 active 状态（脉冲动画持续运行）。
   * 此定时器作为兜底：30 秒后自动切回 idle，防止资源泄漏。
   * 若渲染进程在 30 秒内发送了 PROACTIVE_PROMPT_SHOWN，systemHandlers 会切回 idle，
   * 此时定时器到期后 setState('idle') 因幂等保护无副作用。
   */
  let proactiveTrayResetTimer: ReturnType<typeof setTimeout> | null = null;

  // 主动提示：托盘脉冲 + 系统通知 + 窗口内提示（保留显式处理，含复杂副作用）
  registerSpriteEvent(deps, 'proactivePrompt', ({ prompt, triggers, silent, isMilestone }) => {
    // 整个 handler 用 try/catch 分段保护，防止单个副作用抛错中断后续逻辑
    try {
      // 始终执行：托盘切换为 active 状态（蓝色 + 脉冲）
      deps.trayManager?.setState('active');

      // 启动托盘状态自动复位定时器（兜底）
      if (proactiveTrayResetTimer !== null) {
        clearTimeout(proactiveTrayResetTimer);
      }
      proactiveTrayResetTimer = setTimeout(() => {
        proactiveTrayResetTimer = null;
        deps.trayManager?.setState('idle');
      }, PROACTIVE_TRAY_RESET_MS);

      // 非静默模式：系统通知（检查系统是否支持，避免不支持时崩溃）
      // 注意：silent 恒为 false（ProactiveEngine.tryEmit 在 silentMode 时 return），
      // 此处的 !silent 检查是防御性代码，未来若恢复 silent 路径仍有保护意义
      if (!silent && Notification.isSupported()) {
        // Phase 2.3：里程碑使用特殊通知标题
        const notification = new Notification({
          title: isMilestone ? '🎉 里程碑达成' : 'Memora 精灵',
          body: prompt,
        });
        notification.on('click', () => {
          deps.windowStateManager?.transition('full');
        });
        notification.show();
      }

      // 非静默模式 + 完整窗口可见：窗口内提示
      if (!silent) {
        // Phase 2.3：传递 isMilestone 标志到渲染层
        sendSpriteEventIfVisible(deps, 'proactivePrompt', { prompt, triggers, silent, isMilestone }, silent);

        // 浮动窗口主动提示未读徽章
        // 完整窗口不可见时，用户无法看到 banner，需在浮动窗口徽章上累积未读计数
        // 补充 isDestroyed() 检查，防止窗口销毁后调用 isVisible() 抛错
        const fullWindow = deps.windowManager?.getFullWindow();
        if (fullWindow && !fullWindow.isDestroyed() && !fullWindow.isVisible()) {
          deps.incrementUnreadCount();
        }
      }
    } catch (error) {
      // 某个副作用抛错时记录日志，但不影响精灵事件总线中其他 handler 的执行
      logger.warn({ error: toError(error) }, '[proactivePrompt handler] 副作用执行异常');
    }
  });

  // 7 个简单转发事件：逐个类型安全注册（替代原映射表 + for 循环）
  // 记忆新增 → 仪表盘计数 +1
  forwardSimpleEvent(deps, 'memoryNoticed', () => ({}));
  // 洞察提取 → 仪表盘计数 +1
  forwardSimpleEvent(deps, 'insightGained', () => ({}));
  // 记忆冲突检测 → ProactiveBanner 通知用户
  forwardSimpleEvent(deps, 'conflictDetected', (e) => ({
    newMemoryId: e.newMemoryId,
    newInsight: e.newInsight,
    targetId: e.targetId,
    targetContent: e.targetContent,
  }));
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
  // 会话分叉 → 渲染层通知（提示"已从 XXX 分叉出 N 条消息"并自动切换到新会话）
  forwardSimpleEvent(deps, 'sessionForked', (e) => ({
    from: e.from,
    to: e.to,
    messageCount: e.messageCount,
  }));
  // Phase 2.1：情感基调更新 → 渲染层仪表盘展示
  forwardSimpleEvent(deps, 'affectUpdated', (e) => ({
    warmth: e.warmth,
    playfulness: e.playfulness,
    directness: e.directness,
    initiative: e.initiative,
  }));
  // Phase 3：默契度更新 → 渲染层仪表盘展示
  forwardSimpleEvent(deps, 'rapportUpdated', (e) => ({
    trust: e.trust,
    familiarity: e.familiarity,
    level: e.level,
    description: e.description,
  }));
  // Phase 4：对话上下文更新 → 渲染层仪表盘展示
  forwardSimpleEvent(deps, 'contextUpdated', (e) => ({
    rhythm: e.rhythm,
    coherence: e.coherence,
    depth: e.depth,
    dominantSource: e.dominantSource,
    description: e.description,
  }));
  // 作品投影更新 → 渲染层刷新作品投影面板
  forwardSimpleEvent(deps, 'workProjectionUpdated', (e) => ({
    sourcePath: e.sourcePath,
    summary: e.summary,
  }));
  // Phase 2+：用户模式更新 → 渲染层洞察面板展示
  forwardSimpleEvent(deps, 'patternsUpdated', (e) => ({
    patterns: e.patterns,
  }));
  // 回收站自动清理完成 → 渲染层 toast 通知
  forwardSimpleEvent(deps, 'trashPurged', (e) => ({ purgedCount: e.purgedCount }));

  // 缺口 1.2：在场状态变化 → 完整窗口感知面板 + 浮动窗口视觉反馈
  // 此前 presenceChanged 事件未在桥接层转发，渲染层 handler 从未触发（流断点修复）
  // 浮动窗口需要独立推送：80x80 球体在用户离开时无视觉变化，体验割裂
  registerSpriteEvent(deps, 'presenceChanged', (e) => {
    // 1. 推送到完整窗口（perceptionRenderer 更新在场状态指示器）
    sendSpriteEventIfVisible(deps, 'presenceChanged', {
      state: e.state,
      timestamp: e.timestamp,
      awayDurationMs: e.awayDurationMs,
      reason: e.reason,
    });
    // 2. 推送到浮动窗口（球体变暗 + 离开时长小标签）
    // 仅在浮动窗口存在时推送，未创建浮动窗口时跳过
    const floatWindow = deps.windowManager.getFloatWindow();
    if (floatWindow) {
      floatWindow.broadcastPresence(e.state, e.awayDurationMs);
    }
  });

  // 推送初始感知数据（时序修复：sprite.start() 在监听器注册前就发射了感知事件）
  // 必须在所有监听器注册完成后执行，确保渲染层能收到初始状态
  pushInitialPerceptionData(deps);
}

/**
 * 推送初始感知数据到渲染层
 *
 * 时序问题修复：sprite.start() → perceptionCoordinator.refreshBeforeChat() → 发射事件
 * 此时 setupSpriteEventListeners() 还未调用，事件永久丢失。
 * 解决方案：在监听器注册完成后，主动获取感知快照并推送初始数据。
 *
 * @param deps 依赖
 */
function pushInitialPerceptionData(deps: SpriteEventBridgeDeps): void {
  try {
    const snapshot = deps.sprite.getPerceptionSnapshot();
    const presenceSnapshot = deps.sprite.getPresenceSnapshot?.();

    // 强制推送（不检查窗口可见性）：初始化阶段窗口可能还不可见，
    // 但数据需要预送到渲染层缓存，窗口显示时直接展示
    const fullWindow = deps.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      if (snapshot) {
        // 推送初始情感基调
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
          type: 'affectUpdated',
          payload: {
            warmth: snapshot.affect.warmth,
            playfulness: snapshot.affect.playfulness,
            directness: snapshot.affect.directness,
            initiative: snapshot.affect.initiative,
          },
        });

        // 推送初始默契度
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
          type: 'rapportUpdated',
          payload: {
            trust: snapshot.rapport.trust,
            familiarity: snapshot.rapport.familiarity,
            level: snapshot.rapport.level,
            description: snapshot.rapport.description,
          },
        });

        // 推送初始对话上下文
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
          type: 'contextUpdated',
          payload: {
            rhythm: snapshot.context.rhythm,
            coherence: snapshot.context.coherence,
            depth: snapshot.context.depth,
            dominantSource: snapshot.context.dominantSource,
            description: snapshot.context.description,
          },
        });
      }

      // 推送初始在场状态（时序修复：presenceController.start() 后可能不发射初始事件）
      if (presenceSnapshot) {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
          type: 'presenceChanged',
          payload: presenceSnapshot,
        });
      }
    }
  } catch (error) {
    logger.warn({ error: toError(error) }, '[pushInitialPerceptionData] 推送初始感知数据失败');
  }
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
