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
//   - idempotent：写后状态确定、可安全重跑（如 task_table_update），跳过回喂缓存摘要
//   - idempotent-key：依赖业务唯一键实现幂等（写操作，如 write_file / register_work）
//   - read-only：读/查询类，目标态可被外部改动（写工具/时间），永不跳过——跳过回喂
//     陈旧结果会误导 LLM；重跑无害且无需去重持久化
//   - non-idempotent：非幂等，需补偿机制兜底；另承担「禁止跳过」语义——目标态可被其它工具
//     重建的操作（delete_file 的目标态可被 write_file 重建）必须禁跳过，重跑是否有害另行判断
//
// 内置工具幂等性判断：
//   - read_file / list_dir：读操作，永不跳过（read-only）——文件态可变，跳过回喂陈旧结果误导 LLM
//   - search_memories：读操作，永不跳过（read-only）
//   - write_file（overwrite 模式）：全量覆盖，重复执行结果一致 ✅
//   - write_file（append 模式）：追加写入，重复执行会追加多次 ❌
//   - write_file（insert 模式）：行插入，重复执行会插入多次 ❌
//
// 注：write_file 的幂等性依赖于写入模式——overwrite 模式幂等，
// append/insert 模式非幂等。当前统一标记为 'idempotent-key'，
// 因 overwrite 是最常用模式，append/insert 的补偿应在调用方保证。
// task_table_write 幂等性随 mode 而异（勿一概称「追加语义」）：
//   overwrite（默认）= 清空重建，同参重跑结果一致 → 幂等，但重发会重置已推进的 plan（覆盖进行中状态）；
//   update = 全量替换 → 幂等；
//   append = 逐条追加，重复执行累加 → 非幂等（主要风险面）。
// 映射只支持单值 → 保守标记 'non-idempotent'：宁每次执行、不被仅一次语义静默跳过，
// 防 append 重发漏执行；overwrite 重发风险（重置推进）由 LLM 侧少发同参调用规避。
// ──────────────────────────────────────────────────────────

import type { IdempotencyLevel, ToolExecutionRecord } from '@/agent/types.js';

/**
 * 内置工具幂等性映射
 *
 * key 为工具名，value 为幂等性级别。
 * 供补偿机制和仅一次语义检查使用。
 */
export const BUILTIN_TOOL_IDEMPOTENCY: Record<string, IdempotencyLevel> = {
  read_file: 'read-only',
  write_file: 'idempotent-key',
  // delete_file 归 non-idempotent 是「禁止跳过」而非「重跑有害」（重跑由 deleteFile 的 ENOENT 兜底，无害）。
  // 禁止跳过的原因：删除的目标态可被 write_file 重建，而幂等键只有 name+args、不含文件状态 →
  // 标幂等会让同会话内第二次「写 → 执行 → 删」闭环被静默跳过，脚本残留且 LLM 收到假的「已删除」。
  delete_file: 'non-idempotent',
  list_dir: 'read-only',
  search_memories: 'read-only',
  web_search: 'read-only',
  trace_summary: 'read-only',
  // list_sessions：读操作（列举会话路标），永不跳过（read-only）
  list_sessions: 'read-only',
  // 第二级压缩：由 loop 拦截执行（现场压临时摘要，loop 收尾即弃），永不跳过（read-only）
  compress_context: 'read-only',
  task_table_write: 'non-idempotent',
  task_table_update: 'idempotent',
  read_skill: 'read-only',
  read_resource: 'read-only',
  // list_resources / list_skills：读操作（列举技能 L3 清单 / 技能清单），永不跳过（read-only，同 read_skill）
  list_resources: 'read-only',
  list_skills: 'read-only',
  run_skill_script: 'non-idempotent',
  // run_project_script：运行项目内已有脚本，结果不可预期，禁止跳过（同 run_skill_script）
  run_project_script: 'non-idempotent',
  // register_work：写 JSON 索引（同 path+description → 同记录），以 source 为业务键实现幂等
  register_work: 'idempotent-key',
  // ask_user：read-only 语义——提问的目标态（用户答案）天然可变，永不跳过（跳过=丢问题）
  ask_user: 'read-only',
  // 条件工具（宿主注入对应 provider 才暴露）：
  // web_fetch：读操作，永不跳过（read-only）
  // run_code：任意代码执行，有副作用（计算/IO），如实标记非幂等（重复执行结果不可预期）
  web_fetch: 'read-only',
  run_code: 'non-idempotent',
  // search_project：读操作（只读搜索），永不跳过（read-only）
  search_project: 'read-only',
  // run_team_meeting：评估型会议（注入多角色 persona 一次调用），产出可变、代价高 → read-only（永不跳过）
  run_team_meeting: 'read-only',
};

/**
 * 判断幂等工具是否应跳过执行（仅一次语义）
 *
 * 规则：
 * - non-idempotent 工具永不跳过——失败后允许 LLM 原样重试，恢复时由补偿机制兜底；
 * - read-only 工具永不跳过——目标态可被写工具/时间改动，跳过回喂陈旧结果会误导 LLM，重跑无害；
 * - 幂等工具（idempotent / idempotent-key）仅当上次执行**成功**（ok === true）时跳过；
 *   上次失败（ok === false）不拦截重试，否则失败操作会被静默吞掉。
 *
 * 此判断是幂等契约的 SSOT：assembler.ts 的 preExecutionCheck 装配
 * （工具分发器 dispatchTool，:570）委托本函数，避免闭包内重复实现导致契约漂移。
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
  if (idempotent === 'non-idempotent' || idempotent === 'read-only') return { skip: false };
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
};

/**
 * compress_context 工具定义（独立导出，第二级压缩：LLM 主动触发兜底）
 *
 * 作用对象：尚无记忆摘要的东西——turn 内 loop 进行中的 step（未收尾迭代）、超大 tool_result。
 * 现场压成**临时压缩摘要**替换，turn 收尾即弃、不进记忆库。
 * 与第一级替换（内核自动 LRU，从库取现成摘要）互补：替换只对"已沉淀摘要的问答闭环"可用，
 * 压缩只对"无记忆摘要的 step/工具结果"可用——同一空间管理链条的两级。
 * 由 AgentLoop 拦截执行（非 ToolExecutor），执行逻辑在 loop.compressContext。
 */
export const COMPRESS_CONTEXT_TOOL: ToolDefinition = {
  name: 'compress_context',
  description:
    '当上下文接近容量上限或空间紧张时主动压缩空间（第二级压缩，LLM 触发兜底）：把最早的 turn' +
    '或超大工具结果现场压成临时摘要替换，loop 收尾即弃。当替换无法释放空间（无已存摘要）时、或存在' +
    '超大工具结果 / 较多旧 turn 时使用；压缩内容仍可经 trace_summary 回溯。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '压缩目标："earliest_round"（最早的 turn，默认）或 "largest_tool_result"（最大的工具结果）',
      },
    },
    required: [],
  },
};

/**
 * ask_user 内置工具定义（主动提问唯一通道）
 *
 * 对齐 Claude Code AskUserQuestion 机制：提问 = 一次普通工具调用（Tool Calling）。
 * loop 检出 ask_user → 整轮挂起（step 边界气口）→ 用户答案以 tool result 回填 →
 * LLM 基于答案续跑。工具调用结构完整落地（不「撕掉」），OpenAI 兼容端结构恒合法。
 *
 * 独立导出常量（同 COMPRESS_CONTEXT_TOOL 的「loop 拦截执行」模式）：供 loop/toolExecutor
 * 引用常量名，避免散落字符串工具名导致契约漂移；BUILTIN_TOOLS 数组同样引用本常量。
 */
export const ASK_USER_TOOL: ToolDefinition = {
  name: 'ask_user',
  description:
    '向用户提问（结构化）——当需要用户做决策、补充关键信息、或确认时使用：系统会暂停当前执行，' +
    '在 step 边界向用户展示提问，用户答案会作为本工具的结果返回给你，你据此继续。' +
    '提供候选选项（options）可提升回答效率；不提供时用户自由输入（可设 allowCustom）。',
  // 永不跳过（幂等映射 read-only）：提问的目标态（用户答案）天然可变，跳过会丢问题
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题（一句话，清晰具体）' },
      options: {
        type: 'array',
        description: '候选选项（可选，用户可直接点选）：各项为选项文本；省略时用户自由输入',
        items: { type: 'string', properties: {}, required: [] },
      },
      allowCustom: {
        type: 'string',
        description: '是否允许用户在选项外自由输入："true" / "false"，默认 "false"（options 为空时无效）',
      },
    },
    required: ['question'],
  },
};

/**
 * remember_intel 内置工具定义（情报区写回，大文本统一通道）
 *
 * LLM **私有工作笔记**的写回通道（scratchpad 模式）：当你从大文本/工具结果获取到值得记住的
 * 关键信息时，调用本工具把它写进你的私有情报区。
 *
 * **语义边界**：
 * - 情报区**仅你私有**，装配时作为隐藏的尾部 system 消息注入，**不对用户展示**、不入文档/记忆库；
 * - 写入即记入，可多次调用累积；已记录的旧笔记会自动保留并参与上下文淘汰；
 * - **不要**在 `note` 里写长篇原文——只写你要长期记住的精炼要点。
 *
 * 独立导出常量（同 COMPRESS_CONTEXT_TOOL 的「loop 拦截执行」模式，见 loop.appendIntel）。
 */
export const REMEMBER_INTEL_TOOL: ToolDefinition = {
  name: 'remember_intel',
  description:
    '把一条关键信息写入你的私有情报区（工作笔记）。当你从大文本或工具结果中得到需要长期记住的要点时使用；' +
    '信息对你私有、不会展示给用户、不会写入项目文件。可多次调用，写成精炼要点而非原文。',
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: '要记住的精炼要点（一句话到几行）' },
    },
    required: ['note'],
  },
};

/** web_fetch 正文单次返回最大长度（防长上下文注入；schema 文案与 toolExecutor 执行钳制同源） */
export const WEB_FETCH_CONTENT_MAX_LEN = 50_000;
/** web_fetch 正文默认返回长度（limit 省略时；schema 文案与 toolExecutor 默认值同源） */
export const WEB_FETCH_CONTENT_DEFAULT_LEN = 8_000;

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
      limit: {
        type: 'string',
        description: `返回正文最大字符数，默认 "${WEB_FETCH_CONTENT_DEFAULT_LEN}"，最大 "${WEB_FETCH_CONTENT_MAX_LEN}"`,
      },
    },
    required: ['url'],
  },
};

/**
 * run_code 工具定义（独立导出，条件性包含）
 *
 * 通用代码执行（计算/数据处理/验证底座）。源码不进入 LLM 上下文，仅执行结果返回。
 * 仅在宿主注入了 ICodeExecutionProvider 时才暴露给 LLM。
 *
 * 两种模式（二选一）：
 *   - code：直接执行代码字符串（传统模式）；
 *   - script_path：执行项目根下的脚本文件（cwd=项目根，脚本可 require 项目本地依赖/读取项目数据）。
 *
 * 「临时脚本」闭环（对齐主流 AI IDE 行为约定）：write_file 写脚本 → run_code(script_path)
 * 执行拿数据 → delete_file 清理脚本——一次性数据处理不留痕。
 */
export const RUN_CODE_TOOL: ToolDefinition = {
  name: 'run_code',
  description:
    '执行代码并返回运行结果（通用计算/数据处理/验证能力）。源码不进入上下文，仅执行结果返回。执行能力与隔离等级由宿主注入的执行器决定。' +
    '两种模式（二选一）：① 传 code 直接执行代码字符串；② 传 script_path 执行项目根下的脚本文件（相对项目根路径，cwd=项目根，脚本可 require 项目本地依赖、读取项目数据）。' +
    '一次性数据处理推荐「临时脚本」闭环：先 write_file 写入脚本 → run_code(script_path) 执行拿数据 → delete_file 清理脚本，不留痕。',
  parameters: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description:
          '代码语言（可选；script_path 模式省略时按文件扩展名推断）。**具体支持哪些语言由宿主执行器决定，内核不预设**——' +
          '不确定时优先用 script_path 模式（先 write_file 写文件再执行，按扩展名推断运行时），或先观察项目里已有脚本的扩展名；' +
          '若直接传 code 而语言不被支持，执行器会明确回知可用语言，据此改用即可。',
      },
      code: { type: 'string', description: '要执行的代码内容（与 script_path 二选一）' },
      script_path: {
        type: 'string',
        description: '要执行的项目脚本文件路径（相对项目根，如 "tmp_analyze.mjs"；与 code 二选一，cwd=项目根，脚本可用项目依赖）',
      },
    },
    required: [],
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
    '在当前项目（当前工作区文件夹）中搜索文件。mode="name" 按文件名 glob（如 "**/*.ts"），' +
    // name 裸词语义：无通配符时自动按名称子串/分词放宽，避免"精确路径匹配"假阴性
    '也可写裸文件名（如 "product"）——无通配符的 word 会自动放宽为名称子串/分词匹配；' +
    'mode="content" 按内容关键词（如 "TODO"）搜索，返回 路径:行号:预览。' +
    // 多词语义显式化：LLM 不知道该写"整串"还是"拆词"时，会把一次能问清的事问成多次（甚至放弃）
    'content 模式的多词语义：**先按整串精确匹配，整串零命中才自动放宽为分词匹配' +
    '（任一分词命中即算，不是"全部包含"）**，结果中会标注是否为放宽命中——' +
    '因此多词直接写成一串即可（如 "核心 愿景"、"核心/愿景"），无需拆成多次调用。' +
    '返回文案会如实说明结果是否被截断、是否有文件只被部分检索（过大）或读取失败：' +
    '若文案说"未找到"但同时提示截断、部分检索或读取失败，**不代表项目中不存在该内容**，应换更具体的关键词或缩小 exclude 后重试。' +
    '回答与项目代码/文件结构相关的问题前，若不确定答案，' +
    '应优先调用本工具定位相关文件，再用 read_file 精读内容——不要凭空猜测项目路径或内容。' +
    '典型场景：用户问「项目里有什么/有多少文件/某文件在哪/哪里用到了某个词」；' +
    '省略 query 时列出项目全部文件（受 maxResults 限制）。命中路径为相对项目根的路径，可直接传给 read_file 精读（勿拼绝对路径）。',
  // 读操作：readonly 模式下保留（对齐 read_file / list_dir）
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '文件名 glob（mode=name，如 "**/*.ts"）或裸文件名/内容关键词（mode=content，如 "TODO"）；name 模式无通配符时自动按名称子串/分词放宽；省略时列出项目文件清单' },
      mode: { type: 'string', description: '"name"（按文件名搜索，默认）或 "content"（按内容全文搜索）' },
      exclude: { type: 'string', description: '排除 glob/路径（可选，如 "**/node_modules/**" 或 "docs"）' },
      maxResults: { type: 'string', description: '返回结果数量上限，默认 "20"，最大 "100"' },
    },
    required: [],
  },
};

/**
 * run_team_meeting 内置工具定义（评估/评审型小组会议，单次 LLM 调用注入多角色 persona）
 *
 * 语义：一次调用内读取组内 组长+组员 各角色的完整设定（buildSystemPrompt 取的 persona 全文），
 * 拼成多角色 system prompt，让模型以各角色视角独立评估同一议题，最后以组长视角汇总。
 * 这是「工具内嵌 LLM 调用」的新形态（vs 纯函数工具），只做串联、一次 chat() 完成。
 *
 * **定位边界**：评估/评审型会议（各视角独立观点 + 组长汇总）；**不覆盖**你来我往的讨论型会议。
 * **角色数上限**：按组解析时经 `MAX_TEAM_MEMBERS` 截断，队长 1 + 组员 ≤ 4 = 5 人组（persona 全文
 * token 成本高，约束同 `MAX_TEAM_MEMBERS`）——组员超限部分不参与本次会议。
 *
 * 独立导出常量（同 COMPRESS_CONTEXT_TOOL/ASK_USER_TOOL 的「独立导出」模式），
 * BUILTIN_TOOLS 数组引用同一常量，避免散落字符串工具名。
 */
export const RUN_TEAM_MEETING_TOOL: ToolDefinition = {
  name: 'run_team_meeting',
  description:
    '召开评估/评审型小组会议：一次调用注入组内各角色（组长+组员，队长 1 + 组员 ≤ 4）的完整设定，' +
    '以各角色视角独立评估同一议题（每视角一段），最后以组长视角汇总。适用于「直接产出多角度评审意见」，' +
    '不适用于需要你来我往逐轮对齐的讨论型会议。',
  // 读操作语义（readonly 模式保留）：不修改项目状态，产出可变 → 永不跳过（read-only 幂等）
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      group: { type: 'string', description: '组名（= 组长的角色包名，须已在组名单中）' },
      topic: { type: 'string', description: '要评估的议题（一句话，越具体越好）' },
    },
    required: ['group', 'topic'],
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
 * - TRACE_SUMMARY_TOOL：trace_summary 定义的真源（数组引用同一常量，无内联复述）
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      '读取项目内文件内容（按行分段返回）。路径必须相对项目根目录。' +
      '若不确定目标文件是否存在或路径是否正确，先用 search_project 搜索文件名定位，或 list_dir 查看目录结构，' +
      '确认存在再读——不要凭空猜测路径（读不存在的文件会返回 FILE_NOT_FOUND，是可避免的试探浪费）。' +
      '大文件不会一次全给：返回末尾的「[read_file 分段]」脚注会告知已显示的行号区间与总行数，' +
      '继续读用 offset 指定起始行。',
    readonly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的文件路径' },
        offset: {
          type: 'string',
          description: '起始行号（从 1 开始）。省略则从第 1 行读；续读时用上一段脚注给出的 offset',
        },
        limit: { type: 'string', description: '最多返回的行数。省略则按单次读取预算尽可能多读' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      '写入或创建文件。owner 模式默认自动批准；guest 模式会要求用户确认。受路径白名单保护。支持三种写入模式：overwrite（默认，全量覆盖）、append（追加到末尾）、insert（在指定行号前插入）。若改动只是「文末追加一段 / 单点插入新内容」，优先用 mode=append 或 mode=insert，不要 overwrite 全量重写整份文件（省 token）；只有结构性多处分改才用 overwrite。',
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
    name: 'delete_file',
    description:
      '删除项目内文件。用于清理 LLM 创建的临时脚本等一次性文件（配合 run_code 的 script_path 模式：写脚本 → 执行 → 删除，不留痕）。受路径白名单保护；owner 模式默认自动批准，guest 模式会要求用户确认。仅支持删除文件，不支持删除目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的文件路径' },
      },
      required: ['path'],
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
      '关键词检索记忆库（纯关键词通道，无语义向量通道）。涉及过往决定、历史事实、' +
      '用户偏好、项目背景，或回答不确定时，优先调用本工具按需召回（理解意图 → 搜记忆，结构性前置）。' +
      '命中返回该记忆的最近使用时间 accessedAt（被想起/命中即刷新，反映近期使用的工作连续性）。' +
      '关键词=字面匹配：语义近义/换说法（如「性能优化」vs「QPS 提升」）不会命中——首次未命中时主动' +
      '换等价关键词、换表述重试 2~3 次（LLM 承担词汇桥梁，勿因一次空结果就断言记忆不存在）。' +
      '优先级判据：命中贴合度为主；多个候选贴合度相近时，accessedAt 较新者优先（勿让时间压倒贴合度）。' +
      '先粗筛返回的预览候选，对真正相关的条目再调 trace_summary 精取原文，避免一次拉取过多内容。',
    readonly: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（字面匹配；未命中建议换词重试）' },
        limit: { type: 'string', description: '返回结果数量上限，默认 "5"' },
        mode: { type: 'string', description: '"match"（默认，任一）或 "near"（必须全部）' },
      },
      required: ['query'],
    },
  },
  // ── 记忆即摘要·追溯工具（引用 TRACE_SUMMARY_TOOL 单真源）──
  TRACE_SUMMARY_TOOL,
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
  // ── 主动提问（ask_user 工具，loop 检出挂起；唯一提问通道）──
  ASK_USER_TOOL,
  // ── 情报区写回（remember_intel，LLM 私有笔记；loop 拦截执行）──
  REMEMBER_INTEL_TOOL,
  // ── 任务表管理工具 ──────────────────────────────
  {
    name: 'task_table_write',
    description:
      '写入或更新任务表（命令式：多步任务必须先用本工具把任务拆解为子任务项写入任务表，随后按任务表逐步执行，禁止跳过拆解一次性盲目执行）。' +
        'overwrite 清空现有任务表后写入新任务项（重写/重开计划）；' +
        'append 在现有任务表后追加新任务项；' +
        'update 模式替换现有任务项（保留任务项 ID 与状态）。' +
        '写入后按任务表逐步推进：每完成一个任务项的实际产出（正文回答/写入文件/工具结果），再用 task_table_update 标记 done（先产出、后标记）。' +
        '每个任务项可声明可选 rolePack 字段（小组会议用：该任务项的表层装配角色，须 ∈ 系统提示中声明的 {组长} ∪ {组员}，越界会被忽略）。' +
        '输出格式为 Markdown 表格，包含进度行和状态标记。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: '写入模式："overwrite"（清空后重写全部任务项）、"append"（追加新任务项）、"update"（替换，保留任务项 ID 与状态）',
        },
        items: {
          type: 'array',
          description: '任务项列表，每个任务项包含 description 字段，可选项 rolePack（会议表层装配角色，须 ∈ {组长} ∪ {组员}）',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: '任务项描述' },
              rolePack: {
                type: 'string',
                description: '可选：该任务项的表层装配角色（小组会议用，组长或组员；越界会被忽略，省略按当前生效角色）',
              },
            },
            required: ['description'],
          },
        },
      },
      required: ['mode', 'items'],
    },
  },
  {
    name: 'task_table_update',
    description:
      '更新任务表中指定任务项的状态（命令式：一次只更新一个任务项）。将 plan_item_id 对应的任务项标记为 done（已完成）或 blocked（已阻塞）。' +
        '每完成一个任务项调用一次本工具标记，只有最后一个任务项完成后才宣告任务完成，禁止一次性批量标记所有任务项。' +
        '顺序纪律：调用本工具标记 done 前，必须已完成该任务项的实际产出（正文回答/写入文件/工具结果）——先产出、后标记；' +
        '禁止先标记 done 再补产出（标记后该任务项即视为完成，之后的内容会错归下一个任务项）。' +
        'plan_item_id 传任务表行首序号（1 开始，如 "1" = 第一个任务项）即可定位；或传 task_table_write 返回的任务项短 id（如 "[a1b2c3d4]" 中的 a1b2c3d4）。',
    parameters: {
      type: 'object',
      properties: {
        plan_item_id: { type: 'string', description: '任务项定位：任务表行首序号（1 开始，如 "1"/"2"）或 task_table_write 返回的短 id' },
        status: { type: 'string', description: '新状态："done"（已完成）或 "blocked"（已阻塞）' },
      },
      required: ['plan_item_id', 'status'],
    },
  },
  // ── 渐进披露：角色包内嵌技能按需装载 ──────────────
  {
    name: 'read_skill',
    description:
      '读取技能完整正文（渐进披露 L2，按需装载）：先查激活角色包内嵌技能，再查全局通用技能池。当需要执行某项技能时，先读取其正文获取详细步骤。技能名来自技能清单（角色包声明或全局通用技能）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（用上方技能清单中列出的名称）' },
      },
      required: ['name'],
    },
  },
  // ── 渐进披露 L3：资源/脚本分离 ──────────────────
  {
    name: 'read_resource',
    description:
      '读取技能的参考资源文件（渐进披露 L3，按需调用）。技能含 resources/ 或 references/ 目录时，可通过此工具读取参考资料。资源路径相对技能的 resources/ 或 references/ 目录。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: '技能名' },
        resource_path: { type: 'string', description: '相对 resources/ 或 references/ 的路径（如 "api-spec.md"）' },
      },
      required: ['skill_name', 'resource_path'],
    },
  },
  {
    name: 'run_skill_script',
    description:
      '执行技能的可执行脚本（渐进披露 L3）。脚本源码不进入上下文，仅执行结果返回。当技能含 scripts/ 目录时可调用。' +
      '扩展名推断运行时：.py→python、.js/.mjs/.cjs/.ts→node、.sh/.bash/.zsh/.bat/.cmd→shell。' +
      '⚠️ 跨平台提示（与 run_project_script 同源，勿省）：.sh 需要系统有 sh/bash 解释器——Windows 无 Git Bash 时' +
      '会**静默空跑**（退出码 0 但 stdout/stderr 全空，不是执行成功）；给技能写脚本时请优先选**跨平台**的 .mjs/.js/.py，' +
      'Windows 专属需求用 .bat/.cmd（cmd 原生可执行）；不要写 .sh（Windows 静默空跑）、不要写 .ps1（shell 档不起 PowerShell，同样静默空跑）。',
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
    name: 'run_project_script',
    description:
      '运行项目内已有的脚本文件（默认开放，与角色包能力声明无关）。脚本路径相对项目根，越界（项目外路径）拒绝执行。' +
      '脚本源码不进入上下文，仅执行结果（stdout/stderr/退出码）返回。由内核子进程执行：超时默认 60s（上限 600s，' +
      '可按需传 timeout_ms 秒，如脚本内调用 API 耗时较长）、工作目录=项目根、继承宿主用户环境变量' +
      '（用户本地 shell 语义，脚本可读 API key/工作区变量等）。扩展名推断运行时：.py→python、.js/.mjs/.cjs/.ts→node、.sh/.bash/.zsh/.bat/.cmd→shell。' +
      '⚠️ 跨平台提示：.sh 需要系统有 sh/bash 解释器——Windows 无 Git Bash 时会**静默空跑**（退出码 0 但 stdout/stderr 全空，不是执行成功），' +
      'Windows 上请优先写 .bat/.cmd（cmd 原生可执行）或 .js/.py；不要写 .ps1（shell 档不起 PowerShell，同样静默空跑）。' +
      '与 run_code(script_path) 的区别：本工具运行**仓库既有**脚本（默认开放、内核执行）；' +
      'run_code 面向 LLM 现写的一次性临时脚本（特权 code:execute + 宿主沙箱，写→执行→删闭环）。' +
      '文件组织类操作（批量移动/重命名/归档/复制）优先用脚本一次完成（fs 重命名或一行 mv），避免逐文件 read→write→delete 的多轮低效操作。',
    parameters: {
      type: 'object',
      properties: {
        script_path: { type: 'string', description: '相对项目根目录的脚本路径（如 "scripts/test.py"）' },
        args: {
          type: 'array',
          description: '传递给脚本的参数数组（可选）',
          items: { type: 'string', properties: {}, required: [] },
        },
        timeout_ms: {
          type: 'number',
          description: '执行超时秒数（可选，默认 60，上限 600；脚本内 API 调用等长耗时任务可调大）',
        },
      },
      required: ['script_path'],
    },
  },
  {
    name: 'list_resources',
    description:
      '列出技能的 L3 资源清单（渐进披露 L3）。返回 resources/ 与 references/ 目录下所有资源文件列表。',
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
  // ── 评估/评审型小组会议（单次 LLM 调用注入多角色 persona）──
  RUN_TEAM_MEETING_TOOL,
];
