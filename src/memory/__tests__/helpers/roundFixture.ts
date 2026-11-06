/**
 * 测试专用 Round 夹具
 *
 * 生产库**不再暴露**「造轮」API：`roundStore.createPendingRound` 已删除——真实建轮唯一入口是
 * `MessageHistory.appendUser`（建轮即入会话，ADR-044）。留一个库级工厂等于给下一个人一个
 * 「看起来正当」的造轮入口，故将其降为测试夹具（只在 `__tests__` 内可用，不进生产包面）。
 *
 * 适用对象：以 Round 为**输入数据**的存储 / 视图 / GC 单元测试（它们断言的是存储行为，
 * 不是建轮行为）。断言建轮行为的用例走真实路径 `MessageHistory.appendUser`。
 */
import { generateMessageId, generateRoundId, type Round } from '@/memory/roundStore.js';

/**
 * 构造 pending 状态的 Round（测试夹具）
 * @param userMessage 用户消息正文
 * @returns 新构造的 pending Round（未落盘，需调用方 `store.save`）
 */
export function createPendingRoundFixture(userMessage: string): Round {
  const id = generateRoundId();
  const now = new Date().toISOString();

  return {
    id,
    userMessage: {
      id: generateMessageId(),
      role: 'user',
      content: userMessage,
      timestamp: now,
    },
    status: 'pending',
    createdAt: now,
    refCount: 1,
  };
}

/**
 * 构造 complete 状态的 Round（测试夹具）
 *
 * 与 `createPendingRoundFixture` 同理：生产库**不提供**「把轮标成完成」的工具函数——
 * 生产侧收尾由 `MessageHistory.appendAssistant` 承担（写 AI 消息 + 置 complete + 清 pendingAsk
 * 同一次 save）。此处只为「以完成态轮为输入」的存储 / 视图 / GC 用例造现场。
 *
 * @param round - 待完成的 Round（通常来自 `createPendingRoundFixture`）
 * @param assistantContent - AI 回复正文
 * @param tokenUsage - 可选的 token 用量
 * @returns 新构造的 complete Round（未落盘，需调用方 `store.save`）
 */
export function completeRoundFixture(
  round: Round,
  assistantContent: string,
  tokenUsage?: { input: number; output: number },
): Round {
  const now = new Date().toISOString();

  return {
    ...round,
    assistantMessage: {
      id: generateMessageId(),
      role: 'assistant',
      content: assistantContent,
      timestamp: now,
      tokenUsage,
    },
    status: 'complete',
    completedAt: now,
  };
}
