/**
 * 工具执行器
 *
 * 阶段一：1 个工具（read_file）
 * 阶段二（M-204）：扩展为 4 个工具（read_file / write_file / list_dir / search_memories）
 * 详见 ADR-006 · 安全采用两级权限 + 工具白名单 + 路径白名单
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, isAbsolute, join, relative, dirname, basename } from 'node:path';
import type { SecurityGuard } from '@/security/path-guard.js';
import { toolError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import type { MemoryIndex } from '@/memory/index.js';

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
 * 阶段二（M-204）：4 个工具
 * - read_file：读取文件
 * - write_file：写入/创建文件（受写入二次确认保护）
 * - list_dir：列出目录内容
 * - search_memories：在记忆索引中搜索关键词
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
  {
    name: 'write_file',
    description:
      '写入或创建文件。owner 模式默认自动批准；guest 模式会要求用户确认。受路径白名单保护。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的文件路径' },
        content: { type: 'string', description: '要写入的完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description:
      '列出目录内容。默认相对项目根目录。受路径白名单保护。递归深度 ≤ 3，自动忽略 .git / node_modules。',
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
      '在记忆索引中搜索关键词。支持 match（任一命中，默认）和 near（全部命中）两种模式。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'string', description: '返回结果数量上限，默认 "10"' },
        mode: { type: 'string', description: '"match"（默认，任一）或 "near"（必须全部）' },
      },
      required: ['query'],
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
    private readonly memoryIndex: MemoryIndex,
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
      case 'write_file':
        return this.writeFile(args['path'] as string, args['content'] as string);
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

    const absolutePath = this.resolveSafePath(relativePath);
    this.guardPathOrThrow(absolutePath, 'read_file');

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

  /**
   * 写入文件（路径白名单 + 写入二次确认）
   *
   * 安全策略：
   *   - 路径必须在白名单内
   *   - guest 模式：强制要求用户 y/N 确认
   *   - owner + confirmWrites=true：要求 y/N 确认
   *   - owner + confirmWrites=false：自动批准
   *   - 自动创建父目录（在白名单内）
   */
  private async writeFile(relativePath: string, content: string): Promise<ToolResult> {
    if (!relativePath) {
      throw toolError('write_file 工具调用缺少 path 参数', 'LLM 未传 path', [
        '检查 personality.md 是否明确了 write_file 用法',
      ]);
    }
    if (typeof content !== 'string') {
      throw toolError('write_file 工具调用缺少 content 参数', 'LLM 未传 content', [
        '确认 content 是字符串',
      ]);
    }

    const absolutePath = this.resolveSafePath(relativePath);
    this.guardPathOrThrow(absolutePath, 'write_file');

    // 写入二次确认
    const description = `写入 ${content.length} 字符到 ${basename(absolutePath)}`;
    const confirmed = await this.security.requestWriteConfirmation(
      absolutePath,
      'write_file',
      description,
    );
    if (!confirmed) {
      throw toolError('用户拒绝写入', `用户取消了 write_file 操作：${absolutePath}`, [
        '如需写入，请重新发起请求并确认',
      ]);
    }

    // 自动创建父目录（mkdir recursive）
    const parentDir = dirname(absolutePath);
    await mkdir(parentDir, { recursive: true });

    try {
      await writeFile(absolutePath, content, 'utf-8');
      return `✅ 已写入：${absolutePath}（${content.length} 字符）`;
    } catch (err) {
      throw toolError(
        '文件写入失败',
        `${absolutePath}：${(err as Error).message}`,
        ['确认父目录可写', '确认磁盘空间充足'],
        err as Error,
      );
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
        throw toolError('list_dir 路径不是目录', `${absolutePath} 是文件，不是目录`, [
          'path 参数必须指向目录',
        ]);
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw toolError(
          'list_dir 路径不存在',
          `${absolutePath}：目录不存在`,
          ['确认路径存在', '使用 list_dir(".") 列出项目根'],
          err as Error,
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
    } catch {
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

  /**
   * 判断目录/文件名是否应被忽略
   */
  private shouldIgnore(name: string): boolean {
    const ignored = ['.git', 'node_modules', '.memora', 'dist', 'coverage', '.next'];
    return ignored.includes(name);
  }

  /**
   * 在记忆索引中搜索
   */
  private async searchMemories(
    query: string,
    limitStr: string,
    modeStr: string,
  ): Promise<ToolResult> {
    if (!query) {
      throw toolError('search_memories 工具调用缺少 query 参数', 'LLM 未传 query', [
        'query 不能为空',
      ]);
    }

    let limit = Number.parseInt(limitStr, 10);
    if (Number.isNaN(limit) || limit < 1) {
      limit = 10;
    }
    if (limit > 50) {
      limit = 50;
    }

    const mode: 'match' | 'near' = modeStr === 'near' ? 'near' : 'match';

    const results = await this.memoryIndex.search(query, limit, mode);
    if (results.length === 0) {
      return `（未找到匹配 "${query}" 的记忆）`;
    }

    const lines = results.map((m, i) => {
      const preview = m.content.length > 80 ? `${m.content.slice(0, 80)}…` : m.content;
      return `${i + 1}. [${m.type}:${m.name}] (weight=${m.weight})\n   ${preview.replace(/\n/g, ' ')}`;
    });
    return `搜索 "${query}"（${mode} 模式）找到 ${results.length} 条：\n${lines.join('\n')}`;
  }

  /**
   * 解析相对路径为绝对路径（最终白名单校验由 assertPathAllowed 完成）
   */
  private resolveSafePath(relativePath: string): string {
    return isAbsolute(relativePath) ? relativePath : resolve(this.projectPath, relativePath);
  }

  /**
   * 路径白名单校验（捕获后包装为 toolError）
   */
  private guardPathOrThrow(absolutePath: string, tool: string): void {
    try {
      this.security.assertPathAllowed(absolutePath, tool);
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
  }
}
