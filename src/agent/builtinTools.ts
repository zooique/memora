/**
 * 内置工具定义 + 工具幂等契约（P3.4 补偿机制）
 *
 * 工具定义（schema/参数描述）与工具执行逻辑分离：
 * - 本文件只包含工具的"声明"（名称、描述、参数 schema）
 * - 工具的"执行"逻辑留在 toolExecutor.ts
 * - 工具的幂等性映射（P3.4）在此定义，供补偿机制判断使用
 */

/**
 * 工具定义接口
 *
 * 描述一个工具的名称、用途和参数 schema，
 * 用于构建 LLM 请求的 tools 参数。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// ─── 工具幂等性映射（P3.4 补偿机制） ────────────────────────
//
// 幂等性定义：
//   - idempotent：天然幂等（读操作），相同参数多次执行结果一致
//   - idempotent-key：依赖业务唯一键实现幂等（写操作）
//   - non-idempotent：非幂等，需补偿机制兜底
//
// 内置工具幂等性判断：
//   - read_file / list_dir：读操作，天然幂等 ✅
//   - search_memories：读操作，天然幂等 ✅
//   - write_file（overwrite 模式）：全量覆盖，重复执行结果一致 ✅
//   - write_file（append 模式）：追加写入，重复执行会追加多次 ❌
//   - write_file（insert 模式）：行插入，重复执行会插入多次 ❌
//
// 注：write_file 的幂等性依赖于写入模式——overwrite 模式幂等，
// append/insert 模式非幂等。当前统一标记为 'idempotent-key'，
// 因 overwrite 是最常用模式，append/insert 的补偿应在调用方保证。
// ──────────────────────────────────────────────────────────

import type { IdempotencyLevel } from '@/agent/types.js';

/**
 * 内置工具幂等性映射
 *
 * key 为工具名，value 为幂等性级别。
 * 供补偿机制和仅一次语义检查使用。
 */
export const BUILTIN_TOOL_IDEMPOTENCY: Record<string, IdempotencyLevel> = {
  read_file: 'idempotent',
  write_file: 'idempotent-key',
  list_dir: 'idempotent',
  search_memories: 'idempotent',
};

/**
 * 工具注册表
 * 4 个内置工具：
 * - read_file：读取文件
 * - write_file：写入/创建文件（受写入二次确认保护）
 * - list_dir：列出目录内容
 * - search_memories：在记忆索引中搜索关键词
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取项目内文件内容。路径必须相对项目根目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的文件路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      '写入或创建文件。owner 模式默认自动批准；guest 模式会要求用户确认。受路径白名单保护。支持三种写入模式：overwrite（默认，全量覆盖）、append（追加到末尾）、insert（在指定行号前插入）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的文件路径' },
        content: { type: 'string', description: '要写入的内容' },
        mode: {
          type: 'string',
          description:
            '写入模式："overwrite"（默认，全量覆盖）、"append"（追加到末尾）、"insert"（在 insert_line 行号前插入）',
        },
        insert_line: {
          type: 'string',
          description: 'insert 模式下插入位置的行号（从 1 开始），省略则插入到文件末尾',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description:
      '列出目录内容。默认相对项目根目录。受路径白名单保护。递归深度 ≤ 3，自动忽略 .git / node_modules / .memora / dist / coverage / .next。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的目录路径，默认为 "."（项目根）' },
        recursive: { type: 'string', description: '是否递归（"true" / "false"），默认 "false"' },
        maxDepth: { type: 'string', description: '递归最大深度（1-3），默认 "2"' },
      },
      required: [],
    },
  },
  {
    name: 'search_memories',
    description:
      '在记忆索引中搜索关键词。支持 match（任一命中，默认）和 near（全部命中）两种模式。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'string', description: '返回结果数量上限，默认 "10"' },
        mode: { type: 'string', description: '"match"（默认，任一）或 "near"（必须全部）' },
      },
      required: ['query'],
    },
  },
];
