/**
 * 工具执行器
 *
 * 4 个内置工具：read_file / write_file / list_dir / search_memories
 * 安全采用两级权限 + 工具白名单 + 路径白名单
 *
 * 内置工具实现 + 路径安全已提取到 BuiltinToolHandlers，
 * ToolExecutor 聚焦工具注册 / 分发 / 参数校验。
 */
import type { SecurityGuard } from '@/security/pathGuard.js';
import { toolError, configError, MemoraError, ToolErrorCode } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';
import { truncate } from '@/utils/strings.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import { BUILTIN_TOOLS, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, RUN_CODE_TOOL, SEARCH_PROJECT_TOOL, type ToolDefinition } from '@/agent/builtinTools.js';
import { BuiltinToolHandlers } from '@/agent/builtinToolHandlers.js';
import type { IWebSearchProvider } from '@/web-search/types.js';
import { safeSearch } from '@/web-search/webSearchProvider.js';
import type { IFetchProvider } from '@/web-fetch/types.js';
import { safeFetch } from '@/web-fetch/webFetchProvider.js';
import type { ICodeExecutionProvider } from '@/code-exec/types.js';
import { safeExecuteCode } from '@/code-exec/codeExecutionProvider.js';
import { formatExecutionResult } from '@/skill/skillScriptRunner.js';
import type { IProjectSearchProvider } from '@/project-search/types.js';
import { safeSearchProjectFiles, safeSearchProjectText } from '@/project-search/projectSearchProvider.js';
export { BUILTIN_TOOLS, BUILTIN_TOOL_IDEMPOTENCY } from '@/agent/builtinTools.js';
export type { ToolDefinition } from '@/agent/builtinTools.js';

// ─── web_search 注入防御常量 ─────────────────

/** web_search 查询串最大长度（防过长/恶意查询滥用） */
const WEB_SEARCH_QUERY_MAX_LEN = 200;
/** web_search 单条结果字段最大长度（防长上下文注入） */
const WEB_SEARCH_RESULT_MAX_LEN = 500;

// ─── web_fetch / run_code 注入防御常量 ─────────────────

/** web_fetch 的 url 最大长度（防超长/恶意 URL 滥用） */
const WEB_FETCH_URL_MAX_LEN = 2000;
/** web_fetch 正文单次返回最大长度（防长上下文注入，对齐 BUILTIN_TOOLS 的 limit 上限） */
const WEB_FETCH_CONTENT_MAX_LEN = 50_000;
/** run_code 的 code 最大长度（防超长代码滥用） */
const RUN_CODE_CODE_MAX_LEN = 50_000;
/** run_code 的 language 最大长度（防超长语言名滥用） */
const RUN_CODE_LANGUAGE_MAX_LEN = 32;
/** run_code 单次结果字段最大长度（防长输出撑爆上下文） */
const RUN_CODE_RESULT_MAX_LEN = 20_000;

// ─── run_code script_path 模式：脚本扩展名 → 语言推断 ─────────────────

/** 脚本文件扩展名 → 执行语言映射（script_path 模式省略 language 时推断用；可用性仍取决于宿主执行器） */
const SCRIPT_EXT_LANGUAGE: Record<string, string> = {
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.py': 'python',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  // 注：'.ts' 不在可靠支持集合——node 无法直接解析 TS，省略 language 时交由下方兜底 'node'，
  // 是否真能执行取决于宿主执行器是否具备 TS 转译能力（如 vscode codeExecutor 仅别名 .js/.mjs/.cjs）。
};
/** 无法识别扩展名时的兜底语言（脚本模式默认按 Node 执行） */
const SCRIPT_LANGUAGE_FALLBACK = 'node';

/**
 * 按脚本文件扩展名推断执行语言（run_code script_path 模式）
 *
 * 纯字符串解析（不引入 node:path 依赖，保持 toolExecutor 零 node 依赖的编排层纯度）。
 *
 * @param scriptPath 相对项目根的脚本路径
 * @returns 推断的语言名；无法识别时回退 SCRIPT_LANGUAGE_FALLBACK
 */
function inferLanguageFromScriptPath(scriptPath: string): string {
  // 取最后一个点号后的扩展名（含点）并小写；无扩展名则回退兜底语言
  const lastDot = scriptPath.lastIndexOf('.');
  const ext = lastDot >= 0 ? scriptPath.slice(lastDot).toLowerCase() : '';
  return SCRIPT_EXT_LANGUAGE[ext] ?? SCRIPT_LANGUAGE_FALLBACK;
}

// ─── run_skill_script 注入防御常量 ─────────────────
/** run_skill_script 单次结果最大长度（防脚本刷屏撑爆上下文；对齐 run_code 的 RUN_CODE_RESULT_MAX_LEN） */
const RUN_SCRIPT_RESULT_MAX_LEN = 20_000;

// ─── search_project 注入防御常量 ─────────────────
/** search_project 的 query 最大长度（防超长 glob/关键词滥用） */
const PROJECT_SEARCH_QUERY_MAX_LEN = 500;
/** search_project 的 include/exclude glob 最大长度（防超长模式滥用） */
const PROJECT_SEARCH_GLOB_MAX_LEN = 1000;
/** search_project 单次返回最大条数（防结果刷屏撑爆上下文；对齐 list_dir 的条目上限；导出供宿主实现方对齐） */
export const PROJECT_SEARCH_RESULT_MAX_LEN = 100;

/**
 * search_project 预算下探档位（G4 预算联动，2026-08-31）
 *
 * 剩余对话预算（token）越紧，结果条数上限越低——防止搜索结果撑爆上下文。
 * 与 builtinTools 的 maxResults「默认 20 / 最大 100」语义叠加（取更小者）：
 * LLM 传入的 maxResults 仍按其意愿生效，但不得超过当前预算档位的 cap。
 * 档位从高到低遍历，首个满足 remaining >= minRemaining 的档位生效。
 */
const SEARCH_BUDGET_TIERS: ReadonlyArray<{ minRemaining: number; cap: number }> = [
  { minRemaining: 40_000, cap: 100 }, // 预算充裕：维持内核硬上限
  { minRemaining: 16_000, cap: 30 }, // 中等：降档，结果仍在可精读范围
  { minRemaining: 6_000, cap: 10 }, // 偏紧：只保留最高价值命中
  { minRemaining: 0, cap: 3 }, // 极紧：仅兜底条数
];

/**
 * 按剩余对话预算下探 search_project 结果条数上限
 *
 * @param remainingTokens 剩余对话预算（token）；undefined 表示无预算信息（未装配 loop / 未 prepare）
 * @returns 预算档位 cap；无预算信息时返回硬上限（保持原行为，不做下探）
 */
function computeBudgetCappedMaxResults(remainingTokens: number | undefined): number {
  if (remainingTokens === undefined) return PROJECT_SEARCH_RESULT_MAX_LEN;
  const tier = SEARCH_BUDGET_TIERS.find((t) => remainingTokens >= t.minRemaining);
  return tier?.cap ?? SEARCH_BUDGET_TIERS.at(-1)!.cap;
}

// ─── read_skill / read_resource 注入防御常量 ─────────────────
/** read_skill 技能正文单次返回最大长度（防超长技能正文注入上下文；静态文档对齐 read_file 的 FILE_READ_MAX_LEN） */
const SKILL_CONTENT_MAX_LEN = 50_000;
/** read_resource 资源正文单次返回最大长度（防超长资源注入上下文；与 read_skill 同标准） */
const RESOURCE_CONTENT_MAX_LEN = 50_000;

/**
 * 外部工具返回净化：去控制字符 + 长度上限
 *
 * web_search 返回的是外部不可信内容，注入 LLM 上下文前须净化：
 * 去掉控制字符（防转义/终端注入），再按上限截断（防长上下文注入）。
 *
 * @param text 外部原始文本
 * @param maxLen 最大长度
 * @returns 净化后的文本
 */
export function sanitizeExternalText(text: string, maxLen: number): string {
  // 去控制字符：保留可打印字符（含 \t 制表符），其余控制字符移除
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/**
 * 写入扩展接口
 *
 * 用于在 writeFile 之前注入自定义逻辑（如 diff 展示 + 用户确认）。
 * 当 onBeforeWrite 被提供时，它将替代 SecurityGuard.requestWriteConfirmation 的安全确认流程。
 */
export interface WriteExtensions {
  /**
   * 写入前回调
   * @param path 相对路径
   * @param beforeContent 文件旧内容（null 表示新文件）
   * @param afterContent 要写入的新内容
   * @returns true 继续写入，false 拒绝写入
   */
  onBeforeWrite?: (
    path: string,
    beforeContent: string | null,
    afterContent: string,
  ) => Promise<boolean>;
}

/**
 * 自定义工具的执行上下文
 *
 * 提供安全校验方法，让自定义工具可以（且应该）通过安全层校验路径。
 * 内置工具（read_file/write_file/list_dir）已内置路径校验，
 * 自定义工具如需访问文件系统，应调用 ctx.guardPath() 确保路径在白名单内。
 */
export interface ToolContext {
  /**
   * 校验路径是否在安全白名单内
   *
   * @param path 要校验的路径（相对项目根目录或绝对路径）
   * @throws MemoraError 路径不在白名单内时抛出
   */
  guardPath: (path: string) => void;
}

/**
 * 自定义工具的处理器类型
 *
 * 宿主项目通过 agent.registerTool() 注册领域工具时，
 * 需提供此签名的 handler 函数。
 * handler 接收解析后的参数对象和工具上下文，返回字符串结果。
 *
 * 自定义工具如需访问文件系统，应调用 ctx.guardPath(path) 校验路径。
 */
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

/**
 * 自定义工具注册条目
 *
 * 将工具定义与处理器绑定在一起，
 * 存入 ToolExecutor 的 customTools Map 中。
 */
// 模块私有（0 外部 import，仅 toolExecutor.ts 内部 customTools Map 使用）
interface CustomToolEntry {
  /** 工具定义（名称、描述、参数 schema） */
  definition: ToolDefinition;
  /** 工具执行处理器 */
  handler: ToolHandler;
}

/** step_id 寻址解析结果（ok = 已解析为真实步骤 uuid；fail = 错误文案直接回 LLM） */
type StepIdResolve = { ok: true; id: string } | { ok: false; error: string };

/** resolveStepId 所需的 plan 投影（只读形状，不依赖完整 PlanStep） */
interface StepIdPlanRef {
  id: string;
  order: number;
}

/**
 * 解析 task_table_update 的 step_id 为真实步骤 uuid（2026-09-06 寻址契约收口——唯一解析点）。
 *
 * LLM 可见的步骤标识有三种来源，缺一不可达即断链：
 *   1. task_table_write 返回的短 id（uuid 前 8 位，恒 8 hex；见 assembler writePlan 渲染）；
 *   2. 任务表 renderer 的 # 列序号（1-based）；
 *   3. 完整 uuid（stepLog 等展示）。
 *
 * 解析顺序（防歧义）：
 *   - 完整 uuid 全等命中 → 直用；
 *   - 长度恰为 8 的标识 → 按 uuid 前 8 位前缀语义解析（uuid 前 8 位理论可全数字
 *     (10/16)^8≈2.3%，8 位数字绝不可能是任务表序号 → 恒按短 id 语义，杜绝错配）；
 *   - 其余纯数字 → # 序号（1-based，按 order 匹配——与 renderer「order+1 展示」同键，
 *     不依赖「order==数组下标」弱不变量）；
 *   - 其余 → 未找到（提示可用格式）。
 *
 * 失败返回带定位提示的错误文案；成功后由调用方以完整 uuid 走 planManager.updateStep
 * （sessionManager.updatePlanStepStatus 保持全等匹配写点，不被污染）。
 */
function resolveStepId(stepId: string, plan: StepIdPlanRef[]): StepIdResolve {
  // 1. 完整 uuid 全等（含连字符，长度 36）
  if (plan.some((s) => s.id === stepId)) return { ok: true, id: stepId };
  // 2. 短 id（uuid 前 8 位，恒 8 字符）
  if (stepId.length === 8) {
    const matches = plan.filter((s) => s.id.startsWith(stepId));
    if (matches.length === 1) return { ok: true, id: matches[0]!.id };
    if (matches.length > 1) {
      return { ok: false, error: `[ERR:INVALID_ARG] 步骤短 id "${stepId}" 不唯一（对应 ${matches.length} 个步骤），请改用任务表 # 序号定位` };
    }
    return {
      ok: false,
      error: `[ERR:STEP_NOT_FOUND] 未找到步骤 "${stepId}"：短 id 需为 task_table_write 返回的 8 位标识，或改用任务表 # 序号`,
    };
  }
  // 3. 纯数字 → # 序号（1-based，按 order 匹配）
  if (/^\d+$/.test(stepId)) {
    const idx = Number(stepId) - 1;
    const step = plan.find((s) => s.order === idx);
    if (step) return { ok: true, id: step.id };
    return { ok: false, error: `[ERR:INVALID_ARG] 步骤序号 ${stepId} 超出任务表范围（当前共 ${plan.length} 步，# 列从 1 开始）` };
  }
  // 4. 未知标识
  return {
    ok: false,
    error: `[ERR:STEP_NOT_FOUND] 未找到步骤 "${stepId}"（可用任务表 # 序号或 task_table_write 返回的短 id 定位）`,
  };
}

/**
 * 工具执行器
 *
 * 职责：工具注册 + 分发 + 参数校验。
 * 内置工具实现委托给 BuiltinToolHandlers。
 */
export class ToolExecutor {
  /** 自定义工具注册表（宿主项目通过 registerTool 注册领域工具） */
  private readonly customTools = new Map<string, CustomToolEntry>();
  /** 内置工具处理器（路径安全 + 内置工具实现） */
  private readonly builtinHandlers: BuiltinToolHandlers;
  /**
   * 工具列表变更回调（由 assembleComponents 设置为 loop.refreshToolDefinitions）
   *
   * registerTool 调用后触发，确保 AgentLoop 的 toolDefinitions 快照和 system prompt
   * 同步更新。无 AgentLoop 时为 undefined（如纯 ToolExecutor 单元测试场景）。
   */
  private onToolsChanged?: () => void;

  /**
   * 工具白名单（capabilities → 工具映射产物，M2.1）
   *
   * - `null`（默认）：全部暴露——未声明 capabilities 的角色包/无角色包时保持现状；
   * - `string[]`：只暴露白名单内的工具（内置 + web_search 按名单过滤，自定义工具不受限）；
   * - `[]`：空白名单 = 无内置工具暴露（配合 toolMode=block 即全禁）。
   *
   * 语义：角色包声明 capabilities 后，工具暴露面 = 该角色包
   * 映射出的工具集——「换角色 → 工具集切换」范式验证的最小实现（mvp-scope 验收标准 7）。
   * 白名单只控制**暴露面**（LLM 可见/可调），不改变 execute 路由。
   */
  private toolWhitelist: string[] | null = null;

  /** 网络搜索提供者（可选，注入时启用 web_search 工具） */
  private readonly webSearchProvider?: IWebSearchProvider;

  /** 网页抓取提供者（可选，注入时启用 web_fetch 工具；与 web_search 构成搜索→抓取闭环） */
  private readonly fetchProvider?: IFetchProvider;

  /** 代码执行提供者（可选，注入时启用 run_code 工具） */
  private readonly codeExecutionProvider?: ICodeExecutionProvider;

  /** 项目搜索提供者（可选，注入时启用 search_project 工具；等价 IDE 全局搜索） */
  private readonly projectSearchProvider?: IProjectSearchProvider;

  /**
   * 剩余对话预算提供者（可选，G4 预算联动，2026-08-31）
   *
   * 由 agent 装配时注入（读取 loop 最近一轮 prepare 的剩余预算），
   * 供 search_project 在预算紧张时下探结果条数上限。
   * undefined / 返回 undefined = 无预算信息，保持原行为（不做下探）。
   * 与 read_skill 等回调同款注入模式（装配时序解耦：loop 创建后才可注入）。
   */
  private budgetProvider?: () => number | undefined;

  /** 注入剩余对话预算提供者（装配时由 loop 创建后注入，见 assembler） */
  setBudgetProvider(provider: () => number | undefined): void {
    this.budgetProvider = provider;
  }

  /** 任务表管理回调（由 agent 装配时注入，处理 task_table_write/update） */
  planManager?: {
    writePlan: (
      mode: 'overwrite' | 'append' | 'update',
      steps: Array<{ description: string; rolePack?: string }>,
    ) => string;
    updateStep: (stepId: string, status: 'done' | 'blocked') => string;
    getPlan: () => Array<{ id: string; description: string; status: string; order: number; rolePack?: string }>;
  };

  /**
   * read_skill 技能正文读取回调（由 agent 装配时注入，处理 read_skill）
   *
   * 渐进披露 L2 数据源（两级技能统一）：先查激活角色包内嵌技能
   * （manifest.skills 的 file 指向），再查全局通用技能池（SkillManager 条目）。
   * 委托装配层注入的回调，避免 ToolExecutor 与 rolePackManager/skillManager 强耦合
   * （装配顺序：rolePackManager 在 toolExec 之后创建，用回调注入解耦时序）。
   * 未注入时 read_skill 返回不可用提示。
   */
  readSkill?: (skillName: string) => Promise<string | null>;

  /**
   * read_resource 资源读取回调（由 agent 装配时注入，处理 read_resource）
   *
   * 渐进披露 L3：读取技能的 resources/ 目录下的参考资料。
   * 委托装配层注入的回调，避免 ToolExecutor 与 rolePackManager/skillManager 强耦合。
   */
  readResource?: (skillName: string, resourcePath: string) => Promise<string | null>;

  /**
   * run_skill_script 脚本执行回调（由 agent 装配时注入，处理 run_skill_script）
   *
   * 渐进披露 L3：执行技能的 scripts/ 目录下的可执行脚本。
   * 脚本源码不进入 LLM 上下文，仅执行结果返回。
   */
  runSkillScript?: (
    skillName: string,
    scriptPath: string,
    args: string[],
  ) => Promise<string | null>;

  /**
   * list_resources 资源清单回调（由 agent 装配时注入）
   *
   * 渐进披露 L3：列出技能的 resources/ 目录下所有资源文件。
   */
  listResources?: (skillName: string) => Promise<string>;

  /**
   * list_skills 技能清单回调（由 agent 装配时注入）
   *
   * 渐进披露 L1 补充：列出当前可用的所有技能清单。
   */
  listSkills?: () => Promise<string>;

  /**
   * register_work 作品索引登记回调（由 agent 装配时注入，处理 register_work）
   *
   * 作品投影（2026-08-26 剪枝）：用户主动触发登记一件作品（文档/代码/笔记）
   * 为项目级 JSON 索引，写 <memoraDir>/work-projections.json（纯元数据指针）。
   * 委托装配层注入的回调，避免 ToolExecutor 与 WorkProjectionManager 强耦合
   * （与 read_skill 同款注入模式）。未注入时 register_work 返回不可用提示。
   */
  registerWork?: (sourcePath: string, description: string) => Promise<string>;

  constructor(
    projectPath: string,
    security: SecurityGuard,
    memoryIndex: IMemoryStorage,
    /** 网络搜索提供者（可选，不传则不启用网络搜索能力） */
    webSearchProvider?: IWebSearchProvider,
    /** 会话存储（可选，trace_summary 溯源原始对话用） */
    sessionStore?: ISessionStore,
    /** 网页抓取提供者（可选，不传则不启用 web_fetch 工具） */
    fetchProvider?: IFetchProvider,
    /** 代码执行提供者（可选，不传则不启用 run_code 工具） */
    codeExecutionProvider?: ICodeExecutionProvider,
    /** 项目搜索提供者（可选，不传则不启用 search_project 工具） */
    projectSearchProvider?: IProjectSearchProvider,
  ) {
    this.webSearchProvider = webSearchProvider;
    this.fetchProvider = fetchProvider;
    this.codeExecutionProvider = codeExecutionProvider;
    this.projectSearchProvider = projectSearchProvider;
    // 内置工具实现 + 路径安全委托给 BuiltinToolHandlers
    // 构造参数仅用于初始化 BuiltinToolHandlers，ToolExecutor 自身不再持有这些引用
    this.builtinHandlers = new BuiltinToolHandlers(
      projectPath,
      security,
      memoryIndex,
      sessionStore,
    );
  }

  /**
   * 注册自定义工具
   *
   * 宿主项目调用此方法注册领域专属工具（如 run_tests、query_database、send_email 等业务专属操作）。
   * 工具名不能与内置工具重复，也不能重复注册。
   * 注册后工具会出现在 `tools.list` 列表中，
   * LLM 可通过 tool_call 调用，execute() 会路由到 handler。
   *
   * @param definition 工具定义（名称、描述、参数 schema）
   * @param handler 工具执行处理器
   * @throws 工具名与内置工具冲突或已注册时抛错
   */
  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    if (!definition.name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(definition.name)) {
      throw configError(
        `工具名无效："${definition.name}"`,
        '必须以字母/下划线开头，只含字母/数字/下划线',
        ['请检查工具名称是否符合命名规范'],
      );
    }
    // 不允许覆盖已暴露的内置工具
    if (BUILTIN_TOOLS.some((t) => t.name === definition.name)) {
      throw configError(`不能覆盖内置工具：${definition.name}`, undefined, [
        '请使用不同的工具名称',
      ]);
    }
    // web_search 仅当 webSearchProvider 已注入时由内核管理，不允许覆盖
    // 未注入时宿主可自由注册自己的 web_search 实现
    if (this.webSearchProvider && definition.name === WEB_SEARCH_TOOL.name) {
      throw configError(`不能覆盖内置工具：${definition.name}`, undefined, [
        '请使用不同的工具名称',
      ]);
    }
    // web_fetch 仅当 fetchProvider 已注入时由内核管理，不允许覆盖
    if (this.fetchProvider && definition.name === WEB_FETCH_TOOL.name) {
      throw configError(`不能覆盖内置工具：${definition.name}`, undefined, [
        '请使用不同的工具名称',
      ]);
    }
    // run_code 仅当 codeExecutionProvider 已注入时由内核管理，不允许覆盖
    if (this.codeExecutionProvider && definition.name === RUN_CODE_TOOL.name) {
      throw configError(`不能覆盖内置工具：${definition.name}`, undefined, [
        '请使用不同的工具名称',
      ]);
    }
    // 不允许重复注册
    if (this.customTools.has(definition.name)) {
      throw configError(`工具已注册：${definition.name}`, undefined, [
        '请使用不同的工具名称，或先注销已有工具',
      ]);
    }
    this.customTools.set(definition.name, { definition, handler });
    logger.info({ tool: definition.name }, '自定义工具已注册');
    // 触发 AgentLoop 刷新 toolDefinitions 快照 + system prompt
    // 未设置回调时（如单元测试）静默跳过
    this.onToolsChanged?.();
  }

  /**
   * 移除自定义工具
   *
   * 供测试场景使用，可在测试后清理已注册的自定义工具。
   * 仅能移除通过 registerTool 注册的自定义工具，无法移除内置工具。
   *
   * @param name 工具名称
   */
  removeTool(name: string): void {
    if (this.customTools.has(name)) {
      this.customTools.delete(name);
      this.onToolsChanged?.();
    }
  }

  /**
   * 设置工具列表变更回调
   *
   * 由 assembleComponents 在构造 AgentLoop 后调用，将 loop.refreshToolDefinitions
   * 绑定到 registerTool 的副作用链路中。这样宿主调用 registerTool 注册工具后，
   * AgentLoop 的 toolDefinitions 快照和 system prompt 会自动刷新，
   * 无需宿主手动调用 refreshToolDefinitions。
   *
   * @param callback 工具列表变更时的回调（传 undefined 清除回调）
   */
  setOnToolsChanged(callback: (() => void) | undefined): void {
    this.onToolsChanged = callback;
  }

  /**
   * 设置工具白名单（M2.1：换角色 → 工具集切换）
   *
   * 角色包激活/切换时由 Agent 调用（getActiveCapabilities → resolveCapabilityTools），
   * 把中立能力声明映射为 memora 工具白名单。变更后触发 onToolsChanged，
   * AgentLoop 的 toolDefinitions 快照与 system prompt 自动刷新。
   *
   * @param whitelist 白名单工具名数组；null=全部暴露（默认，无能力声明时）
   */
  setToolWhitelist(whitelist: string[] | null): void {
    this.toolWhitelist = whitelist;
    this.onToolsChanged?.();
  }

  /** 获取当前工具白名单（null=全部暴露） */
  get currentToolWhitelist(): string[] | null {
    return this.toolWhitelist;
  }

  /**
   * 获取所有工具定义（getter 风格，与 persona/skill 一致）
   *
   * 白名单语义（M2.1）：
   * - toolWhitelist === null：全部暴露（内置 + web_search 条件 + 自定义工具）；
   * - toolWhitelist === string[]：内置 + web_search 只保留名单内工具，自定义工具始终暴露
   *   （自定义工具由宿主注册，属宿主能力面，角色包能力声明不越权过滤宿主工具）。
   * - search_project：宿主注入即暴露（方案乙）——本地只读工具，等价 read_file 的只读语义，
   *   不受角色包能力声明过滤（是否具备 project:search 能力不决定其可见性）。
   */
  get list(): ToolDefinition[] {
    // 条件性包含外部信息工具：仅当注入了对应 provider 时才暴露给 LLM
    // - web_search：webSearchProvider 注入时
    // - web_fetch：fetchProvider 注入时（与 web_search 构成搜索→抓取闭环）
    // - run_code：codeExecutionProvider 注入时
    // - search_project：projectSearchProvider 注入时（项目内搜索，等价 IDE 全局搜索）
    let baseTools = BUILTIN_TOOLS;
    if (this.webSearchProvider) baseTools = [...baseTools, WEB_SEARCH_TOOL];
    if (this.fetchProvider) baseTools = [...baseTools, WEB_FETCH_TOOL];
    if (this.codeExecutionProvider) baseTools = [...baseTools, RUN_CODE_TOOL];

    // 白名单过滤（仅内置/条件工具受控；自定义工具不受限）
    const whitelisted = this.toolWhitelist
      ? baseTools.filter((t) => this.toolWhitelist?.includes(t.name))
      : baseTools;

    // search_project 作为宿主注入工具（方案乙）：注入即暴露，追加在自定义工具之后，不受白名单过滤
    const projectSearchTool = this.projectSearchProvider ? [SEARCH_PROJECT_TOOL] : [];

    return [...whitelisted, ...[...this.customTools.values()].map((e) => e.definition), ...projectSearchTool];
  }

  /**
   * 完整内置工具定义（只读闸查询用，单一真理源）
   *
   * 含全部始终内置工具 + 条件工具（web_search / web_fetch / run_code，仅定义层面，
   * 不论 provider 是否注入）。不过白名单过滤、不含自定义工具——只读闸（ToolRunner）需要
   * 「全部内置定义」以查 readonly 标记，而非「当前暴露面」（被白名单过滤的工具 LLM 调不到，
   * 但 readonly 语义应覆盖全部内置写操作）。工具定义知识归本类，装配层经此取值而非重复 import。
   */
  get builtinDefinitions(): ToolDefinition[] {
    return [...BUILTIN_TOOLS, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, RUN_CODE_TOOL, SEARCH_PROJECT_TOOL];
  }

  /**
   * 执行工具调用
   *
   * 新增参数类型校验。
   * LLM 返回的 tool_call 参数可能类型不匹配（如 number 代替 string），
   * 校验器会根据 ToolDefinition.parameters 自动修正常见类型错误，
   * 避免后续 `as string` 强转导致的运行时错误。
   *
   * @param name 工具名称
   * @param argsJson 参数 JSON 字符串
   * @param extensions 写入扩展（可选，用于 diff 确认等）
   * @returns 工具结果的字符串描述
   */
  async execute(name: string, argsJson: string, extensions?: WriteExtensions): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch (err) {
      const e = toError(err);
      throw toolError(
        '工具参数解析失败',
        `args JSON 无效：${e.message}`,
        ['检查 LLM 输出的工具调用格式', '确认 args 是合法 JSON'],
        e,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    // 参数类型校验 + 自动修正
    // LLM 经常返回 number 代替 string（如 maxDepth: 2 而非 "2"），
    // 校验器根据 ToolDefinition 自动转换，避免后续 as string 出错
    const definition = this.list.find((t) => t.name === name);
    if (definition) {
      args = this.validateAndCoerceArgs(name, args, definition);
    }

    const safeArgs = Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? truncate(v, 200) : v]),
    );
    logger.info({ tool: name, args: safeArgs }, '执行工具');

    // 运行时类型安全：从 args 中提取字符串参数，避免不安全的 as string 断言
    const strArg = (key: string, fallback?: string): string => {
      const val = args[key];
      return typeof val === 'string' ? val : (fallback ?? '');
    };

    // 内置工具调用委托给 BuiltinToolHandlers
    switch (name) {
      case 'read_file':
        return this.builtinHandlers.readFile(strArg('path'));
      case 'write_file':
        return this.builtinHandlers.writeFile(
          strArg('path'),
          strArg('content'),
          extensions,
          strArg('mode', 'overwrite'),
          strArg('insert_line') || undefined,
        );
      case 'list_dir':
        return this.builtinHandlers.listDir(
          strArg('path', '.'),
          strArg('recursive', 'false'),
          strArg('maxDepth', '2'),
        );
      case 'search_memories':
        return this.builtinHandlers.searchMemories(
          strArg('query'),
          strArg('limit', '10'),
          strArg('mode', 'match'),
        );
      case 'trace_summary':
        return this.builtinHandlers.traceSummary(
          strArg('sessionId'),
          strArg('roundId') || undefined,
          strArg('limit', '5'),
        );
      case 'list_sessions':
        return this.builtinHandlers.listSessions(strArg('limit', '10'));
      case 'web_search': {
        // web_search 由 ToolExecutor 直接处理，不经过 BuiltinToolHandlers（文件系统导向）
        // 使用注入的 webSearchProvider 执行网络搜索，带超时保护
        if (!this.webSearchProvider) {
          return '[ERR:TOOL:NOT_AVAILABLE] 错误：网络搜索功能未配置，请先注入 IWebSearchProvider';
        }
        const query = strArg('query');
        if (!query) {
          throw toolError(
            'web_search 工具调用缺少 query 参数',
            'LLM 未传 query',
            ['query 不能为空'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        // 参数校验：query 当不可信输入，做长度上限（allow-list 优先）
        if (query.length > WEB_SEARCH_QUERY_MAX_LEN) {
          throw toolError(
            'web_search query 参数过长',
            `query 超过 ${WEB_SEARCH_QUERY_MAX_LEN} 字符上限`,
            ['缩短搜索关键词'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        const limit = Math.min(Number.parseInt(strArg('limit', '5'), 10) || 5, 20);
        const results = await safeSearch(this.webSearchProvider, query, { limit });
        if (results.length === 0) {
          return `（未找到与 "${query}" 相关的搜索结果）`;
        }
        // 搜索来源透出（G5，2026-08-25）：同批次结果来自同一后端，取首条 endpoint 告知用户实际使用的搜索源
        // （降级到 DuckDuckGo 时即透出「搜索来源：DuckDuckGo」），提升 in-flow 信任；宿主渲染工具结果文本即可见。
        const endpoint = results[0]?.endpoint;
        const sourceLine = endpoint ? `（搜索来源：${endpoint}）` : '';
        // 返回净化：外部内容去控制字符 + 长度上限，防长上下文注入
        const body = results
          .map((r, i) => {
            const title = sanitizeExternalText(r.title, WEB_SEARCH_RESULT_MAX_LEN);
            const url = sanitizeExternalText(r.url || '(无链接)', WEB_SEARCH_RESULT_MAX_LEN);
            const snippet = sanitizeExternalText(
              r.snippet.replace(/\n/g, ' '),
              WEB_SEARCH_RESULT_MAX_LEN,
            );
            return `${i + 1}. ${title}\n   URL: ${url}\n   ${snippet}`;
          })
          .join('\n\n');
        return sourceLine ? `${sourceLine}\n\n${body}` : body;
      }
      case 'web_fetch': {
        // web_fetch 由 ToolExecutor 直接处理（与 web_search 同侧，均为外部信息获取）
        // 使用注入的 fetchProvider 抓取网页正文，带超时保护；失败由 safeFetch 降级
        if (!this.fetchProvider) {
          return '[ERR:TOOL:NOT_AVAILABLE] 错误：网页抓取功能未配置，请先注入 IFetchProvider';
        }
        const url = strArg('url');
        if (!url) {
          throw toolError(
            'web_fetch 工具调用缺少 url 参数',
            'LLM 未传 url',
            ['url 不能为空'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        // 参数校验：url 当不可信输入，做长度上限 + 协议白名单（仅 http/https，防 file:// 等本地协议）
        if (url.length > WEB_FETCH_URL_MAX_LEN) {
          throw toolError(
            'web_fetch url 参数过长',
            `url 超过 ${WEB_FETCH_URL_MAX_LEN} 字符上限`,
            ['缩短 url'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        if (!/^https?:\/\//i.test(url)) {
          throw toolError(
            'web_fetch url 协议不支持',
            `仅支持 http/https 协议：${url.slice(0, 64)}`,
            ['使用 http 或 https 开头的完整 URL'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        const maxChars = Math.min(
          Number.parseInt(strArg('limit', '8000'), 10) || 8000,
          WEB_FETCH_CONTENT_MAX_LEN,
        );
        const page = await safeFetch(this.fetchProvider, url, { maxChars });
        if (!page.content) {
          return `（未能从 "${url}" 提取到正文内容）`;
        }
        // 返回净化：外部内容去控制字符 + 长度上限，防长上下文注入
        const title = sanitizeExternalText(page.title, 500);
        const content = sanitizeExternalText(page.content, WEB_FETCH_CONTENT_MAX_LEN);
        return `来源：${page.url || url}\n标题：${title || '(无标题)'}\n\n${content}`;
      }
      case 'delete_file':
        // 删除项目文件（临时脚本闭环收尾：write_file 写 → run_code 执行 → delete_file 清理）
        // 路径白名单 + 用户确认（guest/confirmWrites）由 BuiltinToolHandlers.deleteFile 负责
        return this.builtinHandlers.deleteFile(strArg('path'));
      case 'run_code': {
        // run_code 由 ToolExecutor 直接处理（通用计算/数据处理/验证底座）
        // 使用注入的 codeExecutionProvider 执行代码，带超时保护；失败由 safeExecuteCode 降级
        if (!this.codeExecutionProvider) {
          return '[ERR:TOOL:NOT_AVAILABLE] 错误：代码执行功能未配置，请先注入 ICodeExecutionProvider';
        }
        const language = strArg('language');
        const code = strArg('code');
        const scriptPath = strArg('script_path');
        // 两种模式互斥：code（执行代码字符串）与 script_path（执行项目脚本文件）二选一，防语义歧义
        if (scriptPath && code) {
          throw toolError(
            'run_code 参数冲突',
            'code 与 script_path 不能同时传入',
            ['二选一：传 code 执行代码字符串，或传 script_path 执行项目脚本文件'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        // 统一执行入参：脚本源码 / 代码字符串 + 语言 + 工作目录
        let execCode: string;
        let execLanguage: string;
        // 临时脚本模式 cwd=项目根（脚本可 require 项目本地依赖、读取项目数据）；code 模式不指定由执行器决定
        const execOptions: { cwd?: string } | undefined = scriptPath
          ? { cwd: this.builtinHandlers.projectPath }
          : undefined;
        if (scriptPath) {
          // 读取脚本文件原样执行（路径白名单 + 长度上限由 readScriptFile 负责，截断会破坏语法）
          execCode = await this.builtinHandlers.readScriptFile(scriptPath);
          execLanguage = language || inferLanguageFromScriptPath(scriptPath);
        } else {
          // 传统 code 模式：language + code 均必填
          if (!language) {
            throw toolError(
              'run_code 工具调用缺少 language 参数',
              'LLM 未传 language',
              ['language 不能为空'],
              undefined,
              ToolErrorCode.ARGUMENT_ERROR,
            );
          }
          if (!code) {
            throw toolError(
              'run_code 工具调用缺少 code 参数',
              'LLM 未传 code',
              ['code 不能为空'],
              undefined,
              ToolErrorCode.ARGUMENT_ERROR,
            );
          }
          execCode = code;
          execLanguage = language;
        }
        // 参数校验：language/code 当不可信输入，做长度上限（防超长滥用）
        // script_path 模式代码长度由 readScriptFile 的 SCRIPT_READ_MAX_LEN 兜底，不重复校验
        if (execLanguage.length > RUN_CODE_LANGUAGE_MAX_LEN) {
          throw toolError(
            'run_code language 参数过长',
            `language 超过 ${RUN_CODE_LANGUAGE_MAX_LEN} 字符上限`,
            ['使用简短的语言名，如 "python"、"node"'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        if (!scriptPath && execCode.length > RUN_CODE_CODE_MAX_LEN) {
          throw toolError(
            'run_code code 参数过长',
            `code 超过 ${RUN_CODE_CODE_MAX_LEN} 字符上限`,
            ['精简代码或分步执行'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        const result = await safeExecuteCode(this.codeExecutionProvider, execCode, execLanguage, execOptions);
        // 结果净化：stdout/stderr 当外部内容去控制字符 + 长度上限，防长上下文注入
        const stdout = sanitizeExternalText(result.stdout, RUN_CODE_RESULT_MAX_LEN);
        const stderr = sanitizeExternalText(result.stderr, RUN_CODE_RESULT_MAX_LEN);
        // 格式化：与 run_skill_script 共用 formatExecutionResult（同一真理源，改格式契约须两链路同步）
        return formatExecutionResult(
          { stdout, stderr, exitCode: result.exitCode, timedOut: result.timedOut },
          { kind: 'CODE', timeoutDetail: '代码执行超时', errorDetail: '代码执行失败' },
        );
      }
      case 'search_project': {
        // search_project 由 ToolExecutor 直接处理（与 web_search/run_code 同侧，均为宿主注入能力）
        // 使用注入的 projectSearchProvider 执行项目内搜索，带超时保护；失败由 safe* 降级
        if (!this.projectSearchProvider) {
          return '[ERR:TOOL:NOT_AVAILABLE] 错误：项目搜索功能未配置，请先注入 IProjectSearchProvider';
        }
        const query = strArg('query');
        const mode = strArg('mode', 'name');
        const exclude = strArg('exclude') || undefined;
        // 预算下探（G4）：LLM 传入的 maxResults 仍按其意愿生效，但不得超过预算档位 cap（防结果撑爆上下文）
        const maxResults = Math.min(
          Number.parseInt(strArg('maxResults', '20'), 10) || 20,
          PROJECT_SEARCH_RESULT_MAX_LEN,
          computeBudgetCappedMaxResults(this.budgetProvider?.()),
        );
        // 参数校验：query/exclude 当不可信输入，做长度上限（防超长 glob/关键词滥用）
        if (query.length > PROJECT_SEARCH_QUERY_MAX_LEN) {
          throw toolError(
            'search_project query 参数过长',
            `query 超过 ${PROJECT_SEARCH_QUERY_MAX_LEN} 字符上限`,
            ['缩短搜索词'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        if ((exclude?.length ?? 0) > PROJECT_SEARCH_GLOB_MAX_LEN) {
          throw toolError(
            'search_project exclude 参数过长',
            `exclude 超过 ${PROJECT_SEARCH_GLOB_MAX_LEN} 字符上限`,
            ['缩短 exclude 模式'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        if (mode !== 'name' && mode !== 'content') {
          return `[ERR:INVALID_ARG] 不支持的搜索模式 "${mode}"，仅支持 name/content`;
        }
        if (mode === 'content') {
          if (!query) {
            return '[ERR:INVALID_ARG] content 模式需要 query 内容关键词';
          }
          const textMatches = await safeSearchProjectText(this.projectSearchProvider, {
            pattern: query,
            exclude,
            maxResults,
          });
          if (textMatches.length === 0) {
            return `（未在项目中找到包含 "${query}" 的文件）`;
          }
          const textLines = textMatches
            .map((m, i) => `${i + 1}. ${m.path}${m.line ? `:${m.line}` : ''}${m.preview ? ` — ${m.preview}` : ''}`)
            .join('\n');
          // 截断诚实化：结果达上限或宿主标记截断时，提示 LLM 勿误判"项目仅此这些"（避免缩小范围后漏答）
          const truncated = textMatches.length >= maxResults || textMatches.some((m) => m.truncated);
          return truncated
            ? `${textLines}\n（结果可能已截断：仅返回前 ${textMatches.length} 条，项目可能仍有更多匹配；如需精确定位请换更具体的关键词）`
            : textLines;
        }
        // name 模式：query 为文件名 glob（省略时列出项目全部文件）
        const fileMatches = await safeSearchProjectFiles(this.projectSearchProvider, {
          query: query || '**/*',
          exclude,
          maxResults,
        });
        if (fileMatches.length === 0) {
          return `（未在项目中找到匹配 "${query || '**/*'}" 的文件）`;
        }
        const fileLines = fileMatches.map((m, i) => `${i + 1}. ${m.path}`).join('\n');
        // name 模式由宿主 findFiles 按 maxResults 截断：返回数达上限即提示可能截断
        return fileMatches.length >= maxResults
          ? `${fileLines}\n（结果可能已截断：仅返回前 ${fileMatches.length} 条，项目可能仍有更多匹配；如需精确定位请换更具体的 glob）`
          : fileLines;
      }
      case 'task_table_write': {
        // 写入任务表（overwrite / append / update）；steps 每项可选 rolePack（会议表层装配角色）
        if (!this.planManager) {
          return '[ERR:TOOL:NOT_AVAILABLE] 任务表功能未就绪';
        }
        const writeMode = strArg('mode', 'overwrite');
        if (writeMode !== 'overwrite' && writeMode !== 'append' && writeMode !== 'update') {
          return `[ERR:INVALID_ARG] 不支持的写入模式 "${writeMode}"，仅支持 overwrite/append/update`;
        }
        const stepsRaw = args.steps;
        const steps = Array.isArray(stepsRaw)
          ? (stepsRaw as Array<{ description: string; rolePack?: string }>).map((s) => ({
              description: String(s?.description ?? ''),
              // rolePack 可选：仅接受非空字符串；范围校验在 prepare 期（越界忽略 + warning）
              ...(s?.rolePack && typeof s.rolePack === 'string' ? { rolePack: s.rolePack } : {}),
            }))
          : [];
        if (steps.length === 0 || steps.some((s) => s.description.trim() === '')) {
          return '[ERR:INVALID_ARG] steps 参数不能为空，且每项须含非空 description';
        }
        return this.planManager.writePlan(writeMode, steps);
      }
      case 'task_table_update': {
        // 更新任务状态
        if (!this.planManager) {
          return '[ERR:TOOL:NOT_AVAILABLE] 任务表功能未就绪';
        }
        const stepId = strArg('step_id');
        if (!stepId) {
          return '[ERR:INVALID_ARG] step_id 不能为空';
        }
        // 寻址统一解析（2026-09-06 契约收口，见 resolveStepId）：renderer 只向 LLM 展示 # 序号（1-based），
        // task_table_write 返回 uuid 前 8 位短 id，stepLog 展示完整 uuid——三种来源全部归一为真实 uuid 后
        // 再走 updateStep（全等写点）。此前只支持 # 序号，短 id 断链（描述承诺了但无解析实现）。
        const plan = this.planManager.getPlan?.() ?? [];
        const resolved = resolveStepId(stepId, plan);
        if (!resolved.ok) {
          return resolved.error;
        }
        const stepStatus = strArg('status', 'done');
        if (stepStatus !== 'done' && stepStatus !== 'blocked') {
          return `[ERR:INVALID_ARG] 不支持的状态 "${stepStatus}"，仅支持 done/blocked`;
        }
        return this.planManager.updateStep(resolved.id, stepStatus);
      }
      case 'read_skill': {
        // 渐进披露 L2：读取激活角色包内嵌技能正文（readSkill 回调由 agent 装配注入）
        // name 为必填参数，已由 validateAndCoerceArgs 校验，此处直接用
        if (!this.readSkill) {
          return '[ERR:TOOL:NOT_AVAILABLE] read_skill 不可用：未装配角色包技能读取回调';
        }
        const content = await this.readSkill(strArg('name'));
        if (content === null) {
          return `[ERR:SKILL_NOT_FOUND] 未找到技能 "${strArg('name')}"（角色包未声明该技能，或技能正文读取失败）`;
        }
        // 返回净化：技能正文当外部内容去控制字符 + 长度上限（防超长技能正文撑爆上下文）
        return sanitizeExternalText(content, SKILL_CONTENT_MAX_LEN);
      }
      case 'read_resource': {
        // 渐进披露 L3：读取技能的参考资源文件
        if (!this.readResource) {
          return '[ERR:TOOL:NOT_AVAILABLE] read_resource 不可用：未装配 L3 资源读取回调';
        }
        const skillName = strArg('skill_name');
        const resourcePath = strArg('resource_path');
        const resourceContent = await this.readResource(skillName, resourcePath);
        if (resourceContent === null) {
          return `[ERR:RESOURCE_NOT_FOUND] 未找到资源 "${resourcePath}"（技能 "${skillName}" 无此资源，或资源读取失败）`;
        }
        // 返回净化：资源正文当外部内容去控制字符 + 长度上限（防超长资源撑爆上下文）
        return sanitizeExternalText(resourceContent, RESOURCE_CONTENT_MAX_LEN);
      }
      case 'run_skill_script': {
        // 渐进披露 L3：执行技能的可执行脚本（脚本源码不进上下文，仅结果返回）
        if (!this.runSkillScript) {
          return '[ERR:TOOL:NOT_AVAILABLE] run_skill_script 不可用：未装配 L3 脚本执行回调';
        }
        const skillName = strArg('skill_name');
        const scriptPath = strArg('script_path');
        const scriptArgs = Array.isArray(args['args']) ? (args['args'] as string[]) : [];
        const result = await this.runSkillScript(skillName, scriptPath, scriptArgs);
        if (result === null) {
          return `[ERR:SCRIPT_NOT_FOUND] 未找到脚本 "${scriptPath}"（技能 "${skillName}" 无此脚本，或执行失败）`;
        }
        // 返回净化：脚本输出当外部内容去控制字符 + 长度上限（8-1 对齐 run_code 的防护），防刷屏撑爆上下文
        return sanitizeExternalText(result, RUN_SCRIPT_RESULT_MAX_LEN);
      }
      case 'list_resources': {
        // 渐进披露 L3：列出技能的资源清单
        if (!this.listResources) {
          return '[ERR:TOOL:NOT_AVAILABLE] list_resources 不可用';
        }
        const skillName = strArg('skill_name');
        return await this.listResources(skillName);
      }
      case 'list_skills': {
        // 渐进披露 L1 补充：列出所有技能清单（>50 技能时使用）
        if (!this.listSkills) {
          return '[ERR:TOOL:NOT_AVAILABLE] list_skills 不可用';
        }
        return await this.listSkills();
      }
      case 'register_work': {
        // 作品投影登记（registerWork 回调由 agent 装配注入；用户主动触发写索引卡片）
        if (!this.registerWork) {
          return '[ERR:TOOL:NOT_AVAILABLE] register_work 不可用：未装配作品投影登记回调';
        }
        const path = strArg('path');
        const description = strArg('description');
        if (!path || !description) {
          return '[ERR:INVALID_ARG] register_work 需要 path（相对项目根）与 description（一句话说明）参数';
        }
        return await this.registerWork(path, description);
      }
      default: {
        // 自定义工具 fallback：查找 customTools Map
        const custom = this.customTools.get(name);
        if (custom) {
          // 传入 ToolContext，提供 guardPath 安全校验方法
          // 路径安全委托给 BuiltinToolHandlers
          const ctx: ToolContext = {
            guardPath: (path: string) => {
              const absolutePath = this.builtinHandlers.resolveSafePath(path);
              this.builtinHandlers.guardPathOrThrow(absolutePath, name, 'custom');
            },
          };
          try {
            return await custom.handler(args, ctx);
          } catch (err) {
            // 统一包装为 MemoraError，保持错误处理一致性
            if (err instanceof MemoraError) throw err;
            const e = toError(err);
            throw toolError(
              '自定义工具执行失败',
              `${name}: ${e.message}`,
              ['检查工具参数是否正确', '检查工具 handler 实现是否有 bug'],
              e,
              ToolErrorCode.CUSTOM_TOOL_FAILED,
            );
          }
        }
        throw toolError(
          '未知工具',
          `agent 调用了未注册的工具：${name}`,
          [
            `已注册工具：${this.list.map((t) => t.name).join(', ')}`,
            '检查 personality.md 是否限制了工具集',
          ],
          undefined,
          ToolErrorCode.UNKNOWN_TOOL,
        );
      }
    }
  }

  /**
   * 参数类型校验 + 自动修正
   *
   * LLM 返回的 tool_call 参数经常类型不匹配：
   *   - number → string（如 maxDepth: 2 而非 "2"）
   *   - boolean → string（如 recursive: true 而非 "true"）
   *   - 缺少必填参数
   *
   * 校验策略：
   *   1. 自动修正：number/boolean → string（最常见的 LLM 错误）
   *   2. 缺少必填参数：抛出 toolError
   *   3. 未知参数：忽略（LLM 可能返回额外参数）
   *
   * @param toolName 工具名称（用于错误信息）
   * @param args LLM 返回的原始参数
   * @param definition 工具定义（含参数 schema）
   * @returns 校验/修正后的参数
   */
  private validateAndCoerceArgs(
    toolName: string,
    args: Record<string, unknown>,
    definition: ToolDefinition,
  ): Record<string, unknown> {
    const props = definition.parameters.properties;
    const required = definition.parameters.required;
    const result = { ...args };

    // 检查必填参数
    for (const req of required) {
      if (result[req] === undefined || result[req] === null) {
        throw toolError(
          '工具参数缺失',
          `${toolName}: 缺少必填参数 "${req}"`,
          [`参数 "${req}" 类型应为 ${props[req]?.type ?? 'unknown'}`],
          undefined,
          ToolErrorCode.ARGUMENT_ERROR,
        );
      }
    }

    // 类型修正：根据 schema 中的 type 字段自动转换
    for (const [key, schema] of Object.entries(props)) {
      const value = result[key];
      if (value === undefined || value === null) continue; // 可选参数未传，跳过

      const expectedType = schema.type;
      const actualType = typeof value;

      // string 类型修正：number / boolean → string
      if (expectedType === 'string' && actualType !== 'string') {
        result[key] = String(value);
        logger.debug(
          { tool: toolName, param: key, from: actualType, to: 'string' },
          '参数类型自动修正',
        );
      }
      // number 类型修正：string → number
      else if (expectedType === 'number' && actualType === 'string') {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          result[key] = num;
          logger.debug(
            { tool: toolName, param: key, from: 'string', to: 'number' },
            '参数类型自动修正',
          );
        }
      }
      // boolean 类型修正：string → boolean
      else if (expectedType === 'boolean' && actualType === 'string') {
        if (value === 'true' || value === '1') {
          result[key] = true;
        } else if (value === 'false' || value === '0') {
          result[key] = false;
        }
        logger.debug(
          { tool: toolName, param: key, from: 'string', to: 'boolean' },
          '参数类型自动修正',
        );
      }
      // array 类型修正：单值 → 数组
      else if (expectedType === 'array' && !Array.isArray(value)) {
        result[key] = [value];
        logger.debug(
          { tool: toolName, param: key, from: actualType, to: 'array' },
          '参数类型自动修正',
        );
      }
    }

    return result;
  }
}
