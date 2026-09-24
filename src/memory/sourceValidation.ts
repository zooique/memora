/**
 * Source 校验工具 — 从 memory/types.ts 提取的运行时函数
 *
 * 职责：
 * - escapeLike：转义 SQL LIKE 通配符（须配套 SQL 的 `ESCAPE '\'` 子句，否则转义失效）
 * - validateSource：校验 source 字段安全性和拼写
 * - levenshtein：简单编辑距离计算（输入限短字符串；本文件 :121 用于标签 typo 检测，另导出供 DedupManager 名称相似度复用）
 *
 * 设计原则：
 * - source 是开放字符串，新增来源无需改代码
 * - 校验仅做 typo 检测，不阻止写入（保持开放性）
 * - 安全边界（路径遍历、null 字节）必须拒绝
 */
import { SOURCE_LABELS } from '@/memory/types.js';

/**
 * source 校验严重级别
 *
 * - 'block'：安全边界违规，调用方必须拒绝写入（throw）
 * - 'warn'：调用方 bug 或疑似 typo，应 warn 但允许写入
 * - undefined：无异常
 */
export type SourceValidationSeverity = 'block' | 'warn';

/**
 * 已知 source 标签集合（用于运行时校验）
 *
 * 从 SOURCE_LABELS 常量自动派生，保持同步。
 * 不是枚举——只用于 typo 检测，不阻止写入。
 */
const KNOWN_SOURCES: Set<string> = new Set(Object.values(SOURCE_LABELS));

/**
 * 转义 LIKE 通配符（`%` → `\%`、`_` → `\_`）
 *
 * ⚠️ 必须与 SQL 的 `ESCAPE '\'` 配套使用，即 `LIKE ? ESCAPE '\'`：
 * 未写 ESCAPE 子句时反斜杠被当作普通字符，转义后的模式匹配不到任何含 `%`/`_` 的字面值，
 * 查询静默返回空——比不转义更隐蔽（不转义是过度召回，漏转义是零召回）。
 * 参数本身仍须用 `?` 占位绑定，转义只解决语义、不解决注入。
 *
 * @param str - 原始字符串
 * @returns 转义后的字符串
 */
export function escapeLike(str: string): string {
  return str.replace(/[%_]/g, '\\$&');
}

/**
 * 截取字符串前 maxLen 字符后转义 LIKE 通配符
 *
 * 用于将用户输入 / round-summary 记忆文本作为关键词搜索 SQL LIKE 查询的输入。
 * 截断避免超长输入导致 LIKE 解析性能问题，转义防止通配符被当作模式符。
 * 同 `escapeLike`：SQL 侧必须写 `LIKE ? ESCAPE '\'`，否则转义后的模式查不到字面值。
 *
 * @param text - 原始文本（用户输入 / round-summary 内容）
 * @param maxLen - 最大截取长度，默认 50
 * @returns 截断 + 转义后的字符串
 */
export function escapeLikeSnippet(text: string, maxLen = 50): string {
  return escapeLike(text.slice(0, maxLen));
}

/**
 * 校验 source 字段是否为已知标签
 *
 * 返回校验结果，包含严重级别与警告信息（如有）。
 *
 * 分级策略：
 * - 路径遍历（`..`）与 null 字节 → severity='block'（安全边界，必须拒绝）
 * - 空字符串、非字符串、首尾空格 → severity='block'（调用方 bug，必须拒绝）
 * - 与已知标签 Levenshtein 距离 ≤ 2 的疑似 typo → severity='warn'（保持开放性）
 * - 其他自定义 source → valid: true（完全允许）
 *
 * @param source - 待校验的 source 字符串
 * @returns 校验结果
 */
export function validateSource(source: string): {
  valid: boolean;
  severity?: SourceValidationSeverity;
  warning?: string;
} {
  if (!source || typeof source !== 'string') {
    return {
      valid: false,
      severity: 'block',
      warning: `source 不能为空或非字符串，收到：${String(source)}`,
    };
  }

  if (source.trim() !== source) {
    return {
      valid: false,
      severity: 'block',
      warning: `source 包含首尾空格："${source}"`,
    };
  }

  if (source.includes('..')) {
    return {
      valid: false,
      severity: 'block',
      warning: `source 不能包含路径遍历序列："${source}"`,
    };
  }

  // 路径分隔符（/ 或 \）同样构成目录穿越：source="rules/secret" 可落入保留的
  // rules/ 目录子树，污染命名空间。source 是扁平标签，必须拒绝分隔符。
  if (source.includes('/') || source.includes('\\')) {
    return {
      valid: false,
      severity: 'block',
      warning: `source 不能包含路径分隔符（/ 或 \\）："${source}"`,
    };
  }

  if (source.includes('\0')) {
    return {
      valid: false,
      severity: 'block',
      warning: `source 不能包含 null 字节`,
    };
  }

  // 检查与已知标签的相似度（简单 Levenshtein 距离 ≤ 2）
  if (!KNOWN_SOURCES.has(source)) {
    const closeMatch = [...KNOWN_SOURCES].find(
      (known) => levenshtein(source, known) <= 2 && source !== known,
    );
    if (closeMatch) {
      return {
        valid: true,
        severity: 'warn',
        warning: `source "${source}" 可能是 "${closeMatch}" 的拼写错误（已知标签：${[...KNOWN_SOURCES].join(', ')}）`,
      };
    }
  }

  return { valid: true };
}

/**
 * 简单 Levenshtein 距离计算（仅用于短字符串，不做优化）
 *
 * 同文件 :121 用于标签 typo 检测；另导出供 DedupManager（语义去重场景的名称相似度）复用。
 */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  // 移除非空断言：提取局部变量并 null 检查
  const row0 = matrix[0];
  if (row0) for (let j = 0; j <= a.length; j++) row0[j] = j;

  for (let i = 1; i <= b.length; i++) {
    // 移除非空断言：提取局部变量，用 ?? 0 兜底（初始化保证值存在）
    const rowI = matrix[i];
    const rowPrev = matrix[i - 1];
    if (!rowI || !rowPrev) continue;
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      rowI[j] = Math.min(
        (rowPrev[j] ?? 0) + 1,
        (rowI[j - 1] ?? 0) + 1,
        (rowPrev[j - 1] ?? 0) + cost,
      );
    }
  }

  // 移除非空断言：使用可选链 + 空值合并兜底
  return matrix[b.length]?.[a.length] ?? 0;
}
