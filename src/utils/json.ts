/**
 * JSON 工具函数
 *
 * 从 InsightExtractor 和 WorkProjectionManager 提取的公共 JSON 解析函数，
 * 统一 LLM 输出的 JSON 解析策略。
 */

/**
 * 从 LLM 输出中解析 JSON
 *
 * 解析策略（逐级回退）：
 *   1. 直接 JSON.parse
 *   2. 剥离 markdown 代码块标记后重试
 *   3. 修复常见错误（单引号、尾逗号）后重试
 *   4. 正则提取首个 JSON 对象
 *
 * @param raw - LLM 原始输出文本
 * @returns 解析结果，解析失败返回 null
 */
export function parseLlmJson<T = unknown>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null') return null;

  // 1. 直接解析
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // 继续
  }

  // 2. 剥离 markdown 代码块标记（```json ... ```）
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    } catch {
      // 继续
    }
  }

  // 3. 修复常见错误后重试
  // 只替换作为 JSON key/value 定界符的单引号，不替换字符串内容中的单引号
  // 匹配模式：单引号紧跟在 {, [, :, , 后面（定界符位置），或紧靠在 }, ], ,, : 前面
  const fixed = trimmed
    .replace(/(?<=[{\[:,\s])'|'(?=[}\]:,\s])/g, '"')
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  try {
    return JSON.parse(fixed) as T;
  } catch {
    // 继续
  }

  // 4. 正则提取首个 JSON 对象
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as T;
    } catch {
      // 放弃
    }
  }

  return null;
}
