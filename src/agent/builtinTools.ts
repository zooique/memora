/**
 * 内置工具定义 + 工具幂等契约（补偿机制）
 *
 * 工具定义（schema/参数描述）与工具执行逻辑分离：
 * - 本文件只包含工具的"声明"（名称、描述、参数 schema）
 * - 工具的"执行"逻辑留在 toolExecutor.ts
 * - 工具的幂等性映射在此定义，供补偿机制判断使用
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
  /**
   * 工具是否为只读操作（act.toolReadonly 消费）
   *
   * - true：只读操作（读文件/搜索/查询），在 readonly 模式下保留
   * - false：写操作（写文件/删除/修改），在 readonly 模式下被阻止
   *
   * 未声明时默认为 false（写入操作），需显式标记只读工具
   */
  readonly?: boolean;
}

// ─── 工具幂等性映射（补偿机制） ────────────────────────
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
// 如实标记为 'non-idempotent'（不再被仅一次语义拦截重复追加）。
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
  // list_sessions：读操作（列举会话路标），天然幂等 ✅
  list_sessions: 'idempotent',
  // 第二级压缩：由 loop 拦截执行（现场压临时摘要，loop 收尾即弃），幂等
  compress_context: 'idempotent',
  task_table_write: 'non-idempotent',
  task_table_update: 'idempotent',
  read_skill: 'idempotent',
  read_resource: 'idempotent',
  run_skill_script: 'non-idempotent',
  // register_work：写 JSON 索引（同 path+description → 同记录），以 source 为业务键实现幂等
  register_work: 'idempotent-key',
  // 条件工具（宿主注入对应 provider 才暴露）：
  // web_fetch：读操作，天然幂等 ✅
  // run_code：任意代码执行，有副作用（计算/IO），如实标记非幂等（重复执行结果不可预期）
  web_fetch: 'idempotent',
  run_code: 'non-idempotent',
  // search_project：读操作（只读搜索），天然幂等 ✅
  search_project: 'idempotent',
};

/**
 * 判断幂等工具是否应跳过执行（仅一次语义）
 *
 * 规则：
 * - non-idempotent 工具永不跳过——失败后允许 LLM 原样重试，恢复时由补偿机制兜底；
 * - 幂等工具（idempotent / idempotent-key）仅当上次执行**成功**（ok === true）时跳过；
 *   上次失败（ok === false）不拦截重试，否则失败操作会被静默吞掉。
 *
 * 此判断是幂等契约的 SSOT：agent.ts preExecutionCheck 委托本函数，
 * 避免闭包内重复实现导致契约漂移。
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
  // 读操作：readonly 模式下保留（对齐 web_fetch / search_memories）
  readonly: true,
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
 * compress_context 工具定义（独立导出，第二级压缩：LLM 主动触发兜底）
 *
 * 作用对象：尚无记忆摘要的东西——loop 进行中的执行闭环、超大 tool_result。
 * 现场压成**临时压缩摘要**替换，loop 收尾即弃、不进记忆库。
 * 与第一级替换（内核自动 LRU，从库取现成摘要）互补：替换只对"已沉淀摘要的问答闭环"可用，
 * 压缩只对"无记忆摘要的执行闭环/工具结果"可用——同一空间管理链条的两级。
 * 由 AgentLoop 拦截执行（非 ToolExecutor），执行逻辑在 loop.compressContext。
 */
export const COMPRESS_CONTEXT_TOOL: ToolDefinition = {
  name: 'compress_context',
  description:
    '当上下文过长时压缩空间（第二级压缩，LLM 主动触发兜底）：把最早的执行闭环或超大工具结果' +
    '现场压成临时摘要替换，loop 收尾即弃。当无法通过替换释放空间（无已存摘要）时使用。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '压缩目标："earliest_round"（最早的执行闭环，默认）或 "largest_tool_result"（最大的工具结果）',
      },
    },
    required: [],
  },
};

/**
 * web_fetch 工具定义（独立导出，条件性包含）
 *
 * 与 web_search 成对构成「搜索→抓取」闭环：web_search 返回候选链接，web_fetch 读取正文。
 * 与 BUILTIN_TOOLS 分离的原因同 web_search——仅在宿主注入了 IFetchProvider 时才暴露给 LLM。
 */
export const WEB_FETCH_TOOL: ToolDefinition = {
  name: 'web_fetch',
  description:
    '抓取指定网页的正文内容（搜索→抓取闭环的第二段）。当 web_search 找到候选链接、需要读取正文全文时使用。返回清洗后的纯文本。',
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页完整 URL（http/https）' },
      limit: { type: 'string', description: '返回正文最大字符数，默认 "8000"，最大 "50000"' },
    },
    required: ['url'],
  },
};

/**
 * run_code 工具定义（独立导出，条件性包含）
 *
 * 通用代码执行（计算/数据处理/验证底座）。源码不进入 LLM 上下文，仅执行结果返回。
 * 仅在宿主注入了 ICodeExecutionProvider 时才暴露给 LLM。
 */
export const RUN_CODE_TOOL: ToolDefinition = {
  name: 'run_code',
  description:
    '执行一段代码并返回运行结果（通用计算/数据处理/验证能力）。源码不进入上下文，仅执行结果返回。执行能力与隔离等级由宿主注入的执行器决定。',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', description: '代码语言，如 "python"、"node"、"shell"（可用性取决于宿主执行器）' },
      code: { type: 'string', description: '要执行的代码内容' },
    },
    required: ['language', 'code'],
  },
};

/**
 * search_project 工具定义（独立导出，条件性包含）
 *
 * 与 BUILTIN_TOOLS 分离的原因同 web_search：仅在宿主注入了 IProjectSearchProvider 时才暴露给 LLM。
 * 项目内搜索（等价 IDE 全局搜索）：按文件名 glob 或按内容全文关键词定位项目文件，
 * 命中路径后再用 read_file 精读。这是「LLM 感知当前项目」的入口——回答「项目里有什么/某文件在哪/哪里用到某词」。
 */
export const SEARCH_PROJECT_TOOL: ToolDefinition = {
  name: 'search_project',
  description:
    '在当前项目（当前工作区文件夹）中搜索文件。支持按文件名 glob（如 "**/*.ts"）或按内容全文关键词' +
    '（如 "TODO"）搜索，返回匹配文件列表。当用户问「项目里有什么/有多少文件/某文件在哪/哪里用到了某个词」时使用；' +
    '拿到文件路径后可再用 read_file 读取内容。省略 query 时列出项目全部文件（受 maxResults 限制）。',
  // 读操作：readonly 模式下保留（对齐 read_file / list_dir）
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '文件名 glob（mode=name，如 "**/*.ts"）或内容关键词（mode=content，如 "TODO"）；省略时列出项目文件清单' },
      mode: { type: 'string', description: '"name"（按文件名搜索，默认）或 "content"（按内容全文搜索）' },
      exclude: { type: 'string', description: '排除 glob/路径（可选，如 "**/node_modules/**" 或 "docs"）' },
      maxResults: { type: 'string', description: '返回结果数量上限，默认 "20"，最大 "100"' },
    },
    required: [],
  },
};

/**
 * 始终可用的内置工具注册表（单一真理源 = 下方 `BUILTIN_TOOLS` 数组）。
 *
 * - 增删内置工具只改数组，勿在此复述清单：手工维护的工具列表会随数组演化而腐坏
 *   （本注释曾长期写为"8 个"，实际已增至 14 个，正是这一腐坏的体现）。
 * - 每个工具的 `description` 即其对外契约，以数组内定义为准。
 *
 * 条件性工具（不在此数组，由 toolExecutor 按宿主注入的 Provider 拼接）：
 * - web_search / web_fetch：注入 IWebSearchProvider / IFetchProvider 时暴露，构成搜索→抓取闭环
 * - run_code：注入 ICodeExecutionProvider 时暴露
 * - TRACE_SUMMARY_TOOL：trace_summary 的别名导出（定义与数组内条目相同），供外部消费
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取项目内文件内容。路径必须相对项目根目录。',
    readonly: true,
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
    readonly: true,
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
    readonly: true,
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
  // ── 记忆即摘要·追溯工具 ──────────────────────
  {
    name: 'trace_summary',
    description:
      '追溯轮次摘要的原始对话内容。当需要查看某条摘要对应的完整对话时使用。',
    readonly: true,
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
  {
    name: 'list_sessions',
    description:
      '列出历史会话的路标（每个会话的主题与摘要），用于定位"之前聊过某件事"具体在哪个会话。' +
      '先用它找到目标 sessionId，再用 trace_summary 深入查看该会话的问答摘要。' +
      '注意：当前会话的摘要可能滞后，历史会话的路标准确。',
    readonly: true,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'string', description: '返回条数上限，默认 "10"，最大 "30"' },
      },
      required: [],
    },
  },
  // ── 两级空间管理·第二级压缩（LLM 主动触发兜底）──────
  COMPRESS_CONTEXT_TOOL,
  // ── 任务表管理工具 ──────────────────────────────
  {
    name: 'task_table_write',
    description:
      '写入或更新任务表。overwrite 与 append 均为追加新步骤（overwrite 不再限制 plan 必须为空）；' +
      'update 模式替换现有步骤（保留步骤 ID 与状态）。' +
      '每个步骤可声明可选 rolePack 字段（小组会议用：该步骤的表层装配角色，须 ∈ 系统提示中声明的 {组长} ∪ {组员}，越界会被忽略）。' +
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
          description: '步骤列表，每个步骤包含 description 字段，可选项 rolePack（会议表层装配角色，须 ∈ {组长} ∪ {组员}）',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: '步骤描述' },
              rolePack: {
                type: 'string',
                description: '可选：该步骤的表层装配角色（小组会议用，组长或组员；越界会被忽略，省略按当前生效角色）',
              },
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
  // ── 渐进披露 L3：资源/脚本分离 ──────────────────
  {
    name: 'read_resource',
    description:
      '读取技能的参考资源文件（渐进披露 L3，按需调用）。当技能含 resources/ 目录时，可通过此工具读取参考资料。资源路径相对技能的 resources/ 目录。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: '技能名' },
        resource_path: { type: 'string', description: '相对 resources/ 的路径（如 "api-spec.md"）' },
      },
      required: ['skill_name', 'resource_path'],
    },
  },
  {
    name: 'run_skill_script',
    description:
      '执行技能的可执行脚本（渐进披露 L3）。脚本源码不进入上下文，仅执行结果返回。当技能含 scripts/ 目录时可调用。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: '技能名' },
        script_path: { type: 'string', description: '相对 scripts/ 的路径（如 "lint.ts"）' },
        args: {
          type: 'array',
          description: '传递给脚本的参数数组（可选）',
          items: { type: 'string', properties: {}, required: [] },
        },
      },
      required: ['skill_name', 'script_path'],
    },
  },
  {
    name: 'list_resources',
    description:
      '列出技能的 L3 资源清单（渐进披露 L3）。返回 resources/ 目录下所有资源文件列表。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: '技能名' },
      },
      required: ['skill_name'],
    },
  },
  {
    name: 'list_skills',
    description:
      '列出当前可用的所有技能清单（渐进披露 L1 补充）。当技能数量较多（>50）时使用此工具查询。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  // ── 作品投影：用户主动登记作品索引卡片 ──────────────────
  {
    name: 'register_work',
    description:
      '登记作品索引：把用户的一件作品（文档/代码/笔记）登记为项目级文件索引，追加到 <memoraDir>/work-projections.json 清单中。当用户说「记住这个文件」「把这份文档登记为作品」时使用。path 为相对项目根的源文件路径，description 为作品的一句话说明。登记后 AI 在后续对话中会看到此索引，根据描述自主决定是否读取原文。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的源文件路径（如 docs/architecture.md）' },
        description: { type: 'string', description: '作品的一句话说明（LLM 总结，用户可后续手改）' },
      },
      required: ['path', 'description'],
    },
  },
];
