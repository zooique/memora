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
import { toolError, MemoraError, ToolErrorCode, toError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import { segmentLower } from '@/utils/segmenter.js';
import { truncate } from '@/utils/strings.js';
import { parseFrontmatter } from '@/utils/frontmatter.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
// 使用 import type 避免运行时循环依赖：WriteExtensions 类型定义在 toolExecutor.ts
import type { WriteExtensions } from '@/agent/toolExecutor.js';

/** 工具结果类型（字符串，LLM 直接消费） */
type ToolResult = string;

/**
 * 检测写入内容是否为配置文件（persona/skill/rule）
 *
 * 解析 frontmatter 中的 source 字段，若匹配 persona/skill/rule 则返回对应的工具名后缀。
 * 这是内容特征检测——路径拦截易被绕过，但 frontmatter 中的 source 字段
 * 是 FileStore.write 写入的结构特征，LLM 无法绕过。
 *
 * @param content 写入内容（可能含 frontmatter）
 * @returns 匹配的 source 标签（'persona' | 'skill' | 'rule'），未匹配返回 null
 */
function checkForConfigSource(content: string): 'persona' | 'skill' | 'rule' | null {
  const { frontmatter } = parseFrontmatter(content);
  const source = frontmatter.source;
  if (source && BuiltinToolHandlers.CONFIG_SOURCES.has(source)) {
    return source as 'persona' | 'skill' | 'rule';
  }
  return null;
}

/**
 * 内置工具处理器
 *
 * 管理 4 个内置工具的实际实现 + 路径安全校验。
 * 从 ToolExecutor 提取，保持无状态设计（不持有 customTools 注册表）。
 */
export class BuiltinToolHandlers {
  /** list_dir 默认忽略的目录/文件名 */
  static readonly IGNORED_DIR_NAMES: readonly string[] = [
    '.git',
    'node_modules',
    '.memora',
    'dist',
    'coverage',
    '.next',
  ];

  /**
   * 配置文件目录名集合——这些目录的内容应通过专用工具创建
   *
   * personas/skills/rules 是 SOURCE_LABELS 的映射目录（store.ts SOURCE_TO_DIR），
   * 通过 create_persona/create_skill/create_rule 工具创建会正确写入 configDir 并触发热重载。
   * write_file 写入 projectPath/personas/ 只会创建"孤儿文件"——不在配置目录中，不会被加载。
   */
  /** 配置目录名（路径拦截用，第一级目录匹配） */
  static readonly CONFIG_DIRS: ReadonlySet<string> = new Set(['personas', 'skills', 'rules']);

  /**
   * 配置文件 source 标签（内容特征检测用，frontmatter 中 source 字段值）
   *
   * 路径拦截易被绕过（去掉 personas/ 前缀即可），但配置文件 frontmatter 中必然包含
   * source: persona/skill/rule —— 这是 FileStore.write 写入的结构特征，LLM 无法绕过。
   */
  static readonly CONFIG_SOURCES: ReadonlySet<string> = new Set(['persona', 'skill', 'rule']);

  /**
   * @param projectPath 项目根路径（用于相对路径解析）
   * @param security 安全守卫（路径白名单 + 写入确认）
   * @param memoryIndex 记忆索引（用于 search_memories 工具）
   * @param workProjection 作品投影管理器（可选，读取文件时自动生成投影）
   * @param configDir 配置目录路径（可选，拦截提示中告知 LLM 正确的写入位置）
   */
  constructor(
    private readonly projectPath: string,
    private readonly security: SecurityGuard,
    private readonly memoryIndex: IMemoryStorage,
    private readonly workProjection?: WorkProjectionManager,
    private readonly configDir?: string,
  ) {}

  /**
   * 生成配置目录路径提示
   *
   * 当 configDir 已知时，告知 LLM 正确写入位置（如 C:\Users\SJ\.memora-sprite\config\personas\）；
   * 未知时回退到通用描述。用于拦截错误消息中，引导 LLM 使用专用工具而非 write_file。
   */
  private configPathHint(toolSuffix: string): string {
    if (this.configDir) {
      // 计算目标子目录：persona → personas, skill → skills, rule → rules
      const subDir = `${toolSuffix}s`;
      return `${this.configDir}/${subDir}/`;
    }
    return '配置目录';
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
  async readFile(relativePath: string): Promise<ToolResult> {
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
        this.workProjection.ensureProjection(absolutePath, content, relativePath).catch((err) => {
          logger.warn({ err, path: absolutePath }, '作品投影生成失败');
        });
      }
      return content;
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

    // 配置目录拦截：personas/skills/rules 目录的内容应通过专用工具创建
    // 防止 LLM 误用 write_file 创建"孤儿文件"——写入 projectPath/personas/ 而非 configDir/personas/
    // 检查相对路径的第一级目录（去除前导 ./ / \），不区分大小写
    const firstSegment = relativePath
      .replace(/^[/\\]+/, '')
      .replace(/^\.\//, '')
      .split(/[/\\]/)[0]
      ?.toLowerCase();
    if (firstSegment && BuiltinToolHandlers.CONFIG_DIRS.has(firstSegment)) {
      // personas → persona, skills → skill, rules → rule（去尾 s 得到工具名后缀）
      const toolSuffix = firstSegment.replace(/s$/, '');
      return `错误：${firstSegment}/ 目录下的文件请使用 create_${toolSuffix} 工具创建，不要使用 write_file。create_${toolSuffix} 会正确写入 ${this.configPathHint(toolSuffix)} 并触发热重载。`;
    }

    // 内容特征检测：检查写入内容是否包含配置文件 frontmatter（source: persona/skill/rule）
    // 路径拦截易被绕过（去掉 personas/ 前缀即可），但配置文件 frontmatter 中 source 字段
    // 是 FileStore.write 写入的结构特征，LLM 无法绕过。
    const configSource = checkForConfigSource(content);
    if (configSource) {
      return `错误：写入内容包含 ${configSource} 配置文件的 frontmatter 标记（source: ${configSource}），请使用 create_${configSource} 工具创建，不要使用 write_file。create_${configSource} 会正确写入 ${this.configPathHint(configSource)} 并触发热重载。`;
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
  async listDir(
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
  async searchMemories(
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
}
