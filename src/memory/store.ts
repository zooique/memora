/**
 * 记忆文件存储
 *
 * 冷热分离中的"热"：文件承载记忆本体
 * 详见 ADR-002 · IMemoryStorage 接口与宿主注入模式
 */
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { SOURCE_LABELS, DEFAULT_MEMORY_SCORE, type Memory } from '@/memory/types.js';
import { inferSource, validateSource } from '@/memory/sourceValidation.js';
import { atomicWriteFile } from '@/utils/atomicWrite.js';
import { parseFrontmatter, serializeFrontmatter as serializeFm } from '@/utils/frontmatter.js';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/toError.js';
import { configError } from '@/utils/errors.js';

/**
 * 已知 source 到文件系统目录的映射
 *
 * 仅覆盖配置类记忆（启动时扫描的 persona/rule/skill）；
 * 运行时产生的记忆（insight/profile/work-projection）不由 FileStore 管理
 */
const SOURCE_TO_DIR: Record<string, string> = {
  [SOURCE_LABELS.PERSONA]: 'personas',
  [SOURCE_LABELS.RULE]: 'rules',
  [SOURCE_LABELS.SKILL]: 'skills',
};

/**
 * 文件存储类
 *
 * 每个 source 对应一个子目录（personas/rules/skills/…）
 * 读取时通过 inferSource() 从文件路径推断 source
 */
export class FileStore {
  constructor(private readonly dataDir: string) {}

  /**
   * 读取记忆文件
   *
   * @param source - 来源标签（如 'rule'、'persona'）
   * @param name - 记忆名（不含扩展名）
   */
  async read(source: string, name: string): Promise<Memory | null> {
    const filePath = this.getFilePath(source, name);
    // 异步读取：文件不存在时 readFile 抛 ENOENT，handleFsError 对 ENOENT 静默返回（read 返回 null）
    // 其他错误（EACCES/EISDIR 等）由 handleFsError 重新抛出，让调用方感知故障
    let content: string;
    let fileStat: { mtime: Date };
    try {
      content = await readFile(filePath, 'utf-8');
      fileStat = await stat(filePath);
    } catch (err) {
      this.handleFsError(err, filePath, '记忆文件读取失败');
      return null; // 仅 ENOENT 到达此处（其他错误已在 handleFsError 抛出）
    }

    // 从文件路径推断 source（frontmatter 可覆盖）
    return this.parseMemory(source, name, content, filePath, fileStat.mtime);
  }

  /**
   * 写入记忆文件
   *
   * frontmatter 包含标准字段（id/source/score/createdAt/accessedAt）
   * 和 memory.metadata 中的额外元数据（如 keywords/description）。
   */
  async write(memory: Memory): Promise<void> {
    const filePath = this.getFilePath(memory.source, memory.name);
    await mkdir(dirname(filePath), { recursive: true });

    // 标准字段必须优先于 metadata：metadata 中可能含同名键（如恶意的 source='evil'），
    // 若后展开则劫持 source 语义绕过 sourceValidation。先展开 metadata，再显式覆盖标准字段；
    // 并过滤掉与标准字段同名的 metadata 键，避免写入重复行（如 source: evil\n source: normal）。
    const STANDARD_KEYS = new Set(['id', 'source', 'score', 'createdAt', 'accessedAt']);
    const safeMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(memory.metadata ?? {})) {
      if (!STANDARD_KEYS.has(k)) safeMeta[k] = v;
    }
    const frontmatter = serializeFm({
      ...safeMeta,
      id: memory.id,
      source: memory.source,
      score: String(memory.score),
      createdAt: memory.createdAt,
      accessedAt: memory.accessedAt,
    });
    const content = `---\n${frontmatter}\n---\n\n${memory.content}`;
    // 原子写：设定记忆的文件本身即唯一真理源（SQLite 仅为派生索引），
    // 写入中途崩溃产生的半截文件无处可重建。
    await atomicWriteFile(filePath, content);
  }

  /**
   * 列出某个 source 下的所有记忆
   *
   * @param source - 来源标签（如 'rule'、'persona'）
   * @returns 记忆名称列表（不含扩展名）
   */
  async list(source: string): Promise<string[]> {
    const dir = join(this.dataDir, this.sourceToDir(source));
    // 异步读取：目录不存在时 readdir 抛 ENOENT，handleFsError 对 ENOENT 静默返回（list 返回 []）
    // 其他错误由 handleFsError 重新抛出，让调用方感知故障
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      this.handleFsError(err, dir, '记忆目录读取失败');
      return []; // 仅 ENOENT 到达此处（其他错误已在 handleFsError 抛出）
    }
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  }

  /**
   * 获取文件路径
   */
  private getFilePath(source: string, name: string): string {
    return join(this.dataDir, this.sourceToDir(source), `${name}.md`);
  }

  /**
   * source 到目录名的映射
   *
   * 已知 source 使用预定义目录，未知 source 直接用 source 字符串作目录名。
   * 安全校验：调用 validateSource 拒绝路径遍历（`..`）、null 字节等危险字符，
   * 防止未知 source 被构造为恶意路径绕过 SOURCE_TO_DIR 白名单。
   */
  private sourceToDir(source: string): string {
    const result = validateSource(source);
    if (result.severity === 'block') {
      // 路径遍历 / null 字节 / 空字符串等安全边界违规，必须拒绝
      throw configError(
        'source 校验失败，拒绝映射到目录',
        result.warning,
        ['检查 source 字段是否包含路径遍历序列或特殊字符'],
      );
    }
    return SOURCE_TO_DIR[source] ?? source;
  }

  /**
   * 文件系统错误统一处理
   *
   * 区分两类错误：
   *   - ENOENT（文件/目录不存在）：正常情况，静默返回
   *   - 其他错误（EACCES/EISDIR 等）：真实故障，抛出异常让调用方感知
   *
   * 之前所有错误统一返回 null/[]，导致磁盘故障伪装成"无数据"，
   * 用户感知不到数据丢失。现区分：ENOENT 静默，其他抛错。
   *
   * @param err 捕获的异常
   * @param path 文件/目录路径（用于日志上下文）
   * @param label 日志标签（中文，如 "记忆文件读取失败"）
   * @throws {NodeJS.ErrnoException} 非 ENOENT 错误时重新抛出
   */
  private handleFsError(err: unknown, path: string, label: string): void {
    const error = toError(err) as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      // 文件/目录不存在是正常情况（首次启动、新项目等），静默返回
      return;
    }
    // 非 ENOENT 错误：记录警告并重新抛出，让调用方区分"无数据"与"故障"
    logger.warn({ path, code: error.code, err: error.message }, label);
    throw error;
  }

  /**
   * 解析记忆文件为 Memory 对象
   *
   * @param source - 来源标签
   * @param name - 记忆名
   * @param raw - 文件原始内容
   * @param filePath - 文件路径（用于 inferSource 回退）
   * @param mtime - 文件修改时间
   */
  private parseMemory(
    source: string,
    name: string,
    raw: string,
    filePath: string,
    mtime: Date,
  ): Memory {
    const { frontmatter: meta, body } = parseFrontmatter(raw);

    // 从 frontmatter 读取 source（如有显式声明则覆盖）
    const resolvedSource = meta['source'] ?? inferSource(filePath, source);

    // 无 frontmatter 时，使用默认值
    if (Object.keys(meta).length === 0) {
      const now = mtime.toISOString();
      return {
        id: `${resolvedSource}:${name}`,
        content: raw,
        source: resolvedSource,
        name,
        createdAt: now,
        accessedAt: now,
        score: DEFAULT_MEMORY_SCORE,
      };
    }

    const now = mtime.toISOString();
    // 修复 #34：校验 score，防止 NaN/越界值违反校验规则（min(0).max(1)）
    // frontmatter 中 score 字段若为非数字字符串（如 "abc"），Number 返回 NaN 会破坏后续写入
    const rawScore = Number(meta['score'] ?? DEFAULT_MEMORY_SCORE);
    const score =
      Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 1
        ? rawScore
        : DEFAULT_MEMORY_SCORE;
    return {
      id: meta['id'] ?? `${resolvedSource}:${name}`,
      content: body.trim(),
      source: resolvedSource,
      name,
      createdAt: meta['createdAt'] ?? now,
      accessedAt: meta['accessedAt'] ?? now,
      score,
    };
  }
}
