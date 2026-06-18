/**
 * 工具执行器
 *
 * 阶段一：1 个工具（read_file）
 * 阶段二（M-204）：扩展为 4 个工具（read_file / write_file / list_dir / search_memories）
 * 详见 ADR-006 · 安全采用两级权限 + 工具白名单 + 路径白名单
 */
import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, isAbsolute, join, relative, dirname, basename } from 'node:path';
import type { SecurityGuard } from '@/security/pathGuard.js';
import { toolError, configError, MemoraError, ToolErrorCode } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { WorkProjectionManager } from './workProjection.js';
import { BUILTIN_TOOLS, type ToolDefinition } from './builtinTools.js';
export { BUILTIN_TOOLS } from './builtinTools.js';
export type { ToolDefinition } from './builtinTools.js';

type ToolResult = string;

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
 * S-01: 提供安全校验方法，让自定义工具可以（且应该）通过安全层校验路径。
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
 * S-01: 自定义工具如需访问文件系统，应调用 ctx.guardPath(path) 校验路径。
 */
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

/**
 * 自定义工具注册条目
 *
 * 将工具定义与处理器绑定在一起，
 * 存入 ToolExecutor 的 customTools Map 中。
 */
export interface CustomToolEntry {
  /** 工具定义（名称、描述、参数 schema） */
  definition: ToolDefinition;
  /** 工具执行处理器 */
  handler: ToolHandler;
}

/**
 * 工具执行器
 */
export class ToolExecutor {
  /** 自定义工具注册表（宿主项目通过 registerTool 注册领域工具） */
  private readonly customTools = new Map<string, CustomToolEntry>();

  constructor(
    private readonly projectPath: string,
    private readonly security: SecurityGuard,
    private readonly memoryIndex: IMemoryStorage,
    /** 作品投影管理器（可选，读取文件时自动生成投影） */
    private readonly workProjection?: WorkProjectionManager,
  ) {}

  /**
   * 注册自定义工具
   *
   * 宿主项目调用此方法注册领域专属工具（如小说创作的 create_chapter）。
   * 工具名不能与内置工具重复，也不能重复注册。
   * 注册后工具会出现在 getToolDefinitions() 列表中，
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
    // 不允许覆盖内置工具
    if (BUILTIN_TOOLS.some((t) => t.name === definition.name)) {
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
  }

  /**
   * 获取所有工具定义（内置 + 自定义）
   *
   * 用于构建 LLM 请求的 tools 参数，
   * 以及 AgentLoop 的 system prompt 工具描述。
   */
  getToolDefinitions(): ToolDefinition[] {
    return [...BUILTIN_TOOLS, ...[...this.customTools.values()].map((e) => e.definition)];
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
  async execute(name: string, argsJson: string, extensions?: WriteExtensions): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch (err) {
      throw toolError(
        '工具参数解析失败',
        `args JSON 无效：${(err as Error).message}`,
        ['检查 LLM 输出的工具调用格式', '确认 args 是合法 JSON'],
        err as Error,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }

    // 参数类型校验 + 自动修正
    // LLM 经常返回 number 代替 string（如 maxDepth: 2 而非 "2"），
    // 校验器根据 ToolDefinition 自动转换，避免后续 as string 出错
    const definition = this.getToolDefinitions().find((t) => t.name === name);
    if (definition) {
      args = this.validateAndCoerceArgs(name, args, definition);
    }

    const safeArgs = Object.fromEntries(
      Object.entries(args).map(([k, v]) => [
        k,
        typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...` : v,
      ]),
    );
    logger.info({ tool: name, args: safeArgs }, '执行工具');

    switch (name) {
      case 'read_file':
        return this.readFile(args['path'] as string);
      case 'write_file':
        return this.writeFile(
          args['path'] as string,
          args['content'] as string,
          extensions,
          (args['mode'] as string) ?? 'overwrite',
          args['insert_line'] as string | undefined,
        );
      case 'list_dir':
        return this.listDir(
          (args['path'] as string) ?? '.',
          (args['recursive'] as string) ?? 'false',
          (args['maxDepth'] as string) ?? '2',
        );
      case 'search_memories':
        return this.searchMemories(
          args['query'] as string,
          (args['limit'] as string) ?? '10',
          (args['mode'] as string) ?? 'match',
        );
      default: {
        // 自定义工具 fallback：查找 customTools Map
        const custom = this.customTools.get(name);
        if (custom) {
          // S-01: 传入 ToolContext，提供 guardPath 安全校验方法
          const ctx: ToolContext = {
            guardPath: (path: string) => {
              const absolutePath = this.resolveSafePath(path);
              this.guardPathOrThrow(absolutePath, name, 'custom');
            },
          };
          try {
            return await custom.handler(args, ctx);
          } catch (err) {
            // 统一包装为 MemoraError，保持错误处理一致性
            if (err instanceof MemoraError) throw err;
            throw toolError(
              '自定义工具执行失败',
              `${name}: ${(err as Error).message}`,
              ['检查工具参数是否正确', '检查工具 handler 实现是否有 bug'],
              err as Error,
              ToolErrorCode.CUSTOM_TOOL_FAILED,
            );
          }
        }
        throw toolError(
          '未知工具',
          `agent 调用了未注册的工具：${name}`,
          [
            `已注册工具：${this.getToolDefinitions()
              .map((t) => t.name)
              .join(', ')}`,
            '检查 personality.md 是否限制了工具集',
          ],
          undefined,
          ToolErrorCode.UNKNOWN_TOOL,
        );
      }
    }
  }

  /**
   * 读取文件（带路径白名单校验）
   */
  private async readFile(relativePath: string): Promise<ToolResult> {
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
      const content = await readFile(absolutePath, 'utf-8');
      // 读取文件时自动触发生成/更新作品投影（fire-and-forget，不阻塞读取）
      if (this.workProjection) {
        this.workProjection.ensureProjection(absolutePath, content, relativePath).catch(() => {
          /* 投影生成失败不影响文件读取 */
        });
      }
      return content;
    } catch (err) {
      throw toolError(
        '文件读取失败',
        `${absolutePath}：${(err as Error).message}`,
        ['确认文件存在', '确认当前进程有读取权限'],
        err as Error,
        ToolErrorCode.FILE_NOT_FOUND,
      );
    }
  }

  /**
   * 写入文件（路径白名单 + 写入二次确认 / diff 确认）
   *
   * 支持三种写入模式：
   *   - overwrite（默认）：全量覆盖文件内容
   *   - append：追加内容到文件末尾
   *   - insert：在指定行号前插入内容
   *
   * 安全策略：
   *   - 路径必须在白名单内
   *   - 如果提供了 WriteExtensions.onBeforeWrite：使用 diff 确认（替代安全确认）
   *   - 否则回退到 SecurityGuard.requestWriteConfirmation：
   *     - guest 模式：强制要求用户 y/N 确认
   *     - owner + confirmWrites=true：要求 y/N 确认
   *     - owner + confirmWrites=false：自动批准
   *   - 自动创建父目录（在白名单内）
   *
   * @param relativePath 相对项目根目录的文件路径
   * @param content 要写入的内容
   * @param extensions 写入扩展（可选，用于 diff 确认等）
   * @param mode 写入模式："overwrite" | "append" | "insert"，默认 "overwrite"
   * @param insertLine insert 模式下的目标行号（从 1 开始），省略则插入到末尾
   */
  private async writeFile(
    relativePath: string,
    content: string,
    extensions?: WriteExtensions,
    mode: string = 'overwrite',
    insertLine?: string,
  ): Promise<ToolResult> {
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
      const ok = await extensions.onBeforeWrite(relativePath, beforeContent, finalContent);
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
      const confirmed = await this.security.requestWriteConfirmation(
        absolutePath,
        'write_file',
        description,
      );
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
    await mkdir(parentDir, { recursive: true });

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
      throw toolError(
        '文件写入失败',
        `${absolutePath}：${(err as Error).message}`,
        ['确认父目录可写', '确认磁盘空间充足'],
        err as Error,
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
   *   - 自动忽略：.git / node_modules / .memora / dist / coverage
   */
  private async listDir(
    relativePath: string,
    recursiveStr: string,
    maxDepthStr: string,
  ): Promise<ToolResult> {
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

    try {
      const stats = await stat(absolutePath);
      if (!stats.isDirectory()) {
        throw toolError(
          'list_dir 路径不是目录',
          `${absolutePath} 是文件，不是目录`,
          ['path 参数必须指向目录'],
          undefined,
          ToolErrorCode.DIR_NOT_FOUND,
        );
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw toolError(
          'list_dir 路径不存在',
          `${absolutePath}：目录不存在`,
          ['确认路径存在', '使用 list_dir(".") 列出项目根'],
          err as Error,
          ToolErrorCode.DIR_NOT_FOUND,
        );
      }
      throw err;
    }

    const entries: string[] = [];
    await this.walkDir(absolutePath, absolutePath, entries, 0, maxDepth, recursive);

    if (entries.length === 0) {
      return `（目录为空或所有条目都被忽略）${absolutePath}`;
    }
    return `目录 ${absolutePath} 共有 ${entries.length} 个条目：\n${entries.map((e) => `  ${e}`).join('\n')}`;
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
        out.push(`❓ ${childRel}（无法访问：${(err as Error).message}）`);
      }
    }
  }

  /** list_dir 默认忽略的目录/文件名 */
  static readonly IGNORED_DIR_NAMES = [
    '.git',
    'node_modules',
    '.memora',
    'dist',
    'coverage',
    '.next',
  ];

  /**
   * 判断目录/文件名是否应被忽略
   */
  private shouldIgnore(name: string): boolean {
    return ToolExecutor.IGNORED_DIR_NAMES.includes(name);
  }

  /**
   * 在记忆索引中搜索
   *
   * @param query 搜索关键词
   * @param limitStr 返回数量上限
   * @param modeStr 搜索模式："match"（任一命中，默认）或 "near"（全部命中）
   */
  private async searchMemories(
    query: string,
    limitStr: string,
    modeStr: string,
  ): Promise<ToolResult> {
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
      const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
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
      const preview = m.content.length > 80 ? `${m.content.slice(0, 80)}…` : m.content;
      return `${i + 1}. [${m.source}:${m.name}] (score=${m.score})\n   ${preview.replace(/\n/g, ' ')}`;
    });
    return `搜索 "${query}" 找到 ${results.length} 条（${mode} 模式）：\n${lines.join('\n')}`;
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

  /**
   * 解析相对路径为绝对路径
   *
   * 绝对路径直接使用（安全校验由下游 guardPathOrThrow → SecurityGuard.assertPathAllowed 完成）；
   * 相对路径基于 projectPath 解析。防御纵深：resolveSafePath 只负责路径解析，
   * 白名单拦截由 assertPathAllowed 独立执行。
   */
  private resolveSafePath(relativePath: string): string {
    return isAbsolute(relativePath) ? relativePath : resolve(this.projectPath, relativePath);
  }

  /**
   * 路径白名单校验（捕获后包装为 toolError）
   * @param source S-02: 调用链来源标记
   */
  private guardPathOrThrow(
    absolutePath: string,
    tool: string,
    source: 'builtin' | 'custom' | 'system' = 'builtin',
  ): void {
    try {
      this.security.assertPathAllowed(absolutePath, tool, source);
    } catch (err) {
      throw toolError(
        '路径不在白名单内',
        (err as Error).message,
        [
          '确认路径在白名单内（项目目录/数据目录/显式 allowedPaths）',
          '查看审计日志：~/.memora/logs/memora.log',
        ],
        err as Error,
        ToolErrorCode.PATH_NOT_ALLOWED,
      );
    }
  }
}
