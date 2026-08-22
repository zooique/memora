/**
 * contextPreparer.ts 集成测试——输入增强管线（动态预算装配 + 互斥 + 装配前判负）
 *
 * 覆盖（阶段 6 记忆系统一致性复核的针对性测试）：
 *   1. 互斥锁定：被替换轮的 roundId 经装配 exclude 流入 recall，其摘要不被二次召回（不双写）；
 *   2. 装配前判负：超大输入走独立降级路径（inputTooLarge 事件 + 跳过装配），不依赖/不污染软上限。
 */
import { describe, it, expect, vi } from 'vitest';
import { ContextPreparer, type ContextPreparerDeps } from '@/agent/contextPreparer.js';
import { AGENT_EVENTS } from '@/utils/eventEmitter.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';

/** 完整对话层派生结果类型（loop.getRecentHistoryWithinBudget 返回） */
type DialogueResult = {
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  recentRoundCount: number;
  firstRoundIncluded: boolean;
};

/** 构造测试用 Memory */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '测试内容',
    source: 'content',
    name: 'test-memory',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    score: 0.8,
    ...overrides,
  };
}

/** 构造 ContextPreparer 测试依赖（loop/history/storage 均 mock，token 估算按内容长度） */
function makePreparer(overrides: Partial<ContextPreparerDeps> = {}) {
  const emit = vi.fn();
  const injectSystemMessage = vi.fn();
  const loop = {
    getMessages: () => [{ role: 'system', content: 'sys' }],
    estimateTokens: (msgs: Array<{ content: string }>) =>
      msgs.reduce((acc, m) => acc + m.content.length, 0),
    getRecentHistoryWithinBudget: vi.fn(
      (): DialogueResult => ({ history: [], recentRoundCount: 0, firstRoundIncluded: false }),
    ),
    getReplacedRoundIds: (): readonly string[] => [],
    injectSystemMessage,
  };
  const history = {
    getRecentRoundIds: () => [],
    getFirstRoundId: () => null,
    currentSessionName: '2026-08-22-main',
  };
  const storage = {
    upsert: vi.fn(async () => {}),
    delete: vi.fn(),
    getById: vi.fn(),
    getBySource: vi.fn(),
    search: vi.fn(),
    count: vi.fn(() => 0),
    countBySource: vi.fn(() => 0),
    close: vi.fn(),
  } as unknown as IMemoryStorage;
  const deps: ContextPreparerDeps = {
    history: history as unknown as ContextPreparerDeps['history'],
    loop: loop as unknown as ContextPreparerDeps['loop'],
    rolePackManager: null,
    getIndex: () => storage,
    backgroundProvider: null,
    config: {
      tracer: null,
      vectorStore: null,
      recallExcludeSources: undefined,
      messages: undefined,
      maxContextTokens: 120_000,
    },
    emit,
    switchRolePack: () => false,
    ...overrides,
  };
  const preparer = new ContextPreparer(deps);
  return { preparer, deps, loop, history, storage, emit, injectSystemMessage };
}

describe('ContextPreparer · 互斥锁定（被替换轮不被二次召回）', () => {
  it('第一级替换上报的 roundId 流入装配 exclude，其摘要不被召回（不双写）', async () => {
    const { preparer, loop, storage } = makePreparer();
    // 替换层已把 round-replaced-1 的正文换成其记忆摘要 → roundId 上报
    loop.getReplacedRoundIds = () => ['round-replaced-1'];
    // 语义召回命中：被替换轮的摘要（roundId 命中 exclude）+ 跨会话记忆
    vi.mocked(storage.search).mockReturnValue([
      makeMemory({
        id: 'round-summary:s1:round-replaced-1',
        source: 'round-summary',
        score: 0.95,
        metadata: { roundId: 'round-replaced-1', sessionName: '2026-08-22-main', summaryType: 'fact' },
      }),
      makeMemory({ id: 'cross:1', source: 'content', score: 0.6 }),
    ]);

    const memories = await preparer.recallAndInject('查询', 'full', 'hybrid');
    const ids = memories.map((m) => m.id);
    // 被替换轮的摘要（正文已随替换注入）不被二次召回——互斥时间线闭合，绝不双写
    expect(ids).not.toContain('round-summary:s1:round-replaced-1');
    // 跨会话记忆正常召回
    expect(ids).toContain('cross:1');
  });

  it('未上报被替换轮时，其摘要仍可被正常召回（对照组：exclude 仅含实际注入轮次）', async () => {
    const { preparer, storage } = makePreparer();
    // 无替换发生 → 不上报 roundId
    vi.mocked(storage.search).mockReturnValue([
      makeMemory({
        id: 'round-summary:s1:round-other',
        source: 'round-summary',
        score: 0.9,
        metadata: { roundId: 'round-other', sessionName: '2026-08-22-main', summaryType: 'fact' },
      }),
    ]);

    const memories = await preparer.recallAndInject('查询', 'full', 'hybrid');
    const ids = memories.map((m) => m.id);
    // 未替换的轮次摘要正常召回（exclude 不含它）
    expect(ids).toContain('round-summary:s1:round-other');
  });
});

describe('ContextPreparer · 装配前判负（洞 3 独立路径）', () => {
  it('超大输入走装配前判负：发 inputTooLarge 事件、跳过召回与完整对话层注入、返回空', async () => {
    const { preparer, loop, storage, emit, injectSystemMessage } = makePreparer();
    // 超大输入：锚点划走剩余预算归零 → 装配前判负
    const hugeInput = 'x'.repeat(200_000);

    const memories = await preparer.recallAndInject(hugeInput, 'full', 'hybrid');

    // 独立降级：返回空召回 + 发 inputTooLarge 事件（宿主提示放文件用 read_file）
    expect(memories).toEqual([]);
    expect(emit).toHaveBeenCalledWith(
      AGENT_EVENTS.inputTooLarge,
      expect.objectContaining({ inputLength: hugeInput.length, hint: expect.stringContaining('read_file') }),
    );
    // 装配跳过：未召回（不占软上限统计）、未派生/注入完整对话层
    expect(storage.search).not.toHaveBeenCalled();
    expect(loop.getRecentHistoryWithinBudget).not.toHaveBeenCalled();
    expect(injectSystemMessage).not.toHaveBeenCalled();
  });

  it('正常输入不受判负影响：走正常召回 + 完整对话层注入（对照）', async () => {
    const { preparer, loop, storage, emit, injectSystemMessage } = makePreparer();
    loop.getRecentHistoryWithinBudget = vi.fn(
      (): DialogueResult => ({
        history: [{ role: 'user' as const, content: '第一条' }],
        recentRoundCount: 1,
        firstRoundIncluded: false,
      }),
    );
    vi.mocked(storage.search).mockReturnValue([
      makeMemory({ id: 'cross:1', source: 'content', score: 0.6 }),
    ]);

    const memories = await preparer.recallAndInject('正常问题', 'full', 'hybrid');

    expect(memories.map((m) => m.id)).toContain('cross:1');
    expect(loop.getRecentHistoryWithinBudget).toHaveBeenCalledTimes(1);
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('第一条'));
    expect(emit).not.toHaveBeenCalledWith(AGENT_EVENTS.inputTooLarge, expect.anything());
  });
});
