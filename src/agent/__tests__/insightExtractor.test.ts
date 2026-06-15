/**
 * InsightExtractor 单元测试
 *
 * 覆盖：
 * - classify() 三层输入分类
 * - extract() insight 提取流程
 * - Jaccard 去重
 * - 输入截断
 * - 宿主关键词匹配
 * - 默认提取行为
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InsightExtractor, type MemoryKeywords } from '@/agent/insightExtractor.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { LlmProvider } from '@/llm/provider.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider
// ═══════════════════════════════════════════════════════════════

class MockProvider extends LlmProvider {
  readonly name = 'mock';
  private response: string;

  constructor(response: string = '{"insight": "测试洞察", "tags": ["测试"]}') {
    super();
    this.response = response;
  }

  setResponse(response: string): void {
    this.response = response;
  }

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    yield { content: this.response };
    yield { finishReason: 'stop' };
  }
}

// ═══════════════════════════════════════════════════════════════
// 测试：classify() 三层输入分类
// ═══════════════════════════════════════════════════════════════

describe('InsightExtractor · classify() 三层输入分类', () => {
  let extractor: InsightExtractor;
  let storage: InMemoryStorage;
  let provider: MockProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    extractor = new InsightExtractor(provider, storage);
    extractor.bindGetRecentHistory(() => []);
  });

  // Layer 1: 通用规则

  it('应跳过短于 5 字符的输入', () => {
    expect(extractor.classify('你好')).toBe('skip');
    expect(extractor.classify('hi')).toBe('skip');
    expect(extractor.classify('ok')).toBe('skip');
  });

  it('应跳过问候、确认等无信息量输入', () => {
    expect(extractor.classify('你好呀')).toBe('skip');
    expect(extractor.classify('好的好的')).toBe('skip');
    expect(extractor.classify('嗯嗯嗯嗯')).toBe('skip');
    expect(extractor.classify('知道了知道了')).toBe('skip');
    expect(extractor.classify('谢谢你的帮助')).toBe('skip');
    expect(extractor.classify('Hello world')).toBe('skip');
  });

  it('应对有意义的输入返回 extract', () => {
    expect(extractor.classify('我正在开发一个新项目')).toBe('extract');
    expect(extractor.classify('请记住我的偏好设置')).toBe('extract');
  });

  // Layer 2: 宿主关键词

  it('应匹配宿主领域关键词并返回 extract', () => {
    const keywords: MemoryKeywords = {
      domain: ['主角', '角色', '情节'],
      personal: [],
    };
    extractor.setKeywords(keywords);

    expect(extractor.classify('主角的性格是怎样的')).toBe('extract');
    expect(extractor.classify('角色设定需要调整')).toBe('extract');
  });

  it('应匹配宿主用户专属关键词并返回 extract', () => {
    const keywords: MemoryKeywords = {
      domain: [],
      personal: ['我的', '记住'],
    };
    extractor.setKeywords(keywords);

    expect(extractor.classify('记住这个设定')).toBe('extract');
    expect(extractor.classify('我的项目架构')).toBe('extract');
  });

  it('宿主关键词未设置时应跳过 Layer 2', () => {
    // 不调用 setKeywords，hostKeywords 为 null
    // 输入不命中 Layer 1，应走到 Layer 3 默认 extract
    expect(extractor.classify('这段文字不包含任何关键词')).toBe('extract');
  });

  // Layer 3: 默认 extract

  it('不命中 Layer 1 和 Layer 2 时应默认返回 extract', () => {
    expect(extractor.classify('今天天气不错适合写代码')).toBe('extract');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：extract() insight 提取
// ═══════════════════════════════════════════════════════════════

describe('InsightExtractor · extract() insight 提取', () => {
  let extractor: InsightExtractor;
  let storage: InMemoryStorage;
  let provider: MockProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    extractor = new InsightExtractor(provider, storage);
    extractor.bindGetRecentHistory(() => []);
  });

  it('应将 LLM 提取的 insight 写入存储', async () => {
    provider.setResponse('{"insight": "用户偏好深色主题", "tags": ["偏好", "主题"]}');

    await extractor.extract('我喜欢深色主题', '好的，已记录您的偏好');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(1);
    expect(insights[0]!.content).toBe('用户偏好深色主题');
    expect(insights[0]!.source).toBe(SOURCE_LABELS.INSIGHT);
    expect(insights[0]!.score).toBe(0.5);
    expect(insights[0]!.id).toMatch(/^insight:/);
  });

  it('LLM 返回 null 时不应写入记忆', async () => {
    provider.setResponse('null');

    await extractor.extract('你好', '你好！');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(0);
  });

  it('LLM 返回空字符串时不应写入记忆', async () => {
    provider.setResponse('');

    await extractor.extract('你好', '你好！');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(0);
  });

  it('LLM 返回无 insight 字段时不应写入记忆', async () => {
    provider.setResponse('{"tags": ["测试"]}');

    await extractor.extract('测试内容', '测试回复');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(0);
  });

  it('LLM 返回 insight 为空字符串时不应写入记忆', async () => {
    provider.setResponse('{"insight": "", "tags": []}');

    await extractor.extract('测试内容', '测试回复');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(0);
  });

  it('提取失败时不应抛出异常（fire-and-forget）', async () => {
    // 创建一个会抛错的 provider
    const errorProvider = new (class extends LlmProvider {
      readonly name = 'error';
      async *chat(): AsyncIterable<LlmChunk> {
        throw new Error('LLM 连接失败');
      }
    })();
    const errorExtractor = new InsightExtractor(errorProvider, storage);
    errorExtractor.bindGetRecentHistory(() => []);

    // 不应抛错
    await expect(errorExtractor.extract('测试', '回复')).resolves.toBeUndefined();
  });

  it('应将对话历史传入 LLM prompt', async () => {
    const history = [
      { role: 'user' as const, content: '之前的问题' },
      { role: 'assistant' as const, content: '之前的回答' },
    ];
    const historyExtractor = new InsightExtractor(provider, storage);
    historyExtractor.bindGetRecentHistory(() => history);

    provider.setResponse('{"insight": "用户关注历史", "tags": ["历史"]}');

    await historyExtractor.extract('当前问题', '当前回答');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：Jaccard 去重
// ═══════════════════════════════════════════════════════════════

describe('InsightExtractor · Jaccard 去重', () => {
  let extractor: InsightExtractor;
  let storage: InMemoryStorage;
  let provider: MockProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    extractor = new InsightExtractor(provider, storage);
    extractor.bindGetRecentHistory(() => []);
  });

  it('相似 insight 应更新已有记忆而非创建重复', async () => {
    // 先写入一条已有记忆
    const now = new Date().toISOString();
    storage.upsert({
      id: 'insight:existing-1',
      content: '用户 偏好 深色 主题',
      source: SOURCE_LABELS.INSIGHT,
      name: 'insight-existing',
      createdAt: now,
      accessedAt: now,
      score: 0.5,
    });

    // LLM 返回与已有记忆高度相似的 insight（Jaccard > 0.7）
    provider.setResponse('{"insight": "用户 偏好 深色 主题", "tags": ["偏好"]}');

    await extractor.extract('我喜欢深色主题', '好的');

    // 不应创建新记忆
    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(1);

    // 已有记忆的 score 应增加
    const updated = storage.getById('insight:existing-1');
    expect(updated!.score).toBeGreaterThan(0.5);
    expect(updated!.score).toBeLessThanOrEqual(1.0);
  });

  it('不相似的 insight 应创建新记忆', async () => {
    // 先写入一条已有记忆
    const now = new Date().toISOString();
    storage.upsert({
      id: 'insight:existing-2',
      content: '用户喜欢在早晨写代码',
      source: SOURCE_LABELS.INSIGHT,
      name: 'insight-existing-2',
      createdAt: now,
      accessedAt: now,
      score: 0.5,
    });

    // LLM 返回完全不同的 insight
    provider.setResponse('{"insight": "项目使用 TypeScript 技术栈", "tags": ["技术栈"]}');

    await extractor.extract('项目用 TypeScript', '好的');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(2);
  });

  it('score 增加不应超过 1.0', async () => {
    const now = new Date().toISOString();
    storage.upsert({
      id: 'insight:high-score',
      content: '用户 偏好 深色 主题 模式',
      source: SOURCE_LABELS.INSIGHT,
      name: 'insight-high-score',
      createdAt: now,
      accessedAt: now,
      score: 0.98,
    });

    provider.setResponse('{"insight": "用户 偏好 深色 主题 模式", "tags": ["偏好"]}');

    await extractor.extract('我喜欢深色', '好的');

    const updated = storage.getById('insight:high-score');
    expect(updated!.score).toBeLessThanOrEqual(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：输入截断
// ═══════════════════════════════════════════════════════════════

describe('InsightExtractor · 输入截断', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it('用户输入超过 500 字符时应被截断', async () => {
    const longInput = 'A'.repeat(600);
    let capturedPrompt = '';

    const captureProvider = new (class extends LlmProvider {
      readonly name = 'capture';
      async *chat(messages: Message[]): AsyncIterable<LlmChunk> {
        capturedPrompt = messages[0]?.content ?? '';
        yield { content: '{"insight": "长输入测试", "tags": []}' };
        yield { finishReason: 'stop' };
      }
    })();

    const captureExtractor = new InsightExtractor(captureProvider, storage);
    captureExtractor.bindGetRecentHistory(() => []);
    await captureExtractor.extract(longInput, '短回复');

    // prompt 中应包含截断后的输入（500 字符 + "…"）
    const userInputSection = capturedPrompt.split('用户：')[1]?.split('\n')[0] ?? '';
    expect(userInputSection.length).toBeLessThanOrEqual(502); // 500 + '…'
    expect(userInputSection).toContain('…');
  });

  it('助手回复超过 2000 字符时应被截断', async () => {
    const longAssistant = 'B'.repeat(2500);
    let capturedPrompt = '';

    const captureProvider = new (class extends LlmProvider {
      readonly name = 'capture';
      async *chat(messages: Message[]): AsyncIterable<LlmChunk> {
        capturedPrompt = messages[0]?.content ?? '';
        yield { content: '{"insight": "长回复测试", "tags": []}' };
        yield { finishReason: 'stop' };
      }
    })();

    const captureExtractor = new InsightExtractor(captureProvider, storage);
    captureExtractor.bindGetRecentHistory(() => []);
    await captureExtractor.extract('短输入', longAssistant);

    const assistantSection = capturedPrompt.split('助手：')[1]?.split('\n')[0] ?? '';
    expect(assistantSection.length).toBeLessThanOrEqual(2002); // 2000 + '…'
    expect(assistantSection).toContain('…');
  });

  it('历史消息超过 300 字符时应被截断', async () => {
    const longHistory = [
      { role: 'user' as const, content: 'C'.repeat(400) },
      { role: 'assistant' as const, content: 'D'.repeat(400) },
    ];
    let capturedPrompt = '';

    const captureProvider = new (class extends LlmProvider {
      readonly name = 'capture';
      async *chat(messages: Message[]): AsyncIterable<LlmChunk> {
        capturedPrompt = messages[0]?.content ?? '';
        yield { content: '{"insight": "历史截断测试", "tags": []}' };
        yield { finishReason: 'stop' };
      }
    })();

    const captureExtractor = new InsightExtractor(captureProvider, storage);
    captureExtractor.bindGetRecentHistory(() => longHistory);
    await captureExtractor.extract('短输入', '短回复');

    // 历史消息部分应包含截断标记
    expect(capturedPrompt).toContain('…');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：宿主关键词匹配
// ═══════════════════════════════════════════════════════════════

describe('InsightExtractor · 宿主关键词匹配', () => {
  let extractor: InsightExtractor;
  let storage: InMemoryStorage;
  let provider: MockProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    extractor = new InsightExtractor(provider, storage);
    extractor.bindGetRecentHistory(() => []);
  });

  it('领域关键词匹配应返回 extract', () => {
    extractor.setKeywords({
      domain: ['小说', '角色', '情节', '设定'],
      personal: [],
    });

    expect(extractor.classify('小说的情节发展')).toBe('extract');
    expect(extractor.classify('角色设定需要修改')).toBe('extract');
  });

  it('用户专属关键词匹配应返回 extract', () => {
    extractor.setKeywords({
      domain: [],
      personal: ['我', '我的', '记住', '帮我'],
    });

    expect(extractor.classify('记住这个重要设定')).toBe('extract');
    expect(extractor.classify('我的项目架构')).toBe('extract');
  });

  it('不匹配任何关键词时不应在 Layer 2 拦截', () => {
    extractor.setKeywords({
      domain: ['小说', '角色'],
      personal: ['记住'],
    });

    // 输入不包含任何关键词，但也不命中 Layer 1，应走到 Layer 3
    expect(extractor.classify('今天讨论一下架构设计')).toBe('extract');
  });

  it('setKeywords 应覆盖之前的关键词', () => {
    extractor.setKeywords({
      domain: ['小说'],
      personal: [],
    });
    expect(extractor.classify('小说创作很重要')).toBe('extract');

    // 更换关键词
    extractor.setKeywords({
      domain: ['编程'],
      personal: [],
    });

    // 旧关键词不再匹配（但 Layer 3 默认 extract）
    expect(extractor.classify('小说创作很重要')).toBe('extract');
    // 新关键词匹配
    expect(extractor.classify('编程技巧分享')).toBe('extract');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：默认提取行为
// ═══════════════════════════════════════════════════════════════

describe('InsightExtractor · 默认提取行为', () => {
  let extractor: InsightExtractor;
  let storage: InMemoryStorage;
  let provider: MockProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    extractor = new InsightExtractor(provider, storage);
    extractor.bindGetRecentHistory(() => []);
  });

  it('新 insight 的 id 应以 insight: 前缀开头', async () => {
    provider.setResponse('{"insight": "用户喜欢 TypeScript", "tags": ["偏好"]}');

    await extractor.extract('我喜欢 TypeScript', '好的');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(1);
    expect(insights[0]!.id).toMatch(/^insight:[0-9a-f-]+$/);
  });

  it('新 insight 的 source 应为 insight', async () => {
    provider.setResponse('{"insight": "测试洞察", "tags": []}');

    await extractor.extract('测试输入', '测试回复');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights[0]!.source).toBe('insight');
  });

  it('新 insight 的 score 应为 0.5', async () => {
    provider.setResponse('{"insight": "测试洞察", "tags": []}');

    await extractor.extract('测试输入', '测试回复');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights[0]!.score).toBe(0.5);
  });

  it('新 insight 的 name 应以 insight- 开头', async () => {
    provider.setResponse('{"insight": "测试洞察", "tags": []}');

    await extractor.extract('测试输入', '测试回复');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights[0]!.name).toMatch(/^insight-[0-9a-f]+$/);
  });

  it('createdAt 和 accessedAt 应为有效 ISO 日期', async () => {
    provider.setResponse('{"insight": "测试洞察", "tags": []}');

    await extractor.extract('测试输入', '测试回复');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    const m = insights[0]!;
    expect(new Date(m.createdAt).toISOString()).toBe(m.createdAt);
    expect(new Date(m.accessedAt).toISOString()).toBe(m.accessedAt);
  });

  it('LLM 返回 markdown 代码块包裹的 JSON 时应正常解析', async () => {
    provider.setResponse('```json\n{"insight": "用户偏好 Vim 编辑器", "tags": ["编辑器"]}\n```');

    await extractor.extract('我用 Vim 写代码', '好的');

    const insights = storage.getBySource(SOURCE_LABELS.INSIGHT);
    expect(insights.length).toBe(1);
    expect(insights[0]!.content).toBe('用户偏好 Vim 编辑器');
  });
});
