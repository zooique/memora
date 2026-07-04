/**
 * Sprite 主控测试
 *
 * 注意：loadSpriteConfig/saveSpriteConfig 不接受 dataDir 参数，
 * 始终读写 ~/.memora-sprite/sprite.json。测试中 mock 这两个函数，
 * 确保测试隔离于真实文件系统。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent, AgentEventMap } from 'memora';
import { Sprite } from '../../sprite/sprite.js';
import { TriggerBus, TimerTrigger } from '../../sprite/triggers.js';
import { CliInteraction } from '../../sprite/cli/interaction.js';
import type { IInteraction, InputHandler } from '../../sprite/interaction.js';
import type { SpriteTrigger } from '../../sprite/triggers.js';
import { FileWatcherTrigger } from '../../sprite/fileWatcherTrigger.js';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SPRITE_CONFIG, saveSpriteConfig } from '../../sprite/spriteConfig.js';
import type { SpriteConfig } from '../../sprite/spriteConfig.js';
// GAP-6：回收站自动清理测试需要 MS_PER_DAY 计算 30 天阈值
import { MS_PER_DAY } from '../../sprite/constants.js';
// presence 相关 mock 类型（避免内联 import() 类型注解，符合 consistent-type-imports 规则）
import type { PresenceController, IPowerMonitor, IApp } from '../../sprite/controllers/presenceController.js';

// ─── Mock spriteConfig 模块（测试隔离） ──────────────────
// 重构后 loadSpriteConfig/saveSpriteConfig 固定读写 ~/.memora-sprite/sprite.json，
// 测试中必须 mock 以避免污染用户真实配置文件

/** 模拟的持久化配置存储（内存中，替代真实文件） */
let mockPersistedConfig: SpriteConfig = { ...DEFAULT_SPRITE_CONFIG };

vi.mock('../../sprite/spriteConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // 从内存中读取，而非真实文件
    loadSpriteConfig: vi.fn(() => ({ ...DEFAULT_SPRITE_CONFIG, ...mockPersistedConfig })),
    // 写入内存，而非真实文件
    saveSpriteConfig: vi.fn((config: SpriteConfig) => {
      mockPersistedConfig = { ...mockPersistedConfig, ...config };
    }),
  };
});

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
  // Phase 2.1：情感基调注入点
  injectAffect: vi.fn(),
  // ADR-015 归档模式：Sprite 构造时调用 agent.setArchiveMode，mock 需提供方法
  setArchiveMode: vi.fn(),
  // B4：applyProjectMode 调用 agent.switchProject 切换专注项目（异步）
  switchProject: vi.fn().mockResolvedValue(undefined),
  memory: {
    stats: vi.fn().mockReturnValue({ total: 0, bySource: {} }),
    suggest: vi.fn().mockReturnValue([]),
    // Phase 2.1：情感基调推导需要 list 方法获取所有记忆
    list: vi.fn().mockReturnValue([]),
    // GAP-6：回收站自动清理定时器调用 purgeExpired
    purgeExpired: vi.fn().mockReturnValue(0),
    listDeleted: vi.fn().mockReturnValue([]),
    // B1：dashboard() 调用 getAllRelations 统计冲突关系数
    getAllRelations: vi.fn().mockReturnValue([]),
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
    const sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    expect(sprite.getState()).toBe('idle');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should transition to active on wakeup', async () => {
    const tmpDir = createTmpDir();
    const sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    await sprite.wakeup('你好');
    expect(sprite.getState()).toBe('idle');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should start and stop cleanly', () => {
    const tmpDir = createTmpDir();
    const sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();
    sprite.stop();
    expect(sprite.getState()).toBe('idle');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GAP-6 start 时调用 purgeExpiredMemories 清理过期记忆（启动即清理）', () => {
    const tmpDir = createTmpDir();
    // 清理前置测试累积的调用计数（mockAgent 为模块级共享）
    vi.mocked(mockAgent.memory.purgeExpired).mockClear();
    const sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();
    // 启动时立即执行一次清理（retentionDays=30 默认值）
    expect(mockAgent.memory.purgeExpired).toHaveBeenCalledTimes(1);
    // 传入的阈值应为 30 天前
    const threshold = (mockAgent.memory.purgeExpired as ReturnType<typeof vi.fn>).mock.calls[0][0] as Date;
    const expectedThreshold = Date.now() - 30 * MS_PER_DAY;
    // 允许 1 秒误差（测试执行耗时）
    expect(Math.abs(threshold.getTime() - expectedThreshold)).toBeLessThan(1000);
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GAP-6 recycleBinRetentionDays=0 时禁用自动清理（不调用 purgeExpired）', () => {
    const tmpDir = createTmpDir();
    // 通过 updateConfigBatch 设置 retentionDays=0
    const sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.updateConfigBatch({ recycleBinRetentionDays: 0 });
    vi.mocked(mockAgent.memory.purgeExpired).mockClear();
    sprite.start();
    // retentionDays=0 时不应调用 purgeExpired
    expect(mockAgent.memory.purgeExpired).not.toHaveBeenCalled();
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GAP-6 stop 后定时器被清理（reinitAgent 安全）', () => {
    const tmpDir = createTmpDir();
    const sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();
    sprite.stop();
    // 再次 start 不应抛错（定时器已清理，可重复启动）
    expect(() => sprite.start()).not.toThrow();
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── 缺口 I：prepareForChat 公共方法（从 wakeup 抽取） ──────

describe('Sprite prepareForChat（缺口 I：对话前感知刷新）', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    mockAgent.injectAffect = vi.fn();
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prepareForChat(input) 应触发情感基调推导并注入 system prompt', () => {
    // 缺口 I：prepareForChat 是从 wakeup 抽取的公共方法，
    // 负责对话前感知刷新（推导 affect + rapport + context + 注入 prompt）
    sprite.prepareForChat('你好');
    // injectAffect 应被调用（推导后注入 system prompt）
    expect(mockAgent.injectAffect).toHaveBeenCalled();
  });

  it('prepareForChat(undefined) 应安全执行（不抛错，仍推导）', () => {
    expect(() => sprite.prepareForChat(undefined)).not.toThrow();
    expect(mockAgent.injectAffect).toHaveBeenCalled();
  });

  it('prepareForChat(null) 应安全执行（空输入不推入 recentUserMessages）', () => {
    expect(() => sprite.prepareForChat(null)).not.toThrow();
    expect(mockAgent.injectAffect).toHaveBeenCalled();
  });

  it('prepareForChat(空字符串) 应安全执行', () => {
    expect(() => sprite.prepareForChat('')).not.toThrow();
    expect(mockAgent.injectAffect).toHaveBeenCalled();
  });

  it('连续 prepareForChat 应正常工作（多次推导不累积异常）', () => {
    // start() 已触发一次 deriveAndInjectAffect，clear 后仅计 prepareForChat 调用
    vi.mocked(mockAgent.injectAffect).mockClear();
    sprite.prepareForChat('第一条');
    sprite.prepareForChat('第二条');
    sprite.prepareForChat('第三条');
    // 每次 prepareForChat 都应触发推导
    expect(mockAgent.injectAffect).toHaveBeenCalledTimes(3);
  });
});

// ─── 缺口 A：dailyMessageCount 每日消息计数 ────────────────

describe('Sprite dailyMessageCount（缺口 A：每日消息计数）', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('初始状态 getDailyMessageCounts 应返回空对象（无历史数据）', () => {
    const counts = sprite.getDailyMessageCounts();
    expect(Object.keys(counts).length).toBe(0);
  });

  it('incrementDailyMessageCount 后应返回今日计数 1', () => {
    sprite.incrementDailyMessageCount();
    const counts = sprite.getDailyMessageCounts();
    // getLocalDate 使用本地时区日期，toISOString 是 UTC，跨时区时 key 可能不匹配
    // 改为断言 values 包含 1（今日刚 increment 一次）
    expect(Object.values(counts)).toContain(1);
    expect(Object.values(counts).length).toBe(1);
  });

  it('连续 increment 应累加计数', () => {
    sprite.incrementDailyMessageCount();
    sprite.incrementDailyMessageCount();
    sprite.incrementDailyMessageCount();
    const counts = sprite.getDailyMessageCounts();
    // 今日累加 3 次
    expect(Object.values(counts)).toContain(3);
    expect(Object.values(counts).length).toBe(1);
  });

  it('getDailyMessageCounts 应返回可序列化的 Record（供 reviewManager 消费）', () => {
    sprite.incrementDailyMessageCount();
    const counts = sprite.getDailyMessageCounts();
    // 应是普通对象，非 Map
    expect(counts).toBeTypeOf('object');
    expect(counts.constructor).toBe(Object);
    // 值应为数字
    for (const value of Object.values(counts)) {
      expect(typeof value).toBe('number');
    }
  });
});

describe('Sprite 主动行为', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
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
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
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
    const sprite2 = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    expect(sprite2.getConfig().silentMode).toBe(true);
    sprite2.stop();
  });

  it('updateConfig triggerIntervalMs 应重建 TriggerBus', () => {
    sprite.updateConfig('triggerIntervalMs', 1_800_000);
    expect(sprite.getConfig().triggerIntervalMs).toBe(1_800_000);

    // 重新创建 Sprite 应加载持久化的配置
    const sprite2 = new Sprite({ agent: mockAgent, dataDir: tmpDir });
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

// ─── QC-CONFIG-01: updateConfigBatch 事务性测试 ──────────────
describe('Sprite updateConfigBatch（QC-CONFIG-01 事务性）', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('空批量应返回 updated: true 且不触发持久化（幂等）', () => {
    vi.mocked(saveSpriteConfig).mockClear();
    const result = sprite.updateConfigBatch({});
    expect(result.updated).toBe(true);
    expect(result.error).toBeUndefined();
    // 空批量不写盘
    expect(saveSpriteConfig).not.toHaveBeenCalled();
  });

  it('应一次性应用全部字段并单次持久化', () => {
    vi.mocked(saveSpriteConfig).mockClear();
    const result = sprite.updateConfigBatch({
      silentMode: true,
      proactiveThreshold: 5,
      triggerIntervalMs: 1_800_000,
      fileWatcherDebounceMs: 500,
    });
    expect(result.updated).toBe(true);

    const config = sprite.getConfig();
    expect(config.silentMode).toBe(true);
    expect(config.proactiveThreshold).toBe(5);
    expect(config.triggerIntervalMs).toBe(1_800_000);
    expect(config.fileWatcherDebounceMs).toBe(500);

    // 单次持久化（R6：完整配置跳过读文件，仅一次 writeFileSync）
    expect(saveSpriteConfig).toHaveBeenCalledTimes(1);
  });

  it('任一字段类型非法时应事务回滚（config 状态不变）', () => {
    vi.mocked(saveSpriteConfig).mockClear();
    const before = sprite.getConfig();

    // proactiveThreshold 应为 number，传 string 触发校验失败
    const result = sprite.updateConfigBatch({
      silentMode: true,
      proactiveThreshold: 'invalid' as unknown as number,
    });

    expect(result.updated).toBe(false);
    expect(result.error).toContain('proactiveThreshold');

    // 事务回滚：config 状态不变
    const after = sprite.getConfig();
    expect(after.silentMode).toBe(before.silentMode);
    expect(after.proactiveThreshold).toBe(before.proactiveThreshold);

    // 失败时不持久化
    expect(saveSpriteConfig).not.toHaveBeenCalled();
  });

  it('非法配置键应返回错误且不持久化', () => {
    vi.mocked(saveSpriteConfig).mockClear();
    const result = sprite.updateConfigBatch({
      invalidKey: 'value',
    });

    expect(result.updated).toBe(false);
    expect(result.error).toContain('非法配置键');
    expect(saveSpriteConfig).not.toHaveBeenCalled();
  });

  it('副作用去重：多个 fileWatcher 键只触发一次持久化', () => {
    vi.mocked(saveSpriteConfig).mockClear();
    const result = sprite.updateConfigBatch({
      fileWatcherEnabled: false,
      fileWatcherPaths: ['src', 'docs'],
      fileWatcherDebounceMs: 2_000,
      fileWatcherIgnore: ['**/tmp/**'],
    });

    expect(result.updated).toBe(true);
    // 4 个同类副作用键，但只持久化一次（去重）
    expect(saveSpriteConfig).toHaveBeenCalledTimes(1);

    const config = sprite.getConfig();
    expect(config.fileWatcherEnabled).toBe(false);
    expect(config.fileWatcherPaths).toEqual(['src', 'docs']);
    expect(config.fileWatcherDebounceMs).toBe(2_000);
    expect(config.fileWatcherIgnore).toEqual(['**/tmp/**']);
  });

  it('批量更新后重新创建 Sprite 应加载持久化的配置', () => {
    sprite.updateConfigBatch({
      silentMode: true,
      proactiveThreshold: 7,
      triggerIntervalMs: 900_000,
    });

    // 重新创建 Sprite 应从持久化配置加载
    const sprite2 = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    const config = sprite2.getConfig();
    expect(config.silentMode).toBe(true);
    expect(config.proactiveThreshold).toBe(7);
    expect(config.triggerIntervalMs).toBe(900_000);
    sprite2.stop();
  });
});

describe('TriggerBus', () => {
  it('should register and emit trigger events', () => {
    const bus = new TriggerBus();
    const handler = vi.fn();
    bus.on(handler);

    // 注册一个测试触发器
    const testTrigger: SpriteTrigger = {
      name: 'test',
      start(cb) { cb({ reason: '测试触发', source: 'test' }); },
      stop() {},
    };
    bus.register(testTrigger);
    bus.start();

    expect(handler).toHaveBeenCalledWith({ reason: '测试触发', source: 'test' });
    bus.stop();
  });

  it('should start and stop timer trigger', () => {
    const bus = new TriggerBus();
    bus.register(new TimerTrigger());
    bus.start();
    bus.stop();
  });

  it('should accept custom interval via TimerTrigger', () => {
    const bus = new TriggerBus();
    bus.register(new TimerTrigger(500));
    // 无抛错即可，验证构造函数接受参数
    bus.start();
    bus.stop();
  });
});

// ─── IInteraction 桥接测试 ────────────────────────────────

/** Mock 交互层 — 记录输出 */
class MockInteraction implements IInteraction {
  outputs: string[] = [];
  errors: string[] = [];
  private inputHandler: InputHandler | null = null;
  private closeHandlers: Set<() => void> = new Set();

  start(handler: InputHandler): void {
    this.inputHandler = handler;
  }

  output(text: string): void {
    this.outputs.push(text);
  }

  error(text: string): void {
    this.errors.push(text);
  }

  stop(): void {
    this.inputHandler = null;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  /** 模拟用户输入 */
  simulateInput(text: string): void {
    this.inputHandler?.({ text });
  }

  /** 模拟关闭 */
  simulateClose(): void {
    for (const handler of this.closeHandlers) handler();
  }
}

describe('Sprite + IInteraction 桥接', () => {
  let sprite: Sprite;
  let tmpDir: string;
  let interaction: MockInteraction;

  beforeEach(() => {
    agentListeners.clear();
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    tmpDir = createTmpDir();
    interaction = new MockInteraction();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir, projectPath: tmpDir });
    sprite.start();
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('proactivePrompt 应通过 emitSprite 发射事件', () => {
    // ProactiveEngine 通过 emitSprite 发射 proactivePrompt 事件，不调用 interaction.output
    const proactiveEvents: { prompt: string; triggers: string[] }[] = [];
    sprite.on('proactivePrompt', (payload) => {
      proactiveEvents.push(payload);
    });

    // 累积 3 个事件触发 proactivePrompt
    emitAgentEvent('memoryAdded', { id: '1', source: 'insight', name: 'A' });
    emitAgentEvent('memoryAdded', { id: '2', source: 'insight', name: 'B' });
    emitAgentEvent('memoryAdded', { id: '3', source: 'insight', name: 'C' });

    // emitSprite('proactivePrompt') 应被调用
    expect(proactiveEvents.length).toBeGreaterThan(0);
    expect(proactiveEvents[0].prompt).toContain('记忆');
    // interaction.output 不应被调用
    expect(interaction.outputs.length).toBe(0);
  });

  it('ProactiveEngine 应不依赖 interaction 直接发射事件', () => {
    const tmpDir2 = createTmpDir();
    const sprite2 = new Sprite({ agent: mockAgent, dataDir: tmpDir2 });
    // ProactiveEngine 仅通过 emitSprite 发射事件
    sprite2.start();

    // 累积事件，验证 proactivePrompt 事件正常发射（不依赖 interaction）
    const proactiveEvents: { prompt: string }[] = [];
    sprite2.on('proactivePrompt', (payload) => {
      proactiveEvents.push(payload);
    });
    emitAgentEvent('memoryAdded', { id: '1', source: 'insight', name: 'X' });
    emitAgentEvent('memoryAdded', { id: '2', source: 'insight', name: 'Y' });
    emitAgentEvent('memoryAdded', { id: '3', source: 'insight', name: 'Z' });

    expect(proactiveEvents.length).toBeGreaterThan(0);
    sprite2.stop();
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

// ─── CliInteraction 测试 ──────────────────────────────────

describe('CliInteraction', () => {
  it('应实现 IInteraction 接口', () => {
    const cli = new CliInteraction();
    expect(typeof cli.start).toBe('function');
    expect(typeof cli.output).toBe('function');
    expect(typeof cli.error).toBe('function');
    expect(typeof cli.stop).toBe('function');
    expect(typeof cli.onClose).toBe('function');
  });
});

// ─── FileWatcherTrigger 测试 ──────────────────────────────

describe('FileWatcherTrigger', () => {
  it('应实现 SpriteTrigger 接口', () => {
    const trigger = new FileWatcherTrigger({ watchPaths: [createTmpDir()] });
    expect(trigger.name).toBe('fileWatcher');
    expect(typeof trigger.start).toBe('function');
    expect(typeof trigger.stop).toBe('function');
  });

  it('start/stop 生命周期应不抛错', () => {
    const tmpDir2 = createTmpDir();
    const trigger = new FileWatcherTrigger({ watchPaths: [tmpDir2] });
    const cb = vi.fn();

    trigger.start(cb);
    trigger.stop();

    expect(cb).not.toHaveBeenCalled();
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('应接受自定义配置', () => {
    const trigger = new FileWatcherTrigger({
      watchPaths: ['/tmp/test'],
      ignore: ['**/dist/**'],
      debounceMs: 500,
    });
    expect(trigger.name).toBe('fileWatcher');
  });
});

// ─── B1：触发器主路径（handleTrigger + generateSmartSuggestions） ──
//
// 测试目标：覆盖 sprite.ts 的三个 private 方法：
//   - handleTrigger：触发器事件分发（state 守卫 + fileWatcher/timer 分支）
//   - generateSmartSuggestions：基于健康度数据生成智能建议（3 个检测分支 + 异常静默）
//   - tryUpdateWorkProjection：文件变化→作品投影更新（在 B1 中仅覆盖异常安全性）
//
// 测试策略：
//   - 使用 vi.useFakeTimers() 控制 TimerTrigger 的 setInterval
//   - 通过 mockPersistedConfig.triggerIntervalMs 设置短间隔（100ms）
//   - 通过 mockPersistedConfig.proactiveThreshold=1 让单条 notice 即可触发 proactivePrompt
//   - 通过 mock agent.memory.list 返回特定 Memory[] 控制健康度数据
//   - 通过 sprite.on('proactivePrompt') 观察 generateSmartSuggestions 的副作用

describe('Sprite 触发器主路径（B1：handleTrigger + generateSmartSuggestions）', () => {
  let sprite: Sprite;
  let tmpDir: string;
  /** 收集 proactivePrompt 事件，用于验证 generateSmartSuggestions 的副作用 */
  let proactiveEvents: { prompt: string; triggers: string[] }[];
  /** 控制 wakeup 的 chatSync Promise，用于测试 state 守卫 */
  let resolveChatSync: ((value: string) => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    agentListeners.clear();
    // 短间隔 + 低阈值：让 TimerTrigger 100ms 后触发，单条 notice 即可发射 proactivePrompt
    mockPersistedConfig = {
      ...DEFAULT_SPRITE_CONFIG,
      triggerIntervalMs: 100,
      proactiveThreshold: 1,
    };
    // 重置 memory mock 到空数据（默认安全状态）
    vi.mocked(mockAgent.memory.list).mockReturnValue([]);
    vi.mocked(mockAgent.memory.stats).mockReturnValue({ total: 0, bySource: {} });
    // 重置 chatSync 为可控 Promise（用于 state 守卫测试）
    resolveChatSync = null;
    vi.mocked(mockAgent.chatSync).mockImplementation(() =>
      new Promise<string>((resolve) => {
        resolveChatSync = resolve;
      }),
    );
    tmpDir = createTmpDir();
    proactiveEvents = [];
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.on('proactivePrompt', (payload: { prompt: string; triggers: string[] }) => {
      proactiveEvents.push(payload);
    });
    sprite.start();
  });

  afterEach(() => {
    sprite.stop();
    // 如果有未完成的 chatSync Promise，resolve 它避免 Promise 泄漏
    if (resolveChatSync) resolveChatSync('cleanup');
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TimerTrigger 触发时 handleTrigger 正常执行（空记忆库不抛错、不产生建议）', () => {
    // 空数据：generateSmartSuggestions 三个分支都不触发
    expect(() => vi.advanceTimersByTime(110)).not.toThrow();
    expect(proactiveEvents).toHaveLength(0);
  });

  it('state 非 idle 时 handleTrigger 跳过执行（不调用 generateSmartSuggestions）', async () => {
    // 启动 wakeup 让 state='active'（chatSync 不 resolve，state 保持 active）
    const wakeupPromise = sprite.wakeup('test');
    // 确认 state 已变为 active
    expect(sprite.getState()).toBe('active');

    // 触发 TimerTrigger——handleTrigger 应直接 return（state !== 'idle'）
    vi.advanceTimersByTime(110);

    // 无 proactive 事件产生（generateSmartSuggestions 未被调用）
    expect(proactiveEvents).toHaveLength(0);

    // 完成 wakeup 恢复 state=idle
    resolveChatSync!('response');
    await wakeupPromise;
    expect(sprite.getState()).toBe('idle');
  });

  it('generateSmartSuggestions 检测到重复记忆时触发建议', () => {
    // 构造两条同名记忆（DUPLICATE_NAME_THRESHOLD=1，同名 >=2 条即重复）
    const now = new Date().toISOString();
    vi.mocked(mockAgent.memory.list).mockReturnValue([
      { id: '1', name: '重复记忆', source: 'insight', content: '内容A', score: 0.5, createdAt: now } as never,
      { id: '2', name: '重复记忆', source: 'insight', content: '内容B', score: 0.5, createdAt: now } as never,
    ]);

    vi.advanceTimersByTime(110);

    // generateSmartSuggestions 应检测到 dupCount=2 > 0，触发 suggestion → proactivePrompt
    expect(proactiveEvents.length).toBeGreaterThan(0);
    expect(proactiveEvents[0]!.prompt).toContain('重复');
  });

  it('generateSmartSuggestions 检测到过期记忆时触发建议', () => {
    // 构造 6 条过期记忆（staleMemories.length > 5 才触发建议）
    // STALE_AGE_DAYS=30，createdAt 设为 40 天前
    const oldDate = new Date(Date.now() - 40 * MS_PER_DAY).toISOString();
    const staleMemories = Array.from({ length: 6 }, (_, i) => ({
      id: `stale-${i}`,
      name: `过期记忆${i}`,
      source: 'insight',
      content: `这是过期记忆的内容编号${i}`,
      score: 0.5,
      createdAt: oldDate,
    }));
    vi.mocked(mockAgent.memory.list).mockReturnValue(staleMemories as never);

    vi.advanceTimersByTime(110);

    // generateSmartSuggestions 应检测到 staleMemories.length=6 > 5，触发建议
    expect(proactiveEvents.length).toBeGreaterThan(0);
    expect(proactiveEvents[0]!.prompt).toContain('过时');
  });

  it('generateSmartSuggestions 在 profile 缺失时触发建议', () => {
    // 构造 11 条非 profile 记忆（totalMemories > 10 且 bySource['profile'] 缺失）
    const now = new Date().toISOString();
    const noProfileMemories = Array.from({ length: 11 }, (_, i) => ({
      id: `m-${i}`,
      name: `记忆${i}`,
      source: 'insight',
      content: `内容${i}`,
      score: 0.5,
      createdAt: now,
    }));
    vi.mocked(mockAgent.memory.list).mockReturnValue(noProfileMemories as never);
    // dashboard() 调用 stats()，返回 total=11 且 bySource 无 profile
    vi.mocked(mockAgent.memory.stats).mockReturnValue({
      total: 11,
      bySource: { insight: 11 },
    });

    vi.advanceTimersByTime(110);

    // generateSmartSuggestions 应检测到 profileCount=0 && totalMemories=11 > 10，触发建议
    expect(proactiveEvents.length).toBeGreaterThan(0);
    expect(proactiveEvents[0]!.prompt).toContain('画像');
  });

  it('generateSmartSuggestions 在 memory.list 抛错时静默处理（不崩溃、不抛出）', () => {
    // mock memory.list 抛错——generateSmartSuggestions 应 catch 并记录日志，不抛出
    vi.mocked(mockAgent.memory.list).mockImplementation(() => {
      throw new Error('mock: memory.list 失败');
    });

    // handleTrigger 不应抛错（generateSmartSuggestions 的 catch 兜底）
    expect(() => vi.advanceTimersByTime(110)).not.toThrow();
    // 无 proactive 事件产生（异常导致建议未生成）
    expect(proactiveEvents).toHaveLength(0);
  });

  it('handleTrigger 在 generateSmartSuggestions 异常时不影响主流程（异常不重抛）', () => {
    // 同时 mock memory.list 抛错 + memory.stats 抛错，确保多个异常源都不影响 handleTrigger
    vi.mocked(mockAgent.memory.list).mockImplementation(() => {
      throw new Error('mock: list 失败');
    });
    vi.mocked(mockAgent.memory.stats).mockImplementation(() => {
      throw new Error('mock: stats 失败');
    });

    // handleTrigger 应捕获所有异常，不抛出
    expect(() => vi.advanceTimersByTime(110)).not.toThrow();
  });
});

// ─── B2：Agent 事件转发补测（6 个未测事件） ──────────────
//
// 测试目标：覆盖 subscribeAgentEvents 中 6 个未测事件的转发链路：
//   - conflictDetected → conflictDetected（GAP-4 关键功能，不经过 ProactiveEngine）
//   - projectSwitched → projectSwitched（FD-04 专注模式 UI 通知）
//   - skillMatched → skillMatched（技能匹配提示）
//   - memoryRecalled → memoryRecalled（记忆召回提示）
//   - decayCompleted → decayCompleted（衰减完成通知）
//   - sessionForked → sessionForked（会话分叉通知）
//
// 测试策略：
//   - 每个事件验证"emit Agent 事件 → sprite 发射对应事件 + payload 正确"
//   - conflictDetected 额外验证不经过 ProactiveEngine（不触发 proactivePrompt）
//   - skillMatched 额外验证不触发 proactivePrompt（仅 debug 日志）

describe('Sprite Agent 事件转发（B2：6 个未测事件）', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG, proactiveThreshold: 1 };
    vi.mocked(mockAgent.memory.list).mockReturnValue([]);
    vi.mocked(mockAgent.memory.stats).mockReturnValue({ total: 0, bySource: {} });
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('conflictDetected 事件应直接转发（GAP-4：不经过 ProactiveEngine）', () => {
    const conflictEvents: Array<{
      newMemoryId: string; newInsight: string; targetId: string; targetContent: string;
    }> = [];
    sprite.on('conflictDetected', (payload) => conflictEvents.push(payload));

    // 发射 Agent conflictDetected 事件
    emitAgentEvent('conflictDetected', {
      newMemoryId: 'mem-1',
      newInsight: '新洞察内容',
      targetId: 'mem-2',
      targetContent: '冲突目标内容',
    });

    // 验证 sprite 发射了 conflictDetected 事件，payload 完整转发
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0]!.newMemoryId).toBe('mem-1');
    expect(conflictEvents[0]!.newInsight).toBe('新洞察内容');
    expect(conflictEvents[0]!.targetId).toBe('mem-2');
    expect(conflictEvents[0]!.targetContent).toBe('冲突目标内容');
  });

  it('conflictDetected 不触发 proactivePrompt（事实通知，非主动行为）', () => {
    const proactiveEvents: { prompt: string }[] = [];
    sprite.on('proactivePrompt', (payload) => proactiveEvents.push(payload));

    // 连续发射多个 conflictDetected 事件
    for (let i = 0; i < 5; i++) {
      emitAgentEvent('conflictDetected', {
        newMemoryId: `mem-${i}`,
        newInsight: `洞察${i}`,
        targetId: `target-${i}`,
        targetContent: `内容${i}`,
      });
    }

    // conflictDetected 不经过 ProactiveEngine.addNotice，不会累积触发 proactivePrompt
    expect(proactiveEvents).toHaveLength(0);
  });

  it('projectSwitched 事件应转发 from/to/projectName', () => {
    const projectEvents: Array<{ from: string | null; to: string; projectName: string }> = [];
    sprite.on('projectSwitched', (payload) => projectEvents.push(payload));

    emitAgentEvent('projectSwitched', {
      from: '/old/project',
      to: '/new/project',
      projectName: '新项目',
    });

    expect(projectEvents).toHaveLength(1);
    expect(projectEvents[0]!.from).toBe('/old/project');
    expect(projectEvents[0]!.to).toBe('/new/project');
    expect(projectEvents[0]!.projectName).toBe('新项目');
  });

  it('skillMatched 事件应转发 skill/score（不触发 proactivePrompt）', () => {
    const skillEvents: Array<{ skill: string; score: number }> = [];
    sprite.on('skillMatched', (payload) => skillEvents.push(payload));
    const proactiveEvents: { prompt: string }[] = [];
    sprite.on('proactivePrompt', (payload) => proactiveEvents.push(payload));

    emitAgentEvent('skillMatched', { skill: 'code-review', score: 0.85 });

    expect(skillEvents).toHaveLength(1);
    expect(skillEvents[0]!.skill).toBe('code-review');
    expect(skillEvents[0]!.score).toBe(0.85);
    // skillMatched 不调用 proactiveEngine.addNotice，不触发 proactivePrompt
    expect(proactiveEvents).toHaveLength(0);
  });

  it('memoryRecalled 事件应转发 count/query', () => {
    const recallEvents: Array<{ count: number; query: string }> = [];
    sprite.on('memoryRecalled', (payload) => recallEvents.push(payload));

    emitAgentEvent('memoryRecalled', { count: 5, query: '用户问的问题' });

    expect(recallEvents).toHaveLength(1);
    expect(recallEvents[0]!.count).toBe(5);
    expect(recallEvents[0]!.query).toBe('用户问的问题');
  });

  it('decayCompleted 事件应转发 decayedCount', () => {
    const decayEvents: Array<{ decayedCount: number }> = [];
    sprite.on('decayCompleted', (payload) => decayEvents.push(payload));

    emitAgentEvent('decayCompleted', { decayedCount: 12 });

    expect(decayEvents).toHaveLength(1);
    expect(decayEvents[0]!.decayedCount).toBe(12);
  });

  it('sessionForked 事件应转发 from/to/messageCount', () => {
    const forkEvents: Array<{ from: string; to: string; messageCount: number }> = [];
    sprite.on('sessionForked', (payload) => forkEvents.push(payload));

    emitAgentEvent('sessionForked', {
      from: '2026-07-04-main',
      to: '2026-07-04-main-b1',
      messageCount: 15,
    });

    expect(forkEvents).toHaveLength(1);
    expect(forkEvents[0]!.from).toBe('2026-07-04-main');
    expect(forkEvents[0]!.to).toBe('2026-07-04-main-b1');
    expect(forkEvents[0]!.messageCount).toBe(15);
  });
});

// ─── B3：感知面板 + 用户反馈（getPerceptionSnapshot / recordProactiveAccept / recordProactiveReject） ──
//
// 覆盖目标：
//   - getPerceptionSnapshot：UI 感知面板打开时主动拉取的读路径
//     · 无记忆时返回 null（perceptionCoordinator.getSnapshot 返回 null）
//     · 有记忆时返回 5 字段快照（affect/rapport/context/patterns/proactiveStats）
//     · 读路径无副作用（不发射 affectUpdated 事件）
//   - recordProactiveAccept：用户点击"查看"时调用
//     · 触发 proactiveEngine.recordAccept（acceptCount +1）
//     · 触发 perceptionCoordinator.refreshBeforeChat（发射 affectUpdated 事件）
//   - recordProactiveReject：用户点击"稍后"时调用
//     · 触发 proactiveEngine.recordReject（consecutiveRejects +1）
//     · 不触发 refreshBeforeChat（不发射 affectUpdated 事件）

describe('Sprite 感知面板 + 用户反馈（B3：getPerceptionSnapshot / recordProactiveAccept / recordProactiveReject）', () => {
  let sprite: Sprite;
  let tmpDir: string;
  /** 收集 affectUpdated 事件（用于验证 refreshBeforeChat 是否被调用） */
  let affectEvents: unknown[] = [];

  beforeEach(() => {
    agentListeners.clear();
    affectEvents = [];
    // 默认配置即可，无需短间隔（B3 不依赖 TimerTrigger）
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();
    // 订阅 affectUpdated（start 已触发一次 refreshBeforeChat，可能在 memory.list 为空时不发射）
    sprite.on('affectUpdated', (payload) => affectEvents.push(payload));
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getPerceptionSnapshot 在无记忆时返回 null（perceptionCoordinator.getSnapshot 返回 null）', () => {
    // 默认 mockAgent.memory.list 返回 []，getSnapshot 内部检测到空记忆返回 null
    vi.mocked(mockAgent.memory.list).mockReturnValue([]);
    expect(sprite.getPerceptionSnapshot()).toBeNull();
  });

  it('getPerceptionSnapshot 在有记忆时返回完整快照（5 字段：affect/rapport/context/patterns/proactiveStats）', () => {
    // mock 单条记忆，让 getSnapshot 走非 null 路径
    const now = Date.now();
    vi.mocked(mockAgent.memory.list).mockReturnValue([
      { id: '1', name: '测试记忆', source: 'insight', content: '内容', score: 0.5, createdAt: now } as never,
    ]);
    const snapshot = sprite.getPerceptionSnapshot();
    expect(snapshot).not.toBeNull();
    // 验证 5 个字段全部存在
    expect(snapshot).toHaveProperty('affect');
    expect(snapshot).toHaveProperty('rapport');
    expect(snapshot).toHaveProperty('context');
    expect(snapshot).toHaveProperty('patterns');
    expect(snapshot).toHaveProperty('proactiveStats');
    // proactiveStats 应包含接受率等统计字段
    expect(snapshot!.proactiveStats).toHaveProperty('acceptanceRate');
    expect(snapshot!.proactiveStats).toHaveProperty('acceptCount');
    expect(snapshot!.proactiveStats).toHaveProperty('consecutiveRejects');
  });

  it('getPerceptionSnapshot 是读路径，不发射 affectUpdated 事件（无副作用）', () => {
    // mock 单条记忆让 getSnapshot 返回非 null
    const now = Date.now();
    vi.mocked(mockAgent.memory.list).mockReturnValue([
      { id: '1', name: '测试记忆', source: 'insight', content: '内容', score: 0.5, createdAt: now } as never,
    ]);
    // 清空 start 阶段可能累积的 affectUpdated 事件
    affectEvents.length = 0;
    // 调用 getPerceptionSnapshot（读路径，不应发射事件）
    sprite.getPerceptionSnapshot();
    sprite.getPerceptionSnapshot();
    expect(affectEvents).toHaveLength(0);
  });

  it('recordProactiveAccept 触发 refreshBeforeChat（发射 affectUpdated 事件）', () => {
    // mock 单条记忆，让 refreshBeforeChat 能完成推导并发射 affectUpdated
    const now = Date.now();
    vi.mocked(mockAgent.memory.list).mockReturnValue([
      { id: '1', name: '测试记忆', source: 'insight', content: '内容', score: 0.5, createdAt: now } as never,
    ]);
    // 清空 start 阶段累积的事件
    affectEvents.length = 0;
    sprite.recordProactiveAccept();
    // refreshBeforeChat 被调用 → 推导 affect → 发射 affectUpdated
    expect(affectEvents.length).toBeGreaterThan(0);
  });

  it('recordProactiveReject 不触发 refreshBeforeChat（不发射 affectUpdated 事件）', () => {
    // 清空 start 阶段累积的事件
    affectEvents.length = 0;
    sprite.recordProactiveReject();
    // recordReject 只更新 proactiveEngine 计数，不调用 refreshBeforeChat
    expect(affectEvents).toHaveLength(0);
  });

  it('recordProactiveAccept 后 proactiveStats.acceptCount 递增', () => {
    // mock 单条记忆，让 getPerceptionSnapshot 能返回非 null
    const now = Date.now();
    vi.mocked(mockAgent.memory.list).mockReturnValue([
      { id: '1', name: '测试记忆', source: 'insight', content: '内容', score: 0.5, createdAt: now } as never,
    ]);
    const before = sprite.getPerceptionSnapshot()!.proactiveStats.acceptCount;
    sprite.recordProactiveAccept();
    const after = sprite.getPerceptionSnapshot()!.proactiveStats.acceptCount;
    expect(after).toBe(before + 1);
  });

  it('recordProactiveReject 后 proactiveStats.consecutiveRejects 递增', () => {
    // mock 单条记忆，让 getPerceptionSnapshot 能返回非 null
    const now = Date.now();
    vi.mocked(mockAgent.memory.list).mockReturnValue([
      { id: '1', name: '测试记忆', source: 'insight', content: '内容', score: 0.5, createdAt: now } as never,
    ]);
    const before = sprite.getPerceptionSnapshot()!.proactiveStats.consecutiveRejects;
    sprite.recordProactiveReject();
    const after = sprite.getPerceptionSnapshot()!.proactiveStats.consecutiveRejects;
    expect(after).toBe(before + 1);
  });
});

// ─── B4：在场状态 + 项目模式（setPresenceController / bindPresence / applyProjectMode） ──
//
// 覆盖目标：
//   - setPresenceController：注入 PresenceController，running=true 时自动 start
//   - bindPresence：便捷方法，内部创建 PresenceController 并注入
//     · presenceChanged 事件能正常发射（powerMonitor → sprite 事件转发）
//     · sprite.stop() 后 presenceController.stop() 被调用（防泄漏，QC-SPRITE-01）
//   - applyProjectMode（通过 updateConfigBatch 间接触发）：
//     · projectMode='focus' + focusProjectPath 非空 → 调用 agent.switchProject
//     · projectMode='focus' + focusProjectPath 为空 → 不调用（仅 warn）
//     · projectMode='normal' → 不调用

describe('Sprite 在场状态 + 项目模式（B4：setPresenceController / bindPresence / applyProjectMode）', () => {
  let sprite: Sprite;
  let tmpDir: string;

  beforeEach(() => {
    agentListeners.clear();
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG };
    vi.mocked(mockAgent.memory.list).mockReturnValue([]);
    vi.mocked(mockAgent.memory.stats).mockReturnValue({ total: 0, bySource: {} });
    vi.mocked(mockAgent.switchProject).mockClear();
    tmpDir = createTmpDir();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
  });

  afterEach(() => {
    sprite.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setPresenceController 在 Sprite 未启动时不调用 controller.start()（向后兼容）', () => {
    // Sprite 未调用 start()，running=false
    const mockController = { start: vi.fn(), stop: vi.fn() } as unknown as PresenceController;
    sprite.setPresenceController(mockController);
    // 未启动时不应调用 controller.start()
    expect(mockController.start).not.toHaveBeenCalled();
  });

  it('setPresenceController 在 Sprite 已启动时自动调用 controller.start()', () => {
    sprite.start();
    const mockController = { start: vi.fn(), stop: vi.fn() } as unknown as PresenceController;
    sprite.setPresenceController(mockController);
    // 已启动时应自动调用 controller.start()
    expect(mockController.start).toHaveBeenCalledTimes(1);
  });

  it('bindPresence 创建 PresenceController 并转发 presenceChanged 事件', () => {
    sprite.start();
    const presenceEvents: Array<{ state: string; reason: string }> = [];
    sprite.on('presenceChanged', (payload) => presenceEvents.push(payload));

    // 构造 mock IPowerMonitor + IApp，记录注册的 listener 以便手动触发
    const lockScreenListeners: Array<() => void> = [];
    const mockPowerMonitor = {
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'lock-screen') lockScreenListeners.push(listener);
      }),
      removeListener: vi.fn(),
    } as unknown as IPowerMonitor;
    const mockApp = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IApp;

    sprite.bindPresence(mockPowerMonitor, mockApp);

    // 触发 lock-screen 事件，PresenceController 应发射 presenceChanged
    expect(lockScreenListeners.length).toBeGreaterThan(0);
    lockScreenListeners[0]!();
    expect(presenceEvents).toHaveLength(1);
    expect(presenceEvents[0]!.state).toBe('away');
    expect(presenceEvents[0]!.reason).toContain('lock-screen');
  });

  it('bindPresence 注入后 sprite.stop() 调用 presenceController.stop()（防泄漏）', () => {
    sprite.start();
    // 构造 mock IPowerMonitor + IApp，spy removeListener 验证 stop 被调用
    const mockPowerMonitor = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IPowerMonitor;
    const mockApp = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IApp;

    sprite.bindPresence(mockPowerMonitor, mockApp);
    sprite.stop();

    // stop 后应调用 removeListener 取消注册（QC-SPRITE-01 防泄漏）
    // powerMonitor 注册了 4 个事件（lock-screen/suspend/unlock-screen/resume），stop 时全部取消
    expect(mockPowerMonitor.removeListener).toHaveBeenCalled();
    expect(mockApp.removeListener).toHaveBeenCalled();
  });

  it('updateConfigBatch 设置 projectMode=focus + focusProjectPath 时调用 agent.switchProject', async () => {
    // 禁用 fileWatcher 避免 rebuildFileWatcher 副作用
    mockPersistedConfig = { ...DEFAULT_SPRITE_CONFIG, fileWatcherEnabled: false };
    // 重新创建 sprite 使配置生效
    sprite.stop();
    sprite = new Sprite({ agent: mockAgent, dataDir: tmpDir });
    sprite.start();

    sprite.updateConfigBatch({ projectMode: 'focus', focusProjectPath: '/test/project' });

    // switchProject 是异步的，等待 Promise resolve
    await vi.waitFor(() => {
      expect(mockAgent.switchProject).toHaveBeenCalledWith('/test/project');
    });
  });

  it('updateConfigBatch 设置 projectMode=focus 但 focusProjectPath 为空时不调用 agent.switchProject', () => {
    sprite.start();
    // focusProjectPath 默认为 ''（DEFAULT_SPRITE_CONFIG）
    sprite.updateConfigBatch({ projectMode: 'focus' });
    // 同步检查：未设置 focusProjectPath 时不调用 switchProject
    expect(mockAgent.switchProject).not.toHaveBeenCalled();
  });

  it('updateConfigBatch 设置 projectMode=smart 时不调用 agent.switchProject', () => {
    sprite.start();
    // projectMode=smart（非 focus）时 applyProjectMode 直接 return
    sprite.updateConfigBatch({ projectMode: 'smart' });
    expect(mockAgent.switchProject).not.toHaveBeenCalled();
  });
});
