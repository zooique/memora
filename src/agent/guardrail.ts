/**
 * 护栏模块 — 输入/输出内容安全检查
 *
 * 从 AgentLoop 提取的独立模块，职责单一：
 * 遍历 guardrail 规则，用正则匹配输入/输出文本，
 * 命中 block action 时返回 blocked=true。
 *
 * 护栏自身异常（正则编译失败等）降级为"放行 + 记日志 + 通知宿主"，
 * 永远不阻断用户对话（降级优先原则）。
 *
 * 设计说明：
 * - 输入/输出共享同一护栏规则集和同一检查逻辑
 * - 规则格式：Memory.content 中包含 `pattern: /regex/` 和 `action: block|warn`
 * - 无状态纯函数，由 AgentLoop 调用
 */
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';

/** 护栏检查结果 */
export interface GuardrailResult {
  /** 是否阻断（block action 命中时为 true） */
  blocked: boolean;
  /** 阻断时的提示消息（传给用户） */
  message?: string;
  /** 警告时的提示消息（warn action 命中时仍放行，但附带警告） */
  warning?: string;
}

/** 护栏 UI 消息接口（从 UIMessages 中提取护栏相关字段） */
export interface GuardrailUI {
  /** 输入被阻断时的消息生成函数 */
  inputBlockedByGuard: (rule: string) => string;
  /** 护栏规则正则编译失败时的回调（宿主可据此发射事件通知用户） */
  onRegexError?: (rule: string, message: string) => void;
}

/**
 * 运行护栏检查
 *
 * 遍历所有 guardrail 规则，用正则匹配输入文本。
 * 命中 block action 时返回 blocked=true；
 * 命中 warn action 时返回 blocked=false + warning。
 *
 * 护栏自身异常（正则编译失败等）降级为"放行 + 记日志 + 通知宿主"，
 * 永远不阻断用户对话（降级优先原则）。
 *
 * @param rules - 护栏规则记忆数组（source='guardrail' 的 Memory）
 * @param input - 待检查的文本（用户输入或 LLM 输出）
 * @param ui - UI 消息接口（用于生成阻断/警告提示文案）
 * @returns 护栏检查结果
 */
export function runGuardrails(
  rules: readonly Memory[],
  input: string,
  ui: GuardrailUI,
): GuardrailResult {
  // 无规则时直接放行（快速路径）
  if (rules.length === 0) return { blocked: false };

  for (const rule of rules) {
    try {
      // 从记忆内容中提取 pattern（格式：pattern: /regex/ action: block|warn）
      // 非贪婪 + 正向预查止步于 `action:`：单行格式 `pattern: /暴力/ action: block`
      // 也能正确切出 /暴力/，不再把 `action: block` 整段吞入 pattern 导致 fail-open。
      const patternMatch = rule.content.match(/pattern:\s*(\S.*?)(?=\s+action:|$)/);
      const actionMatch = rule.content.match(/action:\s*(block|warn)/);
      if (!patternMatch || !actionMatch) continue;

      const pattern = patternMatch[1]?.trim();
      const action = actionMatch[1]?.trim();
      if (!pattern || !action) continue;

      // 去掉正则定界符 //（仅当被 / 完整包围时，避免误剥内容中的 /）
      const regexStr =
        pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')
          ? pattern.slice(1, -1)
          : pattern;
      // 编译失败（用户写错正则）被下方 catch 捕获，记 error 并跳过该规则，
      // 不再像旧实现那样静默放行（旧实现因贪婪匹配生成非法字面量正则，永远不匹配）。
      const regex = new RegExp(regexStr, 'i');

      if (regex.test(input)) {
        if (action === 'block') {
          logger.warn({ rule: rule.name, pattern: regexStr }, '输入护栏阻断');
          return { blocked: true, message: ui.inputBlockedByGuard(rule.name) };
        }
        logger.warn({ rule: rule.name, pattern: regexStr }, '输入护栏警告');
        return { blocked: false, warning: ui.inputBlockedByGuard(rule.name) };
      }
    } catch (err) {
      // 护栏自身异常降级：放行 + 记日志 + 通知宿主
      logger.error({ rule: rule.name, err }, '护栏规则执行异常，已降级放行');
      const errMessage = err instanceof Error ? err.message : String(err);
      ui.onRegexError?.(rule.name, errMessage);
    }
  }
  return { blocked: false };
}
