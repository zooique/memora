/**
 * MEM-1：轮次摘要失败的可观测出口（宿主消费点接线）
 *
 * 现象（台账 MEM-1，2026-10-06 回读订正）：内核 `orchestrator.runSummary` **早已**在三条
 * 失败路径上 emit `roundSummaryGenerated { success: false }`（异步 reject / 同步 catch），
 * 但宿主 `consumeFlow` 收场的 `onSummary` 回调**只拿它解锁 UI 定时器、把 `success`
 * 字段整个丢弃** ⇒ 摘要失败在 metrics / 事件 / UI / 记忆库四面皆不可见
 * （「静默失败 = 假阴性」；且在记忆库层面与「轮被中断」不可区分）。
 *
 * 本文件锁定两件事（均为行为判据，不碰实现）：
 *   1. `success:false` → 宿主错误级 notice 单通道（可观测出口成立；成功轮不得误报）
 *   2. 事件触发路径必须对称解绑 handler（`agent.on` 非 `.once`；此前只在 setTimeout
 *      分支 `off`，事件触发分支遗留 → 每轮正常收场累积一个 handler）
 *
 * ⚠️ 变异验证靶标（撤掉任一修复 → 对应用例转红，已实证）：
 *   - 删 `if (!info.success)` 分支 → 用例①③ 转红
 *   - 删事件分支的 `agent?.off(...)` → 用例④ 转红
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import type { Agent, AgentChunk } from '@zooique/memora';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { ProviderStore } from '../../extension/providers/providerStore.js';

// mock vscode：chatPanel 构造最小 API（与 chatPanelHistory.test 同款）
vi.mock('vscode', async () => ({
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    fsPath: '/mock/path',
  },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
  },
}));

/** 摘要事件回调签名（与内核 AgentEventMap 一致，取消费点实际用到的两字段） */
type SummaryHandler = (info: { roundId: string; success: boolean }) => void;

/**
 * agent 桩：`on` / `off` 换成**可观测的注册表**（记录 handler 引用与解绑），
 * 其余为 consumeFlow 收场最小面。
 *
 * 为什么不用 `vi.fn()`：本文件的核心断言之一是「handler 不累积」，需要一个
 * 真实的注册/解绑账本才能取到「当前仍注册了几个」这个事实。
 */
function summaryAgentStub(chatFn: () => AsyncGenerator<AgentChunk, void, unknown>): {
  agent: Agent;
  /** 当前仍注册的摘要 handler 快照（观测「是否泄漏」的唯一口径） */
  liveHandlers: () => SummaryHandler[];
  /** 手动触发摘要事件（模拟内核 emit） */
  emitSummary: (info: { roundId: string; success: boolean }) => void;
  /** 曾注册过的 handler 总数（含已解绑） */
  everRegistered: () => number;
} {
  const handlers = new Set<SummaryHandler>();
  let registered = 0;
  const agent = {
    chat: chatFn,
    getMetrics: () => ({
      llm: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        emptyResponseCount: 0,
        truncationRecoveryCount: 0,
      },
      tools: { callCount: 0, failureCount: 0, unparsedToolIntentCount: 0 },
      // 上下文占用快照（流尾 postContextOccupancy 读取）。缺此字段 → 流尾抛错、
      // 收场代码整段不执行 → handler 永不注册，用例转红且**原因与被测行为无关**
      // （已踩：同型第三次替身缺口，见 chatPanelHistory.test.ts 的替身契约单点说明）。
      context: { occupancy: { usedTokens: 0, windowTokens: 0, ratio: 0 } },
    }),
    sessionManager: {
      getCurrentSessionInfo: () => ({ date: '2026-10-06', session: 's1' }),
      switchToSession: async () => 0,
    },
    on: (event: string, handler: SummaryHandler): void => {
      if (event !== 'roundSummaryGenerated') return;
      handlers.add(handler);
      registered += 1;
    },
    off: (event: string, handler: SummaryHandler): void => {
      if (event !== 'roundSummaryGenerated') return;
      handlers.delete(handler);
    },
    memory: { softDeleteRoundSummaries: vi.fn() },
    getCheckpoint: () => null,
    isPausePending: () => false,
    getEffectiveMaxTokens: () => undefined,
    listBackgroundTasks: () => [],
  } as unknown as Agent;
  return {
    agent,
    liveHandlers: () => [...handlers],
    emitSummary: (info) => handlers.forEach((h) => h(info)),
    everRegistered: () => registered,
  };
}

/** 单轮正常结束的 chat 流（thinking + step_boundary，收场走 done 分支） */
function normalFlow(roundId: string): () => AsyncGenerator<AgentChunk, void, unknown> {
  return () =>
    (async function* () {
      yield { type: 'thinking', phase: 'processing', roundId };
      yield { type: 'step_boundary', roundId };
    })();
}

/** 构造 provider + 抓取 post 消息（复刻既有 harness） */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'memora-summary-obs-'));
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  // 第三个构造参数 = providerStore：收场取活动 Provider 用。传空对象 → `getActive is
  // not a function` 抛错、流尾不执行（与被测行为无关的替身缺口，已踩）。
  // ProviderStore 构造需 SecretStorage（本用例不触达密钥读写，桩即可）。
  const secrets = {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as vscode.SecretStorage;
  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    new ProviderStore(secrets) as never,
  );
  const posted: { type: string; level?: string; message?: string }[] = [];
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      postMessage: (msg: (typeof posted)[number]) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
    onDidReceiveMessage: () => ({ dispose: () => {} }),
  };
  return { provider, posted };
}

/** 错误级 notice（摘要失败唯一允许的出口形态） */
const errorNotices = (posted: { type: string; level?: string; message?: string }[]) =>
  posted.filter((m) => m.type === 'notice' && m.level === 'error');

describe('MEM-1 · 轮次摘要失败可观测出口（onSummary 消费 success）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('摘要失败（success:false）→ 错误级 notice（此前四面不可见）', async () => {
    const { provider, posted } = setup();
    const stub = summaryAgentStub(normalFlow('round-1'));
    provider.setAgent(stub.agent);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-10-06-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('任务');

    // 流已收场（此时 handler 已注册），内核此刻报摘要失败
    stub.emitSummary({ roundId: 'round-1', success: false });

    const notices = errorNotices(posted);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('摘要');
  });

  it('摘要成功（success:true）→ 不产生错误 notice（不误报）', async () => {
    const { provider, posted } = setup();
    const stub = summaryAgentStub(normalFlow('round-1'));
    provider.setAgent(stub.agent);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-10-06-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('任务');

    stub.emitSummary({ roundId: 'round-1', success: true });

    expect(errorNotices(posted)).toHaveLength(0);
  });

  it('摘要失败仍照常解锁 UI（notice 不阻断 done 推送）', async () => {
    const { provider, posted } = setup();
    const stub = summaryAgentStub(normalFlow('round-1'));
    provider.setAgent(stub.agent);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-10-06-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('任务');
    posted.length = 0;

    stub.emitSummary({ roundId: 'round-1', success: false });

    // 解锁语义 = status:done（此轮原已完成，摘要失败不得把 UI 钉在 thinking）
    expect(posted.some((m) => m.type === 'status')).toBe(true);
  });

  it('事件触发路径对称解绑：正常收场后 handler 不累积（agent.on 非 .once）', async () => {
    const { provider } = setup();
    const stub = summaryAgentStub(normalFlow('round-1'));
    provider.setAgent(stub.agent);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-10-06-s1';

    // 连跑三轮：每轮注册一个 handler、每轮收到事件
    for (let i = 1; i <= 3; i++) {
      await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput(`第${i}轮`);
      stub.emitSummary({ roundId: `round-${i}`, success: true });
    }

    // 三次注册（事实记录），但零残留 —— 未解绑则 liveHandlers 长到 3
    expect(stub.everRegistered()).toBe(3);
    expect(stub.liveHandlers()).toHaveLength(0);
  });
});
