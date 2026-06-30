/**
 * evalTypes.ts 单元测试
 *
 * 覆盖 collectAgentChunks（AgentChunk 流收集）与 evaluateResult（期望比对）两个函数。
 * 测试范式：构造 mock AsyncGenerator<AgentChunk>，验证收集与比对逻辑。
 */
import { describe, it, expect } from 'vitest';
import {
  collectAgentChunks,
  evaluateResult,
  type EvalExpectation,
} from '@/eval/evalTypes.js';
import type { AgentChunk } from '@/agent/types.js';

// ─── 测试辅助：构造 AgentChunk 异步迭代器 ─────────────────────

/**
 * 从 chunk 数组构造 AsyncGenerator（模拟 AgentLoop 输出）
 *
 * @param chunks - AgentChunk 数组
 * @returns AsyncGenerator，依次 yield 每个 chunk
 */
async function* mockChunkStream(chunks: AgentChunk[]): AsyncGenerator<AgentChunk, void, unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// ─── collectAgentChunks 测试 ──────────────────────────────────

describe('collectAgentChunks', () => {
  it('空流应返回默认 collected 对象', async () => {
    const collected = await collectAgentChunks(mockChunkStream([]));

    expect(collected.toolsCalled).toEqual([]);
    expect(collected.recallCount).toBe(0);
    expect(collected.guardrailBlocked).toBe(false);
    expect(collected.done).toBe(false);
  });

  it('应正确收集 recall chunk 的 memories 数量', async () => {
    const chunks: AgentChunk[] = [
      {
        type: 'recall',
        memories: [
          { id: 'rule:1', name: '规则1', score: 0.9, source: 'rule' },
          { id: 'insight:2', name: '洞察2', score: 0.7, source: 'insight' },
        ],
      },
    ];

    const collected = await collectAgentChunks(mockChunkStream(chunks));
    expect(collected.recallCount).toBe(2);
  });

  it('应去重收集 tool_start chunk 的工具名', async () => {
    const chunks: AgentChunk[] = [
      { type: 'tool_start', toolCallId: 'call-1', name: 'read_file', args: '{}' },
      { type: 'tool_start', toolCallId: 'call-2', name: 'read_file', args: '{}' },
      { type: 'tool_start', toolCallId: 'call-3', name: 'search_memories', args: '{}' },
    ];

    const collected = await collectAgentChunks(mockChunkStream(chunks));
    // 同名工具去重
    expect(collected.toolsCalled).toEqual(['read_file', 'search_memories']);
  });

  it('应从 text chunk 检测输入护栏阻断', async () => {
    const chunks: AgentChunk[] = [
      { type: 'text', content: '输入被护栏规则阻断：检测到敏感内容' },
    ];

    const collected = await collectAgentChunks(mockChunkStream(chunks));
    expect(collected.guardrailBlocked).toBe(true);
  });

  it('应从 text chunk 检测输出护栏阻断', async () => {
    const chunks: AgentChunk[] = [
      { type: 'text', content: '输出被护栏规则修正：移除了不安全内容' },
    ];

    const collected = await collectAgentChunks(mockChunkStream(chunks));
    expect(collected.guardrailBlocked).toBe(true);
  });

  it('普通 text chunk 不应触发 guardrailBlocked', async () => {
    const chunks: AgentChunk[] = [
      { type: 'text', content: '这是正常的助手回复' },
    ];

    const collected = await collectAgentChunks(mockChunkStream(chunks));
    expect(collected.guardrailBlocked).toBe(false);
  });

  it('done chunk 应标记 done=true', async () => {
    const collected = await collectAgentChunks(mockChunkStream([{ type: 'done' }]));
    expect(collected.done).toBe(true);
  });

  it('应正确处理完整对话流（recall → thinking → tool_start → text → done）', async () => {
    const chunks: AgentChunk[] = [
      { type: 'recall', memories: [{ id: 'rule:1', name: 'r1', score: 0.8, source: 'rule' }] },
      { type: 'thinking', phase: 'recalling' },
      { type: 'tool_start', toolCallId: 'c1', name: 'read_file', args: '{"path":"a.md"}' },
      { type: 'text', content: '文件内容如下' },
      { type: 'done' },
    ];

    const collected = await collectAgentChunks(mockChunkStream(chunks));
    expect(collected.recallCount).toBe(1);
    expect(collected.toolsCalled).toEqual(['read_file']);
    expect(collected.done).toBe(true);
    expect(collected.guardrailBlocked).toBe(false);
  });
});

// ─── evaluateResult 测试 ──────────────────────────────────────

describe('evaluateResult', () => {
  /** 构造默认 collected 对象（避免每个用例重复） */
  const baseCollected = {
    toolsCalled: ['read_file', 'search_memories'],
    recallCount: 2,
    guardrailBlocked: false,
    done: true,
  };

  it('所有期望都满足时应通过', () => {
    const expectation: EvalExpectation = {
      toolsCalled: ['read_file'],
      toolsNotCalled: ['write_file'],
      toolCallCount: { min: 1, max: 3 },
      guardrailBlocked: false,
    };

    const result = evaluateResult('场景1', baseCollected, expectation);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('期望调用的工具未调用时应失败', () => {
    const expectation: EvalExpectation = {
      toolsCalled: ['write_file'],
    };

    const result = evaluateResult('场景2', baseCollected, expectation);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]).toContain('write_file');
  });

  it('不应调用的工具被调用时应失败', () => {
    const expectation: EvalExpectation = {
      toolsNotCalled: ['read_file'],
    };

    const result = evaluateResult('场景3', baseCollected, expectation);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('read_file');
  });

  it('工具调用次数低于最小值时应失败', () => {
    const expectation: EvalExpectation = {
      toolCallCount: { min: 5 },
    };

    const result = evaluateResult('场景4', baseCollected, expectation);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('< 期望最小值 5');
  });

  it('工具调用次数超过最大值时应失败', () => {
    const expectation: EvalExpectation = {
      toolCallCount: { max: 1 },
    };

    const result = evaluateResult('场景5', baseCollected, expectation);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('> 期望最大值 1');
  });

  it('护栏阻断状态不匹配时应失败', () => {
    const expectation: EvalExpectation = {
      guardrailBlocked: true,
    };

    const result = evaluateResult('场景6', baseCollected, expectation);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('期望护栏阻断=true');
  });

  it('空期望应直接通过', () => {
    const result = evaluateResult('场景7', baseCollected, {});
    expect(result.passed).toBe(true);
  });

  it('结果应携带场景名称和 collected 数据', () => {
    const result = evaluateResult('场景8', baseCollected, {});
    expect(result.name).toBe('场景8');
    expect(result.collected).toBe(baseCollected);
  });
});
