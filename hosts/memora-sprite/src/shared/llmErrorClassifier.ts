/**
 * LLM 错误分类器（跨进程纯函数）
 *
 * 职责：
 *   将底层 LLM API 错误消息（如 "401 Unauthorized"、"ECONNREFUSED"、
 *   "fetch failed"）映射为用户可理解的中文提示，帮助首次配置用户
 *   快速定位问题（API Key 错 / 模型名错 / 网络不通 / 额度耗尽等）。
 *
 * 设计：
 *   - 纯函数，无 Node/浏览器依赖，主进程和渲染进程共用
 *   - 基于正则模式匹配，覆盖主流 OpenAI 兼容协议错误形态
 *   - 未匹配时回退到原始错误消息（保留技术细节供高级用户排查）
 *
 * 提取原因（ADR-017 枝叶层 2 次提取）：
 *   onboarding 步骤2 测试连接 + minimalHandlers LLM_CONFIG_TEST handler
 *   都需要错误映射，提取为独立 helper 避免重复实现。
 *
 * 使用：
 *   import { classifyLlmError } from '../../shared/llmErrorClassifier.js';
 *   const friendly = classifyLlmError(rawErrorMessage);
 */

// ─── 错误模式映射表 ────────────────────────────────────────

/**
 * LLM 错误模式映射条目
 *
 * pattern：匹配原始错误消息的正则（大小写不敏感）
 * message：用户可理解的中文提示
 */
interface LlmErrorPattern {
  pattern: RegExp;
  message: string;
}

/**
 * 已知 LLM 错误模式列表（按匹配优先级排序）
 *
 * 排序原则：越具体的模式越靠前，避免被通用模式提前匹配。
 * 例如 "401" 必须在 "network" 之前，因为某些 401 错误消息也可能包含网络字样。
 */
const LLM_ERROR_PATTERNS: readonly LlmErrorPattern[] = [
  // ─── 认证/授权类（最常见，首次配置用户最易踩坑） ───
  {
    pattern: /401|unauthorized|invalid api key|invalid apikey|authentication/i,
    message: 'API Key 无效，请检查是否复制完整（注意前后不要有空格）',
  },
  {
    pattern: /403|forbidden|permission denied|access denied/i,
    message: 'API Key 无权访问该模型，请检查账户额度或模型权限',
  },

  // ─── 模型/资源类 ───
  {
    pattern: /404|not found|model not found|model.*not exist|does not exist/i,
    message: '模型不存在，请检查模型名称拼写（如 deepseek-chat 而非 deepseek）',
  },
  {
    pattern: /context.*length|token.*limit|maximum context/i,
    message: '上下文长度超限，请缩短输入或切换支持更长上下文的模型',
  },

  // ─── 速率/额度类 ───
  {
    pattern: /429|rate limit|rate limit exceeded|too many requests/i,
    message: '请求过于频繁或额度已用尽，请稍后重试或检查账户余额',
  },
  {
    pattern: /insufficient.*balance|quota.*exceeded|余额不足|额度不足/i,
    message: '账户余额不足，请充值后重试',
  },

  // ─── 网络类（baseUrl 错误或网络不通） ───
  {
    pattern: /econnrefused|enotfound|ehostunreach|enetunreach/i,
    message: '无法连接服务器，请检查 API 地址（baseUrl）是否正确',
  },
  {
    pattern: /etimedout|timeout|timed out|请求超时/i,
    message: '请求超时，请检查网络连接或稍后重试',
  },
  {
    pattern: /fetch failed|network error|网络错误|连接失败/i,
    message: '网络连接失败，请检查网络或 API 地址是否可访问',
  },
  {
    pattern: /ssl|certificate|cert/i,
    message: 'SSL 证书验证失败，请检查 API 地址协议（http/https）是否正确',
  },

  // ─── 服务端类 ───
  {
    pattern: /500|internal server error|service unavailable|502|503|504/i,
    message: '服务端临时不可用，请稍后重试',
  },

  // ─── 协议/配置类 ───
  {
    pattern: /base url|invalid url|协议错误|invalid protocol/i,
    message: 'API 地址格式错误，请确认以 https:// 开头且无多余路径',
  },
  {
    pattern: /empty response|返回空响应|空响应/i,
    message: 'LLM 返回空响应，请检查模型名称是否正确或更换模型',
  },
];

// ─── 公共函数 ─────────────────────────────────────────────

/**
 * 将 LLM 错误消息分类为用户友好的中文提示
 *
 * 匹配流程：
 *   1. 按 LLM_ERROR_PATTERNS 顺序匹配（具体模式优先）
 *   2. 命中则返回对应的 message
 *   3. 全部未命中则回退到原始错误消息（保留技术细节）
 *
 * @param rawError 原始错误消息（来自 fetch 异常、HTTP 响应体、LLM SDK 等）
 * @returns 用户友好的中文提示（未匹配时返回原始消息）
 *
 * @example
 * classifyLlmError('401 Unauthorized') // 'API Key 无效，请检查是否复制完整（注意前后不要有空格）'
 * classifyLlmError('connect ECONNREFUSED 127.0.0.1:443') // '无法连接服务器，请检查 API 地址（baseUrl）是否正确'
 * classifyLlmError('some unknown error') // 'some unknown error'
 */
export function classifyLlmError(rawError: string): string {
  // 空值兜底：避免后续 .match 报错
  if (!rawError) return '未知错误';

  // 按优先级顺序匹配，首个命中的模式胜出
  for (const { pattern, message } of LLM_ERROR_PATTERNS) {
    if (pattern.test(rawError)) {
      return message;
    }
  }

  // 未匹配任何已知模式，回退到原始消息
  return rawError;
}
