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
 * 详见 02-上下文组装-v4.0.md §6 · 00-记忆归档原则-v1.0.md
 */
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { TopicMessage, TopicSummarizerResult } from '@/memory/types.js';

/**
 * 话题摘要生成器回调类型
 * 接收话题消息列表，返回结构化摘要结果
 * 返回 null 表示对话价值过低，跳过归档
 * 类型定义下沉至 memory/types.ts（TopicSummarizerResult + TopicSummarizer）
 */
export type TopicSummarizerFn = (messages: TopicMessage[]) => Promise<TopicSummarizerResult | null>;

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
  return async (messages: TopicMessage[]): Promise<TopicSummarizerResult | null> => {
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
- 否则输出：{"约束":["..."], "偏好":["..."], "决策":["..."], "快照":["..."]}
- 空数组的字段可省略
- 每条约束/偏好/决策 10-20 字，只提取用户独有的信息，不包含 LLM 已知的通用知识
- 快照：提取 5-8 句用户原文中信息量最高的句子，逐句截取（≤30 字/句），用于后续话题召回`,
      },
      { role: 'user', content: conversation },
    ];

    let result = '';
    // maxTokens 从 150 提至 250，确保快照字段不被截断（150 可能截断 5-8 句快照）
    for await (const chunk of provider.chat(promptMessages, { maxTokens: 250 })) {
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

    // 解析结构化 JSON，不再丢弃快照字段
    try {
      const parsed = JSON.parse(trimmed) as Record<string, string[]>;
      const constraints = parsed['约束'] ?? [];
      const preferences = parsed['偏好'] ?? [];
      const decisions = parsed['决策'] ?? [];
      const snapshots = parsed['快照'] ?? [];
      const parts: string[] = [];
      if (constraints.length) parts.push('约束：' + constraints.join('；'));
      if (preferences.length) parts.push('偏好：' + preferences.join('；'));
      if (decisions.length) parts.push('决策：' + decisions.join('；'));
      if (snapshots.length) parts.push('快照：' + snapshots.join('；'));
      if (parts.length > 0) {
        return {
          constraints,
          preferences,
          decisions,
          snapshots, // 不再丢弃！替代 DialogueSnapshotExtractor
          summary: parts.join(' | '),
        };
      }
      return null; // 解析后无任何有价值字段
    } catch {
      // JSON 解析失败，降级为原始文本（无结构化字段）
    }

    // 降级：解析失败时返回原始文本作为 summary，快照为空
    return {
      constraints: [],
      preferences: [],
      decisions: [],
      snapshots: [],
      summary: trimmed,
    };
  };
}
