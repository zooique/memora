/**
 * 内置工具定义
 *
 * 工具定义（schema/参数描述）与工具执行逻辑分离：
 * - 本文件只包含工具的"声明"（名称、描述、参数 schema）
 * - 工具的"执行"逻辑留在 toolExecutor.ts
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

/**
 * 工具注册表
 * 阶段二（M-204）：4 个工具
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
