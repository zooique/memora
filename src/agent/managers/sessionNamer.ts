/**
 * 会话命名器：为新建会话生成 autoName + displayName 写入元数据，标题与会话身份（date-session）解耦。
 * 触发时机：仅"新建会话首次问答"触发——判定以"会话尚无 autoName"为准，有即不覆盖，天然只触发一次。
 * 降级：sessionStore 未注入静默跳过；LLM 失败/无价值降级为"新会话 HH:MM"占位。getProvider 惰性获取当前 Provider。
 */

import { logger } from '@/logging/logger.js';
import { parseLlmJson } from '@/utils/json.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';

/** 标题最大字符数（防 LLM 输出超长标题） */
const MAX_TITLE_CHARS = 30;

/** 会话命名器：为会话生成标题写入元数据。best-effort，不阻塞主流程。 */
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
   * 确保会话拥有 autoName（仅新建会话首次问答触发）。已有 autoName 则跳过（不覆盖）。
   * LLM 失败/无价值降级为"新会话 HH:MM"占位；写入 autoName + displayName（初始一致，用户可后续改 displayName）。
   * best-effort：不抛异常，由调用方 fire-and-forget。
   */
  async ensureSessionTitle(date: string, session: string, firstUserContent: string): Promise<void> {
    if (!this.sessionStore) {
      logger.debug({ hasSessionStore: false }, 'SessionNamer: 未注入 sessionStore，跳过命名');
      return;
    }

    const sessionId = `${date}-${session}`;

    // 会话已有 autoName 则跳过 —— 仅新建会话首次触发
    const existing = this.sessionStore.getSessionMeta?.(sessionId);
    if (existing?.autoName) {
      logger.debug(
        { sessionId, autoName: existing.autoName },
        'SessionNamer: 会话已有 autoName，跳过',
      );
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

    // autoName 为 LLM 生成只读名；displayName 初始值一致、用户可修改
    this.sessionStore.updateSessionMeta?.(sessionId, {
      autoName: title,
      displayName: title,
    });
    logger.info({ sessionId, autoName: title }, 'SessionNamer: 会话 autoName 已生成');
  }

  /** 调用 LLM 生成一句话标题：复用 accumulateStream + parseLlmJson（与 SessionArchiver 一致）；无价值（空消息/打招呼）返回 null 由调用方降级 */
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
    const llmResponse = await accumulateStream(this.getProvider(), llmMessages);

    // 解析 LLM 响应（'null' 或无标题视为无价值）
    const trimmed = llmResponse.trim();
    if (!trimmed || trimmed === 'null') {
      return null;
    }

    const parsed = parseLlmJson<{ title?: string }>(trimmed);
    const title =
      parsed && typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : null;

    if (!title) {
      return null;
    }
    // 截断超长标题，防止撑爆展示
    return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title;
  }
}

/** 生成占位标题（LLM 不可用/失败/无价值时降级）："新会话 HH:MM"。导出供宿主复用，单一真理源避免重复实现 */
export function defaultTitle(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `新会话 ${hh}:${mm}`;
}
