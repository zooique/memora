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
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import type { IWebSearchProvider } from '@/web-search/types.js';
import { safeSearch } from '@/web-search/webSearchProvider.js';
import type { IFetchProvider } from '@/web-fetch/types.js';
import { safeFetch } from '@/web-fetch/webFetchProvider.js';
import type { ICodeExecutionProvider } from '@/code-exec/types.js';
import { safeExecuteCode } from '@/code-exec/codeExecutionProvider.js';
import { formatExecutionResult, formatScriptResult, runSkillScript } from '@/skill/skillScriptRunner.js';
import { resolveSafePath } from '@/utils/scanner.js';
import type {
  IProjectSearchProvider,
  ProjectTextSearchResult,
} from '@/project-search/types.js';
import { safeSearchProjectFiles, safeSearchProjectText } from '@/project-search/projectSearchProvider.js';
import { buildSearchTerms } from '@/project-search/terms.js';
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

/**
 * 语言名收敛为脚本运行时白名单三档（node/python/shell）
 *
 * run_project_script 的内核子进程执行器只接受三档运行时；
 * 从扩展名推断的语言若落在白名单外一律兜底 'node'（推断即可信来源，不规则值不回传执行器）。
 */
function normalizeScriptRuntime(language: string): 'node' | 'python' | 'shell' {
  if (language === 'python') return 'python';
  if (language === 'shell') return 'shell';
  return 'node';
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

/**
 * search_project（content 模式）结果格式化 —— 诚实化收口（SEARCH-1）
 *
 * 三态分流（对齐 ripgrep 的 exit 0 / 1 / 2）：
 *   - `failed`              → 检索**未完成**，不得表述为"未找到"（F3：搜索坏了 ≠ 项目里没有）；
 *   - `matches.length === 0` → 零命中，但必须交代「这个零为什么可以信」：截断（F2）/ 只检索了前一部分（F4）/ 读取失败（P5）/ 已放宽（F1）；
 *   - 有命中               → 列结果 + 标注放宽 / 截断 / 单文件上限（F5/F6）。
 *
 * ⚠️ 放宽用词**只**从 `result.termsUsed` 取（**不**回退到调用方自己下发的 `terms`）：两份副本要
 * 保持一致就是双轨镜像；唯一真值 = 宿主回报的"实际用了哪些词"。
 * ⚠️ 文案不重复宿主内部的魔法数（如单文件上限 3）：内核从不扫描，把宿主的内部预算写进内核文案
 * 就是跨层常量镜像（D4 判定律），故只说"被单文件上限截断"而不说"仅显示前 3 条"。
 */
function formatProjectTextSearch(result: ProjectTextSearchResult, query: string): string {
  if (result.failed) {
    return (
      `（项目内容检索未完成（超时或出错），"${query}" 是否存在尚无结论——这不是"没搜到"。` +
      '可重试一次，或换更短/更具体的关键词）'
    );
  }

  const scanned = result.scannedFiles ?? 0;
  const partial = result.partialReadFiles ?? 0;
  const unreadable = result.unreadableSkipped ?? 0;
  const relaxedNote = result.relaxed
    ? `；整串未命中，已按分词放宽为 ${(result.termsUsed ?? []).join('、')} 后仍未命中`
    : '';

  if (result.matches.length === 0) {
    // 零命中的"可信度缺口"：有哪些文件/范围根本没被检索过
    const gaps: string[] = [];
    if (result.truncated) {
      gaps.push(
        result.truncatedBy === 'files'
          ? `已扫描 ${scanned} 个文件后达扫描上限，项目仍有未检索的文件`
          : '结果与扫描均已达上限，项目可能仍有未检索的文件',
      );
    }
    if (partial > 0) gaps.push(`另有 ${partial} 个文件只检索了前一部分（文件过大，后半段未覆盖）`);
    if (unreadable > 0) gaps.push(`另有 ${unreadable} 个文件读取失败，完全未参与检索`);
    if (gaps.length > 0) {
      return (
        `（未找到包含 "${query}" 的文件${relaxedNote}；但${gaps.join('，')}——` +
        '因此这个"未找到"不等于"不存在"，可缩小 exclude 范围或换更具体的关键词后重试）'
      );
    }
    return `（未找到包含 "${query}" 的文件${relaxedNote}；已检索 ${scanned} 个文件，无截断、无跳过）`;
  }

  const lines = result.matches
    .map((m, i) => `${i + 1}. ${m.path}${m.line ? `:${m.line}` : ''}${m.preview ? ` — ${m.preview}` : ''}`)
    .join('\n');
  const notes: string[] = [];
  if (result.relaxed) {
    notes.push(
      `整串未精确命中，以下为按分词放宽（${(result.termsUsed ?? []).join('、')}）后的匹配，可能不是精确命中`,
    );
  }
  if (result.perFileCapped) {
    notes.push('部分文件的命中被单文件上限截断（该文件内可能还有更多命中，可用 read_file 精读）');
  }
  if (result.truncated) {
    notes.push(
      result.truncatedBy === 'files'
        ? `已扫描 ${scanned} 个文件后达扫描上限，项目可能仍有更多匹配`
        : `结果可能已截断：仅返回前 ${result.matches.length} 条，项目可能仍有更多匹配`,
    );
  }
  if (partial > 0) notes.push(`另有 ${partial} 个文件只检索了前一部分（文件过大，后半段未覆盖）`);
  if (unreadable > 0) notes.push(`另有 ${unreadable} 个文件读取失败，完全未参与检索`);
  return notes.length > 0 ? `${lines}\n（${notes.join('；')}）` : lines;
}

// ─── read_skill / read_resource 注入防御常量 ─────────────────
/** read_skill 技能正文单次返回最大长度（防超长技能正文注入上下文；静态角色包内容走字符上限，与 read_file 的 token 预算分段是不同通道） */
const SKILL_CONTENT_MAX_LEN = 50_000;
/** read_resource 资源正文单次返回最大长度（防超长资源注入上下文；与 read_skill 同标准） */
const RESOURCE_CONTENT_MAX_LEN = 50_000;

/**
 * 去 ANSI 转义序列与不可打印控制字符（**不限长**）
 *
 * 净化规则的单一真理源。外部不可信内容（web_search / 子进程输出 / 文件正文）注入 LLM 上下文前
 * 须剥掉控制字符，防转义/终端注入。
 *
 * @param text 原始文本
 * @returns 净化后的文本
 */
export function stripControlChars(text: string): string {
  // 去 ANSI 转义序列（CSI：ESC [ 参数 + 终结符；2026-09-08 env 继承后子进程可能继承
  // FORCE_COLOR 输出色码，单剥 ESC 会留 `[33m` 残渣——整个序列须剥净）
  const withoutAnsi = text.replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '');
  // 去控制字符：保留可打印字符（含 \t 制表符），其余控制字符移除
  return withoutAnsi.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * 外部工具返回净化：去控制字符 + 长度上限
 *
 * 净化规则本身抽为 `stripControlChars`（**单一真理源**），供需要「净化但不限长」的调用方复用——
 * 例如 `read_file`：它的长度由 **token 预算分段**（`sliceFileByLineBudget`）收口，不走字符上限，
 * 但仍须剥掉 ANSI/控制字符。否则它只能传一个假的上限（如 MAX_SAFE_INTEGER）来迁就本函数签名。
 *
 * @param text 外部原始文本
 * @param maxLen 最大长度
 * @returns 净化后的文本
 */
export function sanitizeExternalText(text: string, maxLen: number): string {
  const cleaned = stripControlChars(text);
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
 *   2. 任务表 renderer 的行首序号（1-based，渲染形如「3. 描述 [状态]」）；
 *   3. 完整 uuid（stepLog 等展示）。
 *
 * 解析顺序（防歧义）：
 *   - 完整 uuid 全等命中 → 直用；
 *   - 长度恰为 8 的标识 → 按 uuid 前 8 位前缀语义解析（uuid 前 8 位理论可全数字
 *     (10/16)^8≈2.3%，8 位数字绝不可能是任务表序号 → 恒按短 id 语义，杜绝错配）；
 *   - 其余纯数字 → 行首序号（1-based，按 order 匹配——与 renderer「order+1 展示」同键，
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
      return { ok: false, error: `[ERR:INVALID_ARG] 步骤短 id "${stepId}" 不唯一（对应 ${matches.length} 个步骤），请改用任务表行首序号定位` };
    }
    return {
      ok: false,
      error: `[ERR:STEP_NOT_FOUND] 未找到步骤 "${stepId}"：短 id 需为 task_table_write 返回的 8 位标识，或改用任务表行首序号`,
    };
  }
  // 3. 纯数字 → 行首序号（1-based，按 order 匹配）
  if (/^\d+$/.test(stepId)) {
    const idx = Number(stepId) - 1;
    const step = plan.find((s) => s.order === idx);
    if (step) return { ok: true, id: step.id };
    return { ok: false, error: `[ERR:INVALID_ARG] 步骤序号 ${stepId} 超出任务表范围（当前共 ${plan.length} 步，行首序号从 1 开始）` };
  }
  // 4. 未知标识
  return {
    ok: false,
    error: `[ERR:STEP_NOT_FOUND] 未找到步骤 "${stepId}"（可用任务表行首序号或 task_table_write 返回的短 id 定位）`,
  };
}

/**
 * 默认常驻工具集（tool-exposure-model 探索草稿：默认常驻 vs 角色启动）
 *
 * 判据 A（越界判定）：副作用不越出「项目 + 会话 + 内核自有」边界 → 常驻；
 * 判据 B（来源可信）：执行对象已在仓库/技能目录沉淀 → 常驻。
 * 豁免能力白名单：角色包声明 capabilities 不影响这些工具的暴露面。
 *
 * 特权工具（不在此集，受 toolWhitelist 过滤）：web_search / web_fetch（外部网络，
 * 有真实副作用面，判据 A），run_code（LLM 现写任意代码）。
 * task_table_write / task_table_update 曾在此特权集（需 task:plan capability 解锁）——
 * 2026-09-16 用户拍板改为**直接暴露**：任务表是内核 agent 完成多步任务的**必要基建**
 * （与 compress_context / remember_intel 同属"内核自有上下文维护"判据），不应由角色包
 * 能力声明决定是否可用（否则无 task:plan 能力时，引导语提示用任务表而工具不可见 = 死胡同，
 * LLM 只能放弃改用 write_file 硬拆，实测 round-1789531625618 thought seq244-300 铁证）。
 */
export const DEFAULT_EXPOSED_TOOLS: ReadonlySet<string> = new Set([
  // 项目内读写（判据 A；写删的危险度由 confirmWrites/guest 确认层管）
  'read_file',
  'write_file',
  'delete_file',
  'list_dir',
  // 内核自有数据 / 人机交互 / 上下文维护（判据 A 基建）
  'search_memories',
  'trace_summary',
  'list_sessions',
  'compress_context',
  'remember_intel', // 情报区写回（LLM 私有笔记累积，随每轮装配注入）——上下文维护基建，与 compress_context 同族
  // 任务表管理（2026-09-16 直接暴露：内核多步任务必要基建，非角色包可选能力）
  'task_table_write',
  'task_table_update',
  'ask_user',
  'register_work',
  // 技能域（判据 A+B：来源可信；既定豁免）
  'read_skill',
  'read_resource',
  'run_skill_script',
  'list_resources',
  'list_skills',
  // 项目内既有脚本执行（判据 A+B：仓库已沉淀）；search_project 走宿主注入例外，不在此集
  'run_project_script',
]);

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
   * 工具白名单（capabilities → 工具映射产物，M2.1 → 特权声明模型扩展）
   *
   * - `null`（默认）：全部暴露——未声明 capabilities 的角色包/无角色包时保持现状；
   * - `string[]`：在 DEFAULT_EXPOSED_TOOLS（默认常驻豁免集）之上，追加白名单内的特权工具；
   * - `[]`：仅暴露常驻豁免集（配合 toolMode=block 即全禁）。
   *
   * 语义（tool-exposure-model 探索草稿：默认常驻 vs 角色启动）：
   * 角色包声明 capabilities = 声明超越默认边界的**特权**（web:search / code:execute / task:plan
   * 等），而非逐项打开本地能力。本地只读/项目内/内核基建工具默认常驻，不受白名单过滤——
   * 修正「声明任意能力即误杀常驻工具」的暴露面不对称。
   * 白名单只控制**暴露面**（LLM 可见/可调），不改变 execute 路由。
   */
  private toolWhitelist: string[] | null = null;

  /** 安全守卫（构造参数转存，run_code/run_project_script 执行前确认用） */
  private readonly security: SecurityGuard;

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
    // 转存 SecurityGuard 引用：执行型工具（run_code/run_project_script）执行前确认用
    this.security = security;
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
   * 注入 MemoryInspector，启用 search_memories 的语义混合搜索后端（memory-tool-recall-design §3.3）。
   * assembler 中它依赖 loop/history、后于 toolExec 构造，故用「构造后注入」——装配期经
   * toolExec.setMemoryInspector(...) 接线，未注入时 search_memories 保持旧关键词行为。
   *
   * @param inspector 记忆搜索器（含语义向量后端 + superseded 过滤 + 溯源揭示）
   */
  setMemoryInspector(inspector: MemoryInspector): void {
    this.builtinHandlers.setMemoryInspector(inspector);
  }

  /**
   * 注入 memoryRecalled 事件发射回调（宿主感知「LLM 查询记忆命中 N 条」，§2.4 保留改语义定案）。
   * 转发给 builtinHandlers：search_memories 命中记忆时触发，与 warmRecall 的 memoryRecalled 并为仅存两个触发位。
   *
   * @param callback 命中回调（count 命中条数 / query 检索词），缺省注入则工具静默（无宿主 no-op）
   */
  setOnMemoryRecalled(callback: (info: { count: number; query: string }) => void): void {
    this.builtinHandlers.setOnMemoryRecalled(callback);
  }

  /**
   * 注入召回互斥排除集提供者（memory-tool-recall-design §5.1 工具互斥），
   * 转发给 builtinHandlers：search_memories 用它排除「正文或摘要已在眼前」的轮次 round-summary。
   * assembler 中装配期 wiring（与 setMemoryInspector 同一时机），缺省不注入则工具不过滤。
   *
   * @param provider 返回当前会话「内容已在上下文」的 roundId 精确集合（无参，从 loop 视图派生）
   */
  setExclusionRoundIdsProvider(provider: () => ReadonlySet<string>): void {
    this.builtinHandlers.setExclusionRoundIdsProvider(provider);
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
   * 白名单语义（M2.1 → tool-exposure-model 特权声明模型）：
   * - toolWhitelist === null：全部暴露（内置 + web_search 条件 + 自定义工具）；
   * - toolWhitelist === string[]：全部暴露命中「默认常驻豁免集 DEFAULT_EXPOSED_TOOLS」的
   *   内置工具，特权工具（web_search / web_fetch / run_code / task_table_*）按名单过滤；
   * - toolWhitelist === []：仅常驻豁免集（角色无任何特权能力时，本地能力仍完整可用）。
   * - 自定义工具始终暴露（宿主注册，属宿主能力面，角色包能力声明不越权过滤宿主工具）；
   * - search_project：宿主注入即暴露（方案乙）——本地只读工具，等价 read_file 的只读语义，
   *   不受角色包能力声明与豁免集语义约束（具备与否不决定其可见性）。
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

    // 常驻豁免集无条件暴露（LLM 工具面不因角色包能力声明收窄本地能力）
    const exposed = baseTools.filter((t) => DEFAULT_EXPOSED_TOOLS.has(t.name));

    // 特权工具按白名单过滤（toolWhitelist=null 全暴露；否则只在名单内）
    const privileged = baseTools.filter((t) => !DEFAULT_EXPOSED_TOOLS.has(t.name));
    const whitelisted = this.toolWhitelist
      ? privileged.filter((t) => this.toolWhitelist?.includes(t.name))
      : privileged;

    // search_project 作为宿主注入工具（方案乙）：注入即暴露，追加在自定义工具之后，不受白名单过滤
    const projectSearchTool = this.projectSearchProvider ? [SEARCH_PROJECT_TOOL] : [];

    return [...exposed, ...whitelisted, ...[...this.customTools.values()].map((e) => e.definition), ...projectSearchTool];
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
        return this.builtinHandlers.readFile(
          strArg('path'),
          strArg('offset') || undefined,
          strArg('limit') || undefined,
        );
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
        // 执行确认：guest 模式或 confirmScripts 时询问（run_code 由宿主沙箱执行，此处为权限层确认；
        // owner+confirmScripts=false 自动批准，走审计。code 无落盘路径，target 用描述型标识）
        const execConfirmed = await this.security.confirmScriptRun(
          scriptPath ? `run_code:script:${scriptPath}` : 'run_code:inline',
          'run_code',
          scriptPath ? `运行脚本 ${scriptPath}（宿主沙箱）` : `执行内联代码（${execLanguage}，${execCode.length} 字符，宿主沙箱）`,
        );
        if (!execConfirmed) {
          return '[ERR:SCRIPT_DECLINE] 代码执行未获确认（用户拒绝或未注入确认回调，fail-closed）';
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
          // 放宽词表（D1 精确优先 + 零命中回退）：剔除与整串等价的词——否则宿主会做一轮与
          // 精确轮逐字相同的徒劳扫描，并回报一个名不副实的 relaxed
          const terms = buildSearchTerms(query).filter((t) => t.toLowerCase() !== query.trim().toLowerCase());
          const search = await safeSearchProjectText(this.projectSearchProvider, {
            pattern: query,
            ...(terms.length > 0 ? { terms } : {}),
            exclude,
            maxResults,
          });
          return formatProjectTextSearch(search, query);
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
        // 寻址统一解析（2026-09-06 契约收口，见 resolveStepId）：renderer 只向 LLM 展示行首序号（1-based），
        // task_table_write 返回 uuid 前 8 位短 id，stepLog 展示完整 uuid——三种来源全部归一为真实 uuid 后
        // 再走 updateStep（全等写点）。此前只支持行首序号，短 id 断链（描述承诺了但无解析实现）。
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
        // 脚本执行确认（2026-09-11 定案，与 run_code/run_project_script 同判据）：
        // owner + confirmScripts=false 默认放行（技能脚本来源可信，判据 B，无人值守可跑）；
        // guest 恒确认（受限权限下禁止"来源可信豁免"自主执行，缝合三脚本工具语义裂缝）；
        // confirmScripts=true 时 owner 亦确认（开关语义 = "脚本执行二次确认"，对全部脚本生效）。
        // 无 OS 级沙箱（子进程直跑 + env 继承用户环境），故不能以 Codex workspace-write 的
        // "边界内自动"前提豁免 guest。target 用技能名:脚本路径标识（无落盘绝对路径）。
        const execConfirmed = await this.security.confirmScriptRun(
          `skill:${skillName}:${scriptPath ?? ''}`,
          'run_skill_script',
          `执行技能 ${skillName} 的脚本 ${scriptPath ?? ''}`,
        );
        if (!execConfirmed) {
          return '[ERR:SCRIPT_DECLINE] 技能脚本执行未获确认（用户拒绝或未注入确认回调，fail-closed）';
        }
        const result = await this.runSkillScript(skillName, scriptPath, scriptArgs);
        if (result === null) {
          return `[ERR:SCRIPT_NOT_FOUND] 未找到脚本 "${scriptPath}"（技能 "${skillName}" 无此脚本，或执行失败）`;
        }
        // 返回净化：脚本输出当外部内容去控制字符 + 长度上限（8-1 对齐 run_code 的防护），防刷屏撑爆上下文
        return sanitizeExternalText(result, RUN_SCRIPT_RESULT_MAX_LEN);
      }
      case 'run_project_script': {
        // 项目内已有脚本执行（默认开放，判据 A+B）：内核子进程执行，脚本源码不进上下文
        // 三道防线：路径白名单（执行时二次强制，响应「注册≠强制」教训）→ 确认 → 运行时白名单三档
        const scriptPath = strArg('script_path');
        if (!scriptPath) {
          throw toolError(
            'run_project_script 缺少 script_path 参数',
            '未传脚本路径',
            ['传相对项目根目录的脚本路径，如 "scripts/test.py"'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        const scriptArgs = Array.isArray(args['args']) ? (args['args'] as string[]) : [];
        // ① 路径白名单：相对项目根解析，防穿越返回 null → 拒绝（越界不协商）
        const fullPath = resolveSafePath(this.builtinHandlers.projectPath, scriptPath);
        if (!fullPath) {
          return `[ERR:PATH_DENIED] 脚本路径越界（超出项目根）："${scriptPath}"`;
        }
        // ② 执行确认：guest 模式或 confirmScripts 时询问（owner 默认自动批准，走审计）
        const confirmed = await this.security.confirmScriptRun(
          fullPath,
          'run_project_script',
          `运行项目脚本 ${scriptPath}`,
        );
        if (!confirmed) {
          return '[ERR:SCRIPT_DECLINE] 脚本运行未获确认（用户拒绝或未注入确认回调，fail-closed）';
        }
        // ③ 运行时白名单：扩展名推断并收敛到 node/python/shell 三档（推断即可信，不规则兜底 node）
        const runtime = normalizeScriptRuntime(inferLanguageFromScriptPath(scriptPath));
        // timeout_ms（秒，可选）→ 毫秒透传内核执行器（默认 60s，上限 600s，见 skillScriptRunner 常量）；
        // 脚本内 API 调用/批处理等长耗时任务由 LLM 按需传参，避免误超时
        const timeoutMs = Number.isFinite(args['timeout_ms']) ? Number(args['timeout_ms']) * 1000 : undefined;
        const result = await runSkillScript(
          fullPath,
          runtime,
          scriptArgs,
          timeoutMs,
          // cwd=项目根：项目脚本可加载项目本地依赖/相对数据文件
          this.builtinHandlers.projectPath,
        );
        // 返回净化：脚本输出当外部内容去控制字符 + 长度上限（防刷屏撑爆上下文，对齐 run_skill_script）
        return sanitizeExternalText(formatScriptResult(result), RUN_SCRIPT_RESULT_MAX_LEN);
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
