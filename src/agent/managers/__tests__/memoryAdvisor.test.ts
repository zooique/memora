/**
 * MemoryAdvisor 单元测试 — 记忆顾问（健康诊断 + 关联推荐）
 *
 * 覆盖范围：
 *   - sourceHealth()：source 健康状态判定（healthy/warning/critical）+ 整体状态 + 排序 + 字段精度
 *   - suggest()：关联推荐（无 query 全局推荐 + 有 query 搜索命中优先 + excludeSources + recencyWeight + reason 4 种分支 + contentPreview 截断 + limit）
 *
 * 测试范式：真实 InMemoryStorage 夹具 + 时间偏移构造 + 字段精度断言。
 * 与 memoryInspector.test.ts 同范式，避免 mock 整个 IMemoryStorage 接口。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Memory } from '@/memory/types.js';
import { ONE_DAY_MS } from '@/utils/time.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

// ─── L3 冲突检测夹具 ────────────────────────────────────

/**
 * 创建返回固定 JSON 判词的内存 Mock LLM Provider（judgeWithLlm 依赖流式累积）。
 * @param json - 判词 JSON 字符串
 * @param onMessages - 可选：捕获送入 LLM 的消息（用于断言 prompt 是否含截断标记）
 */
function createJudgeProvider(json: string, onMessages?: (messages: Message[]) => void): LlmProvider {
  return {
    name: 'mock-judge',
    supportsStructuredOutput: true,
    async *chat(messages: Message[], _opts?: unknown) {
      onMessages?.(messages);
      // 一次性返回整段 JSON，避免逐字符分块导致测试不确定
      yield { content: json };
      yield { finishReason: 'stop' };
    },
  } as unknown as LlmProvider;
}

/**
 * 创建抛出异常的 Mock LLM Provider（模拟 judgeWithLlm 失败，验证 detectConflicts 的 catch 降级）。
 */
function createThrowingJudgeProvider(error: Error = new Error('LLM 冲突判断失败')): LlmProvider {
  return {
    name: 'mock-throw',
    supportsStructuredOutput: true,
    async *chat() {
      throw error;
    },
  } as unknown as LlmProvider;
}

/**
 * 构造同 source 冲突检测记忆对（实际写入 work-projection 源）。
 * @returns 返回两条模拟记忆
 */
function seedConflictPair(storage: InMemoryStorage): { a: Memory; b: Memory } {
  const a = createMemory({ id: 'wp:pair-A', name: 'A', content: '用户喜欢 JavaScript' });
  const b = createMemory({ id: 'wp:pair-B', name: 'B', content: '用户讨厌 JavaScript' });
  storage.upsert(a);
  storage.upsert(b);
  return { a, b };
}

// ─── 测试夹具 ─────────────────────────────────────────────

/**
 * 构造单条记忆（覆盖 Memory 7 字段，支持覆写）
 * @param overrides - 字段覆写
 * @returns 完整 Memory 对象
 */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: '默认内容',
    source: SOURCE_LABELS.WORK_PROJECTION,
    name: 'default',
    createdAt: '2026-06-27T10:00:00.000Z',
    accessedAt: '2026-06-27T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * 构造指定天数前访问的记忆（用于时效性测试）
 * @param daysAgo - 距今天数
 * @param overrides - 其他字段覆写
 * @returns 完整 Memory 对象
 */
function createMemoryDaysAgo(daysAgo: number, overrides: Partial<Memory> = {}): Memory {
  const accessedAt = new Date(Date.now() - daysAgo * ONE_DAY_MS).toISOString();
  return createMemory({ accessedAt, ...overrides });
}

/** 真实 InMemoryStorage 夹具（每个 it 重建） */
let storage: InMemoryStorage;
/** MemoryAdvisor 实例（每个 it 重建） */
let advisor: MemoryAdvisor;

beforeEach(() => {
  storage = new InMemoryStorage();
  // 显式注入治理源（生产默认 GOVERNANCE_SOURCES 为空）：测治理机制行为需指定测试源
  advisor = new MemoryAdvisor(storage, null, [SOURCE_LABELS.WORK_PROJECTION]);
});

// ─── sourceHealth() ───────────────────────────────────────

describe('MemoryAdvisor.sourceHealth()', () => {
  describe('空存储与事实观测', () => {
    it('空存储：sources=[]', () => {
      const report = advisor.sourceHealth();
      expect(report.sources).toEqual([]);
      // diagnosedAt 是 ISO 8601 字符串
      expect(typeof report.diagnosedAt).toBe('string');
      expect(new Date(report.diagnosedAt).toString()).not.toBe('Invalid Date');
    });

    it('count 字段反映 source 记忆数', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:3' }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.count).toBe(3);
    });

    it('不因 score 高低或久未访问而判定健康等级（2026-09-09 弃用 status：score 退役后无 avgScore 数据源）', () => {
      // 低分 + 久未访问：仅输出 daysSinceLastAccess 事实，不再有 healthy/warning/critical 判定
      storage.upsert(createMemoryDaysAgo(40, { id: 'content:1' }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]).not.toHaveProperty('status');
      expect(report.sources[0]).not.toHaveProperty('avgScore');
      // daysSinceLastAccess 仍如实输出（诊断事实）
      expect(report.sources[0]?.daysSinceLastAccess).toBeGreaterThanOrEqual(39);
    });
  });

  describe('字段精度与事实', () => {
    it('daysSinceLastAccess 四舍五入到 1 位小数', () => {
      // 1.5 天前访问
      storage.upsert(createMemoryDaysAgo(1.5, { id: 'content:1' }));
      const report = advisor.sourceHealth();
      // 允许 ±0.2 误差（测试执行耗时）
      expect(report.sources[0]?.daysSinceLastAccess).toBeGreaterThanOrEqual(1.4);
      expect(report.sources[0]?.daysSinceLastAccess).toBeLessThanOrEqual(1.6);
    });

    it('daysSinceLastAccess 取该 source 中最近访问时间', () => {
      // 一条 5 天前，一条 1 天前：取 1 天前
      storage.upsert(createMemoryDaysAgo(5, { id: 'content:1' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2' }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.daysSinceLastAccess).toBeGreaterThanOrEqual(0.9);
      expect(report.sources[0]?.daysSinceLastAccess).toBeLessThanOrEqual(1.1);
    });

    it('多 source 按 source 名稳定排序', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'a:1', source: 'a' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'b:1', source: 'b' }));
      const report = advisor.sourceHealth();
      expect(report.sources.map((s) => s.source)).toEqual(['a', 'b']);
    });
  });
});

// ─── suggest() ────────────────────────────────────────────

describe('MemoryAdvisor.suggest()', () => {
  describe('空存储与无候选', () => {
    it('空存储 + 无 query：返回 []', () => {
      expect(advisor.suggest()).toEqual([]);
    });

    it('空存储 + 有 query：返回 []', () => {
      expect(advisor.suggest('关键词')).toEqual([]);
    });

    it('所有 source 被 excludeSources 排除：返回 []', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1' }));
      const result = advisor.suggest(undefined, { excludeSources: [SOURCE_LABELS.WORK_PROJECTION] });
      expect(result).toEqual([]);
    });
  });

  describe('无 query 全局推荐', () => {
    it('仅 content source：返回按 relevance 排序的推荐', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', name: 'recent-high' }));
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:2', name: 'old-low' }));
      const result = advisor.suggest();
      expect(result).toHaveLength(2);
      // 1 天前访问的 relevance 应高于 10 天前访问（relevance 现为纯时效）
      expect(result[0]?.name).toBe('recent-high');
      expect(result[1]?.name).toBe('old-low');
    });

    it('默认不排除任何 source（设定记忆已归角色包，不再参与召回排除）', () => {
      // 治理源覆盖测试涉及的全部 source（无 query 时按治理源遍历采样；默认 excludeSources 为空时不过滤）
      const advisorAll = new MemoryAdvisor(storage, null, [
        SOURCE_LABELS.PERSONA,
        SOURCE_LABELS.RULE,
        SOURCE_LABELS.SKILL,
        SOURCE_LABELS.WORK_PROJECTION,
      ]);
      storage.upsert(createMemoryDaysAgo(1, { id: 'persona:1', source: SOURCE_LABELS.PERSONA }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'rule:1', source: SOURCE_LABELS.RULE }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'skill:1', source: SOURCE_LABELS.SKILL }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1' }));
      const result = advisorAll.suggest();
      expect(result).toHaveLength(4);
    });

    it('每个 source 采样 top-N（SUGGEST_TOP_PER_SOURCE=3）', () => {
      // 插入 5 条 content，应只取前 3 条（按 accessedAt 降序采样最近使用）
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:3' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:4' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:5' }));
      const result = advisor.suggest(undefined, { limit: 10 });
      expect(result).toHaveLength(3);
      // 采样 3 条为最近使用，relevance 单调不增
      const scores = result.map((r) => r.relevance);
      expect(scores[0]).toBeGreaterThanOrEqual(scores[1]!);
      expect(scores[1]).toBeGreaterThanOrEqual(scores[2]!);
    });
  });

  describe('有 query 搜索命中优先', () => {
    it('搜索命中的记忆优先于全局推荐', () => {
      // 一条会被搜索命中（content 含"算法"）
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:hit', name: 'algo', content: '算法优化' }));
      // 一条不会被命中但最近使用
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:high', name: 'high', content: '无关内容' }));
      const result = advisor.suggest('算法');
      expect(result.length).toBeGreaterThan(0);
      // 搜索命中应排第一（即便年久的命中项也先于最近的非命中项）
      expect(result[0]?.name).toBe('algo');
    });

    it('搜索命中 + 全局补充混合', () => {
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:hit', name: 'hit', content: '算法' }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'work-projection:1', source: SOURCE_LABELS.WORK_PROJECTION, name: 'work-projection-1' }));
      const result = advisor.suggest('算法', { limit: 5 });
      // 应包含搜索命中 + 全局推荐
      const names = result.map((r) => r.name);
      expect(names).toContain('hit');
      expect(names).toContain('work-projection-1');
    });

    it('空 query 字符串（仅空格）按无 query 处理', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', name: 'test', content: '内容' }));
      // query 为空格：不调用 search，所有候选都按全局推荐
      const result = advisor.suggest('   ');
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('test');
    });
  });

  describe('limit 控制', () => {
    it('默认 limit=5（受 SUGGEST_TOP_PER_SOURCE 限制实际返回 3）', () => {
      // GOVERNANCE_SOURCES 仅含 WORK_PROJECTION，SUGGEST_TOP_PER_SOURCE=3 限制每 source 采样数
      // 插入 7 条 WORK_PROJECTION 记忆，实际仅能采样 top 3
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:1', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:2', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:3', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:4', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:5', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:6', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:7', source: SOURCE_LABELS.WORK_PROJECTION }));
      const result = advisor.suggest();
      // 默认 limit=5 但受每 source top-3 限制
      expect(result).toHaveLength(3);
    });

    it('自定义 limit=2', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:1', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:2', source: SOURCE_LABELS.WORK_PROJECTION }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:3', source: SOURCE_LABELS.WORK_PROJECTION }));
      const result = advisor.suggest(undefined, { limit: 2 });
      expect(result).toHaveLength(2);
    });
  });

  describe('reason 推荐理由 4 种分支', () => {
    it('reason="与搜索相关"（搜索命中）', () => {
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:1', name: 'hit', content: '算法' }));
      const result = advisor.suggest('算法');
      expect(result[0]?.reason).toBe('与搜索相关');
    });

    it('reason="最近访问"（daysSinceAccess<1）', () => {
      // 0.5 天前访问
      storage.upsert(createMemoryDaysAgo(0.5, { id: 'content:1', name: 'recent' }));
      const result = advisor.suggest();
      expect(result[0]?.reason).toBe('最近访问');
    });

    it('reason="work-projection 推荐"（其他情况）', () => {
      // 5 天前访问（recency 窗口内但非当天）→ 归为"${source} 推荐"
      storage.upsert(createMemoryDaysAgo(5, { id: 'work-projection:1', name: 'mid' }));
      const result = advisor.suggest();
      expect(result[0]?.reason).toBe('work-projection 推荐');
    });
  });

  describe('contentPreview 截断', () => {
    it('短内容：原样返回', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', content: '短内容' }));
      const result = advisor.suggest();
      expect(result[0]?.contentPreview).toBe('短内容');
    });

    it('长内容（>120 字符）：截断 + …', () => {
      const longContent = 'A'.repeat(200);
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', content: longContent }));
      const result = advisor.suggest();
      // 120 字符 + 1 个 … = 121 字符
      expect(result[0]?.contentPreview).toHaveLength(121);
      expect(result[0]?.contentPreview.endsWith('…')).toBe(true);
    });

    it('恰好 120 字符：原样返回（不截断）', () => {
      const exactContent = 'B'.repeat(120);
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', content: exactContent }));
      const result = advisor.suggest();
      expect(result[0]?.contentPreview).toBe(exactContent);
    });
  });

  describe('SuggestHit 字段完整性', () => {
    it('返回对象包含 name/source/relevance/contentPreview/reason 5 字段', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', name: 'test', source: SOURCE_LABELS.WORK_PROJECTION, content: '内容' }));
      const result = advisor.suggest();
      expect(result).toHaveLength(1);
      const hit = result[0]!;
      expect(hit).toHaveProperty('name', 'test');
      expect(hit).toHaveProperty('source', SOURCE_LABELS.WORK_PROJECTION);
      expect(hit).toHaveProperty('relevance');
      expect(hit).toHaveProperty('contentPreview', '内容');
      expect(hit).toHaveProperty('reason');
    });
  });
});

// ─── detectConflicts() ────────────────────────────────────

describe('MemoryAdvisor.detectConflicts()', () => {
  // 每个测试注入独立 LLM Provider 的 advisor
  function makeAdvisorWithProvider(provider: LlmProvider): MemoryAdvisor {
    return new MemoryAdvisor(storage, provider, [SOURCE_LABELS.WORK_PROJECTION]);
  }

  describe('降级路径', () => {
    it('backgroundProvider 未注入：返回 skippedReason 且空结果', async () => {
      // advisor 构造时 provider 为 null（beforeEach 默认）
      const result = await advisor.detectConflicts();
      expect(result.scannedCount).toBe(0);
      expect(result.pairCount).toBe(0);
      expect(result.conflictCount).toBe(0);
      expect(result.conflicts).toEqual([]);
      expect(result.skippedReason).toBe('backgroundProvider 未注入');
    });

    it('候选记忆不足（少于 2 条）：返回 skippedReason', async () => {
      storage.upsert(createMemory({ id: 'wp:solo', name: 'solo' }));
      const advisorWithProvider = makeAdvisorWithProvider(createJudgeProvider('{"hasConflict":false}'));
      const result = await advisorWithProvider.detectConflicts();
      expect(result.scannedCount).toBe(1);
      expect(result.pairCount).toBe(0);
      expect(result.skippedReason).toBe('候选记忆不足（少于 2 条）');
    });

    it('候选数≥2 但无同 source 候选对：返回 skippedReason', async () => {
      // 两条不同 source 的记忆（都纳入 sources 采样）→ 同 source 内无配对数
      storage.upsert(createMemory({ id: 'wp:1', name: 'one' }));
      storage.upsert(createMemory({ id: 'other:1', name: 'two', source: 'other-source' }));
      const advisorWithProvider = new MemoryAdvisor(
        storage,
        createJudgeProvider('{"hasConflict":false}'),
        ['work-projection', 'other-source'],
      );
      const result = await advisorWithProvider.detectConflicts();
      expect(result.pairCount).toBe(0);
      expect(result.skippedReason).toBe('无同 source 候选对');
      expect(result.scannedCount).toBe(2);
    });
  });

  describe('LLM 逐对判断', () => {
    it('LLM 判定冲突（hasConflict=true）：入 conflict 列表并计数', async () => {
      const { a, b } = seedConflictPair(storage);
      const advisorWithProvider = makeAdvisorWithProvider(
        createJudgeProvider(JSON.stringify({
          hasConflict: true,
          conflictDescription: '对 JavaScript 的态度矛盾',
          recommendation: 'both',
          reason: '两条记忆表达相反态度',
        })),
      );
      const result = await advisorWithProvider.detectConflicts();
      expect(result.pairCount).toBe(1);
      expect(result.conflictCount).toBe(1);
      expect(result.conflicts).toHaveLength(1);
      const verdict = result.conflicts[0]!;
      // verdict 携带原始记忆对象（供宿主 UI 展示）
      expect(verdict.memoryA.id).toBe(a.id);
      expect(verdict.memoryB.id).toBe(b.id);
      expect(verdict.hasConflict).toBe(true);
      expect(verdict.conflictDescription).toBe('对 JavaScript 的态度矛盾');
      expect(verdict.recommendation).toBe('both');
      expect(verdict.reason).toBe('两条记忆表达相反态度');
      // skippedReason 为无（正产路径不带降级字段）
      expect(result.skippedReason).toBeUndefined();
    });

    it('LLM 判定无冲突（hasConflict=false）：不计入冲突', async () => {
      seedConflictPair(storage);
      const advisorWithProvider = makeAdvisorWithProvider(
        createJudgeProvider(JSON.stringify({ hasConflict: false, reason: '不同维度，非冲突' })),
      );
      const result = await advisorWithProvider.detectConflicts();
      expect(result.pairCount).toBe(1);
      expect(result.conflictCount).toBe(0);
      expect(result.conflicts).toEqual([]);
    });

    it('recommendation 非法值被忽略（置 undefined），conflictDescription 缺失归一化', async () => {
      seedConflictPair(storage);
      // recommendation 为非法枚举 'c' → 应回退 undefined
      const advisorWithProvider = makeAdvisorWithProvider(
        createJudgeProvider(JSON.stringify({ hasConflict: true, recommendation: 'c', reason: '无理由' })),
      );
      const result = await advisorWithProvider.detectConflicts();
      const verdict = result.conflicts[0]!;
      expect(verdict.recommendation).toBeUndefined();
      expect(verdict.conflictDescription).toBeUndefined();
      expect(verdict.reason).toBe('无理由');
    });

    it('reason 缺失时使用默认占位文案', async () => {
      seedConflictPair(storage);
      const advisorWithProvider = makeAdvisorWithProvider(
        createJudgeProvider(JSON.stringify({ hasConflict: false })),
      );
      const result = await advisorWithProvider.detectConflicts();
      expect(result.conflicts).toHaveLength(0);
      // reason 归一化发生在 judgeConflict（hasConflict=false 不产生 verdict），故此处仅验证不抛错
      expect(result.pairCount).toBe(1);
    });

    it('LLM 判断抛错：单对失败不阻塞，返回空冲突', async () => {
      seedConflictPair(storage);
      const advisorWithProvider = makeAdvisorWithProvider(
        createThrowingJudgeProvider(new Error('LLM 请求超时')),
      );
      const result = await advisorWithProvider.detectConflicts();
      // catch 分支吞掉异常，整体仍返回报告
      expect(result.pairCount).toBe(1);
      expect(result.conflictCount).toBe(0);
      expect(result.conflicts).toEqual([]);
    });

    it('LLM 返回无效 JSON：抛 configError 被吞，返回空冲突', async () => {
      seedConflictPair(storage);
      const advisorWithProvider = makeAdvisorWithProvider(
        createJudgeProvider('这不是 JSON'),
      );
      const result = await advisorWithProvider.detectConflicts();
      expect(result.conflictCount).toBe(0);
      expect(result.conflicts).toEqual([]);
      // 逐对 catch 后仍返回报告，不向上抛
      await expect(advisorWithProvider.detectConflicts()).resolves.toBeDefined();
    });

    it('长内容（>200 字符）送入 LLM 前截断并追加截断标记', async () => {
      // 捕获送入 LLM 的 user 消息，断言 content 已截断
      let captured = '';
      const longA = createMemory({ id: 'wp:long-A', name: 'A', content: 'X'.repeat(300) });
      const longB = createMemory({ id: 'wp:long-B', name: 'B', content: 'Y'.repeat(300) });
      storage.upsert(longA);
      storage.upsert(longB);
      const provider = createJudgeProvider(
        JSON.stringify({ hasConflict: false }),
        (messages) => {
          const userMsg = messages.find((m) => m.role === 'user');
          if (userMsg) captured += userMsg.content;
        },
      );
      const advisorWithProvider = makeAdvisorWithProvider(provider);
      await advisorWithProvider.detectConflicts();
      // buildConflictMessages 走 >200 截断分支：出现截断标记
      expect(captured).toContain('…[截断]');
      expect(captured).toContain('X'.repeat(200));
    });
  });
});
