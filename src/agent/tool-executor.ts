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
    const args = JSON.parse(argsJson) as Record<string, unknown>;

    logger.info({ tool: name, args }, '执行工具');

    switch (name) {
      case 'read_file':
        return this.readFile(args['path'] as string);
      default:
        throw new Error(`未知工具: ${name}`);
    }
  }

  /**
   * 读取文件（带路径白名单校验）
   */
  private async readFile(relativePath: string): Promise<ToolResult> {
    if (!relativePath) {
      throw new Error('path 参数必填');
    }

    // 解析为绝对路径
    const absolutePath = isAbsolute(relativePath)
      ? relativePath
      : resolve(this.projectPath, relativePath);

    // 安全校验
    this.security.assertPathAllowed(absolutePath);

    const content = await readFile(absolutePath, 'utf-8');
    return content;
  }
}
