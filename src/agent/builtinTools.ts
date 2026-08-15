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
    properties: Record<string, { type: string; description: string; items?: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] } }>;
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
// task_table_write 为追加语义（appendPlanStep），重复执行不幂等，
// 如实标记为 'non-idempotent'（J1 修复：不再被仅一次语义拦截重复追加）。
// ──────────────────────────────────────────────────────────

import type { IdempotencyLevel, ToolExecutionRecord } from '@/agent/types.js';

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
  web_search: 'idempotent',
  trace_summary: 'idempotent',
  task_table_write: 'non-idempotent',
  task_table_update: 'idempotent',
  read_skill: 'idempotent',
};

/**
 * 判断幂等工具是否应跳过执行（仅一次语义，P3.4）
 *
 * 规则：
 * - non-idempotent 工具永不跳过——失败后允许 LLM 原样重试，恢复时由补偿机制兜底；
 * - 幂等工具（idempotent / idempotent-key）仅当上次执行**成功**（ok === true）时跳过；
 *   上次失败（ok === false）不拦截重试，否则失败操作会被静默吞掉。
 *
 * 此判断是幂等契约的 SSOT：agent.ts preExecutionCheck 委托本函数，
 * 避免闭包内重复实现导致契约漂移（J1 修复，2026-08-11）。
 *
 * @param records 检查点中的工具执行记录（completedToolCalls）
 * @param name 工具名
 * @param args 参数签名
 * @param idempotent 工具的幂等性级别
 * @returns 是否跳过及上次结果摘要
 */
export function shouldSkipForIdempotency(
  records: readonly ToolExecutionRecord[] | undefined,
  name: string,
  args: string,
  idempotent: IdempotencyLevel,
): { skip: boolean; previousResult?: string } {
  if (idempotent === 'non-idempotent') return { skip: false };
  const record = records?.find((r) => r.name === name && r.argsSignature === args);
  if (!record || record.ok !== true) return { skip: false };
  return {
    skip: true,
    previousResult: record.resultSummary
      ? `[SKIP:TOOL:IDEMPOTENT] 工具已执行（outbox 模式跳过），上次结果：${record.resultSummary}`
      : undefined,
  };
}

/**
 * web_search 工具定义（独立导出，条件性包含）
 *
 * 与 BUILTIN_TOOLS 分离的原因：
 * web_search 不是"始终可用"的内置工具——它仅在宿主注入了 IWebSearchProvider 时才暴露给 LLM。
 * 独立导出让 ToolExecutor.get list() 可以条件性地包含它。
 */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取实时信息。当需要最新数据、新闻、文档或无法从记忆中找到答案时使用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，尽量具体精确' },
      limit: { type: 'string', description: '返回结果数量上限，默认 "5"，最大 "20"' },
    },
    required: ['query'],
  },
};

/**
 * traceSummary 工具定义（独立导出，可供宿主条件性控制可见性）
 *
 * 用于从记忆索引中追溯轮次摘要的原始对话内容。
 * 需要 sessionId 和可选的 roundId 参数。
 */
export const TRACE_SUMMARY_TOOL: ToolDefinition = {
  name: 'trace_summary',
  description: '追溯轮次摘要的原始对话内容。当需要查看某条摘要对应的完整对话时使用。',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: '会话标识（格式：YYYY-MM-DD-sessionName，如 "2026-08-13-main"）' },
      roundId: { type: 'string', description: '轮次 ID（可选，不传则返回该会话最近 N 条摘要对应的对话）' },
      limit: { type: 'string', description: '返回结果数量上限，默认 "5"，最大 "20"' },
    },
    required: ['sessionId'],
  },
};

/**
 * 工具注册表（8 个始终可用的内置工具）
 *
 * - read_file：读取文件
 * - write_file：写入/创建文件（受写入二次确认保护）
 * - list_dir：列出目录内容
 * - search_memories：在记忆索引中搜索关键词
 * - trace_summary：追溯轮次摘要的原始对话
 * - task_table_write：写入/更新任务表行（幂等键保护）
 * - task_table_update：更新任务表行（幂等保护）
 * - read_skill：读取激活角色包内嵌技能正文（渐进披露 L2，按需装载）
 *
 * 另有 WEB_SEARCH_TOOL（条件性暴露，仅注入了 IWebSearchProvider 时可用），见下方独立定义。
 * 另有 TRACE_SUMMARY_TOOL（始终可用，与 BUILTIN_TOOLS 中的 trace_summary 定义相同）。
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
  // ── Phase 1: 记忆即摘要·追溯工具 ──────────────────────
  {
    name: 'trace_summary',
    description:
      '追溯轮次摘要的原始对话内容。当需要查看某条摘要对应的完整对话时使用。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话标识（格式：YYYY-MM-DD-sessionName，如 "2026-08-13-main"）' },
        roundId: { type: 'string', description: '轮次 ID（可选，不传则返回该会话最近 N 条摘要对应的对话）' },
        limit: { type: 'string', description: '返回结果数量上限，默认 "5"，最大 "20"' },
      },
      required: ['sessionId'],
    },
  },
  // ── P2-6: 任务表管理工具 ──────────────────────────────
  {
    name: 'task_table_write',
    description:
      '写入或更新任务表。overwrite 与 append 均为追加新步骤（overwrite 不再限制 plan 必须为空）；' +
      'update 模式替换现有步骤（保留步骤 ID 与状态）。' +
      '输出格式为 Markdown 表格，包含进度行和状态标记。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: '写入模式："overwrite"/"append"（均为追加新步骤）、"update"（替换，保留步骤 ID 与状态）',
        },
        steps: {
          type: 'array',
          description: '步骤列表，每个步骤包含 description 字段',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: '步骤描述' },
            },
            required: ['description'],
          },
        },
      },
      required: ['mode', 'steps'],
    },
  },
  {
    name: 'task_table_update',
    description:
      '更新任务表中指定步骤的状态。将 step_id 对应的步骤标记为 done（已完成）或 blocked（已阻塞）。',
    parameters: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: '步骤 ID（task_table_write 返回的 id 列表中的 id）' },
        status: { type: 'string', description: '新状态："done"（已完成）或 "blocked"（已阻塞）' },
      },
      required: ['step_id', 'status'],
    },
  },
  // ── 渐进披露：角色包内嵌技能按需装载 ──────────────
  {
    name: 'read_skill',
    description:
      '读取激活角色包内嵌技能的完整正文（渐进披露 L2，按需装载）。当需要执行角色包声明的某项技能时，先读取其正文获取详细步骤。技能名来自角色包声明的技能清单。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（角色包 manifest.skills 中声明的 name，或技能文件名去扩展名）' },
      },
      required: ['name'],
    },
  },
];
