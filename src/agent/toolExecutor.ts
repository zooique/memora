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
import { requireConfirmingEntry, type ConfirmingEntry } from '@/security/confirmEntries.js';
import { toolError, configError, MemoraError, ToolErrorCode } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';
import { truncate } from '@/utils/strings.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import {
  ALL_BUILTIN_TOOL_DEFS,
  BUILTIN_TOOLS,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  WEB_FETCH_CONTENT_MAX_LEN,
  WEB_FETCH_CONTENT_DEFAULT_LEN,
  RUN_CODE_TOOL,
  buildRunCodeTool,
  SEARCH_PROJECT_TOOL,
  type ToolDefinition,
} from '@/agent/builtinTools.js';
import { sanitizeExternalText } from '@/agent/textSanitize.js';
import {
  okOutcome,
  failedOutcome,
  blockedOutcome,
  type ToolOutcome,
} from '@/agent/managers/toolCallHelpers.js';
import { BuiltinToolHandlers } from '@/agent/builtinToolHandlers.js';
import type { BackgroundTaskRegistry } from '@/agent/backgroundTasks.js';
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import type { IWebSearchProvider } from '@/web-search/types.js';
import { safeSearch } from '@/web-search/webSearchProvider.js';
import type { IFetchProvider } from '@/web-fetch/types.js';
import { safeFetch } from '@/web-fetch/webFetchProvider.js';
import type { ICodeExecutionProvider } from '@/code-exec/types.js';
import { safeExecuteCode } from '@/code-exec/codeExecutionProvider.js';
import {
  formatExecutionResult,
  formatScriptResult,
  formatCommandResult,
  formatKilledCommandOutput,
  resolveCommandTimeoutMs,
  runShellCommand,
  runSkillScript,
  // 脚本执行的结构化事实（exitCode/timedOut），run_skill_script 回调契约加宽后消费
  type ScriptExecutionResult,
} from '@/skill/skillScriptRunner.js';
import { resolveSafePath, inferRuntimeFromExt, type ScriptRuntime } from '@/utils/scanner.js';
import type {
  IProjectSearchProvider,
  ProjectFileSearchResult,
  ProjectTextSearchResult,
} from '@/project-search/types.js';
import {
  safeSearchProjectFiles,
  safeSearchProjectText,
} from '@/project-search/projectSearchProvider.js';
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
/** run_code 的 code 最大长度（防超长代码滥用） */
const RUN_CODE_CODE_MAX_LEN = 50_000;
/** run_code 的 language 最大长度（防超长语言名滥用） */
const RUN_CODE_LANGUAGE_MAX_LEN = 32;
/** run_code 单次结果字段最大长度（防长输出撑爆上下文） */
const RUN_CODE_RESULT_MAX_LEN = 20_000;

// ─── run_code script_path 模式：脚本扩展名 → 运行时推断 ─────────────────
// 扩展名 → runtime 映射的单一真理源在 utils/scanner.ts（SCRIPT_RUNTIME_MAP/inferRuntimeFromExt），
// 此处不复制表；'.ts' 是否可靠支持在 scanner.ts 的映射处唯一声明（node 无法直接解析 TS，
// 实际可用性取决于宿主执行器是否具备转译能力）。未知扩展名兜底 node（script_path 模式下
// 宁尝试执行，能否跑由宿主执行器裁决）。

/**
 * 脚本运行时白名单三档（node/python/shell）
 *
 * run_project_script 的内核子进程执行器只接受三档运行时；
 * 从扩展名推断的语言若落在白名单外一律兜底 'node'（推断即可信来源，不规则值不回传执行器）。
 */
function normalizeScriptRuntime(language: string): ScriptRuntime {
  if (language === 'python') return 'python';
  if (language === 'shell') return 'shell';
  return 'node';
}

// ─── run_skill_script / run_command 注入防御常量 ─────────────────
/**
 * 脚本 / 命令单次结果最大长度（防刷屏撑爆上下文；对齐 run_code 的 RUN_CODE_RESULT_MAX_LEN）
 *
 * ⚠️ 这是**上下文层**的字符上限，与收集侧的**内存护栏**不是一回事：
 * `skillScriptRunner.MAX_COLLECTED_OUTPUT_BYTES`（字节量纲，防 Node 进程内存膨胀）。
 * 两者量纲不同（字符 / 字节 / token 三层各司其职），**禁止互相对齐或合并**——
 * 合并会让「内存护栏」退化成「上下文截断」，或让后者在 CJK 下实际越界。
 */
const RUN_SCRIPT_RESULT_MAX_LEN = 20_000;

/**
 * run_command 单条命令最大长度（防超长命令滥用）
 *
 * 对齐 `RUN_CODE_CODE_MAX_LEN`（50_000）的注入防御口径：LLM 可能吐出整份文件内容当命令传，
 * 而命令原文会**四处扩散**——裁决链正则、确认卡 UI 展示、审计事件、turn 终态脱管报告
 * （脱管报告把每条命令原文写进 system 消息）。不限长 = 一个超长命令污染整条链路。
 */
const RUN_COMMAND_MAX_LEN = 50_000;

/**
 * 脚本 / 代码长输出的**尾部保留**字符数（缺口 D）
 *
 * 只服务「关键信息常在尾部」的长输出（构建失败原因、堆栈末尾、FAIL 汇总行）。
 * 网页正文 / 技能文档 / 资源文件等**头部即要点**的内容**不传**此参数（默认 0，
 * 保持纯头截断——尾部对它们是页脚噪声）。
 * 是否保留尾部由**调用点显式声明**，不在函数内按内容猜测（猜测 = 隐式分支 + 不可预测）。
 */
const SCRIPT_RESULT_TAIL_CHARS = 4_000;

// ─── search_project 注入防御常量 ─────────────────
/** search_project 的 query 最大长度（防超长 glob/关键词滥用） */
const PROJECT_SEARCH_QUERY_MAX_LEN = 500;
/** search_project 的 include/exclude glob 最大长度（防超长模式滥用） */
const PROJECT_SEARCH_GLOB_MAX_LEN = 1000;
/** search_project 单次返回最大条数（防结果刷屏撑爆上下文；对齐 list_dir 的条目上限；导出供宿主实现方对齐） */
export const PROJECT_SEARCH_RESULT_MAX_LEN = 100;

/**
 * search_project 预算下探档位（与对话预算联动）
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
 * @returns 预算档位 cap；无预算信息时返回硬上限（不下探）
 */
function computeBudgetCappedMaxResults(remainingTokens: number | undefined): number {
  if (remainingTokens === undefined) return PROJECT_SEARCH_RESULT_MAX_LEN;
  const tier = SEARCH_BUDGET_TIERS.find((t) => remainingTokens >= t.minRemaining);
  return tier?.cap ?? SEARCH_BUDGET_TIERS.at(-1)!.cap;
}

/**
 * search_project（content 模式）结果格式化 —— 诚实化收口
 *
 * 三态分流（对齐 ripgrep 的 exit 0 / 1 / 2）：
 *   - `failed`              → 检索**未完成**，不得表述为"未找到"（检索失败：搜索坏了 ≠ 项目里没有）；
 *   - `matches.length === 0` → 零命中，但必须交代「这个零为什么可以信」：结果截断 / 只检索了前一部分（部分检索）/ 读取失败 / 已放宽匹配；
 *   - 有命中               → 列结果 + 标注放宽 / 截断 / 单文件上限。
 *
 * ⚠️ 放宽用词**只**从 `result.termsUsed` 取（**不**回退到调用方自己下发的 `terms`）：两份副本要
 * 保持一致就是双轨镜像；唯一真值 = 宿主回报的"实际用了哪些词"。
 * ⚠️ 文案不重复宿主内部的魔法数（如单文件上限 3）：内核从不扫描，把宿主的内部预算写进内核文案
 * 就是跨层常量镜像，故只说"被单文件上限截断"而不说"仅显示前 3 条"。
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
    .map(
      (m, i) =>
        `${i + 1}. ${m.path}${m.line ? `:${m.line}` : ''}${m.preview ? ` — ${m.preview}` : ''}`,
    )
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

/**
 * name 模式检索结果格式化（语义对齐 content 的两轮放宽）
 *
 * name 模式两轮语义：先按 query 原样作 glob 精确匹配；零命中且 query 不含 glob 元字符、
 * 且内核下发了 `terms` 时，宿主按名称子串逐词 OR 放宽。故零命中同样要交代这个零是否可信：
 * 放宽过（可信零）/ 检索失败（无结论）/ 截断过（不可信零）。
 *
 * ⚠️ 放宽用词**只**从 `result.termsUsed` 取（同 content，不回退到内核自己下发的 `terms`）：
 * 唯一真值 = 宿主回报的"实际用了哪些词"。
 */
function formatProjectFileSearch(result: ProjectFileSearchResult, query: string): string {
  if (result.failed) {
    return (
      `（项目文件检索未完成（超时或出错），"${query}" 是否存在尚无结论——这不是"没搜到"。` +
      '可重试一次，或换更具体的文件名模式）'
    );
  }

  // 放宽用词只取宿主回报，文案与 content 同构（"整串"→"整串 glob"的自洽表述）
  const relaxedNote = result.relaxed
    ? `；整串未精确命中，已按名称放宽为 ${(result.termsUsed ?? []).join('、')} 后仍未命中`
    : '';

  if (result.matches.length === 0) {
    // 零命中的"可信度缺口"：检索被截断 → 不一定是"不存在"（name 模式截断仅 results 主因）
    if (result.truncated) {
      return (
        `（未在项目中找到匹配 "${query}" 的文件${relaxedNote}；但检索已达上限、项目仍有未检索的文件——` +
        '这个"未找到"不等于"不存在"，可换更具体的 glob 重试）'
      );
    }
    // 可信零：原文案不变（未放宽 = 原样 glob 精确匹配的零；放宽过则追加放宽说明）
    return `（未在项目中找到匹配 "${query}" 的文件${relaxedNote}）`;
  }

  const fileLines = result.matches.map((m, i) => `${i + 1}. ${m.path}`).join('\n');
  const notes: string[] = [];
  if (result.relaxed) {
    notes.push(
      `整串未精确命中，以下为按名称放宽（${(result.termsUsed ?? []).join('、')}）后的匹配，可能不是精确命中`,
    );
  }
  // name 模式由宿主 findFiles 按 maxResults 截断：达上限即提示可能截断（与 content 文案同构）
  if (result.truncated) {
    notes.push(
      `结果可能已截断：仅返回前 ${result.matches.length} 条，项目可能仍有更多匹配；如需精确定位请换更具体的 glob`,
    );
  }
  return notes.length > 0 ? `${fileLines}\n（${notes.join('；')}）` : fileLines;
}

// ─── read_skill / read_resource 注入防御常量 ─────────────────
/** read_skill 技能正文单次返回最大长度（防超长技能正文注入上下文；静态角色包内容走字符上限，与 read_file 的 token 预算分段是不同通道） */
const SKILL_CONTENT_MAX_LEN = 50_000;
/** read_resource 资源正文单次返回最大长度（防超长资源注入上下文；与 read_skill 同标准） */
const RESOURCE_CONTENT_MAX_LEN = 50_000;

/**
 * 外部文本净化（转发 re-export，保持既有 import 面不破）
 *
 * 实现真源已迁至 `textSanitize.ts`：净化是**跨模块**的最后一道闸（工具返回 / 脚本与资源正文 /
 * 命令结果三处消费），住在本文件有两个后果——① `builtinToolHandlers` 反向 import 本模块
 * 形成循环依赖；② 命令结果的定长上限成了本模块的**私有常量**，第二个消费面
 * （后台完成回流）看不到它 ⇒ 回流路径无长度上限。
 * 本处只做转发，既有调用点无需改动；新代码直接 import `textSanitize.js`。
 */
export { stripControlChars, sanitizeExternalText } from '@/agent/textSanitize.js';

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

/** plan_item_id 寻址解析结果（ok = 已解析为真实任务项 uuid；fail = 错误文案直接回 LLM） */
type PlanItemIdResolve = { ok: true; id: string } | { ok: false; error: string };

/** resolvePlanItemId 所需的 plan 投影（只读形状，不依赖完整 PlanItem） */
interface PlanItemIdPlanRef {
  id: string;
  order: number;
}

/**
 * 解析 task_table_update 的 plan_item_id 为真实任务项 uuid（唯一解析点）。
 *
 * LLM 可见的任务项标识有三种来源，缺一不可达即断链：
 *   1. task_table_write 返回的短 id（uuid 前 8 位，恒 8 hex；见 assembler writePlan 渲染）；
 *   2. 任务表 renderer 的行首序号（1-based，渲染形如「3. 描述 [状态]」）；
 *   3. 完整 uuid（planItemLog 等展示）。
 *
 * 解析顺序（防歧义）：
 *   - 完整 uuid 全等命中 → 直用；
 *   - 长度恰为 8 的标识 → 按 uuid 前 8 位前缀语义解析（uuid 前 8 位理论可全数字
 *     (10/16)^8≈2.3%，8 位数字绝不可能是任务表序号 → 恒按短 id 语义，杜绝错配）；
 *   - 其余纯数字 → 行首序号（1-based，按 order 匹配——与 renderer「order+1 展示」同键，
 *     不依赖「order==数组下标」弱不变量）；
 *   - 其余 → 未找到（提示可用格式）。
 *
 * 失败返回带定位提示的错误文案；成功后由调用方以完整 uuid 走 planManager.updatePlanItem
 * （sessionManager.updatePlanItemStatus 保持全等匹配写点，不被污染）。
 */
function resolvePlanItemId(planItemId: string, plan: PlanItemIdPlanRef[]): PlanItemIdResolve {
  // 1. 完整 uuid 全等（含连字符，长度 36）
  if (plan.some((s) => s.id === planItemId)) return { ok: true, id: planItemId };
  // 2. 短 id（uuid 前 8 位，恒 8 字符）
  if (planItemId.length === 8) {
    const matches = plan.filter((s) => s.id.startsWith(planItemId));
    if (matches.length === 1) return { ok: true, id: matches[0]!.id };
    if (matches.length > 1) {
      return {
        ok: false,
        error: `[ERR:INVALID_ARG] 任务项短 id "${planItemId}" 不唯一（对应 ${matches.length} 个任务项），请改用任务表行首序号定位`,
      };
    }
    return {
      ok: false,
      error: `[ERR:PLAN_ITEM_NOT_FOUND] 未找到任务项 "${planItemId}"：短 id 需为 task_table_write 返回的 8 位标识，或改用任务表行首序号`,
    };
  }
  // 3. 纯数字 → 行首序号（1-based，按 order 匹配）
  if (/^\d+$/.test(planItemId)) {
    const idx = Number(planItemId) - 1;
    const planItem = plan.find((s) => s.order === idx);
    if (planItem) return { ok: true, id: planItem.id };
    return {
      ok: false,
      error: `[ERR:INVALID_ARG] 任务项序号 ${planItemId} 超出任务表范围（当前共 ${plan.length} 个任务项，行首序号从 1 开始）`,
    };
  }
  // 4. 未知标识
  return {
    ok: false,
    error: `[ERR:PLAN_ITEM_NOT_FOUND] 未找到任务项 "${planItemId}"（可用任务表行首序号或 task_table_write 返回的短 id 定位）`,
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
 * task_table_write / task_table_update **直接暴露**：任务表是内核 agent 完成多步任务的
 * **必要基建**（与 compress_context / remember_intel 同属"内核自有上下文维护"判据），
 * 不应由角色包能力声明决定是否可用——否则无 task:plan 能力时，引导语提示用任务表而工具
 * 不可见 = 死胡同，LLM 只能放弃改用 write_file 硬拆。
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
  'compress_context', // ⚠️ loop 专有通道：不在本文件 execute() switch，由 loop 分派（AgentLoop.executeToolCalls 内 compressContext 三元分支，与 remember_intel 同分支）
  'remember_intel', // 情报区写回（LLM 私有笔记累积，随每轮装配注入）——上下文维护基建；⚠️ loop 专有通道：不在本 execute() switch，由 loop 分派（loop.ts handleRememberIntel）
  // 任务表管理（直接暴露：内核多步任务必要基建，非角色包可选能力）
  'task_table_write',
  'task_table_update',
  'ask_user', // ⚠️ loop 专有通道：不在本 execute() switch，由 loop.handleAskUser 检出挂起（loop.ts willSuspendForAsk → handleAskUser）
  'register_work',
  // 技能域（判据 A+B：来源可信；既定豁免）
  'read_skill',
  'read_resource',
  'run_skill_script',
  'list_resources',
  'list_skills',
  // 项目内既有脚本执行（判据 A+B：仓库已沉淀）；search_project 走宿主注入例外，不在此集
  'run_project_script',
  // 命令执行（§11.5 拍板：常驻开放 + deny/ask/allow 三层护栏）——
  // 不做角色包能力门：命令执行是通用脚手架（构建/测试/git 查询），按需声明会让
  // 「宿主已注入确认闸、内核已恒拦黑名单」的双层防护退化为「角色包没声明就不能用」。
  // 危险度由裁决链（deny 黑名单恒拦 / alwaysAsk 恒确认 / guest 恒确认）承担，不由暴露面承担。
  'run_command',
  'kill_command',
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
   * 工具白名单（capabilities → 工具映射产物，即特权声明模型）
   *
   * - `null`（默认）：全部暴露——未声明 capabilities 的角色包/无角色包时保持现状；
   * - `string[]`：在 DEFAULT_EXPOSED_TOOLS（默认常驻豁免集）之上，追加白名单内的特权工具；
   * - `[]`：仅暴露常驻豁免集（配合 toolMode=block 即全禁）。
   *
   * 语义（tool-exposure-model 探索草稿：默认常驻 vs 角色启动）：
   * 角色包声明 capabilities = 声明超越默认边界的**特权**（web:search / web:fetch / code:execute
   * 等——须在 capabilityMap 映射表内有实际工具映射），而非逐项打开本地能力。
   * ⚠️ `task:plan` **不是**特权：任务表已默认常驻（见上方 DEFAULT_EXPOSED_TOOLS 注释），映射表
   * 不为它保留条目，声明与否行为全同（假特权）。本地只读/项目内/内核基建工具默认常驻，不受白名单过滤——
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

  /** node 可执行文件路径（可选）：run_project_script 的 node runtime 分支注入真实 node 路径 */
  private readonly scriptNodePath?: string;

  /**
   * 后台任务注册表（可选，run_command background=true / kill_command 的唯一数据源）
   *
   * 由 agent 装配时注入（实例非单例，多会话互不可见——见 backgroundTasks 模块头注释）。
   * 未注入时两个工具返回 NOT_AVAILABLE：工具面仍暴露（能力缺失要如实说，不静默假装能跑），
   * 而非把工具从暴露面摘掉（那会让 LLM 以为自己看错了工具清单）。
   */
  private backgroundTasks?: BackgroundTaskRegistry;

  /**
   * 剩余对话预算提供者（可选，预算联动）
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

  /**
   * 注入后台任务注册表（装配层接线，run_command background / kill_command 数据源）
   *
   * 与 toolExec 构造解耦（注册表在 toolExec 之后创建，见 assembler），故用 setter。
   * 注入的是**实例**——多会话各自一张任务表，kill_command 够不着别的会话的进程。
   */
  setBackgroundTasks(registry: BackgroundTaskRegistry): void {
    this.backgroundTasks = registry;
  }

  /** 任务表管理回调（由 agent 装配时注入，处理 task_table_write/update） */
  planManager?: {
    writePlan: (
      mode: 'overwrite' | 'append' | 'replace',
      items: Array<{ description: string; rolePack?: string }>,
    ) => string;
    updatePlanItem: (planItemId: string, status: 'done' | 'blocked') => string;
    getPlan: () => Array<{
      id: string;
      description: string;
      status: string;
      order: number;
      rolePack?: string;
    }>;
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
   *
   * B2-a 契约加宽：返回**结构化执行事实**而非已格式化字符串——格式化与 outcome
   * 派生都在 ToolExecutor 单点完成（与 run_project_script 同源），
   * 消除「exitCode/timedOut 在装配边界被压成文本」的事实丢失。
   */
  runSkillScript?: (
    skillName: string,
    scriptPath: string,
    args: string[],
  ) => Promise<ScriptExecutionResult | null>;

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
   * 作品投影：用户主动触发登记一件作品（文档/代码/笔记）
   * 为项目级 JSON 索引，写 <memoraDir>/work-projections.json（纯元数据指针）。
   * 委托装配层注入的回调，避免 ToolExecutor 与 WorkProjectionManager 强耦合
   * （与 read_skill 同款注入模式）。未注入时 register_work 返回不可用提示。
   */
  registerWork?: (sourcePath: string, description: string) => Promise<string>;

  /**
   * run_team_meeting 评估/评审型会议回调（由 agent 装配时注入，处理 run_team_meeting）
   *
   * 工具内嵌 LLM 调用的新形态：回调持有 rolePackManager（组解析 + persona 全文）与
   * 前台 provider（单次 chat），在装配层闭包中实现一次调用注入多角色 persona 的会议。
   * 委托装配层注入的回调，避免 ToolExecutor 与 rolePackManager/llm 强耦合（同 readSkill 模式）。
   * 未注入时 run_team_meeting 返回不可用提示。
   */
  runTeamMeeting?: (group: string, topic: string) => Promise<string>;

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
    /** node 可执行文件路径（可选）：run_project_script 的 node runtime 分支注入真实 node 路径 */
    scriptNodePath?: string,
  ) {
    this.webSearchProvider = webSearchProvider;
    this.fetchProvider = fetchProvider;
    this.codeExecutionProvider = codeExecutionProvider;
    this.projectSearchProvider = projectSearchProvider;
    // 脚本执行 node 路径：存实例属性，run_project_script 分支透传给内核执行器
    this.scriptNodePath = scriptNodePath;
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
   * 注入 MemoryInspector，启用 search_memories 的纯关键词检索后端（无向量后端）。
   * assembler 中它依赖 loop/history、后于 toolExec 构造，故用「构造后注入」——装配期经
   * toolExec.setMemoryInspector(...) 接线，未注入时 search_memories 保持基础内存查询行为。
   *
   * @param inspector 记忆搜索器（纯关键词，含 superseded 过滤 + 溯源揭示）
   */
  setMemoryInspector(inspector: MemoryInspector): void {
    this.builtinHandlers.setMemoryInspector(inspector);
  }

  /**
   * 注入 memoryRecalled 事件发射回调（宿主感知「LLM 查询记忆命中 N 条」，§2.4 保留改语义定案）。
   * 转发给 builtinHandlers：search_memories 命中记忆时触发，为全库**唯一** memoryRecalled
   * 发射位（无 warmRecall 等其他发射路径）。
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
   * 设置工具白名单（换角色 → 工具集切换）
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
   * 白名单语义（tool-exposure-model 特权声明模型）：
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
    // run_code 定义按宿主执行器声明生成（§10.4-①(b)）：声明 supportedLanguages →
    // 描述列举「支持：a、b、c」；未声明 → buildRunCodeTool 缺省形态（去承诺文案，不列举）
    if (this.codeExecutionProvider)
      baseTools = [...baseTools, buildRunCodeTool(this.codeExecutionProvider.supportedLanguages)];

    // 常驻豁免集无条件暴露（LLM 工具面不因角色包能力声明收窄本地能力）
    const exposed = baseTools.filter((t) => DEFAULT_EXPOSED_TOOLS.has(t.name));

    // 特权工具按白名单过滤（toolWhitelist=null 全暴露；否则只在名单内）
    const privileged = baseTools.filter((t) => !DEFAULT_EXPOSED_TOOLS.has(t.name));
    const whitelisted = this.toolWhitelist
      ? privileged.filter((t) => this.toolWhitelist?.includes(t.name))
      : privileged;

    // search_project 作为宿主注入工具（方案乙）：注入即暴露，追加在自定义工具之后，不受白名单过滤
    const projectSearchTool = this.projectSearchProvider ? [SEARCH_PROJECT_TOOL] : [];

    return [
      ...exposed,
      ...whitelisted,
      ...[...this.customTools.values()].map((e) => e.definition),
      ...projectSearchTool,
    ];
  }

  /**
   * 完整内置工具定义（只读闸查询用，单一真理源）
   *
   * 含全部始终内置工具 + 条件工具（web_search / web_fetch / run_code，仅定义层面，
   * 不论 provider 是否注入）。不过白名单过滤、不含自定义工具——只读闸（ToolRunner）需要
   * 「全部内置定义」以查 readonly 标记，而非「当前暴露面」（被白名单过滤的工具 LLM 调不到，
   * 但 readonly 语义应覆盖全部内置写操作）。定义合集真源 = `builtinTools.ALL_BUILTIN_TOOL_DEFS`
   * （写盘派生索引同源消费），此处只转手、不另存清单。
   */
  get builtinDefinitions(): ToolDefinition[] {
    return [...ALL_BUILTIN_TOOL_DEFS];
  }

  /**
   * 按登记表把执行面路由到对应确认入口（CMD-1-BYPASS 2026-10-03）
   *
   * 入口由 `security/confirmEntries.ts` 的 `CONFIRM_ENTRY_BY_TOOL` 唯一指定，
   * 不在各 case 分支里隐式选方法 ⇒ 新增执行面漏登记会在守卫测试处即红。
   *
   * @param entry 确认入口（来自登记表，类型已排除 `none`——非确认面不可能被路由进来）
   * @param target 确认对象（命令原文 / 脚本路径 / 内联代码标识）
   * @param tool 工具名
   * @param description 面向用户的描述
   * @returns 是否获确认放行
   */
  private async confirmByEntry(
    entry: ConfirmingEntry,
    target: string,
    tool: string,
    description?: string,
  ): Promise<boolean> {
    if (entry === 'command') {
      return this.security.confirmCommandRun(target, tool, description);
    }
    return this.security.confirmScriptRun(target, tool, description);
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
   * @param emitOutcome 原生结构化结果回调（可选 · SCRIPT-2 outcome 通道）：
   *   已切族工具在**返回字符串的同点**按执行事实产出 `ToolOutcome`（status 不读文本前缀）；
   *   未切族不调用 ⇒ ToolRunner 回落文本判据。每调用独立回调，无并发相关性问题。
   * @returns 工具结果的字符串描述（渲染面，逐字保持）
   */
  async execute(
    name: string,
    argsJson: string,
    extensions?: WriteExtensions,
    emitOutcome?: (outcome: ToolOutcome) => void,
  ): Promise<string> {
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

    // 内置工具二分落点契约：构造态可独立可用（缺注入降级）→ BuiltinToolHandlers；
    // 可用性本身依赖装配注入（缺注入即 NOT_AVAILABLE）→ 留在本 switch 内联。
    // 新增内置工具先按此判别归属，勿凭参照漂移。
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
          strArg('old_string') || undefined,
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
          // 未注入提供方 = 工具能力缺失（执行失败事实，非主动拦截）→ 显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] 错误：网络搜索功能未配置，请先注入 IWebSearchProvider';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
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
        // 搜索来源透出：同批次结果来自同一后端，取首条 endpoint 告知用户实际使用的搜索源
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
          // 未注入提供方 = 工具能力缺失（执行失败事实，非主动拦截）→ 显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] 错误：网页抓取功能未配置，请先注入 IFetchProvider';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
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
          // limit 默认值与钳制上限同源（builtinTools WEB_FETCH_TOOL schema 文案，SSOT 收敛）
          Number.parseInt(strArg('limit', String(WEB_FETCH_CONTENT_DEFAULT_LEN)), 10) ||
            WEB_FETCH_CONTENT_DEFAULT_LEN,
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
          // 未注入执行器 = 工具能力缺失（旧口径 [ERR 开头亦判失败），显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] 错误：代码执行功能未配置，请先注入 ICodeExecutionProvider';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
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
          // 扩展名推断 runtime（SSOT：scanner.inferRuntimeFromExt）；未知扩展名兜底 node
          const ext = scriptPath.slice(scriptPath.lastIndexOf('.')).toLowerCase();
          execLanguage = language || inferRuntimeFromExt(ext) || 'node';
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
            ['使用简短的语言名（具体可用集合由宿主执行器决定，如 "js"、"node"）'],
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
        const execConfirmed = await this.confirmByEntry(
          requireConfirmingEntry('run_code'),
          scriptPath ? `run_code:script:${scriptPath}` : 'run_code:inline',
          'run_code',
          scriptPath
            ? `运行脚本 ${scriptPath}（宿主沙箱）`
            : `执行内联代码（${execLanguage}，${execCode.length} 字符，宿主沙箱）`,
        );
        if (!execConfirmed) {
          // 用户/系统拒绝执行 = 主动挡下（permission_denied），非执行失败
          const declineText =
            '[ERR:SCRIPT_DECLINE] 代码执行未获确认（用户拒绝或未注入确认回调，fail-closed）';
          emitOutcome?.(blockedOutcome('permission_denied', declineText));
          return declineText;
        }
        const result = await safeExecuteCode(
          this.codeExecutionProvider,
          execCode,
          execLanguage,
          execOptions,
        );
        // 结果净化：stdout/stderr 当外部内容去控制字符 + 长度上限，防长上下文注入
        const stdout = sanitizeExternalText(
          result.stdout,
          RUN_CODE_RESULT_MAX_LEN,
          SCRIPT_RESULT_TAIL_CHARS,
        );
        const stderr = sanitizeExternalText(
          result.stderr,
          RUN_CODE_RESULT_MAX_LEN,
          SCRIPT_RESULT_TAIL_CHARS,
        );
        // 格式化：与 run_skill_script 共用 formatExecutionResult（同一真理源，改格式契约须两链路同步）
        const codeText = formatExecutionResult(
          { stdout, stderr, exitCode: result.exitCode, timedOut: result.timedOut },
          { kind: 'CODE', timeoutDetail: '代码执行超时', errorDetail: '代码执行失败' },
        );
        // status 直接读执行事实（B2-a：不扫文本前缀）：超时或退出码非 0 = failed，其余 = ok
        const codeFailed = result.timedOut || result.exitCode !== 0;
        emitOutcome?.(codeFailed ? failedOutcome(codeText) : okOutcome(codeText));
        return codeText;
      }
      case 'search_project': {
        // search_project 由 ToolExecutor 直接处理（与 web_search/run_code 同侧，均为宿主注入能力）
        // 使用注入的 projectSearchProvider 执行项目内搜索，带超时保护；失败由 safe* 降级
        if (!this.projectSearchProvider) {
          // 未注入提供方 = 工具能力缺失（执行失败事实，非主动拦截）→ 显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] 错误：项目搜索功能未配置，请先注入 IProjectSearchProvider';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const query = strArg('query');
        const mode = strArg('mode', 'name');
        const exclude = strArg('exclude') || undefined;
        // 预算下探：LLM 传入的 maxResults 仍按其意愿生效，但不得超过预算档位 cap（防结果撑爆上下文）
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
          // 非法参数 = 执行失败事实（方案明文 INVALID_ARG=failed）→ 显式 emit failed
          const invalidModeText = `[ERR:INVALID_ARG] 不支持的搜索模式 "${mode}"，仅支持 name/content`;
          emitOutcome?.(failedOutcome(invalidModeText));
          return invalidModeText;
        }
        if (mode === 'content') {
          if (!query) {
            // 非法参数 = 执行失败事实（方案明文 INVALID_ARG=failed）→ 显式 emit failed
            const missingQueryText = '[ERR:INVALID_ARG] content 模式需要 query 内容关键词';
            emitOutcome?.(failedOutcome(missingQueryText));
            return missingQueryText;
          }
          // 放宽词表（精确优先 + 零命中回退）：剔除与整串等价的词——否则宿主会做一轮与
          // 精确轮逐字相同的徒劳扫描，并回报一个名不副实的 relaxed
          const terms = buildSearchTerms(query).filter(
            (t) => t.toLowerCase() !== query.trim().toLowerCase(),
          );
          const search = await safeSearchProjectText(this.projectSearchProvider, {
            pattern: query,
            ...(terms.length > 0 ? { terms } : {}),
            exclude,
            maxResults,
          });
          return formatProjectTextSearch(search, query);
        }
        // name 模式：query 为文件名 glob（省略时列出项目全部文件）。
        // 与 content 对齐两轮语义——原样 glob 精确匹配；仅当 query 不含 glob 元字符
        // 时，才有"零命中→按名称子串放宽"的余地（裸词=关键词才需要模糊。含 glob 则精准匹配）。
        const nameQuery = query || '**/*';
        const hasGlobMeta = /[*?{}[\]]/.test(nameQuery);
        // 放宽词表：复用 content 同一生产函数 buildSearchTerms（SSOT，无第二份放宽节奏）；
        // 剔除与整串等价的词——否则宿主会做一轮与精确轮逐字相同的徒劳扫描并回报名不副实的 relaxed。
        const nameTerms = !hasGlobMeta
          ? buildSearchTerms(nameQuery).filter((t) => t.toLowerCase() !== nameQuery.toLowerCase())
          : undefined;
        const fileSearch = await safeSearchProjectFiles(this.projectSearchProvider, {
          query: nameQuery,
          ...(nameTerms && nameTerms.length > 0 ? { terms: nameTerms } : {}),
          exclude,
          maxResults,
        });
        return formatProjectFileSearch(fileSearch, nameQuery);
      }
      case 'task_table_write': {
        // 写入任务表（overwrite / append / replace）；items 每项可选 rolePack（会议表层装配角色）
        if (!this.planManager) {
          // 任务表能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText = '[ERR:TOOL:NOT_AVAILABLE] 任务表功能未就绪';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        // mode 为 required（validateAndCoerceArgs 强制校验），不设缺省——设缺省即与 required 契约矛盾
        const writeMode = strArg('mode');
        if (writeMode !== 'overwrite' && writeMode !== 'append' && writeMode !== 'replace') {
          // 非法参数 = 执行失败事实（方案明文 INVALID_ARG=failed）→ 显式 emit failed
          const invalidModeText = `[ERR:INVALID_ARG] 不支持的写入模式 "${writeMode}"，仅支持 overwrite/append/replace`;
          emitOutcome?.(failedOutcome(invalidModeText));
          return invalidModeText;
        }
        const itemsRaw = args.items;
        const items = Array.isArray(itemsRaw)
          ? (itemsRaw as Array<{ description: string; rolePack?: string }>).map((s) => ({
              description: String(s?.description ?? ''),
              // rolePack 可选：仅接受非空字符串；范围校验在 prepare 期（越界忽略 + warning）
              ...(s?.rolePack && typeof s.rolePack === 'string' ? { rolePack: s.rolePack } : {}),
            }))
          : [];
        if (items.length === 0 || items.some((s) => s.description.trim() === '')) {
          // 非法参数 = 执行失败事实（方案明文 INVALID_ARG=failed）→ 显式 emit failed
          const invalidItemsText =
            '[ERR:INVALID_ARG] items 参数不能为空，且每项须含非空 description';
          emitOutcome?.(failedOutcome(invalidItemsText));
          return invalidItemsText;
        }
        return this.planManager.writePlan(writeMode, items);
      }
      case 'task_table_update': {
        // 更新任务状态
        if (!this.planManager) {
          // 任务表能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText = '[ERR:TOOL:NOT_AVAILABLE] 任务表功能未就绪';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const planItemId = strArg('plan_item_id');
        if (!planItemId) {
          // 非法参数 = 执行失败事实（方案明文 INVALID_ARG=failed）→ 显式 emit failed
          const missingIdText = '[ERR:INVALID_ARG] plan_item_id 不能为空';
          emitOutcome?.(failedOutcome(missingIdText));
          return missingIdText;
        }
        // 寻址统一解析（见 resolvePlanItemId）：renderer 只向 LLM 展示行首序号（1-based），
        // task_table_write 返回 uuid 前 8 位短 id，planItemLog 展示完整 uuid——三种来源全部归一为真实 uuid 后
        // 再走 updatePlanItem（全等写点），短 id 不会断链。
        const plan = this.planManager.getPlan?.() ?? [];
        const resolved = resolvePlanItemId(planItemId, plan);
        if (!resolved.ok) {
          // 寻址失败（PLAN_ITEM_NOT_FOUND）= 执行失败事实 → 显式 emit failed
          emitOutcome?.(failedOutcome(resolved.error));
          return resolved.error;
        }
        // status 为 required（validateAndCoerceArgs 强制校验），不设缺省
        const planItemStatus = strArg('status');
        if (planItemStatus !== 'done' && planItemStatus !== 'blocked') {
          // 非法参数 = 执行失败事实（方案明文 INVALID_ARG=failed）→ 显式 emit failed
          const invalidStatusText = `[ERR:INVALID_ARG] 不支持的状态 "${planItemStatus}"，仅支持 done/blocked`;
          emitOutcome?.(failedOutcome(invalidStatusText));
          return invalidStatusText;
        }
        return this.planManager.updatePlanItem(resolved.id, planItemStatus);
      }
      case 'read_skill': {
        // 渐进披露 L2：读取激活角色包内嵌技能正文（readSkill 回调由 agent 装配注入）
        // name 为必填参数，已由 validateAndCoerceArgs 校验，此处直接用
        if (!this.readSkill) {
          // 能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] read_skill 不可用：未装配角色包技能读取回调';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const content = await this.readSkill(strArg('name'));
        if (content === null) {
          // 技能未找到 = 执行失败事实 → 显式 emit failed
          const notFoundText = `[ERR:SKILL_NOT_FOUND] 未找到技能 "${strArg('name')}"（角色包 skills/ 与全局技能池均无此名，或技能正文读取失败）`;
          emitOutcome?.(failedOutcome(notFoundText));
          return notFoundText;
        }
        // 返回净化：技能正文当外部内容去控制字符 + 长度上限（防超长技能正文撑爆上下文）
        return sanitizeExternalText(content, SKILL_CONTENT_MAX_LEN);
      }
      case 'read_resource': {
        // 渐进披露 L3：读取技能的参考资源文件
        if (!this.readResource) {
          // 能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] read_resource 不可用：未装配 L3 资源读取回调';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const skillName = strArg('skill_name');
        const resourcePath = strArg('resource_path');
        const resourceContent = await this.readResource(skillName, resourcePath);
        if (resourceContent === null) {
          // 资源未找到 = 执行失败事实 → 显式 emit failed
          const notFoundText = `[ERR:RESOURCE_NOT_FOUND] 未找到资源 "${resourcePath}"（技能 "${skillName}" 无此资源，或资源读取失败）`;
          emitOutcome?.(failedOutcome(notFoundText));
          return notFoundText;
        }
        // 返回净化：资源正文当外部内容去控制字符 + 长度上限（防超长资源撑爆上下文）
        return sanitizeExternalText(resourceContent, RESOURCE_CONTENT_MAX_LEN);
      }
      case 'run_skill_script': {
        // 渐进披露 L3：执行技能的可执行脚本（脚本源码不进上下文，仅结果返回）
        if (!this.runSkillScript) {
          // 未装配回调 = 工具能力缺失（旧口径 [ERR 开头亦判失败），显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] run_skill_script 不可用：未装配 L3 脚本执行回调';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const skillName = strArg('skill_name');
        const scriptPath = strArg('script_path');
        const scriptArgs = Array.isArray(args['args']) ? (args['args'] as string[]) : [];
        // 脚本执行确认（与 run_code/run_project_script 同判据）：
        // owner + confirmScripts=false 默认放行（技能脚本来源可信，判据 B，无人值守可跑）；
        // guest 恒确认（受限权限下禁止"来源可信豁免"自主执行，缝合三脚本工具语义裂缝）；
        // confirmScripts=true 时 owner 亦确认（开关语义 = "脚本执行二次确认"，对全部脚本生效）。
        // 无 OS 级沙箱（子进程直跑 + env 继承用户环境），故不能以 Codex workspace-write 的
        // "边界内自动"前提豁免 guest。target 用技能名:脚本路径标识（无落盘绝对路径）。
        const execConfirmed = await this.confirmByEntry(
          requireConfirmingEntry('run_skill_script'),
          `skill:${skillName}:${scriptPath ?? ''}`,
          'run_skill_script',
          `执行技能 ${skillName} 的脚本 ${scriptPath ?? ''}`,
        );
        if (!execConfirmed) {
          // 用户/系统拒绝执行 = 主动挡下（permission_denied），非执行失败
          const declineText =
            '[ERR:SCRIPT_DECLINE] 技能脚本执行未获确认（用户拒绝或未注入确认回调，fail-closed）';
          emitOutcome?.(blockedOutcome('permission_denied', declineText));
          return declineText;
        }
        const result = await this.runSkillScript(skillName, scriptPath, scriptArgs);
        if (result === null) {
          // 脚本不存在/无法执行 = 执行事实失败（区别于权限拒绝）
          const notFoundText = `[ERR:SCRIPT_NOT_FOUND] 未找到脚本 "${scriptPath}"（技能 "${skillName}" 无此脚本，或执行失败）`;
          emitOutcome?.(failedOutcome(notFoundText));
          return notFoundText;
        }
        // 格式化在本点单点收口（B2-a：回调只返结构化事实）；再经净化防刷屏撑爆上下文
        const formattedText = sanitizeExternalText(
          formatScriptResult(result),
          RUN_SCRIPT_RESULT_MAX_LEN,
          SCRIPT_RESULT_TAIL_CHARS,
        );
        // status 直接读执行事实：超时或退出码非 0 = failed，其余 = ok（不扫文本前缀）
        const scriptFailed = result.timedOut || result.exitCode !== 0;
        emitOutcome?.(scriptFailed ? failedOutcome(formattedText) : okOutcome(formattedText));
        return formattedText;
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
          // 安全白名单拦截 = 主动挡下（B2-a 拍板：归 permission_denied，不新增枚举值）
          const pathDeniedText = `[ERR:PATH_DENIED] 脚本路径越界（超出项目根）："${scriptPath}"`;
          emitOutcome?.(blockedOutcome('permission_denied', pathDeniedText));
          return pathDeniedText;
        }
        // ② 执行确认：guest 模式或 confirmScripts 时询问（owner 默认自动批准，走审计）
        const confirmed = await this.confirmByEntry(
          requireConfirmingEntry('run_project_script'),
          fullPath,
          'run_project_script',
          `运行项目脚本 ${scriptPath}`,
        );
        if (!confirmed) {
          // 用户/系统拒绝执行 = 主动挡下（permission_denied），非执行失败
          const declineText =
            '[ERR:SCRIPT_DECLINE] 脚本运行未获确认（用户拒绝或未注入确认回调，fail-closed）';
          emitOutcome?.(blockedOutcome('permission_denied', declineText));
          return declineText;
        }
        // ③ 运行时白名单：扩展名推断并收敛到 node/python/shell 三档（推断即可信，不规则兜底 node）
        const ext = scriptPath.slice(scriptPath.lastIndexOf('.')).toLowerCase();
        const runtime = normalizeScriptRuntime(inferRuntimeFromExt(ext) ?? 'node');
        // timeout_ms（秒，可选）→ 毫秒透传内核执行器（默认 60s，上限 600s，见 skillScriptRunner 常量）；
        // 脚本内 API 调用/批处理等长耗时任务由 LLM 按需传参，避免误超时
        const timeoutMs = Number.isFinite(args['timeout_ms'])
          ? Number(args['timeout_ms']) * 1000
          : undefined;
        const result = await runSkillScript(
          fullPath,
          runtime,
          scriptArgs,
          timeoutMs,
          // cwd=项目根：项目脚本可加载项目本地依赖/相对数据文件
          this.builtinHandlers.projectPath,
          // node 路径（可选）：node runtime 分支走宿主注入的真实 node，避免无独立 node 时 ENOENT
          this.scriptNodePath,
        );
        // 返回净化：脚本输出当外部内容去控制字符 + 长度上限（防刷屏撑爆上下文，对齐 run_skill_script）
        // 超时文案按本次实际超时生成（未传 timeout_ms → 内核默认 60s，见上），不恒报上限 600s
        const projectScriptText = sanitizeExternalText(
          formatScriptResult(result, timeoutMs),
          RUN_SCRIPT_RESULT_MAX_LEN,
          SCRIPT_RESULT_TAIL_CHARS,
        );
        // status 直接读执行事实（B2-a：不扫文本前缀）：超时或退出码非 0 = failed，其余 = ok
        const projectScriptFailed = result.timedOut || result.exitCode !== 0;
        emitOutcome?.(
          projectScriptFailed ? failedOutcome(projectScriptText) : okOutcome(projectScriptText),
        );
        return projectScriptText;
      }
      case 'run_command': {
        // 裸命令执行（§13.2 裁决链 → 执行）：三道闸顺序不可颠倒——
        //   ① 参数校验（空命令 / 越界 cwd）② 命令裁决（deny 恒拦 / alwaysAsk 恒确认）
        //   ③ 执行（同步等退出码 / 后台注册表立即返回 taskId）
        // 裁决链判据在 SecurityGuard.confirmCommandRun（与 confirmScriptRun 共用 confirmGate 单点）。
        const command = strArg('command');
        if (!command.trim()) {
          throw toolError(
            'run_command 缺少 command 参数',
            '命令为空',
            ['传要执行的 shell 命令，如 "npm test"'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        if (command.length > RUN_COMMAND_MAX_LEN) {
          // 截半条命令 = 语义破坏（执行的不是用户/模型写的那条），故整条拒收
          throw toolError(
            'run_command 命令过长',
            `命令长度 ${command.length} 字符，超过上限 ${RUN_COMMAND_MAX_LEN}`,
            ['把命令拆成多条执行，或改用脚本文件 + run_project_script'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        // cwd 缺省 = 项目根；显式传入时按项目根解析，越界拒绝（与 run_project_script 同判据）
        let cwd = this.builtinHandlers.projectPath;
        const rawCwd = strArg('cwd');
        if (rawCwd) {
          const resolved = resolveSafePath(this.builtinHandlers.projectPath, rawCwd);
          if (!resolved) {
            const pathDeniedText = `[ERR:PATH_DENIED] 工作目录越界（超出项目根）："${rawCwd}"`;
            // 原生 outcome：越界拒绝 = 主动挡下 ⇒ blocked（对齐 run_project_script 同判据先例；
            // B4 口径：blocked 不再计入 toolFailureCount，见方案 §六决策二）
            emitOutcome?.(blockedOutcome('permission_denied', pathDeniedText));
            return pathDeniedText;
          }
          cwd = resolved;
        }
        // ② 命令裁决：deny 恒拦（不入确认流程）/ alwaysAsk 恒确认 / 其余同脚本判据
        const confirmed = await this.confirmByEntry(
          requireConfirmingEntry('run_command'),
          command,
          'run_command',
          `在工作区执行命令：${command}`,
        );
        if (!confirmed) {
          const declineText =
            '[ERR:COMMAND_DECLINE] 命令未获执行许可（命中恒拦黑名单 / 用户拒绝 / 未注入确认回调 fail-closed）。' +
            '未执行任何命令；如确需执行，请改用等效手段或请用户调整审批设置。';
          // 原生 outcome：语义是「主动挡下」⇒ blocked（permission_denied）。
          // 双轨期编排层仍按 [ERR:COMMAND_DECLINE] 文本算 failed（已知口径分歧，
          // B4 裁决，见方案 §六决策二）⇒ 文本逐字不变，仅新增结构化面。
          emitOutcome?.(blockedOutcome('permission_denied', declineText));
          return declineText;
        }
        // ③ 执行：background=true 立即返回 taskId（不等进程结束）
        // `=== 1` 兜底：validateAndCoerceArgs 已把字符串 'true'/'1' 归一为布尔，
        // 裸数字 1 仍会漏过——若不认，模型要的后台会退化成同步阻塞（正是本能力要消除的形态）
        if (args['background'] === true || args['background'] === 1) {
          if (!this.backgroundTasks) {
            // 能力缺失如实说（B1 缺口补齐：补 emit，对齐 run_code/run_skill_script NOT_AVAILABLE 先例）
            const notAvailableText =
              '[ERR:TOOL:NOT_AVAILABLE] run_command 后台模式不可用：未装配后台任务注册表';
            emitOutcome?.(failedOutcome(notAvailableText));
            return notAvailableText;
          }
          const rawTimeout = args['timeoutMs'];
          const taskId = this.backgroundTasks.start(
            command,
            cwd,
            typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) ? rawTimeout : undefined,
          );
          return (
            `[BACKGROUND_STARTED] taskId=${taskId}（命令已在本轮之外继续运行，本轮对话结束不会终止它）。` +
            '**结果不会自动进入上下文**：它不会自己跳进来，你需要时用 kill_command 传入该 taskId，' +
            '取回截至当时的输出并终止它；若不取，它会一直跑到自己结束（未传 timeoutMs 时没有超时上限）。' +
            '寿命边界：正常退出 VS Code 时随扩展一并终止（扩展崩溃或被强制结束时不保证清理）。' +
            '命令：' +
            command
          );
        }
        // 同步路径：超时钳制与文案同源（resolveCommandTimeoutMs 单一真源，见 §13.6-C）
        const effectiveTimeoutMs = resolveCommandTimeoutMs(
          typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined,
        );
        const result = await runShellCommand(command, cwd, effectiveTimeoutMs);
        // 定长与净化由 formatCommandResult 自带（真源在格式化层，回流面共用同一上限）
        const text = formatCommandResult(result, effectiveTimeoutMs);
        // 原生 status 直接读**执行事实**（不扫文本前缀）：超时或退出码非 0 = failed，其余 = ok。
        // status 与 text 同源产出，编排层/计数层只读 status（B4 判据切换，无文本交叉核对）。
        const commandFailed = result.timedOut || result.exitCode !== 0;
        emitOutcome?.(commandFailed ? failedOutcome(text) : okOutcome(text));
        return text;
      }
      case 'kill_command': {
        // 后台任务终止（§14.1 免裁决链：只可杀本 agent 起的自家任务，taskId 寻址非任意 pid）
        if (!this.backgroundTasks) {
          return '[ERR:TOOL:NOT_AVAILABLE] kill_command 不可用：未装配后台任务注册表';
        }
        const taskId = strArg('taskId');
        if (!taskId) {
          throw toolError(
            'kill_command 缺少 taskId 参数',
            '未传 taskId',
            ['传 run_command 后台执行返回的 taskId（如 "bg-1"）'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        const outcome = this.backgroundTasks.kill(taskId);
        // 不静默成功：不存在与已终态是两种语义，必须让 LLM 知道（§13.6 未决二定案）
        if (!outcome) {
          return (
            `[ERR:TASK_NOT_FOUND] 未找到后台任务 "${taskId}"。` +
            '任务跨轮保留、可在后续轮次 kill；该 id 可能本就有误，或来自扩展重启前的会话' +
            '（注册表不跨重启保留）——本轮不会终止任何进程。'
          );
        }
        const task = this.backgroundTasks.get(taskId);
        if (!outcome.result) {
          return `[TASK_ALREADY_SETTLED] taskId=${taskId} 已是终态（status=${outcome.status}，无需终止；该任务无已捕获输出）`;
        }
        // 结果体的净化与定长由 formatCommandResult / formatKilledCommandOutput 自带
        // （定长真源在格式化层，两条消费面共用）——此处不再套一层，避免两个 policy。
        if (outcome.status === 'killed') {
          // 被主动终止 ≠ 执行失败：走专用格式化，不谎报退出码（见 formatKilledCommandOutput）
          return `[KILLED] taskId=${taskId}（已终止；以下为截至终止时的输出）\n命令：${task?.command ?? '(未知)'}\n${formatKilledCommandOutput(outcome.result)}`;
        }
        const settledNote = `[TASK_ALREADY_SETTLED] taskId=${taskId} 已是终态（status=${outcome.status}，无需终止）`;
        // 行首归属判据改读**结构化执行事实**（B4 判据切换，不再扫文本前缀）：
        // 「已是终态」是控制流事实、「退出码非零/超时」是执行结局事实，两者抢同一行首。
        // 原写法把 [TASK_ALREADY_SETTLED] 放行首 ⇒ 已终态的失败任务被判成功
        // （SCRIPT-1 同形状漏计，2026-10-06 实测）。
        // 修法：失败/超时终态把结果体提到行首（结局可判），「已终态」说明降为末尾附注。
        // ⚠️ 引导语必须**随结果体一起走**（不能钉在 settledNote 上）：它在原文案里是
        // **前置引导**（结果在下方）。若失败路径把同一句放在结果体**之后**，「以下」就变成
        // 指向上方 —— 对 LLM 是指代错乱的谎。两条路径各自带对位置的引导语。
        const commandLine = `命令：${task?.command ?? '(未知)'}`;
        const body = formatCommandResult(outcome.result);
        // 事实真源 = 注册表记录的进程终态（timedOut / exitCode），与同步路径判据同源
        const settledWithFailure = outcome.result.timedOut || outcome.result.exitCode !== 0;
        if (settledWithFailure) {
          // 附注在结果**之后** ⇒ 用回指语（「其结果为」），不用「以下」。
          return `${body}\n${commandLine}\n${settledNote}；其结果为上述内容`;
        }
        // 成功路径：附注在前、结果在后 ⇒ 沿用原文案的前置引导语，逐字不变。
        return `${settledNote}；以下为其结果\n${commandLine}\n${body}`;
      }
      case 'list_resources': {
        // 渐进披露 L3：列出技能的资源清单
        if (!this.listResources) {
          // 能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText = '[ERR:TOOL:NOT_AVAILABLE] list_resources 不可用';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const skillName = strArg('skill_name');
        return await this.listResources(skillName);
      }
      case 'list_skills': {
        // 渐进披露 L1 补充：列出所有技能清单（>50 技能时使用）
        if (!this.listSkills) {
          // 能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText = '[ERR:TOOL:NOT_AVAILABLE] list_skills 不可用';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        return await this.listSkills();
      }
      case 'register_work': {
        // 作品投影登记（registerWork 回调由 agent 装配注入；用户主动触发写索引卡片）
        if (!this.registerWork) {
          // 能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] register_work 不可用：未装配作品投影登记回调';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const path = strArg('path');
        const description = strArg('description');
        if (!path || !description) {
          // 非法参数 = 执行失败事实（方案明文 INVALID_ARG=failed）→ 显式 emit failed
          const invalidArgText =
            '[ERR:INVALID_ARG] register_work 需要 path（相对项目根）与 description（一句话说明）参数';
          emitOutcome?.(failedOutcome(invalidArgText));
          return invalidArgText;
        }
        return await this.registerWork(path, description);
      }
      case 'run_team_meeting': {
        // 评估/评审型小组会议（runTeamMeeting 回调由 agent 装配注入；工具内嵌一次 LLM 调用）
        if (!this.runTeamMeeting) {
          // 能力未装配 = 执行失败事实（非主动拦截）→ 显式 emit failed
          const notAvailableText =
            '[ERR:TOOL:NOT_AVAILABLE] run_team_meeting 不可用：未装配小组会议回调';
          emitOutcome?.(failedOutcome(notAvailableText));
          return notAvailableText;
        }
        const group = strArg('group');
        const topic = strArg('topic');
        // 参数缺失由回调内 runTeamMeetingAssessment 统一抛 ARGUMENT_ERROR，此处前置兜底给不可信入参
        if (!group) {
          throw toolError(
            'run_team_meeting 缺少 group 参数',
            '未传组名（组名 = 组长角色包名）',
            ['传组名，如 run_team_meeting("设计组", "议题")'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        if (!topic) {
          throw toolError(
            'run_team_meeting 缺少 topic 参数',
            '未传要评估的议题',
            ['传一句议题，越具体越好'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        return await this.runTeamMeeting(group, topic);
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
