/**
 * Guardrail（内容护栏）单元测试
 * 覆盖输入护栏阻断、输出护栏阻断、护栏异常降级放行、无护栏规则放行、warn 级别放行
 *
 * 测试分两层：
 * 1. 直接单元测试：runGuardrails() 纯函数，验证各种规则匹配场景
 * 2. 集成测试：通过 AgentLoop.processUserInput 间接验证护栏在对话流中的实际效果
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import { runGuardrails } from '@/agent/guardrail.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';

/**
 * 创建测试用 Memory 对象
 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '你是一个测试助手',
    source: 'persona',
    name: 'test-personality',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    score: 1.0,
    ...overrides,
  };
}

/**
 * 创建 guardrail 类型的 Memory
 *
 * content 同时支持多行格式（`pattern: /regex/\naction: block`）与
 * 单行格式（`pattern: /regex/ action: block`）——S1 修复后两者等价。
 */
function makeGuardrailMemory(
  name: string,
  pattern: string,
  action: 'block' | 'warn',
): Memory {
  return makeMemory({
    id: `guardrail:${name}`,
    source: 'guardrail',
    name,
    content: `pattern: ${pattern}\naction: ${action}`,
    score: 1.0,
  });
}

/**
 * 创建模拟 LLM Provider（单轮纯文本回复）
 */
function mockProvider(chunks: Array<{ content?: string; toolCalls?: Message['toolCalls'] }>): LlmProvider {
  return {
    name: 'mock',
    async *chat() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LlmProvider;
}

/**
 * 收集 AgentLoop processUserInput 的所有 chunks
 */
async function collectChunks(loop: AgentLoop, input: string): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  for await (const chunk of loop.processUserInput(input)) {
    chunks.push(chunk);
  }
  return chunks;
}

// ─── 直接单元测试：runGuardrails() 纯函数 ──────────────────

describe('runGuardrails · 纯函数直接测试', () => {
  /** 测试用 UI 消息实现 */
  const testUI = {
    inputBlockedByGuard: (rule: string) => `Blocked by ${rule}`,
  };

  it('无规则时应直接放行', () => {
    const result = runGuardrails([], '任何输入', testUI);
    expect(result.blocked).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it('block 规则命中时应返回 blocked=true', () => {
    const rules = [makeGuardrailMemory('禁止暴力', '/暴力|攻击/', 'block')];
    const result = runGuardrails(rules, '我要暴力解决问题', testUI);
    expect(result.blocked).toBe(true);
    expect(result.message).toBe('Blocked by 禁止暴力');
  });

  it('warn 规则命中时应放行但返回 warning', () => {
    const rules = [makeGuardrailMemory('敏感词警告', '/敏感词/', 'warn')];
    const result = runGuardrails(rules, '这里有个敏感词', testUI);
    expect(result.blocked).toBe(false);
    expect(result.warning).toBe('Blocked by 敏感词警告');
  });

  it('不匹配任何规则时应放行', () => {
    const rules = [makeGuardrailMemory('禁止暴力', '/暴力|攻击/', 'block')];
    const result = runGuardrails(rules, '你好世界', testUI);
    expect(result.blocked).toBe(false);
    expect(result.message).toBeUndefined();
  });

  it('正则编译失败时应降级放行', () => {
    // 无效正则 [ 导致 RegExp 构造抛错
    const invalidRule = makeMemory({
      id: 'guardrail:invalid',
      source: 'guardrail',
      name: '无效正则',
      content: 'pattern: /[/\naction: block',
      score: 1.0,
    });
    const result = runGuardrails([invalidRule], '任何输入', testUI);
    expect(result.blocked).toBe(false);
  });

  it('规则内容缺少 pattern 字段时应跳过', () => {
    const malformedRule = makeMemory({
      id: 'guardrail:malformed',
      source: 'guardrail',
      name: '格式错误',
      content: 'action: block',
      score: 1.0,
    });
    const result = runGuardrails([malformedRule], '任何输入', testUI);
    expect(result.blocked).toBe(false);
  });

  it('规则内容缺少 action 字段时应跳过', () => {
    const malformedRule = makeMemory({
      id: 'guardrail:malformed',
      source: 'guardrail',
      name: '格式错误',
      content: 'pattern: /test/',
      score: 1.0,
    });
    const result = runGuardrails([malformedRule], 'test', testUI);
    expect(result.blocked).toBe(false);
  });

  it('正则不带定界符时应正常工作', () => {
    // pattern 不含 // 定界符，直接作为正则字符串
    const rules = [makeGuardrailMemory('禁止', '暴力', 'block')];
    const result = runGuardrails(rules, '我要暴力', testUI);
    expect(result.blocked).toBe(true);
  });

  it('S1 修复：单行格式 `pattern: /regex/ action: block` 应正确阻断', () => {
    // 旧实现贪婪正则 /pattern:\s*(.+)/ 把 `action: block` 整段吞入 pattern → 单行格式 fail-open；
    // 修复后非贪婪 + 正向预查止步于 action:，单行格式应与多行格式等价生效。
    const singleLineRule = makeMemory({
      id: 'guardrail:single',
      source: 'guardrail',
      name: '单行规则',
      content: 'pattern: /暴力|攻击/ action: block',
      score: 1.0,
    });
    const result = runGuardrails([singleLineRule], '我要暴力解决问题', testUI);
    expect(result.blocked).toBe(true);
    expect(result.message).toBe('Blocked by 单行规则');
  });

  it('S1 修复：单行格式 warn 应正常返回 warning（不阻断）', () => {
    const singleLineRule = makeMemory({
      id: 'guardrail:single-warn',
      source: 'guardrail',
      name: '单行警告',
      content: 'pattern: /敏感词/ action: warn',
      score: 1.0,
    });
    const result = runGuardrails([singleLineRule], '这里有个敏感词', testUI);
    expect(result.blocked).toBe(false);
    expect(result.warning).toBe('Blocked by 单行警告');
  });

  it('多个规则时第一个命中即返回', () => {
    const rules = [
      makeGuardrailMemory('规则A', '/alpha/', 'block'),
      makeGuardrailMemory('规则B', '/beta/', 'block'),
    ];
    // 命中规则B（第二个），验证遍历到第二个时返回
    const result = runGuardrails(rules, 'beta test', testUI);
    expect(result.blocked).toBe(true);
    expect(result.message).toBe('Blocked by 规则B');
  });
});

// ─── 集成测试：通过 AgentLoop 间接验证 ──────────────────────

describe('Guardrail · 输入护栏阻断', () => {
  it('应在用户输入匹配 block 规则时阻断对话', async () => {
    const guardrailRules = [
      makeGuardrailMemory('禁止暴力', '/暴力|攻击/', 'block'),
    ];

    const loop = new AgentLoop({
      provider: mockProvider([{ content: '不应到达这里' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      guardrailRules,
    });

    const chunks = await collectChunks(loop, '我要暴力解决问题');

    // 应有 text chunk 包含阻断消息
    const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);
    expect(textChunks.some(t => t!.includes('guardrail rule'))).toBe(true);
    expect(textChunks.some(t => t!.includes('禁止暴力'))).toBe(true);

    // 应有 done 事件
    expect(chunks.some(c => c.type === 'done')).toBe(true);

    // LLM 不应被调用（没有正常回复内容）
    expect(textChunks.some(t => t === '不应到达这里')).toBe(false);
  });
});

describe('Guardrail · 输出护栏阻断', () => {
  it('应在 LLM 输出匹配 block 规则时阻断对话', async () => {
    const guardrailRules = [
      makeGuardrailMemory('禁止敏感信息', '/密码是\\d+/', 'block'),
    ];

    const loop = new AgentLoop({
      provider: mockProvider([{ content: '你的密码是123456' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      guardrailRules,
    });

    const chunks = await collectChunks(loop, '告诉我密码');

    // 应有 text chunk 包含输出阻断消息
    const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);
    // 输出被护栏阻断后，应有阻断提示
    const hasBlockMessage = textChunks.some(t => t!.includes('guardrail rule'));
    expect(hasBlockMessage).toBe(true);

    // 应有 done 事件
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });
});

describe('Guardrail · 护栏异常降级放行', () => {
  it('应在护栏规则正则无效时降级放行而不阻断', async () => {
    // 构造一个无效正则（未闭合的括号），让护栏执行时抛异常
    const invalidRule = makeMemory({
      id: 'guardrail:invalid-regex',
      source: 'guardrail',
      name: '无效正则',
      content: 'pattern: /[(invalid/\naction: block',
      score: 1.0,
    });

    const loop = new AgentLoop({
      provider: mockProvider([{ content: '正常回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      guardrailRules: [invalidRule],
    });

    // 护栏异常时应降级放行，对话正常进行
    const chunks = await collectChunks(loop, '正常输入');

    const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);
    // 应包含 LLM 的正常回复（降级放行）
    expect(textChunks.some(t => t === '正常回复')).toBe(true);

    // 应有 done 事件
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });
});

describe('Guardrail · 无护栏规则', () => {
  it('应在无 guardrailRules 时正常放行', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '你好世界' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      // 不传 guardrailRules，默认为空数组
    });

    const chunks = await collectChunks(loop, '你好');

    const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);
    expect(textChunks).toContain('你好世界');
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });

  it('应在 guardrailRules 为空数组时正常放行', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '正常回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      guardrailRules: [],
    });

    const chunks = await collectChunks(loop, '正常输入');

    const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);
    expect(textChunks).toContain('正常回复');
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });
});

describe('Guardrail · warn 级别放行', () => {
  it('应在输入匹配 warn 规则时放行但发出警告', async () => {
    const guardrailRules = [
      makeGuardrailMemory('敏感词警告', '/敏感词/', 'warn'),
    ];

    const loop = new AgentLoop({
      provider: mockProvider([{ content: '正常回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      guardrailRules,
    });

    const chunks = await collectChunks(loop, '包含敏感词的输入');

    const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);

    // 应有护栏警告消息
    const hasWarning = textChunks.some(t => t!.includes('Guardrail Warning'));
    expect(hasWarning).toBe(true);

    // LLM 仍应正常回复（warn 不阻断）
    expect(textChunks.some(t => t === '正常回复')).toBe(true);

    // 应有 done 事件
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });

  it('应在输出匹配 warn 规则时放行但发出警告', async () => {
    const guardrailRules = [
      makeGuardrailMemory('输出警告', '/内部信息/', 'warn'),
    ];

    const loop = new AgentLoop({
      provider: mockProvider([{ content: '这是内部信息请保密' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      guardrailRules,
    });

    const chunks = await collectChunks(loop, '告诉我一些信息');

    const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);

    // 应有护栏警告消息
    const hasWarning = textChunks.some(t => t!.includes('Guardrail Warning'));
    expect(hasWarning).toBe(true);

    // LLM 回复仍应出现（warn 不阻断）
    expect(textChunks.some(t => t!.includes('内部信息'))).toBe(true);

    // 应有 done 事件
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });
});
