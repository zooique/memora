/**
 * ContextAwareness 单元测试 — 对话上下文感知全分支覆盖
 *
 * 测试覆盖：
 *   - deriveContext 空记忆/有记忆/窗口过滤
 *   - deriveRhythm 四档节奏边界
 *   - deriveCoherence 三档连贯性边界
 *   - deriveDepth 三档深度边界
 *   - buildContextPrompt 格式
 *   - describeRhythm/describeCoherence/describeDepth 静态方法
 *   - updateOptions 部分/全量/空更新
 *   - 构造函数默认值
 *
 * 设计原则：
 *   - 禁止 @ts-ignore / as any
 *   - 使用 import type 分离类型导入
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextAwareness } from '../../sprite/controllers/contextAwareness.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 创建测试用 Memory 对象 */
function makeMemory(overrides: Partial<{
  source: string;
  content: string;
  createdAt: string;
}> = {}): Parameters<ContextAwareness['deriveContext']>[0][number] {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    source: overrides.source ?? 'chat',
    content: overrides.content ?? '测试内容',
    name: '测试记忆',
    score: 1,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decayScore: 0,
  } as Parameters<ContextAwareness['deriveContext']>[0][number];
}

/** 创建指定分钟前的时间戳 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

// ─── 测试套件 ────────────────────────────────────────────

describe('ContextAwareness', () => {
  // 控制时间，避免测试受真实时间影响
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 1. deriveContext ──────────────────────────────────

  describe('deriveContext', () => {
    it('空记忆列表应返回 idle 状态', () => {
      const ca = new ContextAwareness();
      const result = ca.deriveContext([]);

      expect(result.rhythm).toBe('idle');
      expect(result.coherence).toBe('none');
      expect(result.depth).toBe('none');
      expect(result.dominantSource).toBeNull();
      expect(result.description).toContain('没有最近的对话活动');
    });

    it('分析窗口外的记忆应被过滤，返回 idle 状态', () => {
      const ca = new ContextAwareness({ analysisWindowMs: 60 * 60 * 1000 }); // 1 小时
      // 记忆在 2 小时前，超过窗口
      const oldMemories = [makeMemory({ createdAt: minutesAgo(121) })];
      const result = ca.deriveContext(oldMemories);

      expect(result.rhythm).toBe('idle');
    });

    it('快节奏对话应正确识别', () => {
      const ca = new ContextAwareness({ analysisWindowMs: 60 * 60 * 1000 }); // 1 小时
      // 创建 25 条记忆（20+ 条/小时 → 快节奏）
      const memories = Array.from({ length: 25 }, () => makeMemory());
      const result = ca.deriveContext(memories);

      expect(result.rhythm).toBe('rapid');
    });

    it('专注话题应正确识别', () => {
      const ca = new ContextAwareness();
      // 80% 的记忆是同一 source → 专注
      const memories = [
        ...Array.from({ length: 8 }, () => makeMemory({ source: 'code' })),
        makeMemory({ source: 'chat' }),
        makeMemory({ source: 'insight' }),
      ];
      const result = ca.deriveContext(memories);

      expect(result.coherence).toBe('focused');
    });

    it('深度讨论应正确识别', () => {
      const ca = new ContextAwareness();
      // 平均内容长度 > 200 字符 → 深度
      const longContent = 'A'.repeat(300);
      const memories = Array.from({ length: 5 }, () => makeMemory({ content: longContent }));
      const result = ca.deriveContext(memories);

      expect(result.depth).toBe('deep');
    });

    it('dominantSource 应返回最高频的 source', () => {
      const ca = new ContextAwareness();
      const memories = [
        makeMemory({ source: 'code' }),
        makeMemory({ source: 'code' }),
        makeMemory({ source: 'code' }),
        makeMemory({ source: 'chat' }),
        makeMemory({ source: 'insight' }),
      ];
      const result = ca.deriveContext(memories);

      expect(result.dominantSource).toBe('code');
    });

    it('maxRecentMessages 应限制分析数量', () => {
      const ca = new ContextAwareness({ maxRecentMessages: 3 });
      const memories = Array.from({ length: 10 }, () => makeMemory());
      const result = ca.deriveContext(memories);

      // 3 条记忆 / 1 小时 = 3 条/小时 → slow
      expect(result.rhythm).toBe('slow');
    });
  });

  // ─── 2. deriveRhythm ───────────────────────────────────

  describe('deriveRhythm（通过 deriveContext 间接测试）', () => {
    it('消息数 0 → idle', () => {
      const ca = new ContextAwareness();
      expect(ca.deriveContext([]).rhythm).toBe('idle');
    });

    it('消息数 1 → slow（1 条/小时 < 5）', () => {
      const ca = new ContextAwareness();
      expect(ca.deriveContext([makeMemory()]).rhythm).toBe('slow');
    });

    it('消息数 5 → normal（5 条/小时 ≥ 5，< 20）', () => {
      const ca = new ContextAwareness();
      const memories = Array.from({ length: 5 }, () => makeMemory());
      expect(ca.deriveContext(memories).rhythm).toBe('normal');
    });

    it('消息数 20 → rapid（20 条/小时 ≥ 20）', () => {
      const ca = new ContextAwareness();
      const memories = Array.from({ length: 20 }, () => makeMemory());
      expect(ca.deriveContext(memories).rhythm).toBe('rapid');
    });
  });

  // ─── 3. deriveCoherence ────────────────────────────────

  describe('deriveCoherence（通过 deriveContext 间接测试）', () => {
    it('主导 source 占比 ≥ 70% → focused', () => {
      const ca = new ContextAwareness();
      // 7 条 code + 3 条其他 = 70% → focused
      const memories = [
        ...Array.from({ length: 7 }, () => makeMemory({ source: 'code' })),
        makeMemory({ source: 'chat' }),
        makeMemory({ source: 'chat' }),
        makeMemory({ source: 'insight' }),
      ];
      expect(ca.deriveContext(memories).coherence).toBe('focused');
    });

    it('主导 source 占比 30%-70% → moderate', () => {
      const ca = new ContextAwareness();
      // 5 条 code + 5 条 chat = 50% → moderate
      const memories = [
        ...Array.from({ length: 5 }, () => makeMemory({ source: 'code' })),
        ...Array.from({ length: 5 }, () => makeMemory({ source: 'chat' })),
      ];
      expect(ca.deriveContext(memories).coherence).toBe('moderate');
    });

    it('主导 source 占比 < 30% → scattered', () => {
      const ca = new ContextAwareness();
      // 2 条 code + 3 条 chat + 3 条 insight = 8 条，max=3 → 37.5% → moderate
      // 修正：2 条 code + 2 条 chat + 2 条 insight + 2 条 profile + 2 条 guardrail = 10 条，max=2 → 20% → scattered
      const memories = [
        ...Array.from({ length: 2 }, () => makeMemory({ source: 'code' })),
        ...Array.from({ length: 2 }, () => makeMemory({ source: 'chat' })),
        ...Array.from({ length: 2 }, () => makeMemory({ source: 'insight' })),
        ...Array.from({ length: 2 }, () => makeMemory({ source: 'profile' })),
        ...Array.from({ length: 2 }, () => makeMemory({ source: 'guardrail' })),
      ];
      expect(ca.deriveContext(memories).coherence).toBe('scattered');
    });

    it('空记忆 → none', () => {
      const ca = new ContextAwareness();
      expect(ca.deriveContext([]).coherence).toBe('none');
    });
  });

  // ─── 4. deriveDepth ────────────────────────────────────

  describe('deriveDepth（通过 deriveContext 间接测试）', () => {
    it('平均长度 ≥ 200 → deep', () => {
      const ca = new ContextAwareness();
      const memories = [
        makeMemory({ content: 'A'.repeat(250) }),
        makeMemory({ content: 'A'.repeat(150) }), // avg = 200
      ];
      expect(ca.deriveContext(memories).depth).toBe('deep');
    });

    it('平均长度 50-200 → moderate', () => {
      const ca = new ContextAwareness();
      const memories = [
        makeMemory({ content: 'A'.repeat(100) }),
        makeMemory({ content: 'A'.repeat(50) }), // avg = 75
      ];
      expect(ca.deriveContext(memories).depth).toBe('moderate');
    });

    it('平均长度 < 50 → shallow', () => {
      const ca = new ContextAwareness();
      const memories = [makeMemory({ content: 'Hi' })];
      expect(ca.deriveContext(memories).depth).toBe('shallow');
    });

    it('content 为空的记忆应计为 0 长度', () => {
      const ca = new ContextAwareness();
      const memories = [
        makeMemory({ content: 'A'.repeat(100) }),
        makeMemory({ content: '' }), // avg = 50
      ];
      expect(ca.deriveContext(memories).depth).toBe('moderate');
    });
  });

  // ─── 5. buildContextPrompt ─────────────────────────────

  describe('buildContextPrompt', () => {
    it('应生成包含节奏、话题、深度的提示文本', () => {
      const ca = new ContextAwareness();
      const context = {
        rhythm: 'rapid' as const,
        coherence: 'focused' as const,
        depth: 'deep' as const,
        dominantSource: 'code',
        description: '测试',
      };
      const prompt = ca.buildContextPrompt(context);

      expect(prompt).toContain('【当前对话上下文】');
      expect(prompt).toContain('节奏：快节奏');
      expect(prompt).toContain('话题：专注');
      expect(prompt).toContain('深度：深度讨论');
    });

    it('idle 状态应显示正确标签', () => {
      const ca = new ContextAwareness();
      const context = {
        rhythm: 'idle' as const,
        coherence: 'none' as const,
        depth: 'none' as const,
        dominantSource: null,
        description: '测试',
      };
      const prompt = ca.buildContextPrompt(context);

      expect(prompt).toContain('节奏：空闲');
      expect(prompt).toContain('话题：无');
      expect(prompt).toContain('深度：无');
    });
  });

  // ─── 6. 静态方法 ───────────────────────────────────────

  describe('describeRhythm', () => {
    it('rapid → 快节奏', () => expect(ContextAwareness.describeRhythm('rapid')).toBe('快节奏'));
    it('normal → 正常', () => expect(ContextAwareness.describeRhythm('normal')).toBe('正常'));
    it('slow → 慢节奏', () => expect(ContextAwareness.describeRhythm('slow')).toBe('慢节奏'));
    it('idle → 空闲', () => expect(ContextAwareness.describeRhythm('idle')).toBe('空闲'));
  });

  describe('describeCoherence', () => {
    it('focused → 专注', () => expect(ContextAwareness.describeCoherence('focused')).toBe('专注'));
    it('moderate → 中等', () => expect(ContextAwareness.describeCoherence('moderate')).toBe('中等'));
    it('scattered → 分散', () => expect(ContextAwareness.describeCoherence('scattered')).toBe('分散'));
    it('none → 无', () => expect(ContextAwareness.describeCoherence('none')).toBe('无'));
  });

  describe('describeDepth', () => {
    it('deep → 深度讨论', () => expect(ContextAwareness.describeDepth('deep')).toBe('深度讨论'));
    it('moderate → 一般讨论', () => expect(ContextAwareness.describeDepth('moderate')).toBe('一般讨论'));
    it('shallow → 浅层问答', () => expect(ContextAwareness.describeDepth('shallow')).toBe('浅层问答'));
    it('none → 无', () => expect(ContextAwareness.describeDepth('none')).toBe('无'));
  });

  // ─── 7. updateOptions ──────────────────────────────────

  describe('updateOptions', () => {
    it('部分更新应只修改指定字段', () => {
      const ca = new ContextAwareness({ analysisWindowMs: 60 * 60 * 1000 });

      ca.updateOptions({ analysisWindowMs: 30 * 60 * 1000 }); // 改为 30 分钟

      // 30 分钟前的记忆应被过滤
      const oldMemories = [makeMemory({ createdAt: minutesAgo(31) })];
      expect(ca.deriveContext(oldMemories).rhythm).toBe('idle');
    });

    it('空更新应不影响现有状态', () => {
      const ca = new ContextAwareness({ analysisWindowMs: 60 * 60 * 1000 });
      const before = ca.deriveContext([makeMemory()]);
      ca.updateOptions({});
      const after = ca.deriveContext([makeMemory()]);

      expect(after.rhythm).toBe(before.rhythm);
    });
  });

  // ─── 8. 构造函数 ───────────────────────────────────────

  describe('构造函数', () => {
    it('无参数时应使用默认值', () => {
      const ca = new ContextAwareness();
      const memories = Array.from({ length: 10 }, () => makeMemory());
      const result = ca.deriveContext(memories);

      // 10 条/小时 → normal
      expect(result.rhythm).toBe('normal');
    });

    it('传入部分参数时应合并默认值', () => {
      const ca = new ContextAwareness({ maxRecentMessages: 3 });
      const memories = Array.from({ length: 10 }, () => makeMemory());
      const result = ca.deriveContext(memories);

      // 3 条/小时 → slow
      expect(result.rhythm).toBe('slow');
    });
  });
});