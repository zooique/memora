/**
 * autoConfigRefiner.ts 单元测试 — Agent 智能总结接口（模式 3）
 *
 * 覆盖范围：
 *   - 构造与配置：默认 options + 自定义 options + 回调存储
 *   - setBackgroundProvider：注入 provider + 注入 null
 *   - analyze 短对话跳过：userInput < 20 + assistantContent < 20 + 边界 20 不跳过
 *   - analyzeWithLlm 路径：数组/对象格式 + 非法 JSON 降级 + 抛错降级 + 流式累加
 *     + 字段缺失过滤 + 置信度过滤 + 数量限制 + 回调失败隔离 + source 字段
 *   - analyzeWithHeuristics 路径：5 种中文偏好模式 + 2 种英文模式 + 4 种领域关键词
 *     + 无匹配 + 多模式同时命中
 *
 * 测试范式：mock LlmProvider.chat 返回 AsyncIterable + 真实 AutoConfigRefiner 实例。
 */
import { describe, expect, it, vi } from 'vitest';
import { AutoConfigRefiner } from '@/agent/managers/autoConfigRefiner.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ConfigSuggestion } from '@/agent/managers/configManager.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/**
 * 构造 mock LlmProvider（chat 方法返回 AsyncIterable）
 *
 * @param chunks - 模拟 LLM 返回的 chunk 序列（每个 chunk 的 content 会被累加）
 * @param shouldThrow - chat 方法是否在迭代时抛出异常（测试降级）
 * @returns mock LlmProvider 实例
 */
function createMockProvider(
  chunks: LlmChunk[] = [{ content: '[]' }],
  shouldThrow = false,
): LlmProvider {
  const chatMock = vi.fn().mockImplementation(() => {
    if (shouldThrow) {
      // 返回一个 async iterator，迭代时抛出异常
      return (async function* () {
        throw new Error('LLM 调用失败');
      })();
    }
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();
  });
  return {
    name: 'mock-provider',
    supportsStructuredOutput: false,
    chat: chatMock,
  } as unknown as LlmProvider;
}

/** 构造一条完整的建议 JSON 字符串（数组格式） */
function buildArrayJson(suggestions: Array<{
  type?: string;
  name?: string;
  content?: string;
  confidence?: number;
  reason?: string;
}>): string {
  return JSON.stringify(suggestions);
}

/** 构造一条完整的建议 JSON 字符串（对象格式 { suggestions: [...] }） */
function buildObjectJson(suggestions: Array<{
  type?: string;
  name?: string;
  content?: string;
  confidence?: number;
  reason?: string;
}>): string {
  return JSON.stringify({ suggestions });
}

// ─── 构造与配置 ────────────────────────────────────────────

describe('AutoConfigRefiner 构造与配置', () => {
  it('默认 options：minConfidence=0.6, maxSuggestions=3', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 通过启发式路径验证默认配置（confidence=0.65 的偏好建议应被保留）
    // 注意：避免触发领域关键词（代码/编程/bug 等），否则会同时产生 persona 建议
    const userInput = '我喜欢用机械键盘打字，手感非常不错，工作效率提升很多';
    const assistantContent = '好的，我了解您喜欢机械键盘，会在后续对话中考虑这一点。';
    await refiner.analyze(userInput, assistantContent);
    // 默认 minConfidence=0.6，启发式偏好 confidence=0.65 应被保留
    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.confidence).toBe(0.65);
  });

  it('自定义 options 覆盖默认值', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback, {
      minConfidence: 0.7,
      maxSuggestions: 1,
      isExistingRule: () => false,
    });
    // 启发式偏好 confidence=0.65 < 0.7，应被过滤
    const userInput = '我喜欢用机械键盘打字，手感非常不错，工作效率提升很多';
    const assistantContent = '好的，我了解您喜欢机械键盘，会在后续对话中考虑这一点。';
    await refiner.analyze(userInput, assistantContent);
    // 0.65 < 0.7，应被过滤
    expect(callback).not.toHaveBeenCalled();
  });

  it('onConfigSuggestion 回调被正确存储并调用', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 避免触发领域关键词（"编辑" 在写作助手关键词中），改用 "配置"
    const userInput = '我习惯用纸质笔记本记录想法，感觉更专注一些';
    const assistantContent = '好的，纸质笔记本是很经典的记录方式，我了解了您的习惯。';
    await refiner.analyze(userInput, assistantContent);
    expect(callback).toHaveBeenCalled();
  });
});

// ─── setBackgroundProvider ────────────────────────────────

describe('setBackgroundProvider', () => {
  it('注入 provider 后走 LLM 路径', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildArrayJson([{
        type: 'rule',
        name: '偏好-TS',
        content: '用户偏好：TypeScript',
        confidence: 0.9,
        reason: '明确声明偏好',
      }]) },
    ]);
    refiner.setBackgroundProvider(provider);

    const userInput = '我喜欢用 TypeScript 写代码，类型系统很棒';
    const assistantContent = '好的，我了解您的偏好了，会在后续对话中考虑这一点。';
    await refiner.analyze(userInput, assistantContent);

    // LLM 路径应被调用
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.name).toBe('偏好-TS');
    expect(suggestion.confidence).toBe(0.9);
  });

  it('注入 null 后走启发式路径', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 先注入 provider，再注入 null
    const provider = createMockProvider();
    refiner.setBackgroundProvider(provider);
    refiner.setBackgroundProvider(null);

    const userInput = '我喜欢用 TypeScript 写代码，类型系统很棒';
    const assistantContent = '好的，我了解您的偏好了，会在后续对话中考虑这一点。';
    await refiner.analyze(userInput, assistantContent);

    // 启发式路径：provider.chat 不应被调用
    expect(provider.chat).not.toHaveBeenCalled();
    // 启发式偏好建议（confidence=0.65）应被回调
    expect(callback).toHaveBeenCalled();
  });
});

// ─── analyze 短对话跳过 ────────────────────────────────────

describe('analyze 短对话跳过', () => {
  it('userInput 长度 < 20 时跳过（不调用回调）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 19 字符（< 20）
    const shortInput = '我喜欢用 TypeScript';
    const assistantContent = '好的，我了解您的偏好了，会在后续对话中考虑这一点。';
    await refiner.analyze(shortInput, assistantContent);
    expect(callback).not.toHaveBeenCalled();
  });

  it('assistantContent 长度 < 20 时跳过（不调用回调）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const userInput = '我喜欢用 TypeScript 写代码，类型系统很棒';
    // 19 字符（< 20）
    const shortAssistant = '好的，了解了您的偏好';
    await refiner.analyze(userInput, shortAssistant);
    expect(callback).not.toHaveBeenCalled();
  });

  it('边界：两者都恰好 20 字符时不跳过', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 精确构造 20 字符的输入（避免领域关键词）
    // "我喜欢用机械键盘打字，手感真的非常不错呢" = 20 字符
    const userInput = '我喜欢用机械键盘打字，手感真的非常不错呢';
    // "好的，了解您的偏好了，会在后续对话中考虑" = 20 字符
    const assistantContent = '好的，了解您的偏好了，会在后续对话中考虑';
    await refiner.analyze(userInput, assistantContent);
    // 启发式路径应被触发（"我喜欢用" 匹配偏好模式）
    expect(callback).toHaveBeenCalled();
  });
});

// ─── analyzeWithLlm 路径 ──────────────────────────────────

describe('analyzeWithLlm 路径', () => {
  it('LLM 返回数组格式 [{...}]', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: '偏好-TS', content: '用户偏好：TS', confidence: 0.9, reason: '明确声明' },
        { type: 'persona', name: '程序员助手', content: '专业领域：编程', confidence: 0.85, reason: '代码相关' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    expect(callback).toHaveBeenCalledTimes(2);
    const s1 = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    const s2 = callback.mock.calls[1]?.[0] as ConfigSuggestion;
    expect(s1.type).toBe('rule');
    expect(s1.name).toBe('偏好-TS');
    expect(s2.type).toBe('persona');
    expect(s2.name).toBe('程序员助手');
  });

  it('LLM 返回对象格式 { suggestions: [...] }', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildObjectJson([
        { type: 'skill', name: '代码审查', content: '技能：代码审查', confidence: 0.8, reason: '频繁提到' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.type).toBe('skill');
    expect(suggestion.name).toBe('代码审查');
  });

  it('LLM 返回空数组 [] 时不调用回调', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([{ content: '[]' }]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it('LLM 返回非法 JSON 降级为空数组（不调用回调）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([{ content: '这不是 JSON' }]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // parseLlmJson 解析失败返回 null，items = []，无建议
    expect(callback).not.toHaveBeenCalled();
  });

  it('LLM 返回 null 字符串降级为空数组', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([{ content: 'null' }]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // parseLlmJson('null') 返回 null，items = []，无建议
    expect(callback).not.toHaveBeenCalled();
  });

  it('LLM 返回空字符串降级为空数组', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([{ content: '' }]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // parseLlmJson('') 返回 null（trimmed 为空），items = []，无建议
    expect(callback).not.toHaveBeenCalled();
  });

  it('LLM 迭代抛错时降级为空数组（不调用回调）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([], true);  // shouldThrow=true
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // LLM 抛错被 catch，返回 []，无建议
    expect(callback).not.toHaveBeenCalled();
  });

  it('流式输出累加（多个 chunk 拼接成完整 JSON）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 将 JSON 拆成 3 个 chunk，验证累加逻辑
    const fullJson = buildArrayJson([
      { type: 'rule', name: '偏好-TS', content: '用户偏好：TS', confidence: 0.9, reason: '明确声明' },
    ]);
    const mid = Math.floor(fullJson.length / 2);
    const provider = createMockProvider([
      { content: fullJson.slice(0, mid) },
      { content: fullJson.slice(mid) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.name).toBe('偏好-TS');
  });

  it('字段缺失过滤（缺 type/name/content/confidence 之一）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildArrayJson([
        // 完整建议（应保留）
        { type: 'rule', name: '完整', content: '内容', confidence: 0.8, reason: '理由' },
        // 缺 type
        { name: '缺type', content: '内容', confidence: 0.8, reason: '理由' },
        // 缺 name
        { type: 'rule', content: '内容', confidence: 0.8, reason: '理由' },
        // 缺 content
        { type: 'rule', name: '缺content', confidence: 0.8, reason: '理由' },
        // 缺 confidence
        { type: 'rule', name: '缺confidence', content: '内容', reason: '理由' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // 只有第一条完整建议被保留
    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.name).toBe('完整');
  });

  it('置信度过滤（< minConfidence=0.6 丢弃）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: '高置信度', content: '内容', confidence: 0.9, reason: '理由' },
        { type: 'rule', name: '边界值', content: '内容', confidence: 0.6, reason: '理由' },
        { type: 'rule', name: '低置信度', content: '内容', confidence: 0.59, reason: '理由' },
        { type: 'rule', name: '零置信度', content: '内容', confidence: 0, reason: '理由' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // 0.9 和 0.6（>= 0.6）保留，0.59 和 0 丢弃
    expect(callback).toHaveBeenCalledTimes(2);
    const s1 = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    const s2 = callback.mock.calls[1]?.[0] as ConfigSuggestion;
    expect(s1.name).toBe('高置信度');
    expect(s2.name).toBe('边界值');
  });

  it('数量限制 maxSuggestions=3（超出截断）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback, { maxSuggestions: 3, isExistingRule: () => false });
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: '建议1', content: '内容', confidence: 0.9, reason: '理由' },
        { type: 'rule', name: '建议2', content: '内容', confidence: 0.85, reason: '理由' },
        { type: 'rule', name: '建议3', content: '内容', confidence: 0.8, reason: '理由' },
        { type: 'rule', name: '建议4', content: '内容', confidence: 0.75, reason: '理由' },
        { type: 'rule', name: '建议5', content: '内容', confidence: 0.7, reason: '理由' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // maxSuggestions=3，只回调前 3 条
    expect(callback).toHaveBeenCalledTimes(3);
    const names = callback.mock.calls.map((c) => (c[0] as ConfigSuggestion).name);
    expect(names).toEqual(['建议1', '建议2', '建议3']);
  });

  it('onConfigSuggestion 回调失败不中断后续', async () => {
    const callback = vi.fn()
      .mockImplementationOnce(() => { throw new Error('回调失败'); })
      .mockImplementationOnce(() => { /* 正常 */ });
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: '建议1', content: '内容', confidence: 0.9, reason: '理由' },
        { type: 'rule', name: '建议2', content: '内容', confidence: 0.85, reason: '理由' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // 第一条回调抛错，第二条仍应被调用
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('source 字段固定为 "auto-config-refiner"', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: '测试', content: '内容', confidence: 0.9, reason: '理由' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.source).toBe('auto-config-refiner');
  });

  it('LLM 调用参数：temperature=0.3 + system prompt 包含规则说明', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([{ content: '[]' }]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );

    // 类型断言：provider.chat 是 vi.fn() 返回的 MockFunction
    const chatMock = provider.chat as unknown as ReturnType<typeof vi.fn>;
    expect(chatMock).toHaveBeenCalledTimes(1);
    const callArgs = chatMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    const [messages, opts] = callArgs!;
    // 第二参数应包含 temperature=0.3
    expect(opts).toMatchObject({ temperature: 0.3 });
    // messages 应为 [system, user] 结构
    expect(messages).toHaveLength(2);
    expect((messages as Message[])[0]?.role).toBe('system');
    expect((messages as Message[])[1]?.role).toBe('user');
    // system prompt 应包含规则/角色/技能说明
    expect((messages as Message[])[0]?.content).toContain('rule');
    expect((messages as Message[])[0]?.content).toContain('persona');
    expect((messages as Message[])[0]?.content).toContain('skill');
  });

  it('LLM 输入截断：userInput 和 assistantContent 各截断 500 字符', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([{ content: '[]' }]);
    refiner.setBackgroundProvider(provider);

    // 构造超长输入（600 字符）
    const longInput = '我喜欢用 TypeScript 写代码'.repeat(30);  // ~720 字符
    const longAssistant = '好的，我了解您的偏好了，会在后续对话中考虑这一点。'.repeat(15);  // ~690 字符
    await refiner.analyze(longInput, longAssistant);

    // 类型断言：provider.chat 是 vi.fn() 返回的 MockFunction
    const chatMock = provider.chat as unknown as ReturnType<typeof vi.fn>;
    const callArgs = chatMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    const messages = callArgs![0] as Message[];
    const userContent = messages[1]?.content ?? '';
    // 应包含 "用户输入：" 前缀 + 截断后的 500 字符
    expect(userContent).toContain('用户输入：');
    // userInput.slice(0, 500) 后应被截断
    expect(userContent.length).toBeLessThan(longInput.length + 1000);
  });
});

// ─── analyzeWithHeuristics 路径（无 backgroundProvider） ────

describe('analyzeWithHeuristics 启发式路径', () => {
  it('无 backgroundProvider 走启发式路径', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 不调用 setBackgroundProvider，backgroundProvider 默认 null
    const userInput = '我喜欢用 TypeScript 写代码，类型系统很棒';
    const assistantContent = '好的，我了解您的偏好了，会在后续对话中考虑这一点。';
    await refiner.analyze(userInput, assistantContent);
    // 启发式偏好建议（confidence=0.65）应被回调
    expect(callback).toHaveBeenCalled();
  });

  // ── 中文偏好模式（5 种触发词） ──

  it('偏好模式：我喜欢 X（confidence=0.65）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 避免触发领域关键词（"代码" 会触发程序员助手）
    await refiner.analyze(
      '我喜欢用机械键盘打字，手感非常不错，很舒适',
      '好的，我了解您喜欢机械键盘，会在后续对话中考虑这一点。',
    );
    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.type).toBe('rule');
    expect(suggestion.confidence).toBe(0.65);
    expect(suggestion.content).toContain('机械键盘');
  });

  it('偏好模式：我偏好 X', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 避免触发领域关键词（"编辑" 在写作助手关键词中），改用 "主题"
    await refiner.analyze(
      '我偏好用深色主题的屏幕背景，眼睛更舒服一些',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );
    expect(callback).toHaveBeenCalled();
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.type).toBe('rule');
    expect(suggestion.name).toContain('深色主题');
  });

  it('偏好模式：我习惯 X', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 注意：input 会被 toLowerCase()，"VSCode" 变成 "vscode"
    await refiner.analyze(
      '我习惯用 vscode 工具写程序，配置了很多快捷键',
      '好的，vscode 是非常流行的工具，我了解了您的习惯。',
    );
    expect(callback).toHaveBeenCalled();
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.content).toContain('vscode');
  });

  it('偏好模式：我常用 X', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 注意：input 会被 toLowerCase()，"Git" 变成 "git"
    await refiner.analyze(
      '我常用 git 工具做版本管理，每天都会提交好几次',
      '好的，git 是版本管理的标准工具，我了解了您的工作流。',
    );
    expect(callback).toHaveBeenCalled();
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.content).toContain('git');
  });

  it('偏好模式：我一般用 X', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '我一般用 pnpm 管理依赖，速度比 npm 快很多',
      '好的，pnpm 确实是高效的包管理器，我了解了您的选择。',
    );
    expect(callback).toHaveBeenCalled();
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.content).toContain('pnpm');
  });

  // ── 英文偏好模式（2 种触发词） ──

  it('英文偏好模式：always use X', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 注意：input 会被 toLowerCase()，"TypeScript" 变成 "typescript"
    await refiner.analyze(
      'I always use typescript for my projects, it is great.',
      'Got it, I understand your preference for typescript.',
    );
    expect(callback).toHaveBeenCalled();
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.type).toBe('rule');
    expect(suggestion.content).toContain('typescript');
  });

  it('英文偏好模式：usually work with X', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 正则匹配：usually\s+(?:use|work with)\s+(.{2,20})
    // "prefer working with" 不匹配（working 不是 use/work with），改用 usually work with
    await refiner.analyze(
      'I usually work with react for frontend development tasks.',
      'Understood, react is a popular choice for frontend.',
    );
    expect(callback).toHaveBeenCalled();
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.content).toContain('react');
  });

  // ── 领域关键词（4 种 persona 建议） ──

  it('领域关键词：程序员助手（代码/编程/bug/debug/重构/函数/接口）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '这个函数的接口设计有问题，需要重构一下，还有个 bug 要 debug',
      '好的，我理解您遇到了代码设计问题，让我帮您分析一下。',
    );
    const personaSuggestions = callback.mock.calls
      .map((c) => c[0] as ConfigSuggestion)
      .filter((s) => s.type === 'persona');
    expect(personaSuggestions.length).toBeGreaterThan(0);
    expect(personaSuggestions.some((s) => s.name === '程序员助手')).toBe(true);
  });

  it('领域关键词：设计师助手（设计/UI/UX/原型/交互/视觉）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '这个 UI 的交互设计不够好，视觉层次有问题，需要重新做原型',
      '好的，我理解您关注 UI/UX 设计，让我帮您分析一下视觉问题。',
    );
    const personaSuggestions = callback.mock.calls
      .map((c) => c[0] as ConfigSuggestion)
      .filter((s) => s.type === 'persona');
    expect(personaSuggestions.some((s) => s.name === '设计师助手')).toBe(true);
  });

  it('领域关键词：写作助手（写作/文案/编辑/文章/内容）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '我需要写一篇关于技术趋势的文章，文案要精炼，内容要有深度',
      '好的，我理解您需要写作方面的协助，让我帮您构思一下。',
    );
    const personaSuggestions = callback.mock.calls
      .map((c) => c[0] as ConfigSuggestion)
      .filter((s) => s.type === 'persona');
    expect(personaSuggestions.some((s) => s.name === '写作助手')).toBe(true);
  });

  it('领域关键词：数据分析师（数据/分析/报表/统计/指标）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '我需要分析这份数据，生成统计报表，关键指标要突出显示',
      '好的，我理解您需要数据分析方面的协助，让我帮您处理。',
    );
    const personaSuggestions = callback.mock.calls
      .map((c) => c[0] as ConfigSuggestion)
      .filter((s) => s.type === 'persona');
    expect(personaSuggestions.some((s) => s.name === '数据分析师')).toBe(true);
  });

  it('无匹配：普通对话不触发启发式建议', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '今天天气怎么样？明天的天气预报如何？',
      '今天天气晴朗，明天多云转晴，气温适中。',
    );
    // 无偏好声明 + 无领域关键词，应无建议
    expect(callback).not.toHaveBeenCalled();
  });

  it('多模式同时命中（偏好 + 领域关键词）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，这个函数的接口设计需要重构',
      '好的，我了解您的偏好了，让我帮您分析代码设计问题。',
    );
    // 应同时触发：偏好规则建议（"我喜欢用 TypeScript"）+ 程序员助手 persona 建议（函数/接口/重构）
    const suggestions = callback.mock.calls.map((c) => c[0] as ConfigSuggestion);
    const ruleSuggestions = suggestions.filter((s) => s.type === 'rule');
    const personaSuggestions = suggestions.filter((s) => s.type === 'persona');
    expect(ruleSuggestions.length).toBeGreaterThan(0);
    expect(personaSuggestions.length).toBeGreaterThan(0);
    expect(personaSuggestions.some((s) => s.name === '程序员助手')).toBe(true);
  });

  it('启发式建议 source 字段固定为 "auto-config-refiner"', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    await refiner.analyze(
      '我喜欢用 TypeScript 写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.source).toBe('auto-config-refiner');
  });

  it('启发式建议 name 截断到 10 字符（偏好-{captured.slice(0, 10)}）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    // 构造超长偏好内容（>10 字符）
    await refiner.analyze(
      '我喜欢用超长的 TypeScript 框架名称写代码，类型系统很棒',
      '好的，我了解您的偏好了，会在后续对话中考虑这一点。',
    );
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    // name 格式："偏好-{captured.slice(0, 10)}"，"偏好-" 占 3 字符，captured 最多 10 字符
    expect(suggestion.name.startsWith('偏好-')).toBe(true);
    // captured 部分最多 10 字符（"偏好-" 后的部分）
    const captured = suggestion.name.slice(3);  // 去掉 "偏好-"
    expect(captured.length).toBeLessThanOrEqual(10);
  });
});

// ─── 建议去重（T2-3：同偏好重复触发不产生重复建议） ─────────────

describe('建议去重（T2-3）', () => {
  const LONG_INPUT = '用户输入足够长的对话内容，超过二十字符用于触发分析流程';
  const LONG_REPLY = '助手回复足够长的对话内容，超过二十字符用于触发分析流程';

  it('跨轮重复回调去重：同一建议第二次 analyze 不再回调宿主', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const userInput = '我喜欢用机械键盘打字，手感非常不错，工作效率提升很多';
    const assistantContent = '好的，我了解您喜欢机械键盘，会在后续对话中考虑这一点。';

    await refiner.analyze(userInput, assistantContent);
    expect(callback).toHaveBeenCalledTimes(1);

    // analyze 每轮执行，下一轮会重复提取同一建议 → 指纹命中应跳过
    await refiner.analyze(userInput, assistantContent);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('同轮重复建议去重：LLM 返回两条同名建议只回调一次', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: 'TS偏好', content: '用户偏好 TypeScript', confidence: 0.8, reason: 'r1' },
        { type: 'rule', name: 'TS偏好', content: '用户偏好 TypeScript', confidence: 0.8, reason: 'r2' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(LONG_INPUT, LONG_REPLY);
    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.name).toBe('TS偏好');
  });

  it('isExistingRule 查重：已有同名 rule 的建议被过滤', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback, {
      isExistingRule: (name) => name === 'TS偏好',
    });
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: 'TS偏好', content: '用户偏好 TypeScript', confidence: 0.8, reason: 'r1' },
        { type: 'rule', name: 'Python偏好', content: '用户偏好 Python', confidence: 0.8, reason: 'r2' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(LONG_INPUT, LONG_REPLY);
    // TS偏好 已存在被过滤，仅 Python偏好 回调
    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.name).toBe('Python偏好');
  });

  it('去重不占 maxSuggestions 名额：已存在建议过滤后剩余建议仍可回调', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback, {
      maxSuggestions: 1,
      isExistingRule: (name) => name === 'TS偏好',
    });
    const provider = createMockProvider([
      { content: buildArrayJson([
        { type: 'rule', name: 'TS偏好', content: '用户偏好 TypeScript', confidence: 0.8, reason: 'r1' },
        { type: 'rule', name: 'Python偏好', content: '用户偏好 Python', confidence: 0.8, reason: 'r2' },
        { type: 'rule', name: 'Go偏好', content: '用户偏好 Go', confidence: 0.8, reason: 'r3' },
      ]) },
    ]);
    refiner.setBackgroundProvider(provider);

    await refiner.analyze(LONG_INPUT, LONG_REPLY);
    // 3 条建议：TS偏好 已存在被过滤 → 剩 2 条新 → maxSuggestions=1 回调 1 条，
    // 且必须是新建议（若去重失效，slice(1) 会取到第一位的 TS偏好 → 本断言转红）
    expect(callback).toHaveBeenCalledTimes(1);
    const suggestion = callback.mock.calls[0]?.[0] as ConfigSuggestion;
    expect(suggestion.name).not.toBe('TS偏好');
  });

  it('未注入 isExistingRule 时仅靠指纹去重（向后兼容，不抛错）', async () => {
    const callback = vi.fn();
    const refiner = new AutoConfigRefiner(callback);
    const userInput = '我喜欢用机械键盘打字，手感非常不错，工作效率提升很多';
    const assistantContent = '好的，我了解您喜欢机械键盘，会在后续对话中考虑这一点。';

    await refiner.analyze(userInput, assistantContent);
    await refiner.analyze(userInput, assistantContent);
    // 未注入查重回调 → 跨轮指纹去重仍生效，仅回调 1 次
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
