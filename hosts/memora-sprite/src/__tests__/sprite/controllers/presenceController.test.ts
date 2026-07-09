/**
 * PresenceController 单元测试
 *
 * 验证用户离开/回来检测、幂等保护、ProactiveEngine 集成。
 * 通过 mock PowerMonitor 和 App 接口实现纯逻辑测试，不依赖 Electron 运行时。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PresenceController } from '../../../sprite/controllers/presenceController.js';
import type { PresenceChangeEvent, IPowerMonitor, IApp } from '../../../sprite/controllers/presenceController.js';

/** Mock EventEmitter 基类（模拟 Electron 的事件监听 + 取消注册） */
class MockEventEmitter {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  /** 取消注册事件监听器（模拟 Electron removeListener） */
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    const idx = handlers.indexOf(listener);
    if (idx !== -1) {
      handlers.splice(idx, 1);
    }
  }

  /** 触发事件（测试辅助） */
  emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  /** 清除所有监听器 */
  clear(): void {
    this.listeners.clear();
  }

  /** 获取指定事件的监听器数量（测试辅助） */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

/**
 * Mock PowerMonitor 类型（IPowerMonitor + 测试辅助方法）
 *
 * 工厂返回类型显式标注为 IPowerMonitor + 辅助方法，
 * 调用处无需 as any 断言。vi.fn() 的 Mock 类型与重载函数签名不完全兼容，
 * 故工厂内部用 as unknown as 集中断言（比散落的 as any 更安全、更清晰）。
 */
type MockPowerMonitor = IPowerMonitor & {
  emit: (event: string, ...args: unknown[]) => void;
  clear: () => void;
  listenerCount: (event: string) => number;
};

/** Mock PowerMonitor（继承 MockEventEmitter 的事件能力） */
function createMockPowerMonitor(): MockPowerMonitor {
  const emitter = new MockEventEmitter();
  return {
    on: vi.fn(emitter.on.bind(emitter)),
    removeListener: vi.fn(emitter.removeListener.bind(emitter)),
    emit: emitter.emit.bind(emitter),
    clear: emitter.clear.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
  } as unknown as MockPowerMonitor;
}

/**
 * Mock App 类型（IApp + 测试辅助方法）
 *
 * 同 MockPowerMonitor，工厂返回类型显式标注避免调用处 as any。
 */
type MockApp = IApp & {
  emit: (event: string, ...args: unknown[]) => void;
  clear: () => void;
  listenerCount: (event: string) => number;
};

/** Mock App（继承 MockEventEmitter 的事件能力） */
function createMockApp(): MockApp {
  const emitter = new MockEventEmitter();
  return {
    on: vi.fn(emitter.on.bind(emitter)),
    removeListener: vi.fn(emitter.removeListener.bind(emitter)),
    emit: emitter.emit.bind(emitter),
    clear: emitter.clear.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
  } as unknown as MockApp;
}

describe('PresenceController', () => {
  let mockPowerMonitor: ReturnType<typeof createMockPowerMonitor>;
  let mockApp: ReturnType<typeof createMockApp>;
  let emitHandler: ReturnType<typeof vi.fn>;
  let checkPendingHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPowerMonitor = createMockPowerMonitor();
    mockApp = createMockApp();
    emitHandler = vi.fn();
    checkPendingHandler = vi.fn();
  });

  describe('start', () => {
    it('启动后注册 powerMonitor 和 app 事件监听', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );

      controller.start();

      // 验证 powerMonitor 事件注册
      expect(mockPowerMonitor.on).toHaveBeenCalledWith('lock-screen', expect.any(Function));
      expect(mockPowerMonitor.on).toHaveBeenCalledWith('suspend', expect.any(Function));
      expect(mockPowerMonitor.on).toHaveBeenCalledWith('unlock-screen', expect.any(Function));
      expect(mockPowerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function));

      // 验证 app 事件注册
      expect(mockApp.on).toHaveBeenCalledWith('browser-window-blur', expect.any(Function));
      expect(mockApp.on).toHaveBeenCalledWith('browser-window-focus', expect.any(Function));
    });

    it('重复调用 start 不会重复注册（幂等保护）', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );

      controller.start();
      controller.start();

      // 每个事件只注册一次
      expect(mockPowerMonitor.on).toHaveBeenCalledTimes(4);
      expect(mockApp.on).toHaveBeenCalledTimes(2);
    });

    it('stop 后取消注册所有事件监听器（防泄漏）', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );

      controller.start();
      controller.stop();

      // 验证所有 powerMonitor 监听器已取消注册
      expect(mockPowerMonitor.removeListener).toHaveBeenCalledWith('lock-screen', expect.any(Function));
      expect(mockPowerMonitor.removeListener).toHaveBeenCalledWith('suspend', expect.any(Function));
      expect(mockPowerMonitor.removeListener).toHaveBeenCalledWith('unlock-screen', expect.any(Function));
      expect(mockPowerMonitor.removeListener).toHaveBeenCalledWith('resume', expect.any(Function));

      // 验证所有 app 监听器已取消注册
      expect(mockApp.removeListener).toHaveBeenCalledWith('browser-window-blur', expect.any(Function));
      expect(mockApp.removeListener).toHaveBeenCalledWith('browser-window-focus', expect.any(Function));

      // 验证事件不再触发
      mockPowerMonitor.emit('lock-screen');
      expect(controller.getState()).toBe('present'); // 未变为 away
    });

    it('stop 后可重新 start（reinitAgent 场景）', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );

      controller.start();
      controller.stop();
      // 重新 start 应该重新注册监听器
      // 注意：vi.fn 的 mock 在 toHaveBeenCalledTimes 中是累积的，需要 clear
      mockPowerMonitor.on.mockClear();
      mockApp.on.mockClear();
      controller.start();

      expect(mockPowerMonitor.on).toHaveBeenCalledTimes(4);
      expect(mockApp.on).toHaveBeenCalledTimes(2);
    });

    it('未启动时调用 stop 无副作用（幂等保护）', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );

      // 未调用 start 直接调用 stop
      controller.stop();

      expect(mockPowerMonitor.removeListener).not.toHaveBeenCalled();
      expect(mockApp.removeListener).not.toHaveBeenCalled();
    });
  });

  describe('离开检测', () => {
    it('锁屏时状态变为 away', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      mockPowerMonitor.emit('lock-screen');

      expect(controller.getState()).toBe('away');
      expect(controller.getAwaySince()).not.toBeNull();
      expect(emitHandler).toHaveBeenCalledWith('presenceChanged', expect.objectContaining({
        state: 'away',
        reason: 'lock-screen',
      }));
    });

    it('系统挂起时状态变为 away', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      mockPowerMonitor.emit('suspend');

      expect(controller.getState()).toBe('away');
      expect(emitHandler).toHaveBeenCalledWith('presenceChanged', expect.objectContaining({
        state: 'away',
        reason: 'suspend',
      }));
    });

    it('窗口失焦后 debounce 过期才变为 away（避免切窗误触发）', () => {
      vi.useFakeTimers();
      try {
        const controller = new PresenceController(
          mockPowerMonitor,
          mockApp,
          { emit: emitHandler },
        );
        controller.start();

        mockApp.emit('browser-window-blur');

        // debounce 期内仍为 present
        expect(controller.getState()).toBe('present');

        // 推进时间超过 debounce 时长（120s）
        vi.advanceTimersByTime(120_000);

        expect(controller.getState()).toBe('away');
        expect(emitHandler).toHaveBeenCalledWith('presenceChanged', expect.objectContaining({
          state: 'away',
          reason: 'window-blur',
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('窗口失焦 debounce 期内聚焦则取消离开判定', () => {
      vi.useFakeTimers();
      try {
        const controller = new PresenceController(
          mockPowerMonitor,
          mockApp,
          { emit: emitHandler },
        );
        controller.start();

        mockApp.emit('browser-window-blur');
        // debounce 期内，state 仍为 present
        expect(controller.getState()).toBe('present');

        // 聚焦取消离开判定
        mockApp.emit('browser-window-focus');

        // 推进时间超过 debounce 时长，不应变为 away
        vi.advanceTimersByTime(120_000);
        expect(controller.getState()).toBe('present');
      } finally {
        vi.useRealTimers();
      }
    });

    it('已处于 away 状态时重复离开事件不触发（幂等保护）', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      // 第一次离开
      mockPowerMonitor.emit('lock-screen');
      expect(emitHandler).toHaveBeenCalledTimes(1);

      // 第二次离开（不同原因）—— 应被忽略
      mockApp.emit('browser-window-blur');
      expect(emitHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('回来检测', () => {
    it('解锁时状态变为 present 并计算离开时长', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      // 先离开
      mockPowerMonitor.emit('lock-screen');
      const awaySince = controller.getAwaySince();

      // 等待一小段时间后回来
      const fakeNow = awaySince! + 5000;
      const originalNow = Date.now;
      Date.now = () => fakeNow;

      mockPowerMonitor.emit('unlock-screen');

      Date.now = originalNow;

      expect(controller.getState()).toBe('present');
      expect(controller.getAwaySince()).toBeNull();

      // 验证事件包含离开时长
      const call = emitHandler.mock.calls[1];
      const payload = call[1] as PresenceChangeEvent;
      expect(payload.state).toBe('present');
      expect(payload.reason).toBe('unlock-screen');
      expect(payload.awayDurationMs).toBe(5000);
    });

    it('系统恢复时状态变为 present', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      mockPowerMonitor.emit('suspend');
      mockPowerMonitor.emit('resume');

      expect(controller.getState()).toBe('present');
    });

    it('窗口聚焦时状态变为 present', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      mockApp.emit('browser-window-blur');
      mockApp.emit('browser-window-focus');

      expect(controller.getState()).toBe('present');
    });

    it('已处于 present 状态时重复回来事件不触发（幂等保护）', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      // 初始状态为 present，直接触发回来事件应被忽略
      mockPowerMonitor.emit('unlock-screen');

      expect(emitHandler).not.toHaveBeenCalled();
    });
  });

  describe('ProactiveEngine 集成', () => {
    it('用户回来时调用 proactiveEngine.checkPending()', () => {
      const mockProactiveEngine = { checkPending: checkPendingHandler };
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        {
          proactiveEngine: mockProactiveEngine,
          emit: emitHandler,
        },
      );
      controller.start();

      // 离开
      mockPowerMonitor.emit('lock-screen');
      expect(checkPendingHandler).not.toHaveBeenCalled();

      // 回来
      mockPowerMonitor.emit('unlock-screen');
      expect(checkPendingHandler).toHaveBeenCalledTimes(1);
    });

    it('未注入 proactiveEngine 时不报错', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      mockPowerMonitor.emit('lock-screen');
      // 不应抛错
      mockPowerMonitor.emit('unlock-screen');

      expect(controller.getState()).toBe('present');
    });
  });

  describe('事件载荷格式', () => {
    it('离开事件包含 state/timestamp/reason', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      mockPowerMonitor.emit('lock-screen');

      const payload = emitHandler.mock.calls[0][1] as PresenceChangeEvent;
      expect(payload.state).toBe('away');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(payload.reason).toBe('lock-screen');
      expect(payload.awayDurationMs).toBeUndefined();
    });

    it('回来事件包含 state/timestamp/reason/awayDurationMs', () => {
      const controller = new PresenceController(
        mockPowerMonitor,
        mockApp,
        { emit: emitHandler },
      );
      controller.start();

      mockPowerMonitor.emit('lock-screen');
      mockPowerMonitor.emit('unlock-screen');

      const payload = emitHandler.mock.calls[1][1] as PresenceChangeEvent;
      expect(payload.state).toBe('present');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(payload.reason).toBe('unlock-screen');
      expect(typeof payload.awayDurationMs).toBe('number');
    });
  });
});
