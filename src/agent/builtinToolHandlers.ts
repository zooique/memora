/**
 * 内置工具处理器（从 ToolExecutor 提取的内置工具实现层）
 *
 * 职责：
 *   1. 路径安全解析（resolveSafePath + guardPathOrThrow）—— 内置 + 自定义工具共享
 *   2. 内置工具实现（read_file / write_file / list_dir / search_memories）
 *   3. 文件写入内容计算（computeWriteContent）
 *   4. 目录递归遍历（walkDir + shouldIgnore）
 *
 * 设计理由：ToolExecutor 作为编排层（注册/分发/校验）体量偏大，内置工具实现（~440 行）
 * 是独立职责——实际文件系统/记忆索引操作，与 ToolExecutor 的注册/分发/校验职责分离。
 *
 * 自然生长原则：BuiltinToolHandlers 不持有 customTools 注册表（避免与 ToolExecutor 状态耦合），
 * 所有方法接收参数，是无状态的纯计算 + I/O 操作。
 */
import { readFile, writeFile, mkdir, readdir, stat, access, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, isAbsolute, join, relative, dirname, basename } from 'node:path';
import type { SecurityGuard } from '@/security/pathGuard.js';
import { toolError, MemoraError, ToolErrorCode } from '@/utils/errors.js';
import { toError, isNodeErrorCode } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';
import { segmentLower } from '@/utils/segmenter.js';
import { truncate } from '@/utils/strings.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { SOURCE_LABELS, roundSummarySessionPrefix } from '@/memory/types.js';
import type { ISessionStore, SessionMeta } from '@/memory/sessionStore.js';
// 会话显示名回退单一真理源（displayName→autoName），sessionId 兜底留在调用端
import { getSessionDisplayName } from '@/memory/sessionStore.js';
import { splitSessionId } from '@/utils/time.js';
// read_file 分段脚注格式单一真理源（生成侧在此用作「截断诚实化」文案）
import { formatSegmentationFooter } from '@/agent/toolLedger.js';
// 使用 import type 避免运行时循环依赖：WriteExtensions 类型定义在 toolExecutor.ts
import type { WriteExtensions } from '@/agent/toolExecutor.js';
import { sanitizeExternalText, stripControlChars } from '@/agent/toolExecutor.js';
import { backgroundTask } from '@/utils/backgroundTask.js';
import { touchScores } from '@/memory/keywordsTouch.js';
import type { AgentSearchHit, MemoryInspector } from '@/agent/managers/memoryInspector.js';
import { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
// token 估算唯一真理源（CJK 感知）——read_file 的分段预算与上下文占用/截断同口径
import { estimateTokensText } from '@/agent/contextManager.js';
// 正整数解析唯一真理源（read_file 分段 offset/limit 与 toolResultCache 去重主体共用）
import { positiveInt, parseLimit } from '@/utils/math.js';
// run_team_meeting 工具内嵌 LLM 调用：Message 构型 + LlmProvider 抽象（chat 流式）
import type { LlmProvider, Message } from '@/llm/provider.js';

/** trace_summary 溯源原始对话的最大消息数（规模控制） */
const TRACE_MESSAGE_LIMIT = 5;
/** trace_summary 单条消息的最大字符数（防长上下文注入） */
const TRACE_MESSAGE_CHAR_LIMIT = 2000;
/** list_sessions 默认返回条数（会话路标，token 可控优先） */
const LIST_SESSIONS_DEFAULT = 10;
/** list_sessions 最大返回条数（防历史会话过多撑爆上下文） */
const LIST_SESSIONS_MAX = 30;
/** list_sessions 单条路标摘要的最大字符数（LLM 生成，过 sanitize 防注入） */
const LIST_SESSIONS_SUMMARY_CHARS = 200;

/** run_team_meeting 返回的评审文本最大字符数（多角色 persona 拼入 + 产出长文，防超长注入撑爆上下文） */
const MEETING_RESULT_MAX_LEN = 20_000;

/**
 * 目录树返回的最大字符数（防超大目录整段进上下文）
 *
 * read_file 走 **token 预算分段**（`LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS`），
 * 不使用字符上限；本常量专职 list_dir——名字须与它实际约束的东西一致。
 */
const DIR_LIST_MAX_LEN = 50_000;

/**
 * 按 token 预算反推字符数截断单行（仅用于「单行本身即超预算」的病态退化分支）
 *
 * 先按其他字符比例（`CHARS_PER_TOKEN`）取字符上限，再按实测比值迭代收敛——
 * 不用固定比例是因为中文密度近英文 2 倍（CJK 1.5 vs 其他 3），固定比例必有一侧失准。
 * 每次迭代都严格缩小 chars（tokens > budget ⇒ 新 chars < 旧 chars），故必收敛。
 */
function clampCharsToTokenBudget(line: string, budget: number): string {
  let chars = Math.max(1, Math.floor(budget * LOOP_CONSTANTS.CHARS_PER_TOKEN));
  let slice = line.slice(0, chars);
  let tokens = estimateTokensText(slice);
  while (tokens > budget && chars > 1) {
    chars = Math.max(1, Math.floor((chars * budget) / tokens));
    slice = line.slice(0, chars);
    tokens = estimateTokensText(slice);
  }
  return slice;
}

/**
 * 脚本文件读取最大长度（run_code script_path 模式）
 *
 * 脚本代码要原样交给执行器，截断会破坏语法——故超限**直接报错**（不静默截断）。
 * 与 read_file 不同：read_file 走 token 预算分段
 * （LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS），不使用字符上限，
 * 故本常量与 read_file 不在同一量纲，无「谁更宽松」的可比关系。
 *
 * 与 utils/fileSafe.DEFAULT_MAX_CONTENT_LEN 同为 200_000 属**异义同值**，勿误合并：
 *   - 本常量：脚本原样读取上限（超限报错，内容交执行器）；
 *   - DEFAULT_MAX_CONTENT_LEN：内容文件读取上限（超限截断，内容入上下文）。
 * 两者各自独立演进，改一侧不联动另一侧。
 */
const SCRIPT_READ_MAX_LEN = 200_000;

/**
 * 内置文件工具忽略的目录/文件名（模块级单一真理源）
 *
 * list_dir 忽略规则与宿主项目内容搜索（search_project content 模式）共享；
 * 宿主通过主入口 import 此常量对齐忽略目录，避免数值/规则漂移。
 */
export const IGNORED_DIR_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  '.memora',
  'dist',
  'coverage',
  '.next',
];

/**
 * 任务表保留文件名判定（write_file 守卫唯一消费）
 *
 * 任务表是内核工具数据（task_table_write/update 管理），不落盘为 markdown 文件——`task-table.md` /
 * `任务表.md` 等文件名保留给任务表机制，禁止 write_file 写入。命中规则 = 文件名（去扩展名）即
 * `task-table` / `task_table` / `任务表`，或以其带分隔符/后缀开头（如 `task-table-进度.md`）。
 *
 * @param absolutePath 目标文件绝对路径
 * @returns 是否命中保留名（任务表语义文件）
 */
export function isReservedTaskTableFile(absolutePath: string): boolean {
  const base = basename(absolutePath).replace(/\.(md|markdown|txt)$/i, '');
  return /^task[-_ ]?table(?:[-_ ].+)?$/i.test(base) || /^任务表(?:[-_ ].+)?$/.test(base);
}

/**
 * 内置工具处理器
 *
 * 管理 4 个内置工具的实际实现 + 路径安全校验。
 * 从 ToolExecutor 提取，保持无状态设计（不持有 customTools 注册表）。
 */
export class BuiltinToolHandlers {
  /** list_dir 默认忽略的目录/文件名（引用模块级单一真理源，保持类静态 API 兼容） */
  static readonly IGNORED_DIR_NAMES: readonly string[] = IGNORED_DIR_NAMES;

  /**
   * @param projectPath 项目根路径（用于相对路径解析；公开只读，供 run_code script_path 模式取 cwd）
   * @param security 安全守卫（路径白名单 + 写入确认）
   * @param memoryIndex 记忆索引（用于 search_memories 工具）
   * @param sessionStore 会话存储（可选，trace_summary 溯源原始对话用；未注入时回退为摘要文本）
   */
  constructor(
    readonly projectPath: string,
    private readonly security: SecurityGuard,
    private readonly memoryIndex: IMemoryStorage,
    private readonly sessionStore?: ISessionStore,
  ) {}

  /** 记忆搜索器（search_memories 语义后端，装配期注入；未注入时回退关键词 memoryIndex.search） */
  private memoryInspector: MemoryInspector | null = null;

  /** 当前会话「正文或摘要已在眼前」的轮次提供者（装配期注入；search_memories 用它与装配期内容互斥） */
  private exclusionRoundIdsProvider: (() => ReadonlySet<string>) | null = null;

  /** memoryRecalled 事件发射回调（宿主感知「LLM 查询记忆命中 N 条」；装配期注入，缺省不发射） */
  private onMemoryRecalled: ((info: { count: number; query: string }) => void) | null = null;

  /**
   * 注入 MemoryInspector，启用 search_memories 的纯关键词搜索后端（memory-tool-recall-design §3.3）。
   * 装配依赖 loop/history，toolExec 在 assembler 中先于它构造，故用「构造后注入」而非构造参数。
   * 注入后 search_memories 走 searchByKeyword（纯关键词 + superseded 过滤 + 溯源揭示），未注入保持旧关键词行为。
   */
  setMemoryInspector(inspector: MemoryInspector): void {
    this.memoryInspector = inspector;
  }

  /**
   * 注入 memoryRecalled 事件发射回调（宿主消费，§2.4「保留改语义」定案）。
   * 搜索工具命中记忆时触发，文案语义 =「LLM 查询记忆命中 N 条」。
   * **唯一触发位**：全库仅本类 emit memoryRecalled（无其他发射点）。
   * 缺省不注入则静默跳过（内置工具也可被测试/脚本直调，无宿主时 no-op）。
   */
  setOnMemoryRecalled(callback: (info: { count: number; query: string }) => void): void {
    this.onMemoryRecalled = callback;
  }

  /**
   * 注入召回互斥排除集提供者（memory-tool-recall-design §5.1 工具互斥）。
   * search_memories 用它排除「正文或摘要已在眼前」轮次的 round-summary，避免与装配期内容重复。
   * 提供者返回精确集合（`loop.getExclusionRoundIds()`：视图内 ∪ 被替换 ∪ 在途），
   * 语义为「该轮内容已在上下文，其摘要不应再被召回带回」——从视图派生，与模型窗口无关。
   * 缺省不注入则不过滤（保持测试/独立调用可直接触发）。
   */
  setExclusionRoundIdsProvider(provider: () => ReadonlySet<string>): void {
    this.exclusionRoundIdsProvider = provider;
  }

  // ─── 路径安全（内置 + 自定义工具共享） ──────────────────────────

  /**
   * 解析相对路径为绝对路径
   *
   * 绝对路径直接使用（安全校验由下游 guardPathOrThrow → SecurityGuard.assertPathAllowed 完成）；
   * 相对路径基于 projectPath 解析。防御纵深：resolveSafePath 只负责路径解析，
   * 白名单拦截由 assertPathAllowed 独立执行。
   */
  resolveSafePath(relativePath: string): string {
    return isAbsolute(relativePath) ? relativePath : resolve(this.projectPath, relativePath);
  }

  /**
   * 路径白名单校验（捕获后包装为 toolError）
   * @param source 调用链来源标记
   */
  guardPathOrThrow(
    absolutePath: string,
    tool: string,
    source: 'builtin' | 'custom' | 'system' = 'builtin',
  ): void {
    try {
      this.security.assertPathAllowed(absolutePath, tool, source);
    } catch (err) {
      const e = toError(err);
      throw toolError(
        '路径不在白名单内',
        e.message,
        [
          '确认路径在白名单内（项目目录/数据目录/显式 allowedPaths）',
          '查看审计日志：路径拒绝事件经内核 logger 输出，见宿主日志通道（IDE 输出面板 / 终端 stderr）',
        ],
        e,
        ToolErrorCode.PATH_NOT_ALLOWED,
      );
    }
  }

  /**
   * 读前预检：目标是目录时抛语义化工具错误（read_file 与 run_code script_path 共用）
   *
   * 两处曾各自实现同一段「stat + isDirectory 判定 + MemoraError 移交」；文案因工具而异，
   * 故工具名与提示参数化。stat 失败（ENOENT/权限）不在此处理——移交调用方统一异常路径。
   *
   * @param absolutePath 目标绝对路径（已过白名单校验）
   * @param displayPath 用于文案的相对路径（可读性）
   * @param toolLabel 工具显示名（如 'read_file' / 'run_code script_path'）
   * @param hint 目录误用时的行动指引
   */
  private async assertFileNotDir(
    absolutePath: string,
    displayPath: string,
    toolLabel: string,
    hint: string,
  ): Promise<void> {
    try {
      const stats = await stat(absolutePath);
      if (stats.isDirectory()) {
        throw toolError(
          `${toolLabel} 目标是目录`,
          `${displayPath}：这是目录，不是文件`,
          [hint],
          undefined,
          ToolErrorCode.ARGUMENT_ERROR,
        );
      }
    } catch (err) {
      // stat 失败（如 ENOENT/权限）移交下方异常路径统一报错；工具错误直接抛出
      if (err instanceof MemoraError) throw err;
    }
  }

  // ─── 内置工具实现 ──────────────────────────────────────

  /**
   * 读取文件（带路径白名单校验；支持按行分段）
   *
   * **分段语义（大文本统一通道）**
   * - `offset`：起始行号（1-based，默认 1）；`limit`：最多返回行数（省略 = 尽可能多）。
   * - **同源不变量**：返回内容的 token 数**恒 ≤ `LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS`**。
   *   这保证 read_file 的结果永不触发入口关落盘（阈值同键）→「路径即引用」不会自我嵌套
   *   （详见该常量注释）。故本方法**不**使用字符数上限，而是按 token 预算逐行填充。
   * - **截断诚实化**：一旦未能读到文件末尾，脚注给出「已显示第 X–Y 行（共 M 行）」与续读
   *   offset；静默追加 `…` 会让 LLM 既不知道后面还有内容、也没有续读手段（静默截断 = 假阴性）。
   */
  async readFile(relativePath: string, offset?: string, limit?: string): Promise<string> {
    if (!relativePath) {
      throw toolError(
        'read_file 工具调用缺少 path 参数',
        'LLM 未传 path',
        ['检查 personality.md 是否明确了 read_file 用法', '检查 LLM 输出'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    const absolutePath = this.resolveSafePath(relativePath);
    this.guardPathOrThrow(absolutePath, 'read_file');

    // 读前预检：目标是目录时给出可执行指引（read_file 语义是读文件；
    // EISDIR 原生错误对 LLM 无意义，直接提示改用 list_dir）
    await this.assertFileNotDir(absolutePath, relativePath, 'read_file', '改用 list_dir 列出该目录下的内容');

    try {
      const content = await readFile(absolutePath, 'utf-8');
      // 返回净化（去控制字符/ANSI，**不做字符数截断**——按行分段的 token 预算在下方收口）
      return this.sliceFileByLineBudget(stripControlChars(content), relativePath, offset, limit);
    } catch (err) {
      const e = toError(err);
      // 区分 ENOENT（文件不存在）和其他 IO 错误
      if (e instanceof MemoraError) throw e;
      if (isNodeErrorCode(err, 'ENOENT')) {
        // 前置兄弟目录提示：siblingDirHint 是"失败即给证据"（CTX-1b·P2）——但内核事件
        // 落盘 summary 只取前 100 字符（loop.ts tool_result）。若把它拼接在长路径**之后**，
        // 危害：路径串本身（盘根+文件名）往往已占满 100 字 → 兄弟目录清单被整个截掉，
        // LLM 重放/治理只见「文件不存在」却看不到同级真实文件名（HALL-1 实测 seq261/262
        // 的 summary 停在 `[同` 即此）。故**前置**清单：保证 summary 前 100 字先到达证据，
        // 而非路径。路径本身对"自查文件名"零贡献，放后面不损失。
        const hint = await this.siblingDirHint(absolutePath);
        const evidenceFirst = hint ? `${hint}\n${absolutePath}：文件不存在` : `${absolutePath}：文件不存在`;
        throw toolError(
          'read_file 文件不存在',
          evidenceFirst,
          ['确认路径正确', '使用 list_dir 查看目录结构'],
          e,
          ToolErrorCode.FILE_NOT_FOUND,
        );
      }
      throw toolError(
        'read_file 读取失败',
        `${absolutePath}：${e.message}`,
        ['确认文件权限', '确认路径正确'],
        e,
        ToolErrorCode.UNKNOWN,
      );
    }
  }

  /**
   * P2 失败即给证据：read_file 目标不存在（ENOENT）时，返回其**同级目录实际条目**的紧凑清单，
   * 让模型自查真实文件名（优于单纯拒绝；配合 P0-2 失败硬闸在首次失败就给路，比硬拦更止妖）。
   * 父目录不可读 / 无可见条目 → 返回空串（不掩盖原始错误）。条目经 shouldIgnore 过滤，join 拼接。
   */
  private async siblingDirHint(filePath: string): Promise<string> {
    try {
      const parent = dirname(filePath);
      const names = await readdir(parent);
      const visible = names.filter((n) => !this.shouldIgnore(n)).sort();
      if (visible.length === 0) return '';
      const sample = visible.slice(0, 20);
      const tail = visible.length > sample.length ? `…（共 ${visible.length} 项）` : '';
      return `\n[同级目录内容，供比对] ${sample.join('、')}${tail}`;
    } catch {
      // 父目录不可读/权限问题时放弃证据（不把次要失败盖过原始 ENOENT）
      return '';
    }
  }

  /**
   * 按行分段 + token 预算切片（read_file 返回形态的**单一收口**）
   *
   * 算法：
   *   1. 解析 `offset`（1-based 起始行）/ `limit`（行数上限）；offset 超出末尾 → 如实告知；
   *   2. 期望区间 = offset .. min(offset+limit−1, 总行数)；
   *   3. 若**不需要**截断（读到末尾且预算够）→ 返回原文，**不追加脚注**（零噪音）；
   *   4. 否则先为脚注预留 token，再**二分**出最大可容纳行数（token 随行数单调增 → 二分成立）；
   *   5. 脚注如实告知「已显示第 X–Y 行（共 M 行）」与续读 `offset=Y+1`。
   *
   * 退化情形（病态长行：单行本身就超预算）→ 该行按估算比反推字符数截断，并明示已截断。
   *
   * **不变量**：任何返回路径的 token 数都 ≤ `SINGLE_TOOL_RESULT_MAX_TOKENS −
   * TOOL_RESULT_WRAP_OVERHEAD_TOKENS`（**含脚注**）—— 即 wrapped 入上下文后仍 ≤ 单条上限，
   * 从而**结构性不触发**入口关落盘（否则 LLM 每次读文件只看得到路径）。脚注预留用最坏位数
   * （endLine = 总行数）估算，故实际脚注必不超预留。
   *
   * @param content 已净化的文件全文
   * @param displayPath 用于文案的相对路径（越界/退化提示可读）
   * @param offset LLM 传入的起始行号字符串（可选）
   * @param limit LLM 传入的行数上限字符串（可选）
   */
  private sliceFileByLineBudget(
    content: string,
    displayPath: string,
    offset?: string,
    limit?: string,
  ): string {
    // 预算扣除包裹开销：使 wrapped 后仍 ≤ 单条上限（见 TOOL_RESULT_WRAP_OVERHEAD_TOKENS 注释）
    const budget =
      LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS - LOOP_CONSTANTS.TOOL_RESULT_WRAP_OVERHEAD_TOKENS;
    const lines = content.split('\n');
    const total = lines.length;

    const start = positiveInt(offset) ?? 1;
    if (start > total) {
      return `[read_file] ${displayPath} 共 ${total} 行；offset=${start} 已超出文件末尾，无可显示内容。`;
    }

    const limitNum = positiveInt(limit);
    const wantedEnd = limitNum === undefined ? total : Math.min(start + limitNum - 1, total);

    // 是否需要截断（= 是否需要脚注）：用户 limit 截短了，或整个尾段本身超预算
    const tailTokens = estimateTokensText(lines.slice(start - 1).join('\n'));
    const needFooter = wantedEnd < total || tailTokens > budget;
    if (!needFooter) {
      return lines.slice(start - 1).join('\n');
    }

    // 脚注预留：按最坏位数（endLine 取总行数）估算，实际脚注必不超此预留
    const reserve = estimateTokensText(`\n${formatSegmentationFooter(start, total, total)}`);
    const bodyBudget = budget - reserve;

    // 二分最大可容纳行数 k ∈ [0, wantedEnd − start + 1]
    const maxK = wantedEnd - start + 1;
    let lo = 0;
    let hi = maxK;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const tokens = estimateTokensText(lines.slice(start - 1, start - 1 + mid).join('\n'));
      if (tokens <= bodyBudget) lo = mid;
      else hi = mid - 1;
    }
    const endLine = start + lo - 1;

    if (lo === 0) {
      // 退化：单行即超预算 → 按估算比反推字符数，明示已截断
      const marker = '[该行超过单次读取预算，已截断] ';
      const fillBudget = Math.max(1, bodyBudget - estimateTokensText(marker));
      return (
        `${marker}${clampCharsToTokenBudget(lines[start - 1]!, fillBudget)}\n` +
        formatSegmentationFooter(start, start, total)
      );
    }

    // 二分下界保证 body 不超 bodyBudget；脚注按 ceil 可加性不超 reserve
    return (
      `${lines.slice(start - 1, endLine).join('\n')}\n${formatSegmentationFooter(start, endLine, total)}`
    );
  }

  /**
   * 读取项目脚本文件原始内容（供 run_code script_path 模式执行）
   *
   * 与 readFile 的区别：不截断不净化——脚本代码要原样交给执行器，截断会破坏语法。
   * 仅做路径白名单校验 + 长度上限（SCRIPT_READ_MAX_LEN，防超大脚本滥用）。
   *
   * @param relativePath 相对项目根的文件路径
   * @returns 脚本文件原始内容
   */
  async readScriptFile(relativePath: string): Promise<string> {
    if (!relativePath) {
      throw toolError(
        'run_code script_path 参数缺失',
        'LLM 未传 script_path',
        ['script_path 不能为空'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    const absolutePath = this.resolveSafePath(relativePath);
    this.guardPathOrThrow(absolutePath, 'run_code');

    // 读前预检：目标是目录时给出可执行指引（脚本语义是文件）
    await this.assertFileNotDir(absolutePath, relativePath, 'run_code script_path', '传入脚本文件路径');

    try {
      const content = await readFile(absolutePath, 'utf-8');
      if (content.length > SCRIPT_READ_MAX_LEN) {
        throw toolError(
          'run_code 脚本文件过长',
          `脚本超过 ${SCRIPT_READ_MAX_LEN} 字符上限`,
          ['精简脚本或拆分为多个文件'],
          undefined,
          ToolErrorCode.ARGUMENT_ERROR,
        );
      }
      return content;
    } catch (err) {
      if (err instanceof MemoraError) throw err;
      const e = toError(err);
      if (isNodeErrorCode(err, 'ENOENT')) {
        throw toolError(
          'run_code 脚本文件不存在',
          `${absolutePath}：文件不存在`,
          ['确认 script_path 正确', '先 write_file 创建脚本再执行'],
          e,
          ToolErrorCode.FILE_NOT_FOUND,
        );
      }
      throw toolError(
        'run_code 读取脚本失败',
        `${absolutePath}：${e.message}`,
        ['确认文件可读'],
        e,
        ToolErrorCode.UNKNOWN,
      );
    }
  }

  /**
   * 删除项目文件（供 delete_file 工具）
   *
   * 安全策略：路径白名单校验 + 用户确认（guest 模式 / confirmWrites）。
   * 仅支持删除文件，不支持删除目录（防误删）。
   *
   * 与 readScriptFile 同属「临时脚本」闭环（write_file 写 → run_code 执行 → delete_file 清理，
   * 对齐主流 AI IDE 一次性数据处理不留痕的行为约定）。
   *
   * @param relativePath 相对项目根的文件路径
   * @returns 删除结果描述
   */
  async deleteFile(relativePath: string): Promise<string> {
    if (!relativePath) {
      throw toolError(
        'delete_file 工具调用缺少 path 参数',
        'LLM 未传 path',
        ['检查 personality.md 是否明确了 delete_file 用法'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    const absolutePath = this.resolveSafePath(relativePath);
    this.guardPathOrThrow(absolutePath, 'delete_file');

    try {
      // 删前预检：目标是目录时拒绝（防误删）
      const stats = await stat(absolutePath);
      if (stats.isDirectory()) {
        throw toolError(
          'delete_file 目标是目录',
          `${relativePath}：这是目录，delete_file 仅支持删除文件`,
          ['改用专门的删除目录工具（若存在）或手动删除'],
          undefined,
          ToolErrorCode.ARGUMENT_ERROR,
        );
      }
    } catch (err) {
      // stat 失败（如 ENOENT）视为"已删除"，返回成功（幂等性）；判定收口 isNodeErrorCode
      if (err instanceof MemoraError) throw err;
      if (isNodeErrorCode(err, 'ENOENT')) {
        return `✅ 文件不存在（已删除）：${absolutePath}`;
      }
      const e = toError(err);
      throw toolError(
        'delete_file 预检失败',
        `${absolutePath}：${e.message}`,
        ['确认路径正确'],
        e,
        ToolErrorCode.UNKNOWN,
      );
    }

    // 删除确认：owner 模式默认自动批准，guest 模式 / confirmWrites 需用户确认
    const needConfirm = this.security.permission === 'guest' || this.security.confirmWrites;
    if (needConfirm) {
      const description = `删除文件：${basename(absolutePath)}`;
      const confirmed = await this.security.requestWriteConfirmation(
        absolutePath,
        'delete_file',
        description,
      );
      if (!confirmed) {
        throw toolError(
          '用户拒绝删除',
          `用户取消了 delete_file 操作：${absolutePath}`,
          ['如需删除，请重新发起请求并确认'],
          undefined,
          ToolErrorCode.WRITE_REJECTED,
        );
      }
    }

    try {
      await unlink(absolutePath);
      return `✅ 已删除：${absolutePath}`;
    } catch (err) {
      const e = toError(err);
      throw toolError(
        'delete_file 删除失败',
        `${absolutePath}：${e.message}`,
        ['确认文件未被占用', '确认有删除权限'],
        e,
        ToolErrorCode.PERMISSION_DENIED,
      );
    }
  }

  /**
   * 写入文件（支持 overwrite / append / insert 三种模式）
   *
   * 安全策略：
   *   - 路径必须在白名单内
   *   - 写入前需用户确认（WriteExtensions.onBeforeWrite 或 SecurityGuard.requestWriteConfirmation）
   *   - 自动创建不存在的父目录
   *
   * @param relativePath 相对项目根的文件路径
   * @param content 要写入的内容
   * @param extensions 写入扩展（可选，用于 diff 确认等）
   * @param mode 写入模式："overwrite" | "append" | "insert"，默认 "overwrite"
   * @param insertLine insert 模式下的目标行号（从 1 开始），省略则插入到末尾
   */
  async writeFile(
    relativePath: string,
    content: string,
    extensions?: WriteExtensions,
    mode: string = 'overwrite',
    insertLine?: string,
  ): Promise<string> {
    if (!relativePath) {
      throw toolError(
        'write_file 工具调用缺少 path 参数',
        'LLM 未传 path',
        ['检查 personality.md 是否明确了 write_file 用法'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }
    if (typeof content !== 'string') {
      throw toolError(
        'write_file 工具调用缺少 content 参数',
        'LLM 未传 content',
        ['确认 content 是字符串'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    // 校验 mode 参数合法性
    const validModes = ['overwrite', 'append', 'insert'];
    if (!validModes.includes(mode)) {
      throw toolError(
        'write_file 参数错误',
        `mode 必须是 ${validModes.join('/')} 之一，收到：${mode}`,
        ['检查 LLM 输出的 mode 参数'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    // insert 模式必须提供 insert_line
    if (mode === 'insert' && !insertLine) {
      throw toolError(
        'write_file 参数错误',
        'insert 模式必须提供 insert_line 参数',
        ['insert_line 指定插入位置的行号（从 1 开始）'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    const absolutePath = this.resolveSafePath(relativePath);
    this.guardPathOrThrow(absolutePath, 'write_file');

    // 保留名守卫：任务表是内核工具数据（task_table_write/update 管理），不落盘为 markdown 文件。
    // 若放行，LLM 会在同一会话内反复 write_file 写 .memora/task-table.md（成功先例 few-shot 强化 →
    // 下轮沿用），绕过 PlanItem 通道导致顶部任务板不渲染/视角切换失效；软指令压不过先例，
    // 必须确定性拦截——命中即失败，错误样本进会话历史成为「此路不通」负面先例，
    // 引导 LLM 改走 task_table_write 单通道。
    if (isReservedTaskTableFile(absolutePath)) {
      throw toolError(
        '保留文件名：任务表必须用 task_table_write/task_table_update 管理',
        `write_file 不允许写入 ${basename(absolutePath)}（任务表是内核工具数据，不落盘为文件）`,
        ['使用 task_table_write 创建/更新任务表', '使用 task_table_update 标记步骤状态'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    // 读取文件旧内容（如果存在）
    let beforeContent: string | null = null;
    try {
      await access(absolutePath, constants.F_OK);
      beforeContent = await readFile(absolutePath, 'utf-8');
    } catch {
      // 文件不存在 → 新文件，beforeContent 保持 null
    }

    // 根据 mode 计算最终写入内容
    const finalContent = this.computeWriteContent(mode, content, beforeContent, insertLine);

    // 写入确认：优先使用 WriteExtensions.onBeforeWrite（diff 确认），
    // 否则回退到 SecurityGuard.requestWriteConfirmation（安全确认）
    if (extensions?.onBeforeWrite) {
      let ok: boolean;
      try {
        ok = await extensions.onBeforeWrite(relativePath, beforeContent, finalContent);
      } catch (err) {
        const e = toError(err);
        throw toolError(
          '写入确认失败',
          `写入确认回调异常：${e.message}`,
          ['重试写入操作', '检查扩展实现是否有 bug'],
          e,
          ToolErrorCode.UNKNOWN,
        );
      }
      if (!ok) {
        throw toolError(
          '用户拒绝写入',
          `用户取消了 write_file 操作：${absolutePath}`,
          ['如需写入，请重新发起请求并确认'],
          undefined,
          ToolErrorCode.WRITE_REJECTED,
        );
      }
    } else {
      // 回退到原有安全确认流程
      const description = `写入 ${finalContent.length} 字符到 ${basename(absolutePath)}（模式：${mode}）`;
      let confirmed: boolean;
      try {
        confirmed = await this.security.requestWriteConfirmation(
          absolutePath,
          'write_file',
          description,
          // 透传 diff 内容，供宿主 UI 在确认弹窗中展示变更预览
          { beforeContent, afterContent: finalContent },
        );
      } catch (err) {
        const e = toError(err);
        throw toolError(
          '写入确认失败',
          `安全确认异常：${e.message}`,
          ['重试写入操作'],
          e,
          ToolErrorCode.UNKNOWN,
        );
      }
      if (!confirmed) {
        throw toolError(
          '用户拒绝写入',
          `用户取消了 write_file 操作：${absolutePath}`,
          ['如需写入，请重新发起请求并确认'],
          undefined,
          ToolErrorCode.WRITE_REJECTED,
        );
      }
    }

    // 自动创建父目录（mkdir recursive）
    const parentDir = dirname(absolutePath);
    try {
      await mkdir(parentDir, { recursive: true });
    } catch (err) {
      const e = toError(err);
      throw toolError(
        '创建目录失败',
        `无法创建父目录 ${parentDir}：${e.message}`,
        ['确认父目录路径可写', '检查磁盘权限'],
        e,
        ToolErrorCode.PERMISSION_DENIED,
      );
    }

    try {
      await writeFile(absolutePath, finalContent, 'utf-8');
      // 返回结果包含写入模式、行数变化等信息
      const newLines = finalContent.split('\n').length;
      const oldLines = beforeContent !== null ? beforeContent.split('\n').length : 0;
      const modeLabel =
        mode === 'overwrite' ? '覆盖' : mode === 'append' ? '追加' : `插入到第${insertLine}行`;
      return (
        `✅ 已写入（${modeLabel}）：${absolutePath}（${finalContent.length} 字符，${newLines} 行）` +
        (beforeContent !== null ? ` [旧文件: ${oldLines} 行]` : ' [新文件]')
      );
    } catch (err) {
      const e = toError(err);
      throw toolError(
        '文件写入失败',
        `${absolutePath}：${e.message}`,
        ['确认父目录可写', '确认磁盘空间充足'],
        e,
        ToolErrorCode.PERMISSION_DENIED,
      );
    }
  }

  /**
   * 根据写入模式计算最终文件内容
   *
   * @param mode 写入模式
   * @param content LLM 提供的写入内容
   * @param beforeContent 文件旧内容（null 表示新文件）
   * @param insertLine insert 模式下的行号
   * @returns 最终要写入文件的完整内容
   */
  private computeWriteContent(
    mode: string,
    content: string,
    beforeContent: string | null,
    insertLine: string | undefined,
  ): string {
    switch (mode) {
      case 'overwrite':
        // 全量覆盖：直接使用 content
        return content;

      case 'append':
        // 追加模式：旧内容 + 新内容
        if (beforeContent === null) {
          // 新文件等同于 overwrite
          return content;
        }
        return beforeContent + content;

      case 'insert': {
        // 插入模式：在指定行号前插入
        if (beforeContent === null) {
          // 新文件等同于 overwrite
          return content;
        }
        const lineNum = Number.parseInt(insertLine ?? '1', 10);
        if (Number.isNaN(lineNum) || lineNum < 1) {
          throw toolError(
            'write_file 参数错误',
            `insert_line 必须是正整数，收到：${insertLine}`,
            ['insert_line 从 1 开始计数'],
            undefined,
            ToolErrorCode.ARGUMENT_ERROR,
          );
        }
        const lines = beforeContent.split('\n');
        // 行号超出范围时追加到末尾
        const insertIdx = Math.min(lineNum - 1, lines.length);
        lines.splice(insertIdx, 0, content);
        return lines.join('\n');
      }

      default:
        // 理论上不会到达（writeFile 已校验 mode），防御性兜底
        return content;
    }
  }

  /**
   * 列出目录内容
   *
   * 安全策略：
   *   - 路径必须在白名单内
   *   - 递归深度 ≤ 3（maxDepth 入参强校验）
   *   - 自动忽略：.git / node_modules / .memora / dist / coverage / .next
   */
  async listDir(relativePath: string, recursiveStr: string, maxDepthStr: string): Promise<string> {
    const absolutePath = this.resolveSafePath(relativePath);
    this.guardPathOrThrow(absolutePath, 'list_dir');

    const recursive = recursiveStr === 'true' || recursiveStr === '1';
    let maxDepth = Number.parseInt(maxDepthStr, 10);
    if (Number.isNaN(maxDepth) || maxDepth < 1) {
      maxDepth = 2;
    }
    if (maxDepth > 3) {
      maxDepth = 3;
    }

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (err) {
      // stat 调用失败：区分 ENOENT（不存在）和其他 IO 错误
      if (isNodeErrorCode(err, 'ENOENT')) {
        const e = toError(err);
        throw toolError(
          'list_dir 路径不存在',
          `${absolutePath}：目录不存在`,
          ['确认路径存在', '使用 list_dir(".") 列出项目根'],
          e,
          ToolErrorCode.DIR_NOT_FOUND,
        );
      }
      // 其他 IO 错误（如权限问题），包装为统一的 TOOL_ERROR
      const e = toError(err);
      throw toolError(
        'list_dir 访问失败',
        `${absolutePath}：${e.message}`,
        ['确认目录权限', '尝试其他路径'],
        e,
        ToolErrorCode.UNKNOWN,
      );
    }

    // stat 成功，检查是否为目录
    if (!stats.isDirectory()) {
      throw toolError(
        'list_dir 路径不是目录',
        `${absolutePath} 是文件，不是目录`,
        ['path 参数必须指向目录'],
        undefined,
        ToolErrorCode.DIR_NOT_FOUND,
      );
    }

    const entries: string[] = [];
    await this.walkDir(absolutePath, absolutePath, entries, 0, maxDepth, recursive);

    if (entries.length === 0) {
      return `（目录为空或所有条目都被忽略）${absolutePath}`;
    }
    // 返回净化：目录树同为工具结果，做长度上限（避免超大目录整段进上下文）
    return sanitizeExternalText(
      `目录 ${absolutePath} 共有 ${entries.length} 个条目：\n${entries.map((e) => `  ${e}`).join('\n')}`,
      DIR_LIST_MAX_LEN,
    );
  }

  /**
   * 递归遍历目录（深度受限 + 忽略特定目录）
   */
  private async walkDir(
    root: string,
    current: string,
    out: string[],
    depth: number,
    maxDepth: number,
    recursive: boolean,
  ): Promise<void> {
    if (depth > maxDepth) return;

    let names: string[];
    try {
      names = await readdir(current);
    } catch (err) {
      logger.debug({ err, dir: current }, 'readdir 失败，跳过');
      return;
    }

    names.sort();

    for (const name of names) {
      // 忽略：.git / node_modules / .memora / dist / coverage
      if (this.shouldIgnore(name)) continue;

      const childAbs = join(current, name);
      const childRel = relative(root, childAbs);

      try {
        const childStat = await stat(childAbs);
        if (childStat.isDirectory()) {
          out.push(`📁 ${childRel}/`);
          // 递归条件：未达到 maxDepth（depth+1 < maxDepth）
          // maxDepth=1 → 0+1<1=false 不递归；maxDepth=2 → 0+1<2=true 递归 1 层
          if (recursive && depth + 1 < maxDepth) {
            await this.walkDir(root, childAbs, out, depth + 1, maxDepth, recursive);
          }
        } else {
          out.push(`📄 ${childRel}`);
        }
      } catch (err) {
        // 跳过无法访问的条目（符号链接断开、权限不足等）
        out.push(`❓ ${childRel}（无法访问：${toError(err).message}）`);
      }
    }
  }

  /**
   * 判断目录/文件名是否应被忽略
   */
  private shouldIgnore(name: string): boolean {
    return BuiltinToolHandlers.IGNORED_DIR_NAMES.includes(name);
  }

  /**
   * 在记忆索引中搜索
   *
   * @param query 搜索关键词
   * @param limitStr 返回数量上限
   * @param modeStr 搜索模式："match"（任一命中，默认）或 "near"（全部命中）
   */
  async searchMemories(query: string, limitStr: string, modeStr: string): Promise<string> {
    if (!query) {
      throw toolError(
        'search_memories 工具调用缺少 query 参数',
        'LLM 未传 query',
        ['query 不能为空'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    // limit 解析统一收口 parseLimit（非法→默认值，超上限钳制到 50）
    const limit = parseLimit(limitStr, AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT, 50);

    // 工具召回与装配期内容互斥（§5.1）：排除「正文或摘要已在眼前」的轮次 round-summary
    // （正文已在眼前，避免重复返回）。由装配期注入的 exclusionRoundIdsProvider 提供
    // （= loop.getExclusionRoundIds() 精确集合）；缺省不注入则不过滤（测试/独立调用可直接触发）。
    const excludedRoundIds: ReadonlySet<string> = this.exclusionRoundIdsProvider
      ? this.exclusionRoundIdsProvider()
      : new Set<string>();

    // memory-tool-recall-design §3.3：注入 MemoryInspector 后走纯关键词搜索（searchByKeyword
    // = 纯关键词 + superseded 过滤 + accessedAt/溯源揭示），否则回退旧关键词 memoryIndex.search。
    // 包进带超时的函数：底部 search_memories 是有用户感知的读工具，语义 embed 是远程调用，
    // 响应性护栏 MEMORY_SEARCH_TIMEOUT_MS（5s）超时降级为提示，不挂死工具调用（排雷见 constants.ts）。
    const hits: AgentSearchHit[] = await this.withMemorySearchTimeout(async () =>
      this.memoryInspector
        ? await this.memoryInspector.searchByKeyword(query, limit, excludedRoundIds)
        : this.memoryIndex
            .search(query, limit)
            .map((m) => ({
              id: m.id,
              name: m.name,
              source: m.source,
              contentPreview: m.content,
              // 溯源 roundId 用于互斥过滤（与 searchByKeyword 排除口径一致）
              roundId: m.roundId,
            }))
            .filter((h) => !(h.roundId && excludedRoundIds.has(h.roundId))),
    );

    // near 模式（"must all keywords" 严格过滤）：不论后端（searchByKeyword 或 memoryIndex）
    // 一律在候选结果上做「所有关键词都命中」后置过滤，保证 mode 参数语义恒生效。
    if (modeStr === 'near' && hits.length > 0) {
      const keywords = segmentLower(query);
      if (keywords.length > 1) {
        const filtered = hits.filter((m) => {
          const text = `${m.contentPreview} ${m.name}`.toLowerCase();
          return keywords.every((kw) => text.includes(kw));
        });
        hits.length = 0;
        hits.push(...filtered);
      }
    }

    if (hits.length === 0) {
      return `（未找到匹配 "${query}" 的记忆${modeStr === 'near' ? '（near 模式：所有关键词必须命中）' : ''}）`;
    }

    // 命中即 touch（§3.4/§3.3「命中 touch」行）：fire-and-forget 刷新 accessedAt（backgroundTask + touchScores）。
    // 只 touch 不加权（§5.2 定案）：accessedAt 是「使用轨迹」唯一事实源，touchScores 内部只调 storage.touch
    // 刷新访问时间、不写任何重要度字段——命中 = 被 LLM 想起，仅用于排序，不做记忆强化加权。查询低频，无自反馈（自动注入退役后根除正反馈）。
    this.touchHits(hits);

    // memoryRecalled 事件（§2.4「保留改语义」定案）：LLM 查询记忆命中 N 条 → 宿主感知提示。
    // 唯一发射位：此处是全库唯一 emit。
    this.onMemoryRecalled?.({ count: hits.length, query });

    const lines = hits.map((m, i) => {
      const preview = truncate(m.contentPreview ?? '', 80);
      const access = m.accessedAt ? ` accessedAt=${m.accessedAt}` : '';
      // 结构化溯源（§3.3「返回」行）：round-summary 命中项显式附 sessionId/roundId，LLM 零解析直用 trace_summary
      const trace = m.sessionId
        ? ` trace(${m.sessionId}${m.roundId ? `, round=${m.roundId}` : ''})`
        : '';
      // 命中项仅保留 accessedAt/trace
      return `${i + 1}. [${m.source}:${m.name}] (${access}${trace})\n   ${preview.replace(/\n/g, ' ')}`;
    });
    return `搜索 "${query}" 找到 ${hits.length} 条（${modeStr} 模式）：\n${lines.join('\n')}`;
  }

  /**
   * 命中即 touch：fire-and-forget 刷新命中记忆的 accessedAt（不涉及任何重要度字段）。
   *
   * 收敛到 keywordsTouch.ts 的单一真理源 touchScores（§5.2 只 touch 不加权，内部只调 storage.touch）——
   * 不为工具命中另造写分路径。backgroundTask 保证 fire-and-forget 不阻塞搜索返回，
   * 且统一并发限流；失败兜底记日志即可（touch 是排序副作用，非主线流程）。
   *
   * @param hits 搜索命中项（取其 id 定位，实际写入交由 touchScores 收敛）
   */
  private touchHits(hits: readonly AgentSearchHit[]): void {
    if (hits.length === 0) return;
    backgroundTask('search_memories.touch', () =>
      touchScores(
        this.memoryIndex,
        hits.map((h) => h.id),
      ),
    );
  }

  /**
   * `search_memories` 响应性护栏包装：给整次记忆搜索设上限。
   *
   * 背景：搜索服务为网络调用时超时远长于本地上限，这里收窄为 MEMORY_SEARCH_TIMEOUT_MS（5s）——
   * 超时降级为「搜索超时」提示（空结果语义），而非挂死工具或抛错中断对话。
   *
   * @param run 返回记忆搜索结果的函数（同步或异步）
   * @returns 搜索完成后返回全量命中；超时则返回空数组（降级提示由调用方近零命中分支承担）
   */
  private async withMemorySearchTimeout(run: () => Promise<AgentSearchHit[]>): Promise<AgentSearchHit[]> {
    const timeout = new Promise<AgentSearchHit[]>((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error('记忆搜索超时'));
      }, LOOP_CONSTANTS.MEMORY_SEARCH_TIMEOUT_MS);
      // 让定时器不阻塞 Node 事件循环退出（测试/关停场景无悬挂定时器）
      if (typeof (id as { unref?: () => void }).unref === 'function') id.unref();
    });

    try {
      return await Promise.race([run(), timeout]);
    } catch (err) {
      // 超时降级：记日志 + 返回空（近零命中分支已有「未找到匹配」文案兜底，不重复造文案）
      logger.warn({ err: toError(err).message }, 'search_memories 搜索超时，已降级为空结果');
      return [];
    }
  }

  /**
   * 追溯轮次摘要的原始对话内容
   *
   * 从记忆索引中查找 `source='round-summary'` 的记忆，
   * 根据 sessionId 和 roundId 过滤。
   * 返回格式化后的摘要列表，包含摘要内容、类型和溯源信息。
   *
   * @param sessionId 会话标识（格式：YYYY-MM-DD-sessionName）
   * @param roundId 轮次 ID（可选，不传则返回最近 N 条摘要）
   * @param limitStr 返回结果数量上限（默认 "5"，最大 "20"）
   */
  async traceSummary(sessionId: string, roundId?: string, limitStr?: string): Promise<string> {
    if (!sessionId) {
      throw toolError(
        'trace_summary 工具调用缺少 sessionId 参数',
        'LLM 未传 sessionId',
        ['sessionId 不能为空'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    // limit 解析统一收口 parseLimit（非法→默认 5，超上限钳制到 20）
    const limit = parseLimit(limitStr, 5, 20);

    // 获取所有 round-summary 类型的记忆
    const allSummaries = this.memoryIndex.getBySource(SOURCE_LABELS.ROUND_SUMMARY);

    // 按 sessionId 过滤
    // 会话级前缀与写侧同源（roundSummarySessionPrefix，memory/types）：标签变更无需同步两处
    const sessionPrefix = roundSummarySessionPrefix(sessionId);
    const matched = allSummaries.filter((m) => m.id.startsWith(sessionPrefix));

    if (roundId) {
      // 精确匹配轮次
      const exact = matched.find((m) => m.id === `${sessionPrefix}${roundId}`);
      if (!exact) {
        return `（未找到会话 "${sessionId}" 中轮次 "${roundId}" 的摘要）`;
      }
      // 溯源真实化：优先返回该轮次的原始对话
      // 仅当宿主注入了 sessionStore 且能定位到对应轮次消息时返回原始对话，
      // 否则回退为摘要文本（保证工具始终可用、不因缺注入而报错）。
      const raw = this.loadRawRoundMessages(sessionId, roundId);
      if (raw) {
        // 关键修复：原始对话文本注入前必须过 sanitizeExternalText，去控制字符 + 长度上限。
        // 与 toolExecutor 主路径净化一致，防止用户历史中的控制字符/隐藏指令直通 LLM 上下文。
        const lines = raw.messages
          .map((m) => `[${m.role}] ${sanitizeExternalText(m.content, TRACE_MESSAGE_CHAR_LIMIT)}`)
          .join('\n');
        const truncNote = raw.truncated ? '\n（对话已截断，仍有更多消息）' : '';
        return `会话：${sessionId} | 轮次：${roundId} 原始对话：\n${lines}${truncNote}`;
      }
      const summaryType = exact.summaryType ?? 'general';
      const modifiedInfo = exact.isModified ? '（已手动修改）' : '';
      // 溯源失败降级：按本次查找结果渲染（原始对话已删），不依赖字段标记
      return `会话：${sessionId} | 轮次：${roundId} | 类型：${summaryType}${modifiedInfo}\n摘要：${exact.content}\n（原始对话已删除，仅剩摘要）\n`;
    }

    // 未指定 roundId，返回最近 N 条（按 createdAt 降序）
    if (matched.length === 0) {
      return `（会话 "${sessionId}" 暂无轮次摘要）`;
    }

    matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const top = matched.slice(0, limit);

    const lines = top.map((m, i) => {
      const roundIdFromMeta = m.roundId ?? 'unknown';
      const summaryType = m.summaryType ?? 'general';
      const preview = truncate(m.content, 120);
      return `${i + 1}. [${summaryType}] 轮次 ${roundIdFromMeta}\n   ${preview.replace(/\n/g, ' ')}`;
    });

    return `会话 "${sessionId}" 的轮次摘要（最近 ${top.length} 条）：\n${lines.join('\n')}`;
  }

  /**
   * 溯源指定轮次的原始对话消息
   *
   * 通过 sessionStore.loadMessages 定位该会话，按 SessionMessage.roundId 过滤出本轮消息。
   * 规模控制：最多 5 条消息，超过则截断并标记 isTruncated。
   *
   * @param sessionId 会话标识（格式：YYYY-MM-DD-sessionName）
   * @param roundId 轮次 ID
   * @returns 原始消息列表（≤5 条）+ 是否截断；会话存储不可用或未命中该轮次时返回 null
   */
  private loadRawRoundMessages(
    sessionId: string,
    roundId: string,
  ): { messages: Array<{ role: string; content: string }>; truncated: boolean } | null {
    if (!this.sessionStore) return null;
    // 解析 date（前 10 位 YYYY-MM-DD）与 session（去掉 "YYYY-MM-DD-" 前缀）
    // 用内核 splitSessionId（SSOT 契约，防 session 名含连字符时切错）
    const parsed = splitSessionId(sessionId);
    if (!parsed.session) return null;
    try {
      const all = this.sessionStore.loadMessages(parsed.date, parsed.session);
      const roundMsgs = all.filter((m) => m.roundId === roundId);
      if (roundMsgs.length === 0) return null;
      const truncated = roundMsgs.length > TRACE_MESSAGE_LIMIT;
      return {
        messages: roundMsgs.slice(0, TRACE_MESSAGE_LIMIT),
        truncated,
      };
    } catch (err) {
      // 会话存储异常时降级（不阻断工具），由调用方回退摘要文本
      logger.warn({ err, sessionId, roundId }, 'trace_summary 读取原始对话失败，降级为摘要');
      return null;
    }
  }

  /**
   * list_sessions：列出历史会话**路标**（会话级摘要），供 LLM 粗定位后再用 trace_summary 下钻。
   *
   * 会话级摘要是「路标」而非记忆——存于 SessionMeta（summary/keyTopics），不进记忆召回池
   * （见 R5：会话级路标不进记忆库）。本工具是「粗定位 → 细取证」闭环的第一环：
   * 返回最近 N 个会话的路标，LLM 据此挑目标，再用 trace_summary(sessionId) 取该会话轮次摘要。
   *
   * 路标滞后说明：SessionArchiver 在**会话切换前**触发，故当前会话的摘要可能落后于最新对话。
   * 本工具按 updatedAt 降序返回，历史会话路标准确；当前会话以实际上下文为准，不依赖路标。
   *
   * @param limitStr 返回条数上限（默认 "10"，最大 "30"）
   * @returns 格式化的会话路标列表；无会话存储 / 无会话时返回说明文本（不抛错）
   */
  async listSessions(limitStr?: string): Promise<string> {
    // limit 解析统一收口 parseLimit（非法→默认 10，超上限钳制到 30）
    const limit = parseLimit(limitStr, LIST_SESSIONS_DEFAULT, LIST_SESSIONS_MAX);

    // 未注入会话存储：降级为说明文本（与 trace_summary 的降级哲学一致，不阻塞对话）
    if (!this.sessionStore) return '（未配置会话存储，无法列出历史会话）';

    let ids: string[];
    try {
      ids = this.sessionStore.listSessions();
    } catch (err) {
      logger.warn({ err }, 'list_sessions 列举会话失败，降级为空结果');
      return '（读取历史会话失败，请稍后重试）';
    }
    if (ids.length === 0) return '（暂无历史会话）';

    const metas: SessionMeta[] = [];
    for (const id of ids) {
      try {
        const meta = this.sessionStore.getSessionMeta(id);
        if (meta) metas.push(meta);
      } catch (err) {
        // 单个会话 meta 损坏不影响整体列举（降级优先，跳过该条）
        logger.warn({ err, sessionId: id }, 'list_sessions 读取会话元数据失败，跳过该条');
      }
    }
    // 按最近活跃降序（历史会话列表的直觉顺序）
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const shown = metas.slice(0, limit);
    if (shown.length === 0) return '（暂无历史会话）';

    const lines = shown.map((m, i) => {
      const name = getSessionDisplayName(m) || m.sessionId;
      // 路标文本由 LLM 生成自用户内容 → 过 sanitize 防注入，并限长
      const summary = m.summary
        ? `\n   ${sanitizeExternalText(m.summary, LIST_SESSIONS_SUMMARY_CHARS)}`
        : '';
      const topics =
        m.keyTopics && m.keyTopics.length > 0
          ? `\n   主题：${sanitizeExternalText(m.keyTopics.join(' / '), LIST_SESSIONS_SUMMARY_CHARS)}`
          : '';
      return `${i + 1}. ${m.sessionId} · ${sanitizeExternalText(name, 100)}${topics}${summary}`;
    });

    const moreNote =
      metas.length > shown.length
        ? `\n（共 ${metas.length} 个会话，仅显示最近 ${shown.length} 个；需要更多请调大 limit）`
        : '';
    return (
      `历史会话路标（按最近活跃降序，共 ${metas.length} 个）：\n${lines.join('\n')}${moreNote}\n\n` +
      '如需查看某个会话的问答摘要，用 trace_summary 并传入该会话的 sessionId（不传 roundId 即返回该会话最近若干轮）。'
    );
  }
}

/**
 * 拼装 run_team_meeting 的多角色 system prompt（纯函数，可单测）
 *
 * 把各角色 persona 全文按「组长置前、组员随后」顺序拼接，并在头部声明任务——
 * 让模型以各角色设定与专业视角独立评估议题，最后以组长视角汇总。
 * 组长在 prompt 中显式标注为「组长」，承担唯一汇总视角。
 *
 * @param roles 参与会议的角色（name + persona 全文；已过滤未装载的空 persona）
 * @param leaderName 组长的角色包名（唯一汇总视角）
 * @param topic 要评估的议题
 * @returns 完成拼装的多角色 system prompt
 */
function buildTeamMeetingPrompt(
  roles: ReadonlyArray<{ name: string; persona: string }>,
  leaderName: string,
  topic: string,
): string {
  const roleLines = roles
    .map((r, i) => {
      const tag = r.name === leaderName ? `角色${i + 1}（组长）` : `角色${i + 1}（组员）`;
      return `── ${tag}名称：${r.name} ──\n${r.persona}`;
    })
    .join('\n\n');
  return (
    `请以以下各角色的设定与专业视角，分别独立评估议题「${topic}」，给出各自的立场与理由` +
    `（每个视角一段），最后以组长「${leaderName}」视角做简短汇总。\n\n${roleLines}`
  );
}

/**
 * run_team_meeting 执行实现（工具内嵌 LLM 调用，一次 chat() 完成）
 *
 * 串联既有原语实现「评估/评审型小组会议」：解析组名 → 取各角色 persona 全文 → 拼多角色
 * system prompt → 单次 provider.chat() → 返回评审文本。依赖经参数注入（不持有全局状态），
 * 由装配层在后续注入时把 rolePackManager 与 provider 收敛进闭包。
 *
 * 边界（探索方案 §5.3 实证）：
 * - 只覆盖评估/评审型（各视角独立观点 + 组长汇总），不覆盖你来我往的讨论型会议；
 * - 角色数隐式受组解析截断约束（组长 1 + 组员 ≤ 4），persona 全文 token 成本高。
 *
 * @param params 依赖注入 + 工具入参（resolveTeam/buildPersona/provider 由装配层提供）
 * @returns 多角色评估文本（已净化 + 长度上限）
 * @throws 参数缺失 / 组不存在 / 组角色未装载 → MemoraError
 */
export async function runTeamMeetingAssessment(params: {
  /** 组解析：按组名返回队长 + 组员名单（null = 组不存在） */
  resolveTeam: (group: string) => { leader: string; members: readonly string[] } | null;
  /** 角色 persona 取全文（如 rolePackManager.buildSystemPrompt(name)） */
  buildPersona: (name: string) => string;
  /** 前台 LLM provider（评审为 turn 内工具，走主通道） */
  provider: LlmProvider;
  /** 组名（= 组长角色包名） */
  group: string;
  /** 要评估的议题 */
  topic: string;
}): Promise<string> {
  const { group, topic } = params;
  if (!group || !group.trim()) {
    throw toolError(
      'run_team_meeting 缺少 group 参数',
      '未传组名（组名 = 组长角色包名）',
      ['传组名，如 run_team_meeting("设计组", "议题")'],
      undefined,
      ToolErrorCode.ARGUMENT_ERROR,
    );
  }
  if (!topic || !topic.trim()) {
    throw toolError(
      'run_team_meeting 缺少 topic 参数',
      '未传要评估的议题',
      ['传一句议题，越具体越好'],
      undefined,
      ToolErrorCode.ARGUMENT_ERROR,
    );
  }

  // 组解析：组名 = 组长角色包名；未命中即组不存在
  const team = params.resolveTeam(group);
  if (!team) {
    throw toolError(
      'run_team_meeting 组不存在',
      `未找到组长为「${group}」的组`,
      ['确认组名与组长角色包名一致', '确认该组已在组名单中配置'],
      undefined,
      ToolErrorCode.ARGUMENT_ERROR,
    );
  }

  // 取各角色 persona 全文；未装载（buildPersona 返回空）的角色跳过，保证拼入的都有效
  const roles = [team.leader, ...team.members]
    .map((name) => ({ name, persona: params.buildPersona(name) }))
    .filter((r) => r.persona.length > 0);
  if (roles.length === 0) {
    throw toolError(
      'run_team_meeting 组角色未装载',
      `组「${group}」的成员角色包均未装载，无法开会`,
      ['确认组长与组员角色包已装载'],
      undefined,
      ToolErrorCode.ARGUMENT_ERROR,
    );
  }

  // 一次 chat() 完成多角色评估 + 组长汇总（拼装见 buildTeamMeetingPrompt）
  const systemPrompt = buildTeamMeetingPrompt(roles, team.leader, topic);
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请按上述要求给出各角色观点与组长汇总的正式评估。' },
  ];
  let response = '';
  for await (const chunk of params.provider.chat(messages)) {
    if (chunk.content) response += chunk.content;
  }
  if (!response.trim()) return '（会议未产生输出）';
  return sanitizeExternalText(response, MEETING_RESULT_MAX_LEN);
}
