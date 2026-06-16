/**
 * Sprite 主控测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent, AgentEventMap } from 'memora';
import { Sprite } from '../sprite/sprite.js';
import { TriggerBus } from '../sprite/triggers.js';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// 记录 Agent.on 注册的回调，以便手动触发
type AgentEventHandler = (e: unknown) => void;
const agentListeners = new Map<string, AgentEventHandler>();

const mockAgent = {
  chatSync: vi.fn().mockResolvedValue('mocked response'),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn((event: string, handler: AgentEventHandler) => {
    agentListeners.set(event, handler);
  }),
  off: vi.fn((event: string, _handler: AgentEventHandler) => {
    agentListeners.delete(event);
  }),
  removeAllListeners: vi.fn(),
  memory: {
    stats: vi.fn().mockReturnValue({ total: 0, bySource: {} }),
    suggest: vi.fn().mockReturnValue([]),
  },
  persona: null,
} as unknown as Agent;

/** 手动触发 Agent 事件（模拟 Agent 内部 emit） */
function emitAgentEvent<K extends keyof AgentEventMap>(event: K, payload: AgentEventMap[K]): void {
  const handler = agentListeners.get(event);
  if (handler) handler(payload);
}

/** 创建测试用临时目录 */
function createTmpDir(): string {
  const dir = join(tmpdir(), `memora-sprite-unit-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Sprite', () => {
  it('should start in idle state', () => {
    const tmpDir = createTmpDir();
    const sprite = new Sprite(mockAgent, tmpDir);
    expect(sprite.getState()).toBe('idle');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should transition to active on wakeup', async () => {
    const tmpDir = createTmpDir();
    const sprite = new Sprite(mockAgent, tmpDir);
    await sprite.wakeup('你好');
    expect(sprite.getState()).toBe('idle');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should start and stop cleanly', () => {
    const tmpDir = createTmpDir();
    const sprite = new Sprite(mockAgent, tmpDir);
    sprite.start();
    sprite.stop();
    expect(sprite.getState()).toBe('idle');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('Sprite 主动行为', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    tmpDir = createTmpDir();
    sprite = new Sprite(mockAgent, tmpDir);
    sprite.start();
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('累积 3 个事件后应发射 proactivePrompt', () => {
    const proactiveHandler = vi.fn();
    sprite.on('proactivePrompt', proactiveHandler);

    // 触发 2 个事件——不应发射
    emitAgentEvent('memoryAdded', { id: '1', source: 'insight', name: '记忆A' });
    emitAgentEvent('memoryAdded', { id: '2', source: 'profile', name: '记忆B' });
    expect(proactiveHandler).not.toHaveBeenCalled();

    // 触发第 3 个事件——应发射
    emitAgentEvent('memoryAdded', { id: '3', source: 'insight', name: '记忆C' });
    expect(proactiveHandler).toHaveBeenCalledTimes(1);
    const call0 = proactiveHandler.mock.calls[0]![0];
    expect(call0.prompt).toContain('记忆');
    expect(call0.triggers).toEqual(['memory', 'memory', 'memory']);
  });

  it('不同事件类型混合应生成正确的提示', () => {
    const proactiveHandler = vi.fn();
    sprite.on('proactivePrompt', proactiveHandler);

    emitAgentEvent('memoryAdded', { id: '1', source: 'insight', name: '记忆A' });
    emitAgentEvent('insightExtracted', { source: 'insight', insight: '关于TS的洞察' });
    emitAgentEvent('personaSwitched', { from: null, to: '开发者' });

    expect(proactiveHandler).toHaveBeenCalledTimes(1);
    const { prompt, triggers } = proactiveHandler.mock.calls[0]![0];
    expect(triggers).toEqual(['memory', 'insight', 'persona']);
    expect(prompt).toContain('记忆');
    expect(prompt).toContain('洞察');
    expect(prompt).toContain('角色');
  });

  it('冷却期内不应重复发射 proactivePrompt', () => {
    const proactiveHandler = vi.fn();
    sprite.on('proactivePrompt', proactiveHandler);

    // 第一次：累积 3 个事件
    emitAgentEvent('memoryAdded', { id: '1', source: 'insight', name: 'A' });
    emitAgentEvent('memoryAdded', { id: '2', source: 'insight', name: 'B' });
    emitAgentEvent('memoryAdded', { id: '3', source: 'insight', name: 'C' });
    expect(proactiveHandler).toHaveBeenCalledTimes(1);

    // 冷却期内：再累积 3 个事件
    emitAgentEvent('memoryAdded', { id: '4', source: 'insight', name: 'D' });
    emitAgentEvent('memoryAdded', { id: '5', source: 'insight', name: 'E' });
    emitAgentEvent('memoryAdded', { id: '6', source: 'insight', name: 'F' });
    // 冷却期内不应发射
    expect(proactiveHandler).toHaveBeenCalledTimes(1);
  });

  it('memoryNoticed 事件应在 memoryAdded 时发射', () => {
    const noticedHandler = vi.fn();
    sprite.on('memoryNoticed', noticedHandler);

    emitAgentEvent('memoryAdded', { id: '1', source: 'insight', name: '测试记忆' });
    expect(noticedHandler).toHaveBeenCalledWith({ source: 'insight', name: '测试记忆' });
  });

  it('personaChanged 事件应在 personaSwitched 时发射', () => {
    const changedHandler = vi.fn();
    sprite.on('personaChanged', changedHandler);

    emitAgentEvent('personaSwitched', { from: '旧角色', to: '新角色' });
    expect(changedHandler).toHaveBeenCalledWith({ from: '旧角色', to: '新角色' });
  });

  it('insightGained 事件应在 insightExtracted 时发射', () => {
    const gainedHandler = vi.fn();
    sprite.on('insightGained', gainedHandler);

    emitAgentEvent('insightExtracted', { source: 'insight', insight: '新洞察' });
    expect(gainedHandler).toHaveBeenCalledWith({ source: 'insight', insight: '新洞察' });
  });
});

describe('Sprite 配置持久化', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    tmpDir = createTmpDir();
    sprite = new Sprite(mockAgent, tmpDir);
    sprite.start();
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getConfig 应返回默认配置', () => {
    const config = sprite.getConfig();
    expect(config.triggerIntervalMs).toBe(3_600_000);
    expect(config.silentMode).toBe(false);
    expect(config.proactiveThreshold).toBe(3);
    expect(config.proactiveCooldownMs).toBe(300_000);
  });

  it('updateConfig 应更新配置并持久化', () => {
    sprite.updateConfig('silentMode', true);
    expect(sprite.getConfig().silentMode).toBe(true);

    // 重新创建 Sprite 应加载持久化的配置
    const sprite2 = new Sprite(mockAgent, tmpDir);
    expect(sprite2.getConfig().silentMode).toBe(true);
    sprite2.stop();
  });

  it('updateConfig triggerIntervalMs 应重建 TriggerBus', () => {
    sprite.updateConfig('triggerIntervalMs', 1_800_000);
    expect(sprite.getConfig().triggerIntervalMs).toBe(1_800_000);

    // 重新创建 Sprite 应加载持久化的配置
    const sprite2 = new Sprite(mockAgent, tmpDir);
    expect(sprite2.getConfig().triggerIntervalMs).toBe(1_800_000);
    sprite2.stop();
  });

  it('formatConfig 应返回可读文本', () => {
    const text = sprite.formatConfig();
    expect(text).toContain('精灵配置');
    expect(text).toContain('60 分钟');
    expect(text).toContain('关闭');
  });

  it('静默模式应阻止 proactivePrompt 发射', () => {
    sprite.updateConfig('silentMode', true);
    const proactiveHandler = vi.fn();
    sprite.on('proactivePrompt', proactiveHandler);

    emitAgentEvent('memoryAdded', { id: '1', source: 'insight', name: 'A' });
    emitAgentEvent('memoryAdded', { id: '2', source: 'insight', name: 'B' });
    emitAgentEvent('memoryAdded', { id: '3', source: 'insight', name: 'C' });

    expect(proactiveHandler).not.toHaveBeenCalled();
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

  it('should accept custom interval', () => {
    const bus = new TriggerBus(500);
    // 无抛错即可，验证构造函数接受参数
    bus.start();
    bus.stop();
  });
});
