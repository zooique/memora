/**
 * triggers.ts 单元测试
 *
 * 覆盖范围：
 * - TimerTrigger：构造、默认/自定义间隔、start/stop 生命周期、回调触发
 * - TriggerBus：注册/注销、on/off 回调、start/stop 生命周期、emit 异常隔离
 *
 * 测试策略（对齐 proactiveEngine.test.ts 范式）：
 * - 使用 vitest fake timers 控制 TimerTrigger 的定时行为
 * - mock SpriteTrigger 接口用于 TriggerBus 的独立测试
 * - 类型导入使用 import type
 * - 禁止 @ts-ignore / as any / as unknown as
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerTrigger, TriggerBus } from '../../sprite/triggers.js';
import type { SpriteTrigger, TriggerPayload } from '../../sprite/triggers.js';
import { logger } from 'memora';
// P2-3：导入 ErrorCode，用于断言错误码（防止回归为裸 Error）
import { ErrorCode } from '../../sprite/errors.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/**
 * 创建 mock SpriteTrigger 实例
 * start/stop 方法均为 vi.fn()，便于验证 TriggerBus 的调用行为
 */
function createMockTrigger(name: string): SpriteTrigger {
  return {
    name,
    start: vi.fn(),
    stop: vi.fn(),
  };
}

// ─── TimerTrigger 测试 ──────────────────────────────────

describe('TimerTrigger', () => {
  // 每个测试后恢复真实计时器，防止 fake timers 泄漏到其他测试
  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 1. 构造（3 测试） ────────────────────────────────

  describe('构造', () => {
    it('默认间隔 = DEFAULT_INTERVAL_MS（3_600_000，即 1 小时）', () => {
      // 静态属性直接验证，不依赖实例
      expect(TimerTrigger.DEFAULT_INTERVAL_MS).toBe(3_600_000);
    });

    it('自定义间隔透传：构造时传入 5000ms，间隔后触发而非默认间隔', () => {
      vi.useFakeTimers();
      const customMs = 5000;
      const trigger = new TimerTrigger(customMs);
      const mockCb = vi.fn();

      trigger.start(mockCb);

      // 推进 4999ms — 未到自定义间隔，回调不应触发
      vi.advanceTimersByTime(4999);
      expect(mockCb).not.toHaveBeenCalled();

      // 再推进 1ms — 到达自定义间隔，回调应触发
      vi.advanceTimersByTime(1);
      expect(mockCb).toHaveBeenCalledTimes(1);

      trigger.stop();
    });

    it('name 属性为 "timer"', () => {
      const trigger = new TimerTrigger();
      expect(trigger.name).toBe('timer');
    });
  });

  // ─── 2. start/stop 生命周期（5 测试） ─────────────────

  describe('start/stop 生命周期', () => {
    it('start() 后推进间隔时间，回调被调用且参数格式正确', () => {
      vi.useFakeTimers();
      const trigger = new TimerTrigger(1000);
      const mockCb = vi.fn();

      trigger.start(mockCb);

      // 首次未到间隔
      expect(mockCb).not.toHaveBeenCalled();

      // 推进 1000ms，定时器触发
      vi.advanceTimersByTime(1000);
      expect(mockCb).toHaveBeenCalledTimes(1);
      // 验证回调参数格式
      expect(mockCb).toHaveBeenCalledWith({
        reason: '定时检查',
        source: 'timer',
      } satisfies TriggerPayload);

      trigger.stop();
    });

    it('start() 后多次推进时间，回调被多次调用（间隔触发）', () => {
      vi.useFakeTimers();
      const trigger = new TimerTrigger(1000);
      const mockCb = vi.fn();

      trigger.start(mockCb);

      // 推进 3 个周期
      vi.advanceTimersByTime(3000);
      expect(mockCb).toHaveBeenCalledTimes(3);

      trigger.stop();
    });

    it('stop() 清理定时器：推进时间后回调不再被调用', () => {
      vi.useFakeTimers();
      const trigger = new TimerTrigger(1000);
      const mockCb = vi.fn();

      trigger.start(mockCb);
      vi.advanceTimersByTime(1000);
      expect(mockCb).toHaveBeenCalledTimes(1);

      // 停止后推进时间
      trigger.stop();
      vi.advanceTimersByTime(5000);
      // 回调次数仍为 1，未增加
      expect(mockCb).toHaveBeenCalledTimes(1);
    });

    it('stop() 后 callback 置为 null：重新 start 时旧回调不干扰', () => {
      vi.useFakeTimers();
      const trigger = new TimerTrigger(1000);
      const mockCbA = vi.fn();
      const mockCbB = vi.fn();

      // 第一次 start + stop
      trigger.start(mockCbA);
      vi.advanceTimersByTime(1000);
      expect(mockCbA).toHaveBeenCalledTimes(1);
      trigger.stop();

      // 第二次 start 使用新回调
      trigger.start(mockCbB);
      vi.advanceTimersByTime(1000);
      // 旧回调不再被调用
      expect(mockCbA).toHaveBeenCalledTimes(1);
      // 新回调正常触发
      expect(mockCbB).toHaveBeenCalledTimes(1);

      trigger.stop();
    });

    it('重复 start() 覆盖前一次（不抛错，新回调生效）', () => {
      vi.useFakeTimers();
      const trigger = new TimerTrigger(1000);
      const mockCbFirst = vi.fn();
      const mockCbSecond = vi.fn();

      // 第一次 start
      trigger.start(mockCbFirst);
      // 第二次 start 覆盖，不抛错
      expect(() => trigger.start(mockCbSecond)).not.toThrow();

      // 推进时间，新回调生效
      vi.advanceTimersByTime(1000);
      expect(mockCbSecond).toHaveBeenCalled();

      trigger.stop();
    });
  });
});

// ─── TriggerBus 测试 ────────────────────────────────────

describe('TriggerBus', () => {
  let bus: TriggerBus;

  beforeEach(() => {
    bus = new TriggerBus();
  });

  // ─── 1. 注册与注销（5 测试） ──────────────────────────

  describe('注册与注销', () => {
    it('register() 注册触发器成功', () => {
      const trigger = createMockTrigger('testTrigger');

      // 注册不抛错
      expect(() => bus.register(trigger)).not.toThrow();
      // 已注册触发器名称列表包含该名称
      expect(bus.registeredTriggers).toContain('testTrigger');
    });

    it('register() 重复注册同名触发器抛错："触发器 "xxx" 已注册"', () => {
      const trigger = createMockTrigger('duplicate');

      bus.register(trigger);
      // P2-3：重复注册应抛出 MemoraError 且携带 VALIDATION_ERROR code（防止回归为裸 Error）
      expect(() => bus.register(trigger)).toThrow(
        expect.objectContaining({
          code: ErrorCode.VALIDATION_ERROR,
          message: '触发器 "duplicate" 已注册',
        }),
      );
    });

    it('unregister() 注销触发器：调用 trigger.stop() 并从内部 Map 移除', () => {
      const trigger = createMockTrigger('toRemove');

      bus.register(trigger);
      bus.unregister('toRemove');

      // 验证 trigger.stop() 被调用
      expect(trigger.stop).toHaveBeenCalledTimes(1);
      // 验证已从注册表中移除
      expect(bus.registeredTriggers).not.toContain('toRemove');
    });

    it('unregister() 不存在的触发器静默返回（不抛错）', () => {
      // 注销不存在的触发器不应抛错
      expect(() => bus.unregister('nonexistent')).not.toThrow();
    });

    it('registeredTriggers 返回已注册触发器名称列表', () => {
      const triggerA = createMockTrigger('triggerA');
      const triggerB = createMockTrigger('triggerB');

      bus.register(triggerA);
      bus.register(triggerB);

      // 名称列表包含所有已注册触发器
      expect(bus.registeredTriggers).toEqual(['triggerA', 'triggerB']);
    });
  });

  // ─── 2. on/off 回调（3 测试） ─────────────────────────

  describe('on/off 回调', () => {
    it('on() 注册 handler', () => {
      const handler = vi.fn();

      bus.on(handler);
      // 注册不抛错，通过后续 emit 测试间接验证 handler 已注册
      expect(() => bus.on(handler)).not.toThrow();
    });

    it('off() 移除 handler：移除后 emit 不再调用该 handler', () => {
      // 注册一个 mock trigger 以触发 emit
      const trigger = createMockTrigger('test');
      bus.register(trigger);
      bus.start();

      const handler = vi.fn();
      bus.on(handler);

      // 捕获 trigger.start 收到的回调
      const startCb = (trigger.start as ReturnType<typeof vi.fn>).mock.calls[0][0] as (payload: TriggerPayload) => void;

      // 移除 handler
      bus.off(handler);

      // 触发 emit
      startCb({ reason: 'test', source: 'test' });
      // handler 不应被调用
      expect(handler).not.toHaveBeenCalled();
    });

    it('同一 handler 重复 on() 不重复注册（Set 去重）', () => {
      // 注册一个 mock trigger 以触发 emit
      const trigger = createMockTrigger('test');
      bus.register(trigger);
      bus.start();

      const handler = vi.fn();
      // 重复注册同一 handler
      bus.on(handler);
      bus.on(handler);
      bus.on(handler);

      // 捕获 trigger.start 收到的回调
      const startCb = (trigger.start as ReturnType<typeof vi.fn>).mock.calls[0][0] as (payload: TriggerPayload) => void;

      // 触发 emit
      startCb({ reason: 'test', source: 'test' });
      // handler 只被调用一次（Set 去重生效）
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 3. start/stop 生命周期（4 测试） ─────────────────

  describe('start/stop 生命周期', () => {
    it('start() 为每个已注册 trigger 调用 trigger.start(cb)', () => {
      const triggerA = createMockTrigger('triggerA');
      const triggerB = createMockTrigger('triggerB');

      bus.register(triggerA);
      bus.register(triggerB);
      bus.start();

      // 每个 trigger 的 start 都被调用
      expect(triggerA.start).toHaveBeenCalledTimes(1);
      expect(triggerB.start).toHaveBeenCalledTimes(1);
      // 传入的回调是函数类型
      const cbArg = (triggerA.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(typeof cbArg).toBe('function');
    });

    it('start() 传递的 cb 调用后触发 emit（handler 收到 payload）', () => {
      const trigger = createMockTrigger('test');
      bus.register(trigger);
      bus.start();

      const handler = vi.fn();
      bus.on(handler);

      // 捕获 trigger.start 收到的回调并手动调用
      const startCb = (trigger.start as ReturnType<typeof vi.fn>).mock.calls[0][0] as (payload: TriggerPayload) => void;
      const payload: TriggerPayload = { reason: '定时检查', source: 'timer' };
      startCb(payload);

      // handler 收到 payload
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('stop() 为每个已注册 trigger 调用 trigger.stop()', () => {
      const triggerA = createMockTrigger('triggerA');
      const triggerB = createMockTrigger('triggerB');

      bus.register(triggerA);
      bus.register(triggerB);
      bus.stop();

      // 每个 trigger 的 stop 都被调用
      expect(triggerA.stop).toHaveBeenCalledTimes(1);
      expect(triggerB.stop).toHaveBeenCalledTimes(1);
    });

    it('stop() 后 handler 不再收到事件（TimerTrigger 集成验证）', () => {
      vi.useFakeTimers();
      // 使用真实 TimerTrigger 进行集成测试
      const timerTrigger = new TimerTrigger(1000);
      bus.register(timerTrigger);
      bus.start();

      const handler = vi.fn();
      bus.on(handler);

      // 推进时间，触发 emit
      vi.advanceTimersByTime(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      // 停止总线
      bus.stop();
      // 推进更多时间，不应再收到事件
      vi.advanceTimersByTime(5000);
      expect(handler).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  // ─── 4. emit 异常隔离（2 测试） ───────────────────────

  describe('emit 异常隔离', () => {
    it('P2-ERR-01：单个 handler 抛异常不中断其他 handler 分发', () => {
      const trigger = createMockTrigger('test');
      bus.register(trigger);
      bus.start();

      const errorMsg = 'handler A 内部错误';
      const handlerA = vi.fn(() => {
        throw new Error(errorMsg);
      });
      const handlerB = vi.fn();

      bus.on(handlerA);
      bus.on(handlerB);

      // 捕获 trigger.start 收到的回调并手动调用
      const startCb = (trigger.start as ReturnType<typeof vi.fn>).mock.calls[0][0] as (payload: TriggerPayload) => void;
      const payload: TriggerPayload = { reason: 'test', source: 'test' };

      // emit 不应因 handlerA 异常而中断
      expect(() => startCb(payload)).not.toThrow();
      // handlerA 被调用并抛异常
      expect(handlerA).toHaveBeenCalledTimes(1);
      // handlerB 仍被正常调用
      expect(handlerB).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledWith(payload);
    });

    it('异常 handler 错误信息通过 logger.error 记录', () => {
      const trigger = createMockTrigger('test');
      bus.register(trigger);
      bus.start();

      const errorMsg = 'handler 内部错误';
      const handler = vi.fn(() => {
        throw new Error(errorMsg);
      });

      bus.on(handler);

      // 监控 logger.error 调用
      const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      // 捕获 trigger.start 收到的回调并手动调用
      const startCb = (trigger.start as ReturnType<typeof vi.fn>).mock.calls[0][0] as (payload: TriggerPayload) => void;
      startCb({ reason: 'test', source: 'test' });

      // logger.error 被调用，且包含错误信息
      expect(loggerErrorSpy).toHaveBeenCalled();
      const firstCallArg = loggerErrorSpy.mock.calls[0]?.[0];
      expect(firstCallArg).toEqual(expect.objectContaining({ err: expect.stringContaining(errorMsg) }));
      expect(loggerErrorSpy.mock.calls[0]?.[1]).toContain('[TriggerBus]');

      loggerErrorSpy.mockRestore();
    });
  });
});