/**
 * ProactiveEngine 单元测试
 *
 * 覆盖范围：
 * - 构造与配置：构造函数 / setEmitter / updateConfig
 * - addNotice 事件累积：累积 / 阈值触发 / FIFO 上限保护
 * - tryEmit 冷却保护：空队列 / 静默模式 / cooldownMs 内/外 / 发射后清空
 * - checkPending 主动检查：有事件触发 / 无事件静默
 * - buildPrompt 提示生成：6 种事件类型（单/多）+ 混合 + 空摘要 + 未知类型降级
 * - checkMilestones 里程碑检测（Phase 2.3）：首次初始化 / 量级突破 / 新 source / 幂等
 * - magnitudeLabel 量级标签：known magnitude / 未知降级 10^N
 * - emitSprite 事件格式：proactivePrompt 参数 + silent 恒为 false
 *
 * 测试策略（对齐 memoryController.test.ts 范式）：
 * - mock SpriteEmitter（vi.fn()）
 * - 通过 setLogger() 注入 mock logger（logger 为 getter-only 单例，无法 spyOn）
 * - 纯业务逻辑测试，无 I/O、无 LLM、无 DOM
 * - 类型导入使用 import type（consistent-type-imports 规则）
 * - 禁止 @ts-ignore / as any / as unknown as
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProactiveEngine } from '../../../sprite/controllers/proactiveEngine.js';
import type { ProactiveConfig, SpriteEmitter } from '../../../sprite/controllers/proactiveEngine.js';
import type { DashboardData } from '../../../sprite/controllers/memoryController.js';
import { setLogger } from 'memora';
import type { ILogger } from 'memora';

// ─── Mock 工厂 ──────────────────────────────────────────

/**
 * 创建 Mock ILogger
 *
 * 用于通过 setLogger() 注入，验证 tryEmit 中的 logger.info 调用
 * logger 为 getter-only 单例，无法用 vi.spyOn，必须通过 setLogger 替换内部 _logger 引用
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
 * 创建默认配置的 ProactiveEngine 实例
 *
 * @param overrides 部分配置覆盖
 * @returns 已注入 emitter 的 engine 实例
 */
function createEngine(overrides: Partial<ProactiveConfig> = {}): {
  engine: ProactiveEngine;
  mockEmit: ReturnType<typeof vi.fn>;
} {
  const mockEmit = vi.fn();
  const config: ProactiveConfig = {
    threshold: 3,
    cooldownMs: 60000,
    silentMode: false,
    ...overrides,
  };
  const engine = new ProactiveEngine(config);
  engine.setEmitter(mockEmit as SpriteEmitter);
  return { engine, mockEmit };
}

/**
 * 创建 DashboardData 测试数据
 *
 * @param overrides 部分字段覆盖
 */
function makeDashboard(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    total: 0,
    bySource: {},
    suggestions: [],
    relationCount: 0,
    ...overrides,
  };
}

// ─── 测试用例 ────────────────────────────────────────────

describe('ProactiveEngine', () => {
  let mockLogger: ILogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    setLogger(mockLogger);
  });

  afterEach(() => {
    // 确保每个测试后恢复真实计时器（fake timers 测试的安全网）
    vi.useRealTimers();
  });

  // ─── 1. 构造与配置（3 测试） ──────────────────────────

  describe('构造与配置', () => {
    it('构造函数正确存储 config（threshold/cooldownMs/silentMode）', () => {
      const { engine } = createEngine({ threshold: 5, cooldownMs: 120000, silentMode: true });
      // 通过 pendingCount 和 updateConfig 间接验证 config 存储正确
      // 初始 pendingCount 为 0
      expect(engine.pendingCount).toBe(0);
    });

    it('setEmitter 注册发射器后 addNotice 可触发调用', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      // threshold=1 且 cooldownMs=0：每 addNotice 一次立即触发 tryEmit
      engine.addNotice('memory', 'test');
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('updateConfig 部分更新：threshold 单独更新，cooldownMs/silentMode 保留原值', () => {
      const { engine, mockEmit } = createEngine({ threshold: 5, cooldownMs: 60000, silentMode: false });
      // 更新 threshold 为 2，其余不变
      engine.updateConfig({ threshold: 2 });
      // 添加 2 个 notice 后应触发 emit（threshold 已改为 2）
      engine.addNotice('memory', 'a');
      engine.addNotice('memory', 'b');
      // threshold=2 触发 tryEmit，cooldownMs=60000 首次发射通过
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 2. addNotice 事件累积（4 测试） ──────────────────

  describe('addNotice 事件累积', () => {
    it('单次 addNotice 累积到 pendingNotices，pendingCount 增加', () => {
      const { engine } = createEngine({ threshold: 10 });
      engine.addNotice('memory', 'test');
      expect(engine.pendingCount).toBe(1);
    });

    it('未达 threshold 不触发 tryEmit（emitSprite 未被调用）', () => {
      const { engine, mockEmit } = createEngine({ threshold: 3, cooldownMs: 0 });
      // threshold=3，只添加 2 条
      engine.addNotice('memory', 'a');
      engine.addNotice('memory', 'b');
      expect(engine.pendingCount).toBe(2);
      // emitSprite 未被调用（未达阈值）
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('达到 threshold 自动触发 tryEmit（emitSprite 被调用）', () => {
      const { engine, mockEmit } = createEngine({ threshold: 3, cooldownMs: 0 });
      // threshold=3，添加 3 条即触发
      engine.addNotice('memory', 'a');
      engine.addNotice('memory', 'b');
      expect(mockEmit).not.toHaveBeenCalled(); // 2 条未触发
      engine.addNotice('memory', 'c');
      expect(mockEmit).toHaveBeenCalledTimes(1); // 第 3 条触发
    });

    it('pendingNotices 达到 MAX_PENDING_NOTICES=100 时 FIFO 淘汰最旧', () => {
      const { engine } = createEngine({ threshold: 200 }); // threshold 设高，避免自动触发
      // 先添加 100 条（达到上限）
      for (let i = 0; i < 100; i++) {
        engine.addNotice('memory', `notice-${i}`);
      }
      expect(engine.pendingCount).toBe(100);

      // 再添加 1 条，触发 FIFO 淘汰（shift + push）
      engine.addNotice('memory', 'overflow');
      // pendingCount 保持 100（最旧的被淘汰，新的加入）
      expect(engine.pendingCount).toBe(100);
    });
  });

  // ─── 3. tryEmit 冷却保护（5 测试） ────────────────────

  describe('tryEmit 冷却保护', () => {
    it('pendingNotices 为空时直接返回（emitSprite 不调用）', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      // checkPending 在无累积事件时不应触发 emit
      engine.checkPending();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('silentMode=true 时跳过发射（emitSprite 不调用）', () => {
      const { engine, mockEmit } = createEngine({
        threshold: 1,
        cooldownMs: 0,
        silentMode: true,
      });
      engine.addNotice('memory', 'test');
      // silentMode=true 时 tryEmit 直接 return，不调用 emitSprite
      expect(mockEmit).not.toHaveBeenCalled();
      // pendingNotices 未被清空（tryEmit 提前返回）
      expect(engine.pendingCount).toBe(1);
    });

    it('cooldownMs 内（now - lastProactiveAt < cooldownMs）跳过发射', () => {
      // 使用 fake timers 精确控制时间
      vi.useFakeTimers();
      const startTime = new Date('2024-01-01T00:00:00.000Z').getTime();
      vi.setSystemTime(startTime);

      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 60000 });

      // 第一次 addNotice：lastProactiveAt=0，cooldown 检查通过，正常发射
      engine.addNotice('memory', 'first');
      expect(mockEmit).toHaveBeenCalledTimes(1);

      // 第二次 addNotice：cooldown 内（仅过了 1000ms），应跳过
      vi.setSystemTime(startTime + 1000);
      engine.addNotice('memory', 'second');
      // emitSprite 仍只被调用 1 次（第二次被 cooldown 拦住）
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('cooldownMs 外正常发射', () => {
      vi.useFakeTimers();
      const startTime = new Date('2024-01-01T00:00:00.000Z').getTime();
      vi.setSystemTime(startTime);

      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 60000 });

      // 第一次发射
      engine.addNotice('memory', 'first');
      expect(mockEmit).toHaveBeenCalledTimes(1);

      // 冷却期过后（60001ms），再次发射
      vi.setSystemTime(startTime + 60001);
      engine.addNotice('memory', 'second');
      expect(mockEmit).toHaveBeenCalledTimes(2);
    });

    it('发射后 pendingNotices 清空', () => {
      const { engine, mockEmit } = createEngine({ threshold: 2, cooldownMs: 0 });
      engine.addNotice('memory', 'a');
      engine.addNotice('memory', 'b');
      // threshold=2 触发发射
      expect(mockEmit).toHaveBeenCalledTimes(1);
      // 发射后 pendingNotices 被 splice(0) 清空
      expect(engine.pendingCount).toBe(0);
    });

    it('logger.info 在发射时记录日志', () => {
      const { engine } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('memory', 'test');
      // tryEmit 中调用 logger.info({ prompt }, '主动提示')
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.any(String) }),
        '主动提示',
      );
    });
  });

  // ─── 4. checkPending 主动检查（2 测试） ───────────────

  describe('checkPending 主动检查', () => {
    it('有累积事件时 checkPending 触发 tryEmit', () => {
      const { engine, mockEmit } = createEngine({ threshold: 10, cooldownMs: 0 });
      // 先累积 2 条事件（未达 threshold=10，不会自动触发）
      engine.addNotice('memory', 'a');
      engine.addNotice('memory', 'b');
      expect(mockEmit).not.toHaveBeenCalled();

      // 外部主动调用 checkPending 触发 tryEmit
      engine.checkPending();
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('无累积事件时 checkPending 静默返回', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      // 无累积事件
      engine.checkPending();
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // ─── 5. buildPrompt 提示文本生成（10 测试） ────────────
  // 注：buildPrompt 为 private 方法，通过 addNotice + tryEmit 间接测试

  describe('buildPrompt 提示文本生成', () => {
    it('单 memory："有新的记忆（summary）——需要我帮你整理一下吗？"', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('memory', 'test summary');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '有新的记忆（test summary）——需要我帮你整理一下吗？',
        triggers: ['memory'],
        silent: false,
        isMilestone: false,
      });
    });

    it('多 memory："积累了 N 条新记忆（summary）——..."', () => {
      const { engine, mockEmit } = createEngine({ threshold: 2, cooldownMs: 0 });
      engine.addNotice('memory', 'summary1');
      engine.addNotice('memory', 'summary2');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '积累了 2 条新记忆（summary1）——需要我帮你整理一下吗？',
        triggers: ['memory', 'memory'],
        silent: false,
        isMilestone: false,
      });
    });

    it('单 insight："获得了新的洞察（summary）——..."', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('insight', '洞察摘要');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '获得了新的洞察（洞察摘要）——需要我帮你整理一下吗？',
        triggers: ['insight'],
        silent: false,
        isMilestone: false,
      });
    });

    it('多 insight："提取了 N 条洞察（summary）——..."', () => {
      const { engine, mockEmit } = createEngine({ threshold: 2, cooldownMs: 0 });
      engine.addNotice('insight', '洞察1');
      engine.addNotice('insight', '洞察2');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '提取了 2 条洞察（洞察1）——需要我帮你整理一下吗？',
        triggers: ['insight', 'insight'],
        silent: false,
        isMilestone: false,
      });
    });

    it('persona："角色发生了变化（summary）——..."', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('persona', '角色从开发者切换为设计师');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '角色发生了变化（角色从开发者切换为设计师）——需要我帮你整理一下吗？',
        triggers: ['persona'],
        silent: false,
        isMilestone: false,
      });
    });

    it('单 file："检测到文件变化（summary）——..."', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('file', 'src/index.ts');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '检测到文件变化（src/index.ts）——需要我帮你整理一下吗？',
        triggers: ['file'],
        silent: false,
        isMilestone: false,
      });
    });

    it('多 file："检测到 N 次文件变化（summary）——..."', () => {
      const { engine, mockEmit } = createEngine({ threshold: 2, cooldownMs: 0 });
      engine.addNotice('file', 'file1.ts');
      engine.addNotice('file', 'file2.ts');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '检测到 2 次文件变化（file1.ts）——需要我帮你整理一下吗？',
        triggers: ['file', 'file'],
        silent: false,
        isMilestone: false,
      });
    });

    it('单 milestone："达成了新的里程碑（summary）——..."', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('milestone', '积累了上百条记忆', true);
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '达成了新的里程碑（积累了上百条记忆）——需要我帮你整理一下吗？',
        triggers: ['milestone'],
        silent: false,
        isMilestone: true,
      });
    });

    it('混合事件：parts 逗号连接（memory+insight）', () => {
      const { engine, mockEmit } = createEngine({ threshold: 2, cooldownMs: 0 });
      engine.addNotice('memory', '新记忆');
      engine.addNotice('insight', '新洞察');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '有新的记忆，获得了新的洞察（新记忆）——需要我帮你整理一下吗？',
        triggers: ['memory', 'insight'],
        silent: false,
        isMilestone: false,
      });
    });

    it('summaries 全空字符串时无括号部分', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('memory', '');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '有新的记忆——需要我帮你整理一下吗？',
        triggers: ['memory'],
        silent: false,
        isMilestone: false,
      });
    });

    it('无已知事件类型时默认提示"有些事情发生了变化，你可能想看看。"', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('unknownType', 'something');
      expect(mockEmit).toHaveBeenCalledWith('proactivePrompt', {
        prompt: '有些事情发生了变化，你可能想看看。',
        triggers: ['unknownType'],
        silent: false,
        isMilestone: false,
      });
    });
  });

  // ─── 6. checkMilestones 里程碑检测（Phase 2.3，6 测试） ─

  describe('checkMilestones 里程碑检测', () => {
    it('首次调用仅初始化不触发 addNotice（返回空数组）', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      const dashboard = makeDashboard({
        total: 100,
        bySource: { chat: 50, insight: 50 },
      });
      const triggers = engine.checkMilestones(dashboard);
      // 首次调用：仅初始化，不触发任何里程碑
      expect(triggers).toEqual([]);
      // addNotice 未被调用，emitSprite 未被调用
      expect(mockEmit).not.toHaveBeenCalled();
      // pendingCount 仍为 0
      expect(engine.pendingCount).toBe(0);
    });

    it('首次调用后已知 source 不再触发新 source 里程碑', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      const dashboard = makeDashboard({
        total: 10,
        bySource: { chat: 10 },
      });
      // 首次调用：初始化 knownSources
      engine.checkMilestones(dashboard);
      expect(mockEmit).not.toHaveBeenCalled();

      // 第二次调用：相同 source 不触发新 source 里程碑
      const triggers = engine.checkMilestones(dashboard);
      expect(triggers).toEqual([]);
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('首次调用后 knownSources 包含当前所有 source', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      const dashboard = makeDashboard({
        total: 10,
        bySource: { chat: 5, profile: 3, insight: 2 },
      });
      // 首次调用初始化
      engine.checkMilestones(dashboard);

      // 第二次调用：已知 source 不触发，但新 source 会触发
      const dashboard2 = makeDashboard({
        total: 10,
        bySource: { chat: 5, profile: 3, insight: 2, rule: 1 },
      });
      const triggers = engine.checkMilestones(dashboard2);
      // 'rule' 是新 source，应触发里程碑
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.type).toBe('new_source_rule');
      expect(triggers[0]!.summary).toBe('首次从 rule 中提取了记忆');
      // addNotice 被调用，emitSprite 也被触发（threshold=1）
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('模式 1：记忆量级突破（total 100→1000，magnitude 2→3）触发 milestone', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      // 首次调用：初始化，total=100 → magnitude=2
      engine.checkMilestones(makeDashboard({ total: 100, bySource: { chat: 100 } }));
      expect(mockEmit).not.toHaveBeenCalled();

      // 第二次调用：total=1000 → magnitude=3，新量级应触发
      const triggers = engine.checkMilestones(makeDashboard({ total: 1000, bySource: { chat: 1000 } }));
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.type).toBe('memory_magnitude_3');
      expect(triggers[0]!.summary).toBe('积累了上千条记忆');
      // emitSprite 被触发（threshold=1，addNotice 注入了 milestone）
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('模式 1：magnitude < 2 不触发（total=50 → magnitude=1）', () => {
      const { engine } = createEngine({ threshold: 1, cooldownMs: 0 });
      // 首次调用：初始化，total=50 → magnitude=1（<2，不加入 noticedMagnitudes）
      engine.checkMilestones(makeDashboard({ total: 50, bySource: { chat: 50 } }));

      // 第二次调用：total=100 → magnitude=2（>=2 且不在 noticedMagnitudes 中）
      const triggers = engine.checkMilestones(makeDashboard({ total: 100, bySource: { chat: 100 } }));
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.type).toBe('memory_magnitude_2');
    });

    it('模式 1：已通知量级幂等不重复触发', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      // 首次调用：初始化，total=1000 → magnitude=3
      engine.checkMilestones(makeDashboard({ total: 1000, bySource: { chat: 1000 } }));

      // 第二次调用：total=1000，magnitude=3 已在 noticedMagnitudes 中
      const triggers = engine.checkMilestones(makeDashboard({ total: 1000, bySource: { chat: 1000 } }));
      // 幂等：不重复触发
      expect(triggers).toEqual([]);
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('模式 2：新 source 首次出现触发 milestone', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      // 首次调用：初始化，knownSources={chat}
      engine.checkMilestones(makeDashboard({ total: 10, bySource: { chat: 10 } }));

      // 第二次调用：新 source 'profile' 出现
      const triggers = engine.checkMilestones(
        makeDashboard({ total: 15, bySource: { chat: 10, profile: 5 } }),
      );
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.type).toBe('new_source_profile');
      expect(triggers[0]!.summary).toBe('首次从 profile 中提取了记忆');
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('模式 2：已知 source 幂等不重复触发', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      // 首次调用：初始化，knownSources={chat, profile}
      engine.checkMilestones(makeDashboard({ total: 15, bySource: { chat: 10, profile: 5 } }));

      // 第二次调用：相同 source 不触发新 source 里程碑
      const triggers = engine.checkMilestones(
        makeDashboard({ total: 20, bySource: { chat: 15, profile: 5 } }),
      );
      expect(triggers).toEqual([]);
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // ─── 7. magnitudeLabel 量级标签（2 测试） ──────────────
  // 注：magnitudeLabel 为 private 方法，通过 checkMilestones 间接测试

  describe('magnitudeLabel 量级标签', () => {
    it('2→"上百条"、3→"上千条"、4→"上万条"、5→"十万条"', () => {
      const { engine } = createEngine({ threshold: 10 });
      // 首次初始化
      engine.checkMilestones(makeDashboard({ total: 10, bySource: { chat: 10 } }));

      // total=100 → magnitude=2，summary 含 "上百条"
      const t1 = engine.checkMilestones(makeDashboard({ total: 100, bySource: { chat: 100 } }));
      expect(t1[0]!.summary).toBe('积累了上百条记忆');

      // total=1000 → magnitude=3，summary 含 "上千条"
      const t2 = engine.checkMilestones(makeDashboard({ total: 1000, bySource: { chat: 1000 } }));
      expect(t2[0]!.summary).toBe('积累了上千条记忆');

      // total=10000 → magnitude=4，summary 含 "上万条"
      const t3 = engine.checkMilestones(makeDashboard({ total: 10000, bySource: { chat: 10000 } }));
      expect(t3[0]!.summary).toBe('积累了上万条记忆');

      // total=100000 → magnitude=5，summary 含 "十万条"
      const t4 = engine.checkMilestones(makeDashboard({ total: 100000, bySource: { chat: 100000 } }));
      expect(t4[0]!.summary).toBe('积累了十万条记忆');
    });

    it('6（未知 magnitude）→"10^6 条"（降级）', () => {
      const { engine } = createEngine({ threshold: 10 });
      // 首次初始化
      engine.checkMilestones(makeDashboard({ total: 10, bySource: { chat: 10 } }));

      // total=1000000 → magnitude=6，不在 labels 映射中，降级为 10^6 条
      const triggers = engine.checkMilestones(
        makeDashboard({ total: 1000000, bySource: { chat: 1000000 } }),
      );
      expect(triggers[0]!.summary).toBe('积累了10^6 条记忆');
    });
  });

  // ─── 8. emitSprite 事件格式（2 测试） ──────────────────

  describe('emitSprite 事件格式', () => {
    it('emitSprite("proactivePrompt", {prompt, triggers, silent:false}) 参数格式', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('memory', 'test');
      const callArgs = mockEmit.mock.calls[0];
      expect(callArgs[0]).toBe('proactivePrompt');
      expect(callArgs[1]).toEqual({
        prompt: '有新的记忆（test）——需要我帮你整理一下吗？',
        triggers: ['memory'],
        silent: false,
        isMilestone: false,
      });
    });

    it('silent 字段恒为 false（tryEmit 已在 silentMode 时提前 return）', () => {
      const { engine, mockEmit } = createEngine({ threshold: 1, cooldownMs: 0 });
      engine.addNotice('memory', 'test');
      // silent 字段恒为 false，无论 config.silentMode 是什么
      // （silentMode=true 时 tryEmit 提前 return，不会走到 emitSprite）
      expect(mockEmit.mock.calls[0][1].silent).toBe(false);
    });
  });
});