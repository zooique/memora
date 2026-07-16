/**
 * 角色语义匹配器 — LLM 辅助角色匹配（agent 层纯函数模块）
 *
 * 从 PersonaManager.matchByLlm 迁移至此，遵循 backend_layers_rules §分层职责：
 * persona/ 不直接调 LLM，agent/ 可通过 provider 接口调 LLM。
 *
 * 与 userFactExtractor.ts 同级，为 agent/ 根级纯函数模块（非有状态 Manager）。
 */
import type { LlmProvider } from '@/llm/provider.js';
import type { Persona } from '@/persona/types.js';
import { logger } from '@/logging/logger.js';

/** LLM 辅助匹配的 maxTokens 上限（角色名很短，无需长响应） */
const LLM_MATCH_MAX_TOKENS = 50;

/**
 * LLM 辅助语义角色匹配
 *
 * 当关键词匹配低置信度或无命中时，由 agent 层调用此函数进行语义级匹配。
 *
 * 降级策略：
 *   - LLM 调用失败/超时 → 返回 null（由调用方降级处理）
 *   - LLM 返回无效角色名 → 返回 null（防止幻觉）
 *   - LLM 返回 "none" → 返回 null（明确无匹配）
 *   - 候选列表为空（排除当前角色后） → 返回 null
 *
 * @param provider 后台 LLM Provider
 * @param personaList 完整角色列表（函数内部排除当前激活角色）
 * @param activePersonaName 当前激活角色名（排除自身，避免无意义切换）
 * @param userInput 用户输入文本
 * @returns 匹配的角色名，无匹配/失败返回 null
 */
export async function matchPersonaByLlm(
  provider: LlmProvider,
  personaList: Persona[],
  activePersonaName: string | undefined,
  userInput: string,
): Promise<string | null> {
  // 排除当前激活角色（避免无意义切换）
  const candidates = personaList.filter((p) => p.name !== activePersonaName);
  if (candidates.length === 0) return null;

  // 构造角色列表描述（name + description/content 前缀 + keywords）
  const personaListText = candidates
    .map((p) => {
      const desc = p.description ?? p.content.substring(0, 50).trim();
      return `- ${p.name}：${desc}（关键词：${p.keywords.join(', ')}）`;
    })
    .join('\n');

  try {
    const stream = provider.chat(
      [
        {
          role: 'system',
          content:
            '你是角色匹配助手。根据用户输入，从以下角色中选择最匹配的一个。\n\n' +
            `角色列表：\n${personaListText}\n\n` +
            '规则：\n1. 只返回角色名，不解释\n2. 无匹配返回 "none"',
        },
        { role: 'user', content: userInput },
      ],
      { maxTokens: LLM_MATCH_MAX_TOKENS, temperature: 0 },
    );

    let result = '';
    for await (const chunk of stream) {
      if (chunk.content) result += chunk.content;
    }

    const trimmed = result.trim();
    if (!trimmed || trimmed === 'none') return null;

    // 验证返回的角色名在候选列表中（防止 LLM 幻觉）
    const matched = candidates.find((p) => p.name === trimmed);
    return matched ? matched.name : null;
  } catch (err) {
    logger.warn({ err }, 'LLM 辅助角色匹配失败，降级为关键词匹配');
    return null;
  }
}
