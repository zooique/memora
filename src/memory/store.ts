/**
 * 记忆文件存储
 *
 * 冷热分离中的"热"：文件承载记忆本体
 * 详见 ADR-002 · IMemoryStorage 接口与宿主注入模式
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { SOURCE_LABELS, inferSource, type Memory } from '@/memory/types.js';
import { parseFrontmatter, serializeFrontmatter as serializeFm } from '@/utils/frontmatter.js';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/toError.js';

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

/** 无 frontmatter 或 score 缺失时的默认 score */
const DEFAULT_MEMORY_SCORE = 0.5;

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
    // 异步读取：文件不存在时 readFile 抛 ENOENT，捕获后返回 null（避免 existsSync 的 TOCTOU 竞态）
    let content: string;
    let fileStat: { mtime: Date };
    try {
      content = await readFile(filePath, 'utf-8');
      fileStat = await stat(filePath);
    } catch (err) {
      // ENOENT 属正常情况（文件不存在），静默返回 null；其他错误（EACCES/EISDIR 等）记录警告
      const error = toError(err) as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        logger.warn({ path: filePath, code: error.code, err: error.message }, '记忆文件读取失败');
      }
      return null;
    }

    // 从文件路径推断 source（frontmatter 可覆盖）
    return this.parseMemory(source, name, content, filePath, fileStat.mtime);
  }

  /**
   * 写入记忆文件
   */
  async write(memory: Memory): Promise<void> {
    const filePath = this.getFilePath(memory.source, memory.name);
    await mkdir(dirname(filePath), { recursive: true });

    const frontmatter = serializeFm({
      id: memory.id,
      source: memory.source,
      score: String(memory.score),
      createdAt: memory.createdAt,
      accessedAt: memory.accessedAt,
    });
    const content = `---\n${frontmatter}\n---\n\n${memory.content}`;
    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * 列出某个 source 下的所有记忆
   *
   * @param source - 来源标签（如 'rule'、'persona'）
   * @returns 记忆名称列表（不含扩展名）
   */
  async list(source: string): Promise<string[]> {
    const dir = join(this.dataDir, this.sourceToDir(source));
    // 异步读取：目录不存在时 readdir 抛 ENOENT，捕获后返回空数组（避免 existsSync 的 TOCTOU 竞态）
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      // ENOENT 属正常情况（目录不存在），静默返回空数组；其他错误（EACCES/EISDIR 等）记录警告
      const error = toError(err) as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        logger.warn({ dir, code: error.code, err: error.message }, '记忆目录读取失败');
      }
      return [];
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
   * 已知 source 使用预定义目录，未知 source 直接用 source 字符串作目录名
   */
  private sourceToDir(source: string): string {
    return SOURCE_TO_DIR[source] ?? source;
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
    // 修复 #34：校验 score，防止 NaN/越界值违反 zod schema（min(0).max(1)）
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
