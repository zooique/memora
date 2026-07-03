/**
 * 工具执行器
 *
 * 阶段一：1 个工具（read_file）
 * 阶段二（M-204）：扩展为 4 个工具（read_file / write_file / list_dir / search_memories）
 * 详见 ADR-006 · 安全采用两级权限 + 工具白名单 + 路径白名单
 *
 * QC-R2-10 拆分：内置工具实现 + 路径安全已提取到 BuiltinToolHandlers，
 * ToolExecutor 聚焦工具注册 / 分发 / 参数校验。
 */
import type { SecurityGuard } from '@/security/pathGuard.js';
import { toolError, configError, MemoraError, ToolErrorCode, toError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import { BUILTIN_TOOLS, type ToolDefinition } from '@/agent/builtinTools.js';
import { BuiltinToolHandlers } from '@/agent/builtinToolHandlers.js';
export { BUILTIN_TOOLS } from '@/agent/builtinTools.js';
export type { ToolDefinition } from '@/agent/builtinTools.js';

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
 *
 * 职责：工具注册 + 分发 + 参数校验。
 * 内置工具实现委托给 BuiltinToolHandlers（QC-R2-10）。
 */
export class ToolExecutor {
  /** 自定义工具注册表（宿主项目通过 registerTool 注册领域工具） */
  private readonly customTools = new Map<string, CustomToolEntry>();
  /** 内置工具处理器（路径安全 + 内置工具实现，QC-R2-10 提取） */
  private readonly builtinHandlers: BuiltinToolHandlers;

  constructor(
    projectPath: string,
    security: SecurityGuard,
    memoryIndex: IMemoryStorage,
    /** 作品投影管理器（可选，读取文件时自动生成投影） */
    workProjection?: WorkProjectionManager,
  ) {
    // QC-R2-10：内置工具实现 + 路径安全委托给 BuiltinToolHandlers
    // 构造参数仅用于初始化 BuiltinToolHandlers，ToolExecutor 自身不再持有这些引用
    this.builtinHandlers = new BuiltinToolHandlers(
      projectPath,
      security,
      memoryIndex,
      workProjection,
    );
  }

  /**
   * 注册自定义工具
   *
   * 宿主项目调用此方法注册领域专属工具（如 create_chapter、run_tests 等业务专属操作）。
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
   * 获取所有工具定义（IX-02：统一为 getter 风格，与 persona/skill 一致）
   */
  get list(): ToolDefinition[] {
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
      Object.entries(args).map(([k, v]) => [
        k,
        typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...` : v,
      ]),
    );
    logger.info({ tool: name, args: safeArgs }, '执行工具');

    // 运行时类型安全：从 args 中提取字符串参数，避免不安全的 as string 断言
    const strArg = (key: string, fallback?: string): string => {
      const val = args[key];
      return typeof val === 'string' ? val : (fallback ?? '');
    };

    // QC-R2-10：内置工具调用委托给 BuiltinToolHandlers
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
      default: {
        // 自定义工具 fallback：查找 customTools Map
        const custom = this.customTools.get(name);
        if (custom) {
          // S-01: 传入 ToolContext，提供 guardPath 安全校验方法
          // QC-R2-10: 路径安全委托给 BuiltinToolHandlers
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
            `已注册工具：${this.list
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
