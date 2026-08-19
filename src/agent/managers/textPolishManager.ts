/**
 * 文本润色管理器 — 对用户输入做 LLM 润色（语法修正 + 表达优化）。
 * 不修改语义、不存储记忆、不触发归档、不注入上下文；独立于 Agent 生命周期仅依赖 Provider。
 * 位于 agent/ 层（依赖 LlmProvider 做生成，memory/ 层只做存储召回不做 LLM 调用）。润色失败 fire-and-forget 不阻塞主流程。
 */
import type { LlmProvider, Message } from '@/llm/provider.js';
import { logger } from '@/logging/logger.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';

/** 润色请求超时（ms），单次润色应快速完成 */
const POLISH_TIMEOUT_MS = 15_000;
/** 润色输入截断上限（字符），控制 LLM token 消耗 */
const POLISH_INPUT_LIMIT = 2000;

// ─── 类型 ────────────────────────────────────────────────

/** 润色结果 */
export interface PolishResult {
  /** 润色后的文本 */
  polished: string;
  /** 是否与原文本不同（false 表示 LLM 认为无需修改） */
  changed: boolean;
}

// ─── Prompt 模板（模块级函数） ───────────────────────────

/** 构建润色 prompt：system 定义润色规则（不改语义/不加内容/不变语气）+ user 携带待润色文本；要求仅输出润色后文本 */
function buildPolishMessages(text: string): Message[] {
  return [
    {
      role: 'system',
      content: `你是文本润色助手。润色用户输入的文本，使其更流畅、更准确。

        规则：
        - 仅修正语法错误、拼写错误、标点错误
        - 优化表达流畅度（冗余句子精简、拗口句子重组）
        - 不修改原文的语义、语气、风格
        - 不添加原文没有的信息
        - 不解释修改内容
        - 直接输出润色后的文本，不要加任何前缀、后缀或 markdown 标记`,
    },
    {
      role: 'user',
      content: text,
    },
  ];
}

/** 文本润色管理器：构造注入 LlmProvider（assembler 创建），调用 polish() 润色 */
export class TextPolishManager {
  /** LLM Provider（构造函数注入） */
  private readonly provider: LlmProvider;

  /** @param provider LLM Provider（assembler 注入，优先后台降级前台） */
  constructor(provider: LlmProvider) {
    this.provider = provider;
  }

  /**
   * 润色文本（语法修正 + 表达优化），流式累积模式（与 WorkProjectionManager.generate 一致）。
   * 输入截断 2000 字符控 token；15s 超时（润色应快速完成）。
   */
  async polish(text: string, signal?: AbortSignal): Promise<PolishResult> {
    // 截断过长输入（控 token）
    const truncated = text.slice(0, POLISH_INPUT_LIMIT);

    const messages = buildPolishMessages(truncated);

    let result = '';
    try {
      result = await accumulateStream(this.provider, messages, {
        maxTokens: 500,
        temperature: 0.3,
        timeoutMs: POLISH_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      logger.warn({ error }, '文本润色 LLM 调用失败');
      throw error;
    }

    // 去除首尾空白（LLM 可能输出多余换行）
    const polished = result.trim();
    const changed = polished !== text && polished.length > 0;

    return { polished: changed ? polished : text, changed };
  }
}