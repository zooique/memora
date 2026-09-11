/**
 * contextPreparer.ts 集成测试——上下文装配管线（动态预算装配 + 装配前判负 + 对话层注入 + 占用）
 *
 * 覆盖（记忆自动注入退役，memory-tool-recall-design §3/§4）：
 *   1. 自动注入退役锚点：assembleContext 无返回值、storage.search 不再被调用
 *     （若有人把每轮自动召回段加回，storage.search 被调用、该断言转红）；
 *   2. 装配前判负：超大输入走独立降级路径（inputTooLarge 事件 + 跳过注入），不污染软上限；
 *   3. 预算可视化占用：各层 token/条数与 free 互斥拼满非负收敛；
 *   4. 对话层注入开关：fixed 不注入 [Recent conversation]，hybrid 注入。
 */
import { describe, it, expect, vi } from 'vitest';
import { ContextPreparer, type ContextPreparerDeps } from '@/agent/contextPreparer.js';
import { AGENT_EVENTS } from '@/utils/eventEmitter.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';

/** 完整对话层派生结果类型（loop.getRecentHistoryWithinBudget 返回） */
type DialogueResult = {
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  recentRoundCount: number;
  firstRoundIncluded: boolean;
};

/** 构造 ContextPreparer 测试依赖（loop/storage 均 mock，token 估算按内容长度） */
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
    // 完整对话消息（占用计量源；默认空，测试可覆写）
    getConversationMessages: (): Array<{ role: 'user' | 'assistant'; content: string }> => [],
    getReplacedRoundIds: (): readonly string[] => [],
    getVisibleRoundIds: (): ReadonlySet<string> => new Set(),
    getExclusionRoundIds: (): ReadonlySet<string> => new Set(),
    recordBudget: vi.fn(),
    recordOccupancy: vi.fn(),
    injectSystemMessage,
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
    loop: loop as unknown as ContextPreparerDeps['loop'],
    rolePackManager: null,
    getIndex: () => storage,
    config: {
      tracer: null,
      vectorStore: null,
      messages: undefined,
      maxContextTokens: 120_000,
    },
    emit,
    ...overrides,
  };
  const preparer = new ContextPreparer(deps);
  return { preparer, deps, loop, storage, emit, injectSystemMessage };
}

describe('ContextPreparer · 自动注入退役（突变锚点）', () => {
  it('assembleContext 不做自动召回：storage.search 不被调用（检索唯一入口 = search_memories 工具）', async () => {
    const { preparer, storage } = makePreparer();
    // 记忆检索已移交 LLM 主动 search_memories 工具；prepare 期不再代模型召回注入
    vi.mocked(storage.search).mockReturnValue([
      {
        id: 'cross:1',
        content: '测试内容',
        source: 'content',
        name: 'test-memory',
        createdAt: '2026-01-01T00:00:00.000Z',
        accessedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await preparer.assembleContext('查询');

    // 加回自动召回段 → storage.search 被调用 → 此项转红
    expect(storage.search).not.toHaveBeenCalled();
  });
});

describe('ContextPreparer · 装配前判负（洞 3 独立路径）', () => {
  it('超大输入走装配前判负：发 inputTooLarge 事件、跳过注入', async () => {
    const { preparer, loop, storage, emit, injectSystemMessage } = makePreparer();
    // 超大输入：锚点划走剩余预算归零 → 装配前判负
    const hugeInput = 'x'.repeat(200_000);

    await preparer.assembleContext(hugeInput);

    // 独立降级：发 inputTooLarge 事件（宿主提示放文件用 read_file）
    expect(emit).toHaveBeenCalledWith(
      AGENT_EVENTS.inputTooLarge,
      expect.objectContaining({ inputLength: hugeInput.length, hint: expect.stringContaining('read_file') }),
    );
    // 装配跳过：无召回（不占软上限统计）、未派生/注入完整对话层
    expect(storage.search).not.toHaveBeenCalled();
    expect(loop.getRecentHistoryWithinBudget).not.toHaveBeenCalled();
    expect(injectSystemMessage).not.toHaveBeenCalled();
  });

  it('正常输入不受判负影响：走预算派生 + 完整对话层注入（对照）', async () => {
    const { preparer, loop, storage, injectSystemMessage } = makePreparer();
    loop.getRecentHistoryWithinBudget = vi.fn(
      (): DialogueResult => ({
        history: [{ role: 'user' as const, content: '第一条' }],
        recentRoundCount: 1,
        firstRoundIncluded: false,
      }),
    );

    await preparer.assembleContext('正常问题');

    expect(loop.getRecentHistoryWithinBudget).toHaveBeenCalledTimes(1);
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('第一条'));
    expect(storage.search).not.toHaveBeenCalled();
  });
});

describe('ContextPreparer · 预算可视化占用（各段互斥、free 非负收敛）', () => {
  it('hybrid 模式计量完整对话', async () => {
    const { preparer, loop } = makePreparer();
    // hybrid 对话与 loop.messages 同源：getConversationMessages 与 dialogue.history 一致
    loop.getConversationMessages = () => [{ role: 'user' as const, content: '第一条' }];
    loop.getRecentHistoryWithinBudget = vi.fn(
      (): DialogueResult => ({
        history: [{ role: 'user' as const, content: '第一条' }],
        recentRoundCount: 1,
        firstRoundIncluded: false,
      }),
    );

    await preparer.assembleContext('正常问题');

    expect(loop.recordOccupancy).toHaveBeenCalledTimes(1);
    const occ = vi.mocked(loop.recordOccupancy).mock.calls[0]![0];
    expect(occ.totalTokens).toBe(120_000);
    expect(occ.rolePackBaseTokens).toBe(3);
    expect(occ.dialogueTokens).toBe(3);
    expect(occ.dialogueCount).toBe(1);
    expect(occ.inputAnchorTokens).toBe(8);
    expect(occ.outputReserveTokens).toBe(18_000);
    const used =
      occ.rolePackBaseTokens +
      occ.dialogueTokens +
      occ.inputAnchorTokens +
      occ.outputReserveTokens;
    expect(occ.freeTokens).toBe(occ.totalTokens - used);
    expect(occ.freeTokens).toBeGreaterThanOrEqual(0);
  });

  it('占用计量全量对话（loop.messages 全量 user/assistant）', async () => {
    const { preparer, loop } = makePreparer();
    loop.getConversationMessages = () => [
      { role: 'user', content: '上一轮问题' }, // 长度 5
      { role: 'assistant', content: '上一轮回答' }, // 长度 5
    ];

    await preparer.assembleContext('正常问题');

    expect(loop.recordOccupancy).toHaveBeenCalledTimes(1);
    const occ = vi.mocked(loop.recordOccupancy).mock.calls[0]![0];
    expect(occ.dialogueTokens).toBe(10);
    expect(occ.dialogueCount).toBe(1);
    expect(occ.totalTokens).toBe(120_000);
    expect(occ.rolePackBaseTokens).toBe(3);
    expect(occ.inputAnchorTokens).toBe(8);
    expect(occ.outputReserveTokens).toBe(18_000);
    const used =
      occ.rolePackBaseTokens +
      occ.dialogueTokens +
      occ.inputAnchorTokens +
      occ.outputReserveTokens;
    expect(occ.freeTokens).toBe(occ.totalTokens - used);
    expect(occ.freeTokens).toBeGreaterThanOrEqual(0);
  });
});

describe('ContextPreparer · 对话层注入', () => {
  it('注入最近对话摘要块（阶段2 contextAssembly 键退役，对话层注入恒 hybrid）', async () => {
    const { preparer, loop, injectSystemMessage } = makePreparer();
    loop.getRecentHistoryWithinBudget = vi.fn(
      (): DialogueResult => ({
        history: [
          { role: 'user' as const, content: '上一轮问题' },
          { role: 'assistant' as const, content: '上一轮回答' },
        ],
        recentRoundCount: 1,
        firstRoundIncluded: true,
      }),
    );

    await preparer.assembleContext('新问题');

    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('[Recent conversation]'));
  });
});