/**
 * 话题摘要生成器 — 事件驱动的话题归档
 *
 * 设计（M-203-改 · M-209 记忆归档原则 v0.3）：
 *   - 回调模式：避免在 MessageHistory 中硬依赖 LlmProvider
 *   - 结构化提取：LLM 输出 JSON {约束/偏好/决策} → 格式化为可读文本
 *   - 低价值对话返回 null（跳过归档）
 *   - JSON 解析失败时降级为原始文本
 *
 * 本模块位于 agent 层（非 cli 层），因为：
 *   - Agent 门面类需要此能力来组装 MessageHistory
 *   - CLI 层通过 agent 层导入，不形成架构倒挂
 *
 * 详见 agent上下文组装协议.md §6 · 记忆归档原则.md
 */
import type { LlmProvider, Message } from '../llm/provider.js';
import type { TopicMessage } from '../memory/types.js';

/**
 * 话题摘要生成器回调类型
 * 接收话题消息列表，返回精炼后的核心记忆
 * 返回 null 表示对话价值过低，跳过归档
 */
export type TopicSummarizerFn = (messages: TopicMessage[]) => Promise<string | null>;

/**
 * 创建话题摘要生成器
 *
 * 策略：
 *   - 收集完整对话（user + assistant），截断到 800 字
 *   - 结构化提取：LLM 输出 JSON {约束/偏好/决策} → 格式化为可读文本
 *   - 低价值对话返回 null（跳过归档）
 *   - JSON 解析失败时降级为原始文本
 * 失败不抛出（fire-and-forget 模式，log 即可）
 *
 * @param provider LLM 提供者
 * @returns TopicSummarizerFn 回调函数
 */
export function createTopicSummarizer(provider: LlmProvider): TopicSummarizerFn {
  return async (messages: TopicMessage[]): Promise<string | null> => {
    // 收集完整对话（user + assistant），截断到 800 字以免 prompt 过长
    const conversation = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n')
      .slice(0, 800);

    const promptMessages: Message[] = [
      {
        role: 'system',
        content: `你是记忆价值评估与结构化提取助手。分析以下对话，提取用户独有的信息。

判断标准（记忆归档原则 v0.3 · 结构化）：
- 约束：用户透露的技术栈、环境限制、项目配置（大模型不知道的信息）
- 偏好：用户的代码风格偏好、工作流偏好、审美偏好、命名习惯
- 决策：用户做出的会影响未来交互的架构选型、策略决定

输出格式（严格 JSON，不含 markdown 代码块标记）：
- 对话全是通用问答/闲聊，无任何独有信息 → 只输出 SKIP
- 否则输出：{"约束":["..."], "偏好":["..."], "决策":["..."]}
- 空数组的字段可省略
- 每条 10-20 字，只提取用户独有的信息，不包含 LLM 已知的通用知识`,
      },
      { role: 'user', content: conversation },
    ];

    let result = '';
    for await (const chunk of provider.chat(promptMessages, { maxTokens: 150 })) {
      if (chunk.content) result += chunk.content;
    }
    const trimmed = result.trim();

    // LLM 返回 SKIP 或空白 → 低价值，不归档
    if (
      trimmed.toUpperCase() === 'SKIP' ||
      trimmed.toUpperCase().startsWith('SKIP') ||
      trimmed.length === 0
    ) {
      return null;
    }

    // v0.3：尝试解析结构化 JSON，格式化为可读文本存储
    try {
      const parsed = JSON.parse(trimmed) as Record<string, string[]>;
      const parts: string[] = [];
      if (parsed['约束']?.length) parts.push('约束：' + parsed['约束'].join('；'));
      if (parsed['偏好']?.length) parts.push('偏好：' + parsed['偏好'].join('；'));
      if (parsed['决策']?.length) parts.push('决策：' + parsed['决策'].join('；'));
      if (parts.length > 0) return parts.join(' | ');
    } catch {
      // JSON 解析失败，降级使用原始文本
    }

    return trimmed;
  };
}
