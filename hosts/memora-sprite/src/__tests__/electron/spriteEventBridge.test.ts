/**
 * SpriteEventBridge 单元测试
 *
 * 覆盖范围：
 * - setupSpriteEventListeners 注册（3 测试）：unsubscribe 先执行 + 8 个事件订阅 + sprite.on 调用次数
 * - proactivePrompt 事件处理（10 测试）：
 *   - 始终执行部分（3 测试）：silent=true 仅 trayManager.setState / silent=false+Notification.isSupported=false 跳过通知 / QC-SPRITE-04 try/catch 保护
 *   - 托盘复位定时器（2 测试）：QC-SPRITE-05 30 秒定时器到期 / 定时器防重
 *   - 系统通知（2 测试）：silent=false+isSupported=true 创建 Notification / silent=true 不创建
 *   - 窗口内提示（2 测试）：窗口可见时发送 IPC / 窗口不可见时 incrementUnreadCount
 *   - 窗口状态检查（1 测试）：窗口已销毁时不调用 isVisible
 * - 7 个简单转发事件（7 测试）：
 *   - memoryNoticed / insightGained / personaChanged / projectSwitched / skillMatched / memoryRecalled / decayCompleted
 *   - 每个事件：窗口可见时发送 IPC + 窗口不可见时不发送
 * - sendSpriteEventIfVisible 可见性检查（3 测试）：可见/最小化/不可见
 * - unsubscribeSpriteEvents（3 测试）：取消订阅 + 数组清空 + 单个 unsubscribe 抛错不影响其他
 *
 * 测试策略：
 * - mock Sprite（on/off/emit 方法使用 vi.fn()）
 * - mock WindowManager（getFullWindow 返回 mock webContents.send）
 * - mock WindowStateManager（transition 方法）
 * - mock TrayManager（setState 方法）
 * - mock electron Notification（vi.mock）
 * - 通过 setLogger 注入 mockLogger（logger 为 getter-only 单例）
 * - 使用 vi.useFakeTimers() 控制时间（30 秒托盘复位定时器）
 * - 类型导入使用 import type
 * - 禁止 @ts-ignore / as any / as unknown as
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupSpriteEventListeners, unsubscribeSpriteEvents, type SpriteEventBridgeDeps } from '../../electron/spriteEventBridge.js';
import type { SpriteEventMap } from '../../sprite/sprite.js';
import { MAIN_TO_RENDERER_CHANNELS } from '../../electron/ipc/channels.js';
import { setLogger } from 'memora';
import type { ILogger } from 'memora';

// ─── Mock Notification（使用 vi.hoisted 确保变量在 vi.mock 工厂中可用）──────────────────────

/**
 * vi.hoisted 与 vi.mock 配合使用：vi.hoisted 创建的变量会被提升到 vi.mock 之前，
 * 使得工厂函数可以访问这些变量。
 */
const { mockNotificationInstances, getIsSupported, setIsSupported } = vi.hoisted(() => {
  const instances: Array<{
    on: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
  }> = [];
  // 使用普通变量
  let isSupported = true;
  return {
    mockNotificationInstances: instances,
    getIsSupported: () => isSupported,
    setIsSupported: (v: boolean) => { isSupported = v; },
  };
});

// 注：setIsSupported / getIsSupported 已从 vi.hoisted 解构，测试中直接调用即可，
// 无需额外包装对象（export const 在测试文件中可能与 vitest ESM 提升顺序冲突）

vi.mock('electron', () => {
  /**
   * Notification mock 构造函数
   */
  const NotificationMock = function(this: unknown) {
    const instance = {
      on: vi.fn(),
      show: vi.fn(),
    };
    mockNotificationInstances.push(instance);
    return instance;
  } as unknown as ReturnType<typeof vi.fn> & { isSupported: () => boolean };

  // isSupported 作为静态方法，调用 getIsSupported() 读取值
  (NotificationMock as { isSupported: () => boolean }).isSupported = () => getIsSupported();

  return { Notification: NotificationMock };
});

// ─── Mock 依赖工厂 ────────────────────────────────────────

/**
 * 创建 Mock Sprite
 *
 * 对齐 Sprite.spriteHandlers 行为：
 * - on() 注册 handler 到内部 Map
 * - off() 从 Map 删除 handler
 * - emit() 触发所有已注册的 handler
 */
function createMockSprite() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  const sprite = {
    on: vi.fn(function(this: unknown, event: string, handler: (...args: unknown[]) => void) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
    }),
    off: vi.fn(function(this: unknown, event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler);
    }),
    emit: (event: string, payload: unknown) => {
      const set = handlers.get(event);
      if (!set) return;
      for (const h of set) {
        h(payload);
      }
    },
  };

  return { sprite, handlers };
}

/**
 * 创建 Mock WindowManager
 *
 * @param visible 窗口是否可见（默认 true）
 * @param minimized 窗口是否最小化（默认 false）
 * @param destroyed 窗口是否已销毁（默认 false）
 */
function createMockWindowManager(visible = true, minimized = false, destroyed = false) {
  const mockWebContents = {
    send: vi.fn(),
  };
  const mockWindow = {
    isVisible: vi.fn(() => visible),
    isMinimized: vi.fn(() => minimized),
    isDestroyed: vi.fn(() => destroyed),
    webContents: mockWebContents,
  };
  return {
    windowManager: {
      getFullWindow: vi.fn(() => (destroyed ? null : mockWindow)),
    },
    mockWindow,
    mockWebContents,
  };
}

/**
 * 创建 Mock WindowStateManager
 */
function createMockWindowStateManager() {
  return {
    windowStateManager: {
      transition: vi.fn(),
    },
  };
}

/**
 * 创建 Mock TrayManager
 */
function createMockTrayManager() {
  return {
    trayManager: {
      setState: vi.fn(),
    },
  };
}

/**
 * 创建 Mock ILogger
 */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * 构建完整的测试依赖对象
 *
 * 所有依赖使用同一组 mocks，确保 emit 触发的是 setupSpriteEventListeners 注册的 handlers。
 */
function createTestDeps(visible = true, minimized = false, destroyed = false) {
  const { sprite } = createMockSprite();
  const { windowManager, mockWindow, mockWebContents } = createMockWindowManager(visible, minimized, destroyed);
  const { windowStateManager } = createMockWindowStateManager();
  const { trayManager } = createMockTrayManager();
  const incrementUnreadCount = vi.fn();

  // deps 对象的 emit 方法直接调用 sprite.emit（触发已注册的 handlers）
  const deps = {
    sprite,
    windowManager: windowManager as SpriteEventBridgeDeps['windowManager'],
    windowStateManager: windowStateManager as SpriteEventBridgeDeps['windowStateManager'],
    trayManager: trayManager as SpriteEventBridgeDeps['trayManager'],
    incrementUnreadCount,
    // emit 方法用于测试时触发事件
    emit: (event: keyof SpriteEventMap, payload: SpriteEventMap[keyof SpriteEventMap]) => {
      sprite.emit(event, payload);
    },
    // 内部引用（供测试断言用）
    _mockWindow: mockWindow,
    _mockWebContents: mockWebContents,
  };

  return deps as typeof deps & { emit: typeof deps.emit };
}

// ─── 测试用例 ────────────────────────────────────────────

describe('SpriteEventBridge', () => {
  let mockLogger: ILogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    setLogger(mockLogger);
    vi.useFakeTimers();
    mockNotificationInstances.length = 0;
    setIsSupported(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ════════════════════════════════════════════════════════
  // 1. setupSpriteEventListeners 注册（3 测试）
  // ════════════════════════════════════════════════════════

  describe('setupSpriteEventListeners 注册', () => {
    it('调用前先执行 unsubscribeSpriteEvents（清空旧订阅，防止 reinitAgent 重复注册）', () => {
      const deps = createTestDeps();
      // 第一次注册
      setupSpriteEventListeners(deps);
      // 第二次注册（模拟 reinitAgent 场景）
      setupSpriteEventListeners(deps);
      // sprite.off 应被调用 8 次（清除旧订阅）
      expect(deps.sprite.off).toHaveBeenCalledTimes(8);
      // sprite.on 应被调用 16 次（每次注册 8 个事件，两次注册）
      expect(deps.sprite.on).toHaveBeenCalledTimes(16);
    });

    it('注册 8 个事件订阅（proactivePrompt + 7 个简单事件）', () => {
      const deps = createTestDeps();
      setupSpriteEventListeners(deps);

      // 验证 8 个事件类型都被订阅
      const calledEvents = deps.sprite.on.mock.calls.map((call: unknown[]) => call[0]);
      expect(calledEvents).toContain('proactivePrompt');
      expect(calledEvents).toContain('memoryNoticed');
      expect(calledEvents).toContain('insightGained');
      expect(calledEvents).toContain('personaChanged');
      expect(calledEvents).toContain('projectSwitched');
      expect(calledEvents).toContain('skillMatched');
      expect(calledEvents).toContain('memoryRecalled');
      expect(calledEvents).toContain('decayCompleted');
      expect(calledEvents).toHaveLength(8);
    });

    it('sprite.on 被调用 8 次（每个事件一次）', () => {
      const deps = createTestDeps();
      setupSpriteEventListeners(deps);
      expect(deps.sprite.on).toHaveBeenCalledTimes(8);
    });
  });

  // ════════════════════════════════════════════════════════
  // 2. proactivePrompt 事件处理（10 测试）
  // ════════════════════════════════════════════════════════

  describe('proactivePrompt 事件处理', () => {
    // ─── 2.1 始终执行部分（3 测试） ────────────────────

    describe('始终执行部分', () => {
      it('silent=true：仅执行 trayManager.setState("active")，不发送通知/IPC', () => {
        const deps = createTestDeps();
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt，silent=true
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: true });

        // trayManager.setState('active') 应被调用
        expect((deps.trayManager as { setState: ReturnType<typeof vi.fn> }).setState).toHaveBeenCalledWith('active');
        // IPC 不应发送（无窗口相关 IPC，silent=true 跳过窗口内提示）
        expect(deps._mockWebContents.send).not.toHaveBeenCalled();
      });

      it('silent=false + Notification.isSupported=false：跳过系统通知，但仍发送窗口内提示', () => {
        setIsSupported(false);
        const deps = createTestDeps();
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt，silent=false
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: false });

        // 窗口可见时 IPC 应被发送（系统通知被跳过，但窗口内提示正常）
        expect(deps._mockWebContents.send).toHaveBeenCalled();
        const sendCall = deps._mockWebContents.send.mock.calls.find(
          (call: unknown[]) => (call[1] as { type?: string })?.type === 'proactivePrompt',
        );
        expect(sendCall).toBeDefined();
      });

      it('QC-SPRITE-04：trayManager.setState 抛错时 logger.warn 记录，不影响后续逻辑', () => {
        const deps = createTestDeps();
        // 让 trayManager.setState 抛出错误
        (deps.trayManager as { setState: ReturnType<typeof vi.fn> }).setState.mockImplementationOnce(() => {
          throw new Error('setState error');
        });
        setupSpriteEventListeners(deps);

        // 不应抛出异常
        expect(() => {
          deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: true });
        }).not.toThrow();
        // logger.warn 应被调用
        expect(mockLogger.warn).toHaveBeenCalled();
      });
    });

    // ─── 2.2 托盘复位定时器（2 测试） ─────────────────

    describe('托盘复位定时器（QC-SPRITE-05）', () => {
      it('proactivePrompt 触发后启动 30 秒定时器，到期后 trayManager.setState("idle")', () => {
        const deps = createTestDeps();
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: true });

        // 30 秒后定时器应将托盘切回 idle
        vi.advanceTimersByTime(30_000);
        expect((deps.trayManager as { setState: ReturnType<typeof vi.fn> }).setState).toHaveBeenLastCalledWith('idle');
      });

      it('30 秒内再次触发 proactivePrompt：clearTimeout 旧定时器 + 启动新定时器', () => {
        const deps = createTestDeps();
        setupSpriteEventListeners(deps);

        // 第一次触发
        deps.emit('proactivePrompt', { prompt: '提示1', triggers: ['memory'], silent: true });

        // 10 秒后再次触发（应清除旧定时器）
        vi.advanceTimersByTime(10_000);
        deps.emit('proactivePrompt', { prompt: '提示2', triggers: ['memory'], silent: true });

        // 40 秒后（从第一次触发开始算 40 秒，从第二次触发开始算 30 秒）
        // 应只有一次 'idle' 调用（第二次触发在 10 秒时清除了旧定时器）
        vi.advanceTimersByTime(30_000);
        const idleCalls = (deps.trayManager as { setState: ReturnType<typeof vi.fn> }).setState.mock.calls.filter(
          (call: unknown[]) => call[0] === 'idle',
        );
        // 第二次触发的 30 秒定时器在 40 秒时到期，只触发一次 idle
        expect(idleCalls).toHaveLength(1);
      });
    });

    // ─── 2.3 系统通知（2 测试） ────────────────────────

    describe('系统通知', () => {
      it('silent=false + Notification.isSupported=true：创建 Notification + show + click 触发 windowStateManager.transition("full")', () => {
        // setIsSupported 已在 beforeEach 设为 true
        const deps = createTestDeps();
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: false });

        // Notification 构造函数应被调用（mockNotificationInstances 应有 1 个实例）
        expect(mockNotificationInstances).toHaveLength(1);
        // show() 应被调用
        expect(mockNotificationInstances[0]!.show).toHaveBeenCalled();
        // click 事件注册
        expect(mockNotificationInstances[0]!.on).toHaveBeenCalledWith('click', expect.any(Function));

        // 模拟 click 事件触发 windowStateManager.transition
        const clickHandler = mockNotificationInstances[0]!.on.mock.calls.find(
          (call: unknown[]) => call[0] === 'click',
        )?.[1] as () => void;
        clickHandler?.();
        expect((deps.windowStateManager as { transition: ReturnType<typeof vi.fn> }).transition).toHaveBeenCalledWith('full');
      });

      it('silent=true：不创建 Notification', () => {
        // setIsSupported 已在 beforeEach 设为 true，但 silent=true 时不需要检查 isSupported
        const deps = createTestDeps();
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt，silent=true
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: true });

        // Notification 不应被实例化
        expect(mockNotificationInstances).toHaveLength(0);
      });
    });

    // ─── 2.4 窗口内提示（2 测试） ─────────────────────

    describe('窗口内提示', () => {
      it('silent=false + 窗口可见：webContents.send(SPRITE_EVENT, {type:"proactivePrompt", payload, silent})', () => {
        const deps = createTestDeps(true, false, false);
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: false });

        // IPC 应被发送
        expect(deps._mockWebContents.send).toHaveBeenCalled();
        const sendCall = deps._mockWebContents.send.mock.calls.find(
          (call: unknown[]) => call[0] === MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT,
        );
        expect(sendCall).toBeDefined();
        expect((sendCall?.[1] as { type: string })?.type).toBe('proactivePrompt');
        expect((sendCall?.[1] as { payload: { prompt: string } })?.payload?.prompt).toBe('测试提示');
      });

      it('silent=false + 窗口不可见：incrementUnreadCount 调用 + 不发送 IPC', () => {
        const deps = createTestDeps(false, false, false);
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: false });

        // incrementUnreadCount 应被调用
        expect(deps.incrementUnreadCount).toHaveBeenCalledTimes(1);
        // IPC 不应被发送（窗口不可见）
        expect(deps._mockWebContents.send).not.toHaveBeenCalled();
      });
    });

    // ─── 2.5 窗口状态检查（1 测试） ───────────────────

    describe('窗口状态检查', () => {
      it('窗口已销毁（isDestroyed=true）：不调用 isVisible + 不发送 IPC', () => {
        const deps = createTestDeps(true, false, true); // visible=true, minimized=false, destroyed=true
        setupSpriteEventListeners(deps);

        // 触发 proactivePrompt
        deps.emit('proactivePrompt', { prompt: '测试提示', triggers: ['memory'], silent: false });

        // isVisible 不应被调用（因为 isDestroyed 检查在前）
        expect(deps._mockWindow.isVisible).not.toHaveBeenCalled();
        // IPC 不应被发送
        expect(deps._mockWebContents.send).not.toHaveBeenCalled();
        // 但 trayManager.setState('active') 仍应执行（始终执行部分不依赖窗口）
        expect((deps.trayManager as { setState: ReturnType<typeof vi.fn> }).setState).toHaveBeenCalledWith('active');
      });
    });
  });

  // ════════════════════════════════════════════════════════
  // 3. 7 个简单转发事件（7 测试）
  // ════════════════════════════════════════════════════════

  describe('7 个简单转发事件', () => {
    const simpleEvents: Array<{
      name: keyof SpriteEventMap;
      payload: SpriteEventMap[keyof SpriteEventMap];
    }> = [
      { name: 'memoryNoticed', payload: { source: 'chat', name: '测试记忆' } },
      { name: 'insightGained', payload: { source: 'chat', insight: '测试洞察' } },
      { name: 'personaChanged', payload: { from: '开发者', to: '设计师' } },
      { name: 'projectSwitched', payload: { from: null, to: 'project-a', projectName: '项目A' } },
      { name: 'skillMatched', payload: { skill: 'typescript', score: 0.95 } },
      { name: 'memoryRecalled', payload: { count: 5, query: '测试查询' } },
      { name: 'decayCompleted', payload: { decayedCount: 3 } },
    ];

    simpleEvents.forEach(({ name, payload }) => {
      it(`${name}：窗口可见时 webContents.send(SPRITE_EVENT, {type, payload, silent:false})`, () => {
        const deps = createTestDeps(true, false, false);
        setupSpriteEventListeners(deps);

        // 触发事件
        deps.emit(name, payload);

        // IPC 应被发送
        expect(deps._mockWebContents.send).toHaveBeenCalled();
        const sendCall = deps._mockWebContents.send.mock.calls.find(
          (call: unknown[]) =>
            call[0] === MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT &&
            (call[1] as { type: string })?.type === name,
        );
        expect(sendCall).toBeDefined();
        expect((sendCall?.[1] as { silent: boolean })?.silent).toBe(false);
      });

      it(`${name}：窗口不可见时不发送 IPC`, () => {
        const deps = createTestDeps(false, false, false);
        setupSpriteEventListeners(deps);

        // 触发事件
        deps.emit(name, payload);

        // IPC 不应被发送
        expect(deps._mockWebContents.send).not.toHaveBeenCalled();
      });
    });
  });

  // ════════════════════════════════════════════════════════
  // 4. sendSpriteEventIfVisible 可见性检查（3 测试）
  // ════════════════════════════════════════════════════════

  describe('sendSpriteEventIfVisible 可见性检查', () => {
    it('窗口可见（isVisible=true && !isMinimized && !isDestroyed）→ 发送 IPC', () => {
      const deps = createTestDeps(true, false, false);
      setupSpriteEventListeners(deps);

      // 触发 memoryNoticed（简单事件，走 sendSpriteEventIfVisible）
      deps.emit('memoryNoticed', { source: 'chat', name: '测试' });

      expect(deps._mockWebContents.send).toHaveBeenCalled();
    });

    it('窗口最小化（isMinimized=true）→ 不发送 IPC（macOS isVisible 可能仍为 true）', () => {
      const deps = createTestDeps(true, true, false); // visible=true, minimized=true
      setupSpriteEventListeners(deps);

      // 触发 memoryNoticed
      deps.emit('memoryNoticed', { source: 'chat', name: '测试' });

      // IPC 不应被发送（isMinimized 检查阻止）
      expect(deps._mockWebContents.send).not.toHaveBeenCalled();
    });

    it('窗口不可见（isVisible=false）→ 不发送 IPC', () => {
      const deps = createTestDeps(false, false, false);
      setupSpriteEventListeners(deps);

      // 触发 memoryNoticed
      deps.emit('memoryNoticed', { source: 'chat', name: '测试' });

      // IPC 不应被发送
      expect(deps._mockWebContents.send).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════
  // 5. unsubscribeSpriteEvents（3 测试）
  // ════════════════════════════════════════════════════════

  describe('unsubscribeSpriteEvents', () => {
    it('调用所有订阅者的 unsubscribe 函数（sprite.off 被调用 8 次）', () => {
      const deps = createTestDeps();
      setupSpriteEventListeners(deps);

      // 取消订阅
      unsubscribeSpriteEvents();

      // sprite.off 应被调用 8 次（每个事件取消一次）
      expect(deps.sprite.off).toHaveBeenCalledTimes(8);
    });

    it('取消订阅后 spriteEventUnsubscribers 数组清空', () => {
      const deps = createTestDeps();
      setupSpriteEventListeners(deps);

      // 取消订阅
      unsubscribeSpriteEvents();

      // 再次取消订阅（应无操作，不报错）
      expect(() => unsubscribeSpriteEvents()).not.toThrow();
      // sprite.off 不应再被调用（数组已清空）
      expect(deps.sprite.off).toHaveBeenCalledTimes(8);
    });

    it('QC-R2-01：某个 unsubscribe 抛错时 logger.warn 记录，不影响其他 unsubscribe 执行', () => {
      const deps = createTestDeps();
      setupSpriteEventListeners(deps);

      // 让 sprite.off 在某些调用时抛出错误
      let offCallCount = 0;
      (deps.sprite.off as ReturnType<typeof vi.fn>).mockImplementation(() => {
        offCallCount++;
        if (offCallCount <= 2) {
          throw new Error('off error');
        }
      });

      // 不应抛出异常
      expect(() => unsubscribeSpriteEvents()).not.toThrow();
      // logger.warn 应被调用（记录错误）
      expect(mockLogger.warn).toHaveBeenCalled();
      // sprite.off 仍被调用 8 次（不因错误而中断）
      expect(offCallCount).toBe(8);
    });
  });
});
