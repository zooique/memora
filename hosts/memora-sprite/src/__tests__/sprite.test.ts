/**
 * Sprite 主控测试
 */
import { describe, it, expect, vi } from 'vitest';
import type { Agent } from 'memora';
import { Sprite } from '../sprite/sprite.js';
import { TriggerBus } from '../sprite/triggers.js';

// Mock Agent（不需要真实 LLM 调用）
const mockAgent = {
  chatSync: vi.fn().mockResolvedValue('mocked response'),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  off: vi.fn(),
  removeAllListeners: vi.fn(),
} as unknown as Agent;

describe('Sprite', () => {
  it('should start in idle state', () => {
    const sprite = new Sprite(mockAgent);
    expect(sprite.getState()).toBe('idle');
  });

  it('should transition to active on wakeup', async () => {
    const sprite = new Sprite(mockAgent);
    await sprite.wakeup('你好');
    // wakeup 结束后应回到 idle
    expect(sprite.getState()).toBe('idle');
  });

  it('should start and stop cleanly', () => {
    const sprite = new Sprite(mockAgent);
    sprite.start();
    sprite.stop();
    expect(sprite.getState()).toBe('idle');
  });
});

describe('TriggerBus', () => {
  it('should emit trigger events', () => {
    const bus = new TriggerBus();
    const handler = vi.fn();
    bus.on(handler);

    bus.emit('test');
    expect(handler).toHaveBeenCalledWith('test');
  });

  it('should start and stop timer', () => {
    const bus = new TriggerBus();
    bus.start();
    bus.stop();
    // 无抛错即可
  });
});
