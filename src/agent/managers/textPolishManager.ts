/**
 * 文本润色管理器 — 对用户输入文本进行 LLM 润色（语法修正 + 表达优化）
 *
 * 职责：
 *   - 接收原始文本，调用 LLM 输出润色后的文本
 *   - 不修改原始语义，仅修正语法/拼写/表达流畅度
 *   - 不存储记忆、不触发归档、不注入对话上下文
 *
 * 使用场景：
 *   - 快速输入浮窗的"润色"按钮：用户输入草稿 → 点击润色 → LLM 返回优化后文本
 *
 * 设计原则：
 *   - 独立于 Agent 生命周期，仅依赖 Provider
 *   - 润色失败不影响主对话流程（fire-and-forget）
 *   - 参照 WorkProjectionManager 的 system+user 双消息 + 流式累积模式
 *
 * 分层说明：
 *   本模块位于 agent/ 层（非 memory/ 层），因为它依赖 LlmProvider 做内容生成。
 *   memory/ 层只做存储和召回，不做 LLM 调用。
 */
import type { LlmProvider, Message } from '@/llm/provider.js';
import { logger } from '@/logging/logger.js';

/** 润色请求超时（ms），单次润色应快速完成 */
const POLISH_TIMEOUT_MS = 15_000;

/** 润色输入文本截断上限（字符），控制 LLM token 消耗 */
const POLISH_INPUT_LIMIT = 2000;

// ─── 类型 ────────────────────────────────────────────────

/** 润色结果 */
export interface PolishResult {
  /** 润色后的文本 */
  polished: string;
  /** 是否与原文本不同（false 表示 LLM 认为无需修改） */
  changed: boolean;
}

// ─── Prompt 模板（模块级函数，与 InsightExtractor 的 buildExtractionPrompt 同模式） ───

/**
 * 构建文本润色 prompt
 *
 * 设计要点：
 *   - system 消息定义润色规则（不修改语义、不添加内容、不改变语气）
 *   - user 消息携带待润色文本
 *   - 要求仅输出润色后文本（不含解释、不含 markdown 标记）
 *
 * @param text 待润色的原始文本
 * @returns system + user 消息数组
 */
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

/**
 * 文本润色管理器
 *
 * 构造函数注入 LlmProvider（由 assembler 创建时注入），
 * 调用 polish() 方法对文本进行 LLM 润色。
 *
 * 使用方式：
 *   const polisher = new TextPolishManager(provider);
 *   const result = await polisher.polish('原始文本');
 *   // result.polished → 润色后文本
 */
export class TextPolishManager {
  /** LLM Provider（构造函数注入，参照 InsightExtractor 模式） */
  private readonly provider: LlmProvider;

  /**
   * @param provider LLM Provider（由 assembler 注入，优先后台 Provider 降级前台）
   */
  constructor(provider: LlmProvider) {
    this.provider = provider;
  }

  /**
   * 润色文本
   *
   * 调用 LLM 对输入文本进行润色（语法修正 + 表达优化），
   * 使用流式累积模式（与 WorkProjectionManager.generate 一致）。
   *
   * 输入截断到 2000 字符（控制 token 消耗），
   * 15s 超时（润色应快速完成，超时抛出异常）。
   *
   * @param text 待润色的原始文本
   * @param signal 可选的 AbortSignal（用于取消正在进行的润色请求）
   * @returns 润色结果（polished + changed）
   */
  async polish(text: string, signal?: AbortSignal): Promise<PolishResult> {
    // 截断过长的输入（控制 token 消耗）
    const truncated = text.slice(0, POLISH_INPUT_LIMIT);

    const messages = buildPolishMessages(truncated);

    // 流式累积模式（与 WorkProjectionManager.generate / InsightExtractor.extract 一致）
    let result = '';
    try {
      for await (const chunk of this.provider.chat(messages, {
        maxTokens: 500,
        temperature: 0.3,
        timeoutMs: POLISH_TIMEOUT_MS,
        signal,
      })) {
        if (chunk.content) {
          result += chunk.content;
        }
      }
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