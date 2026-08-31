/**
 * 内置工具处理器（从 ToolExecutor 提取的内置工具实现层）
 *
 * 职责：
 *   1. 路径安全解析（resolveSafePath + guardPathOrThrow）—— 内置 + 自定义工具共享
 *   2. 内置工具实现（read_file / write_file / list_dir / search_memories）
 *   3. 文件写入内容计算（computeWriteContent）
 *   4. 目录递归遍历（walkDir + shouldIgnore）
 *
 * 设计理由：ToolExecutor 802 行超阈值，内置工具实现（~440 行）
 * 是独立职责——实际文件系统/记忆索引操作，与 ToolExecutor 的注册/分发/校验职责分离。
 *
 * 自然生长原则：BuiltinToolHandlers 不持有 customTools 注册表（避免与 ToolExecutor 状态耦合），
 * 所有方法接收参数，是无状态的纯计算 + I/O 操作。
 */
import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, isAbsolute, join, relative, dirname, basename } from 'node:path';
import type { SecurityGuard } from '@/security/pathGuard.js';
import { toolError, MemoraError, ToolErrorCode } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';
import { segmentLower } from '@/utils/segmenter.js';
import { truncate } from '@/utils/strings.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { ISessionStore, SessionMeta } from '@/memory/sessionStore.js';
// 使用 import type 避免运行时循环依赖：WriteExtensions 类型定义在 toolExecutor.ts
import type { WriteExtensions } from '@/agent/toolExecutor.js';
import { sanitizeExternalText } from '@/agent/toolExecutor.js';

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

/**
 * 文件读取返回的最大字符数（防长上下文注入）
 *
 * read_file 返回的项目文件内容同为工具结果——按哲学"工具结果做基础净化与长度上限"
 * 对齐 web_search/web_fetch/run_code 的防御：超大文件内容不整段进入 LLM 上下文，
 * 避免撑爆 ContextManager token 上限、与控制字符注入面回归一致。
 */
const FILE_READ_MAX_LEN = 50_000;

/**
 * 工具结果返回净化：去控制字符 + 长度上限
 *
 * 与 toolExecutor.sanitizeExternalText 同语义（外部/项目文件内容注入 LLM 前统一净化），
 * 保持内置文件工具与 web 系工具的注入防御一致。
 *
 * @param text 原始文本
 * @param maxLen 最大长度
 * @returns 净化后的文本
 */
function sanitizeToolResult(text: string, maxLen: number): string {
  // 去控制字符：保留可打印字符（含 \t 制表符），其余控制字符移除
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

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
 * 内置工具处理器
 *
 * 管理 4 个内置工具的实际实现 + 路径安全校验。
 * 从 ToolExecutor 提取，保持无状态设计（不持有 customTools 注册表）。
 */
export class BuiltinToolHandlers {
  /** list_dir 默认忽略的目录/文件名（引用模块级单一真理源，保持类静态 API 兼容） */
  static readonly IGNORED_DIR_NAMES: readonly string[] = IGNORED_DIR_NAMES;

  /**
   * @param projectPath 项目根路径（用于相对路径解析）
   * @param security 安全守卫（路径白名单 + 写入确认）
   * @param memoryIndex 记忆索引（用于 search_memories 工具）
   * @param sessionStore 会话存储（可选，trace_summary 溯源原始对话用；未注入时回退为摘要文本）
   */
  constructor(
    private readonly projectPath: string,
    private readonly security: SecurityGuard,
    private readonly memoryIndex: IMemoryStorage,
    private readonly sessionStore?: ISessionStore,
  ) {}

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
          '查看审计日志：~/.memora/logs/memora.log',
        ],
        e,
        ToolErrorCode.PATH_NOT_ALLOWED,
      );
    }
  }

  // ─── 内置工具实现 ──────────────────────────────────────

  /**
   * 读取文件（带路径白名单校验）
   */
  async readFile(relativePath: string): Promise<string> {
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

    try {
      // 读前预检：目标是目录时给出可执行指引（read_file 语义是读文件；
      // EISDIR 原生错误对 LLM 无意义，直接提示改用 list_dir）
      const stats = await stat(absolutePath);
      if (stats.isDirectory()) {
        throw toolError(
          'read_file 目标是目录',
          `${relativePath}：这是目录，不是文件`,
          ['改用 list_dir 列出该目录下的内容'],
          undefined,
          ToolErrorCode.ARGUMENT_ERROR,
        );
      }
    } catch (err) {
      // stat 失败（如 ENOENT/权限）移交下方 readFile 异常路径统一报错；工具错误直接抛出
      if (err instanceof MemoraError) throw err;
    }

    try {
      const content = await readFile(absolutePath, 'utf-8');
      // 返回净化：工具结果同哲学"长度上限 + 去控制字符"（超大文件不整段进上下文，防注入/撑爆）
      // 注：作品投影改为用户主动触发（register_work 工具），read_file 不再自动生成
      return sanitizeToolResult(content, FILE_READ_MAX_LEN);
    } catch (err) {
      const e = toError(err);
      // 区分 ENOENT（文件不存在）和其他 IO 错误
      if (e instanceof MemoraError) throw e;
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: unknown }).code === 'ENOENT'
      ) {
        throw toolError(
          'read_file 文件不存在',
          `${absolutePath}：文件不存在`,
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
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: unknown }).code === 'ENOENT'
      ) {
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
    // 返回净化：目录树同为工具结果，做长度上限（避免超大目录整段进上下文，与 read_file 防御一致）
    return sanitizeToolResult(
      `目录 ${absolutePath} 共有 ${entries.length} 个条目：\n${entries.map((e) => `  ${e}`).join('\n')}`,
      FILE_READ_MAX_LEN,
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

    let limit = Number.parseInt(limitStr, 10);
    if (Number.isNaN(limit) || limit < 1) {
      limit = 10;
    }
    if (limit > 50) {
      limit = 50;
    }

    const mode = modeStr === 'near' ? 'near' : 'match';
    let results = this.memoryIndex.search(query, limit);

    // near 模式：过滤只保留所有关键词都命中的结果
    if (mode === 'near' && results.length > 0) {
      // 复用 segmentText 分词，与 inMemoryStorage 搜索保持一致
      const keywords = segmentLower(query);
      if (keywords.length > 1) {
        results = results.filter((m) => {
          const text = `${m.content} ${m.name}`.toLowerCase();
          return keywords.every((kw) => text.includes(kw));
        });
      }
    }

    if (results.length === 0) {
      return `（未找到匹配 "${query}" 的记忆${mode === 'near' ? '（near 模式：所有关键词必须命中）' : ''}）`;
    }

    const lines = results.map((m, i) => {
      const preview = truncate(m.content, 80);
      return `${i + 1}. [${m.source}:${m.name}] (score=${m.score})\n   ${preview.replace(/\n/g, ' ')}`;
    });
    return `搜索 "${query}" 找到 ${results.length} 条（${mode} 模式）：\n${lines.join('\n')}`;
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

    let limit = Number.parseInt(limitStr ?? '5', 10);
    if (Number.isNaN(limit) || limit < 1) limit = 5;
    if (limit > 20) limit = 20;

    // 获取所有 round-summary 类型的记忆
    const allSummaries = this.memoryIndex.getBySource(SOURCE_LABELS.ROUND_SUMMARY);

    // 按 sessionId 过滤
    const sessionPrefix = `round-summary:${sessionId}:`;
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
    const date = sessionId.slice(0, 10);
    const session = sessionId.length > 11 ? sessionId.slice(11) : '';
    if (!session) return null;
    try {
      const all = this.sessionStore.loadMessages(date, session);
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
    const parsed = Number.parseInt(limitStr ?? String(LIST_SESSIONS_DEFAULT), 10);
    let limit = Number.isNaN(parsed) || parsed < 1 ? LIST_SESSIONS_DEFAULT : parsed;
    if (limit > LIST_SESSIONS_MAX) limit = LIST_SESSIONS_MAX;

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
      const name = m.displayName || m.autoName || m.sessionId;
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
