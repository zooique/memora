/**
 * 工具执行器
 *
 * 阶段一：1 个工具（read_file）
 * 阶段二：白名单 + 5 个工具
 * 详见 ADR-006 · 安全采用两级权限 + 工具白名单 + 路径白名单
 */
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import type { SecurityGuard } from '../security/path-guard.js';
import { toolError } from '../utils/errors.js';
import { logger } from '../logging/logger.js';

export type ToolResult = string;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * 工具注册表
 * 阶段一：最小集（1 个工具）
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
];

/**
 * 工具执行器
 */
export class ToolExecutor {
  constructor(
    private readonly projectPath: string,
    private readonly security: SecurityGuard,
  ) {}

  /**
   * 执行工具调用
   * @returns 工具结果的字符串描述
   */
  async execute(name: string, argsJson: string): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch (err) {
      throw toolError(
        '工具参数解析失败',
        `args JSON 无效：${(err as Error).message}`,
        ['检查 LLM 输出的工具调用格式', '确认 args 是合法 JSON'],
        err as Error,
      );
    }

    logger.info({ tool: name, args }, '执行工具');

    switch (name) {
      case 'read_file':
        return this.readFile(args['path'] as string);
      default:
        throw toolError('未知工具', `agent 调用了未注册的工具：${name}`, [
          `已注册工具：${BUILTIN_TOOLS.map((t) => t.name).join(', ')}`,
          '检查 personality.md 是否限制了工具集',
        ]);
    }
  }

  /**
   * 读取文件（带路径白名单校验）
   */
  private async readFile(relativePath: string): Promise<ToolResult> {
    if (!relativePath) {
      throw toolError('read_file 工具调用缺少 path 参数', 'LLM 未传 path', [
        '检查 personality.md 是否明确了 read_file 用法',
        '检查 LLM 输出',
      ]);
    }

    // 解析为绝对路径
    const absolutePath = isAbsolute(relativePath)
      ? relativePath
      : resolve(this.projectPath, relativePath);

    // 安全校验 + 审计日志（M-105）
    // assertPathAllowed 已经抛 MemoraError，类型分类为 tool——直接 catch 后包装
    try {
      this.security.assertPathAllowed(absolutePath, 'read_file');
    } catch (err) {
      throw toolError(
        '路径不在白名单内',
        (err as Error).message,
        [
          '确认路径在白名单内（项目目录/数据目录/显式 allowedPaths）',
          '查看审计日志：~/.memora/logs/memora.log',
        ],
        err as Error,
      );
    }

    try {
      return await readFile(absolutePath, 'utf-8');
    } catch (err) {
      throw toolError(
        '文件读取失败',
        `${absolutePath}：${(err as Error).message}`,
        ['确认文件存在', '确认当前进程有读取权限'],
        err as Error,
      );
    }
  }
}
