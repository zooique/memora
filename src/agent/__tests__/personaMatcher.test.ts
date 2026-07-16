/**
 * 角色语义匹配器测试（agent 层纯函数模块）
 *
 * 从 personaManager.test.ts 的 'autoMatch · LLM 辅助判断' 区段迁移。
 * matchPersonaByLlm 是纯函数，直接接收 Persona[] 参数，无需文件系统 mock。
 *
 * 覆盖范围：
 *   - 正常匹配：LLM 返回有效角色名
 *   - 降级策略：LLM 返回 none / 无效角色名 / 空字符串 / 调用失败
 *   - 候选过滤：排除当前激活角色
 *   - 边界：候选列表为空时短路返回，不调用 LLM
 *   - prompt 构造：验证 system prompt 包含角色列表且排除当前角色
 */
import { describe, it, expect, vi } from 'vitest';
import { matchPersonaByLlm } from '@/agent/personaMatcher.js';
import type { Persona } from '@/persona/types.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';

/**
 * 构造测试用 Persona 对象（内存构造，无需文件系统）
 * @param name 角色名
 * @param keywords 关键词数组
 * @param description 角色描述（可选）
 */
function createPersona(
  name: string,
  keywords: string[] = [],
  description?: string,
): Persona {
  return {
    name,
    id: `persona:${name}`,
    keywords,
    description,
    content: `${name}的角色设定内容。`,
    filePath: `(test-${name})`,
  };
}

/**
 * 构造 mock LlmProvider（chat 返回指定内容的 AsyncIterable）
 * @param responseContent - LLM 返回的完整文本
 * @param shouldThrow - chat 方法是否抛出异常（测试降级）
 * @returns mock LlmProvider 实例（chat 为 vi.fn 以支持断言）
 */
function createMockProvider(
  responseContent: string = 'none',
  shouldThrow = false,
): LlmProvider & { chat: ReturnType<typeof vi.fn> } {
  const chatMock = vi.fn().mockImplementation(() => {
    if (shouldThrow) {
      return (async function* () {
        throw new Error('LLM 调用失败');
      })();
    }
    return (async function* () {
      yield { content: responseContent } as LlmChunk;
    })();
  });
  return {
    name: 'mock-provider',
    chat: chatMock,
  } as unknown as LlmProvider & { chat: ReturnType<typeof vi.fn> };
}

describe('matchPersonaByLlm · LLM 辅助角色匹配', () => {
  /** 默认助手角色（测试常量） */
  const defaultPersona = createPersona('默认助手', ['通用'], '通用助手');
  /** 程序员助手角色（测试常量） */
  const coderPersona = createPersona(
    '程序员助手',
    ['编程', '代码', '架构', '设计'],
    '专业编程助手',
  );

  it('LLM 返回匹配角色名时返回该角色名', async () => {
    const provider = createMockProvider('程序员助手');
    const result = await matchPersonaByLlm(
      provider,
      [defaultPersona, coderPersona],
      '默认助手',
      '帮我写代码',
    );

    expect(result).toBe('程序员助手');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回 "none" 时返回 null', async () => {
    const provider = createMockProvider('none');
    const result = await matchPersonaByLlm(
      provider,
      [defaultPersona, coderPersona],
      '默认助手',
      '帮我写代码',
    );

    expect(result).toBeNull();
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回无效角色名时返回 null（防止幻觉）', async () => {
    const provider = createMockProvider('不存在的角色');
    const result = await matchPersonaByLlm(
      provider,
      [defaultPersona, coderPersona],
      '默认助手',
      '帮我写代码',
    );

    expect(result).toBeNull();
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回空字符串时返回 null', async () => {
    const provider = createMockProvider('');
    const result = await matchPersonaByLlm(
      provider,
      [defaultPersona, coderPersona],
      '默认助手',
      '帮我写代码',
    );

    expect(result).toBeNull();
  });

  it('LLM 调用失败时降级返回 null', async () => {
    const provider = createMockProvider('', true);
    const result = await matchPersonaByLlm(
      provider,
      [defaultPersona, coderPersona],
      '默认助手',
      '帮我写代码',
    );

    expect(result).toBeNull();
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('排除当前激活角色（LLM 返回当前角色名时返回 null）', async () => {
    const provider = createMockProvider('程序员助手');
    // 当前激活角色是程序员助手，LLM 返回程序员助手
    // 但候选列表已排除当前角色，所以 LLM 返回的"程序员助手"不在候选中 → null
    const result = await matchPersonaByLlm(
      provider,
      [defaultPersona, coderPersona],
      '程序员助手',
      '帮我写代码',
    );

    expect(result).toBeNull();
  });

  it('候选列表为空（排除当前角色后）时返回 null，不调用 LLM', async () => {
    const provider = createMockProvider('程序员助手');
    // 只有一个角色且是当前激活角色 → 排除后候选为空
    const result = await matchPersonaByLlm(
      provider,
      [coderPersona],
      '程序员助手',
      '帮我写代码',
    );

    expect(result).toBeNull();
    // 候选为空时应短路返回，不调用 LLM
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('构造正确的 system prompt（包含角色列表且排除当前角色）', async () => {
    const provider = createMockProvider('程序员助手');
    await matchPersonaByLlm(
      provider,
      [defaultPersona, coderPersona],
      '默认助手',
      '帮我写代码',
    );

    // 验证 LLM 接收的 messages 参数
    const callArgs = provider.chat.mock.calls[0]!;
    const messages = callArgs[0] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    // system prompt 应包含候选角色（排除当前激活角色"默认助手"）
    expect(messages[0]!.content).toContain('程序员助手');
    expect(messages[0]!.content).not.toContain('默认助手');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toBe('帮我写代码');
  });
});
