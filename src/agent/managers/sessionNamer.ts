/**
 * 会话命名器（SessionNamer · ADR-024 会话标题层）
 *
 * 职责：
 *   为新建会话生成用户可读标题，写入会话标题元数据（setSessionTitle）。
 *   标题是独立展示元数据，与会话身份（date-session）解耦，不污染主键。
 *
 * 触发时机：
 *   仅"新建会话的第一次问答闭环"触发（ensureSessionTitle）。
 *   判定以"会话尚无标题"为准——新建会话首轮问答前必然无标题，
 *   手动改名后 title 非空即不再覆盖，天然满足"只触发一次"，无需粘性锁定。
 *
 * 降级策略：
 *   - sessionStore 未注入：静默跳过（best-effort）
 *   - 会话已有标题：跳过（不覆盖手动改名）
 *   - LLM 不可用 / 失败 / 无价值：降级为"新会话 HH:MM"占位（借鉴 WorkBuddy 占位式）
 *
 * 设计：
 *   - 与 SessionArchiver 同形态：复用公共 accumulateStream + parseLlmJson 管线
 *   - 通过 getProvider 惰性获取当前 LLM Provider（setProvider 切换后仍命中最新模型）
 *   - 不依赖 Agent 实例，仅依赖 ISessionStore 的标题元数据能力
 */

import { logger } from '@/logging/logger.js';
import { parseLlmJson } from '@/utils/json.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';

/** 标题最大字符数（防止 LLM 输出超长标题） */
const MAX_TITLE_CHARS = 30;

/**
 * 会话命名器
 *
 * 为会话生成标题，写入会话标题元数据。best-effort，不阻塞主流程。
 */
export class SessionNamer {
  /** 惰性获取当前 LLM Provider（setProvider 切换后仍取最新） */
  private getProvider: () => LlmProvider;
  /** 会话存储（读取/写入会话标题元数据） */
  private sessionStore: ISessionStore | undefined;

  constructor(options: {
    /** 惰性获取当前 LLM Provider */
    getProvider: () => LlmProvider;
    /** 会话存储（可选，未注入则标题层静默失效） */
    sessionStore?: ISessionStore;
  }) {
    this.getProvider = options.getProvider;
    this.sessionStore = options.sessionStore;
  }

  /**
   * 确保会话拥有标题（仅新建会话首次问答触发）
   *
   * 流程：
   *   1. 若会话已有标题，跳过（不覆盖手动改名）
   *   2. 调用 LLM 从首条用户消息生成一句话标题
   *   3. 失败/无价值时降级为"新会话 HH:MM"占位
   *   4. 写入会话标题元数据
   *
   * best-effort：任何异常都不抛出，由调用方 fire-and-forget。
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识（不含日期前缀）
   * @param firstUserContent 首条用户消息内容（标题语义贴合用户意图）
   */
  async ensureSessionTitle(
    date: string,
    session: string,
    firstUserContent: string,
  ): Promise<void> {
    if (!this.sessionStore) {
      logger.debug({ hasSessionStore: false }, 'SessionNamer: 未注入 sessionStore，跳过命名');
      return;
    }

    const sessionId = `${date}-${session}`;

    // 会话已有标题则跳过 —— 决策3：仅新建会话首次触发，不覆盖手动改名
    const existing = this.sessionStore.getSessionMeta?.(sessionId);
    if (existing?.title) {
      logger.debug({ sessionId, title: existing.title }, 'SessionNamer: 会话已有标题，跳过');
      return;
    }

    // 生成标题（LLM 失败或无价值时降级为占位，不阻塞）
    let title: string;
    try {
      title = (await this.generateTitle(firstUserContent)) ?? defaultTitle();
    } catch (err) {
      logger.warn({ err, sessionId }, 'SessionNamer: 标题生成失败，降级为占位');
      title = defaultTitle();
    }

    // 写入会话标题元数据（宿主未实现 setSessionTitle 时静默失效）
    this.sessionStore.setSessionTitle?.(sessionId, title);
    logger.info({ sessionId, title }, 'SessionNamer: 会话标题已生成');
  }

  /**
   * 调用 LLM 生成一句话标题
   *
   * 复用 accumulateStream + parseLlmJson 管线（与 SessionArchiver 一致）。
   * LLM 无价值（空消息/纯打招呼）时返回 null，由调用方降级为占位。
   *
   * @param content 首条用户消息内容
   * @returns 标题字符串，无价值返回 null
   */
  private async generateTitle(content: string): Promise<string | null> {
    const prompt = `你是会话命名助手。请根据用户的第一条消息，为会话生成一个简短标题（10 字以内），用于在历史列表中识别。

要求：
1. 一句话概括用户的意图/主题
2. 不超过 10 个汉字，简洁精炼
3. 输出 JSON：{"title": "标题"}
4. 若消息为空或纯打招呼（如"你好"、"在吗"），输出 null

=== 用户第一条消息 ===
${content}
=== 结束 ===`;

    const llmMessages: Message[] = [{ role: 'user', content: prompt }];
    // 流式累积（复用 accumulateStream 工具函数）
    const llmResponse = await accumulateStream(this.getProvider(), llmMessages);

    // 解析 LLM 响应
    const trimmed = llmResponse.trim();
    if (!trimmed || trimmed === 'null') {
      return null;
    }

    const parsed = parseLlmJson<{ title?: string }>(trimmed);
    const title = parsed && typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : null;

    if (!title) {
      return null;
    }
    // 截断超长标题，防止撑爆展示
    return title.length > MAX_TITLE_CHARS
      ? title.slice(0, MAX_TITLE_CHARS)
      : title;
  }
}

/**
 * 生成占位标题（LLM 不可用/失败/无价值时降级）
 *
 * 格式："新会话 HH:MM"（借鉴 WorkBuddy 占位式命名，best-effort 不阻塞）。
 *
 * @returns 占位标题
 */
function defaultTitle(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `新会话 ${hh}:${mm}`;
}