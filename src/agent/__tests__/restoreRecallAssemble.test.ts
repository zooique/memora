/**
 * 恢复 → 召回 → 装配全链路集成测试（Agent 门面层）
 *
 * 覆盖交叉链路（K3 + K6 修复间交互）：
 * - 恢复：agent.restoreFromCheckpoint() → CheckpointRestoreCoordinator.restore()
 *   （① 热窗口载入 → ② 温记忆按需召回 → ③ 契约重注入）
 * - 召回：warmRecall 以 mainGoal/currentGoal 从 IMemoryStorage 真实召回早期上下文
 * - 装配：恢复后继续 chat，ContextPreparer.recallAndInject 注入不产生双份最近对话
 *
 * 与 SessionManager 层单测（mock loop）互补：本测试走真实 Agent 门面，
 * 不 mock 内部组件，验证「恢复协议 → 召回 → 装配」完整链路的端到端行为。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import type { SessionCheckpoint, ChatMessage } from '@/agent/types.js';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider — 记录最近一次收到的 messages（供装配断言）
// ═══════════════════════════════════════════════════════════════

class RecordingProvider extends LlmProvider {
  readonly name = 'recording-mock';
  /** 最近一次 chat 收到的完整消息列表（装配结果） */
  lastMessages: Message[] = [];

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    this.lastMessages = [...messages];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    yield { content: `Mock 回复：${lastUser?.content ?? '(empty)'}` };
    yield { finishReason: 'stop' };
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** 项目骨架：默认角色包 + skills 目录（strategy 可注入 contextAssembly 等装配策略） */
function seedProject(
  _projectPath: string,
  configDir: string,
  _dataDir: string,
  strategy: Record<string, unknown> = {},
): void {
  const rolePackDir = join(configDir, 'role-packs', '默认助手');
  mkdirSync(rolePackDir, { recursive: true });
  writeFileSync(
    join(rolePackDir, 'manifest.json'),
    JSON.stringify({
      name: '默认助手',
      displayName: '默认助手',
      keywords: ['你好', '帮助'],
      strategy,
    }),
    'utf-8',
  );
  writeFileSync(join(rolePackDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  mkdirSync(join(configDir, 'skills'), { recursive: true });
}

/** 创建 Agent 实例（RecordingProvider + 可注入 storage） */
function makeAgent(
  projectPath: string,
  configDir: string,
  dataDir: string,
  provider: RecordingProvider,
  storage?: InMemoryStorage,
): Agent {
  return new Agent({
    projectPath,
    provider,
    configDir,
    dataDir,
    permission: 'owner',
    allowedPaths: [dataDir],
    storage,
    messages: {
      abortedByUser: '用户取消了对话',
      maxIterationsReached: '\n\n[已达到最大迭代次数]',
      recentConversationLabel: '[最近对话]',
      userLabel: '用户',
      assistantLabel: '助手',
    },
  });
}

/** 构造含 tool_calls 配对的热窗口消息（模拟暂停前多轮，含截断场景） */
function buildToolHotMemory(): ChatMessage[] {
  return [
    { role: 'user', content: '第1轮-用户问题', name: 'user' },
    {
      role: 'assistant',
      content: '',
      name: 'assistant',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', content: '第1轮-工具结果', name: 'tool', toolCallId: 'call-1' },
    { role: 'assistant', content: '第1轮-基于工具的回复', name: 'assistant' },
    { role: 'user', content: '第2轮-继续问题', name: 'user' },
    {
      role: 'assistant',
      content: '',
      name: 'assistant',
      toolCalls: [{ id: 'call-2', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
    },
    { role: 'tool', content: '第2轮-搜索结果', name: 'tool', toolCallId: 'call-2' },
    { role: 'assistant', content: '第2轮-基于工具的回复', name: 'assistant' },
  ];
}

/** 构造合法 SessionCheckpoint（必填字段齐全，hotMemory 可注入） */
function buildCheckpoint(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
  const base: SessionCheckpoint = {
    schemaVersion: AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION,
    sessionId: '2026-08-23-integration',
    status: 'paused',
    mainGoal: '构建测试项目',
    currentGoal: '构建测试项目',
    goalChangeSeq: 0,
    lastHeartbeat: Date.now(),
    plan: [],
    role: { name: '默认助手', description: '通用助手' },
    standard: { quality: '', constraints: [] },
    resource: { documents: [], memories: [], context: '' },
    hotMemory: buildToolHotMemory(),
    truncatedCount: 2,
  };
  return { ...base, ...overrides } as SessionCheckpoint;
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

describe('全链路：恢复 → 召回 → 装配（Agent 门面层）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;
  let provider: RecordingProvider;
  let storage: InMemoryStorage;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-chain-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-chain-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-chain-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
    provider = new RecordingProvider();
    storage = new InMemoryStorage();
  });

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it('恢复协议：restoreFromCheckpoint 完整执行（热窗口载入 → 温记忆召回 → 契约重注入）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, provider, storage);
    await agent.init();

    // 预置一条早期温记忆（round-summary），其 content 与 checkpoint.mainGoal 语义相关
    // 关键词通道（segmentLower 分词）命中：content 含 mainGoal 核心词
    storage.upsert({
      id: 'round-summary:integration:r0',
      content: '早期阶段已确认：本项目使用 TypeScript 构建测试项目，技术栈为 node 环境。',
      source: 'round-summary',
      name: 'integration:r0',
      createdAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      score: 0.6,
    });

    // 事件监听：验证 warmRecall 发射 memoryRecalled
    const memoryRecalledSpy = vi.fn();
    agent.on('memoryRecalled', memoryRecalledSpy);

    // 完整恢复协议
    const checkpoint = buildCheckpoint();
    const count = await agent.restoreFromCheckpoint(checkpoint);

    // ── ① 热窗口载入：消息恢复进 loop ──
    expect(count).toBe(checkpoint.hotMemory.length);
    const loopMessages = agent.agentLoop?.getMessages() ?? [];
    // 排除 system（角色前缀/截断提示/温记忆注入），热记忆 user/assistant/tool 全部在场
    const hot = loopMessages.filter((m) => m.role !== 'system');
    expect(hot).toHaveLength(checkpoint.hotMemory.length);

    // ── ② 温记忆召回：早期上下文注入 loop system message ──
    expect(memoryRecalledSpy).toHaveBeenCalled();
    const systemTexts = loopMessages.filter((m) => m.role === 'system').map((m) => String(m.content));
    const warmContextInjected = systemTexts.some((t) => t.includes('[恢复的早期上下文]'));
    expect(warmContextInjected).toBe(true);

    // 资源槽合并：checkpoint.resource.memories 含召回记忆 id
    const restoredResource = agent.sessionManager?.getCheckpoint()?.resource;
    expect(restoredResource?.memories).toContain('round-summary:integration:r0');

    // ── ③ 契约重注入：角色名与 checkpoint 一致 ──
    expect(agent.rolePackManager?.activeName).toBe('默认助手');

    // 热记忆载入后 tool_calls 与 tool 结果配对完整（K3 交互：恢复不破坏配对）
    for (let i = 0; i < hot.length; i++) {
      const msg = hot[i]!;
      if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        expect(hot[i + 1]?.role).toBe('tool');
        expect(hot[i + 1]?.toolCallId).toBe(msg.toolCalls[0]!.id);
      }
    }
    // 无孤立 tool_calls
    const toolCallIds = hot.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    const allCallIds = hot.flatMap((m) => m.toolCalls?.map((tc) => tc.id) ?? []);
    for (const callId of allCallIds) {
      expect(toolCallIds).toContain(callId);
    }
  });

  it('恢复后继续对话：装配不产生双份最近对话（K6 交互）', async () => {
    // fixed 装配模式：loop 已保留完整对话历史，K6 修复保证不再注入 conversation 摘要造成双份
    seedProject(tmpProject, tmpConfig, tmpData, {
      prepare: { contextAssembly: 'fixed' },
    });
    agent = makeAgent(tmpProject, tmpConfig, tmpData, provider, storage);
    await agent.init();

    // 恢复一个含热窗口历史的 checkpoint（模拟暂停后恢复）
    const checkpoint = buildCheckpoint();
    const count = await agent.restoreFromCheckpoint(checkpoint);
    expect(count).toBeGreaterThan(0);

    // 继续对话：装配上下文
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of agent.chat('继续分析')) {
      // 消费流
    }

    // 装配断言（基于 loop 真实状态，避免后台 round-summary 任务污染 provider.lastMessages）：
    const loopMessages = agent.agentLoop?.getMessages() ?? [];

    // 1) 恢复的热窗口 user 消息在装配后仍只出现一次（不重复注入摘要副本）
    const userContents = loopMessages.filter((m) => m.role === 'user').map((m) => String(m.content));
    const hotUserContents = checkpoint.hotMemory.filter((m) => m.role === 'user').map((m) => m.content);
    for (const uc of hotUserContents) {
      expect(userContents.filter((c) => c.includes(uc))).toHaveLength(1);
    }

    // 2) 新增输入 '继续分析' 恰好出现一次（loop 中用户输入带 <user_input> 包装，用 includes 判定）
    expect(userContents.filter((c) => c.includes('继续分析'))).toHaveLength(1);

    // 3) fixed 模式不注入 '[最近对话]' 摘要块（K6 修复的核心：避免与 loop 保留的完整历史双份）
    const systemTexts = loopMessages.filter((m) => m.role === 'system').map((m) => String(m.content));
    const hasDuplicateSummary = systemTexts.some((t) => t.includes('最近对话'));
    expect(hasDuplicateSummary).toBe(false);
  });
});
