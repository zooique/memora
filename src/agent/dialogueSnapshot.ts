/**
 * 对话快照提取 — 切话题时的种子机制
 *
 * 职责：
 *   - 切话题时从旧话题中提取 3-5 句最有信息量的用户原文
 *   - 存入新话题文件的 frontmatter seed_snapshots 字段
 *   - 作为新话题启动时的"种子"，让 Agent 知道上一个话题的核心想法
 *
 * 设计原则（01-主架构-v4.0.md §3.5 / 00-记忆归档原则-v1.0.md §6）：
 *   - 用户换话题后原话题上下文已卸载，对话快照作为"种子"
 *   - 同步 LLM 提炼（切话题时触发，不阻塞对话但有延迟）
 *   - 3-5 句，覆盖用户核心想法和关键决策
 *   - 失败降级为空数组（种子没有不会影响对话，只是少了上下文）
 *
 * 成本警告（R-101 暂缓）：
 *   - 每切一次话题 = 一次额外 LLM 调用
 *   - 快照提取 prompt ~200 tokens + 用户原文 ~800 tokens = ~1000 tokens/次
 *   - 阶段一切话题频率低，成本可控；阶段二频繁切换后需评估
 *
 * 分层说明：
 *   本模块位于 agent/ 层（非 memory/ 层），因为它依赖 LlmProvider 做内容生成。
 *   memory/ 层只做存储和召回，不做 LLM 调用（EmbeddingService 接口注入除外）。
 */
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { TopicMessage } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';

/**
 * 对话快照提取器
 *
 * 分层：agent/ 层 — 调用 LLM 提取种子，不属于 memory/ 的存储/召回职责。
 */
export class DialogueSnapshotExtractor {
  constructor(private readonly provider: LlmProvider) {}

  /**
   * 从话题消息中提取 3-5 句用户原文作为种子
   *
   * @param messages 旧话题的消息列表（只取 user 发言）
   * @returns 3-5 句种子原文，失败返回空数组
   */
  async extract(messages: readonly TopicMessage[]): Promise<string[]> {
    // 过滤出用户的发言
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) return [];

    // 截断到最近 2000 字符（覆盖约 10 轮对话的 user 发言）
    const userText = userMessages
      .slice(-15) // 取最近 15 条
      .map((m) => `[用户]: ${m.content}`)
      .join('\n')
      .slice(0, 2000);

    try {
      const promptMessages: Message[] = [
        {
          role: 'system',
          content: `你是对话精华提取助手。从用户发言中选出 3-5 句最能代表其核心想法、偏好或决策的原文。

要求：
- 只选用户的发言，不选助手的回复
- 保持原文，不改写、不缩写
- 选择信息密度最高的语句（透露了偏好、身份、决定等）
- 按原文顺序排列

输出格式（严格，每行一句，不加编号）：
第一句原文
第二句原文
第三句原文`,
        },
        { role: 'user', content: userText },
      ];

      let result = '';
      for await (const chunk of this.provider.chat(promptMessages, { maxTokens: 300 })) {
        if (chunk.content) result += chunk.content;
      }

      // 按行分割，过滤空行
      const lines = result
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      // 限制 3-5 句
      const snapshots = lines.slice(0, Math.min(lines.length, 5));

      if (snapshots.length === 0) {
        logger.debug('对话快照提炼结果为空，跳过');
        return [];
      }

      // 最短句也要有实际信息（至少 5 个字符）
      const meaningful = snapshots.filter((s) => s.length >= 5);

      if (meaningful.length > 0) {
        logger.info({ count: meaningful.length }, '对话快照提炼完成');
      }
      return meaningful.slice(0, 5);
    } catch (err) {
      // 快照提取失败不阻塞话题切换
      logger.warn({ err }, '对话快照提炼失败，跳过');
      return [];
    }
  }
}
