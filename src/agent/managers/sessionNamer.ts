/**
 * 会话命名器：为新建会话生成 autoName + displayName 写入元数据，标题与会话身份（date-session）解耦。
 * 触发时机：仅"新建会话首次问答"触发——判定以"会话尚无 autoName"为准，有即不覆盖，天然只触发一次。
 * 降级：sessionStore 未注入静默跳过；LLM 失败/无价值**不写 autoName**（读侧现算占位标题，下一轮可重试）。
 * getProvider 惰性获取当前 Provider。
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
  /** 标题更新回调（可选，用于通知 Agent 发射事件） */
  private onTitleUpdated?: (sessionId: string, title: string) => void;

  constructor(options: {
    /** 惰性获取当前 LLM Provider */
    getProvider: () => LlmProvider;
    /** 会话存储（可选，未注入则标题层静默失效） */
    sessionStore?: ISessionStore;
    /** 标题更新回调（可选，标题生成后触发） */
    onTitleUpdated?: (sessionId: string, title: string) => void;
  }) {
    this.getProvider = options.getProvider;
    this.sessionStore = options.sessionStore;
    this.onTitleUpdated = options.onTitleUpdated;
  }

  /**
   * 确保会话拥有 autoName（仅新建会话首次问答触发）。已有 autoName 则跳过（不覆盖）。
   *
   * 失败语义（2026-11-07 修正）：LLM 失败 / 无价值时**什么都不写**，只留一条 warn。
   * 旧实现把 `defaultTitle()` 占位串同时写进 autoName，等于把「一次失败」永久记为「已命名」，
   * 后续每轮都被 `existing.autoName` 命中而跳过 —— 真机上表现为标题永远是「新会话 HH:MM」。
   * 现在占位标题由读侧按创建时间现算，命名只承载**真实标题**，失败留待下一轮重试。
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

    // 生成标题：失败 / 无价值一律为 null（不降级写入，下一轮重试）
    let title: string | null = null;
    try {
      title = await this.generateTitle(firstUserContent);
    } catch (err) {
      logger.warn({ err, sessionId }, 'SessionNamer: 标题生成失败，本轮不写，下一轮重试');
    }
    if (!title) {
      logger.warn({ sessionId }, 'SessionNamer: 未取得有效标题，本轮不写，下一轮重试');
      return;
    }

    // autoName 为 LLM 生成只读名；displayName 初始值一致、用户可修改
    this.sessionStore.updateSessionMeta?.(sessionId, {
      autoName: title,
      displayName: title,
    });
    logger.info({ sessionId, autoName: title }, 'SessionNamer: 会话 autoName 已生成');

    // 触发标题更新回调（通知 Agent 发射事件，宿主据此刷新 UI）
    if (this.onTitleUpdated) {
      try {
        this.onTitleUpdated(sessionId, title);
      } catch (err) {
        logger.warn({ err, sessionId }, 'SessionNamer: onTitleUpdated 回调异常，已忽略');
      }
    }
  }

  /** 调用 LLM 生成一句话标题：复用 accumulateStream + parseLlmJson（与 SessionArchiver 一致）；无价值（空消息/打招呼）返回 null，调用方本轮不写、下一轮重试 */
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

/** 生成占位标题（"新会话 HH:MM"）。导出供宿主复用，单一真理源避免重复实现。
 *
 * 时间口径 = **会话创建时刻**，不是调用时刻：占位标题代表「某时创建、尚未命名」，
 * 每次读时现算 `new Date()` 会让同一会话标题随刷新变化（用户只会当 bug）。
 *
 * @param createdAt 会话创建时刻（来源：`sessionIdCreatedAt(sessionId)` 或 meta.createdAt）
 */
export function defaultTitle(createdAt: Date | string | number = new Date()): string {
  const at = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(at.getTime())) return '新会话';
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `新会话 ${hh}:${mm}`;
}
