/**
 * 记忆文件存储
 *
 * 冷热分离中的"热"：文件承载记忆本体
 * 详见 ADR-002 · 选用 better-sqlite3 作为存储层
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Memory, MemoryTypeValue } from './types.js';
import { TYPE_TO_DIR_MAP } from './types.js';
import { parseFrontmatter, serializeFrontmatter as serializeFm } from './frontmatter.js';

/**
 * 文件存储类
 * 每个记忆类型对应一个子目录
 */
export class FileStore {
  constructor(private readonly dataDir: string) {}

  /**
   * 读取记忆文件
   * @param type 记忆类型
   * @param name 记忆名（不含扩展名）
   */
  async read(type: MemoryTypeValue, name: string): Promise<Memory | null> {
    const filePath = this.getFilePath(type, name);
    if (!existsSync(filePath)) return null;

    const content = await readFile(filePath, 'utf-8');
    const stat_ = await stat(filePath);

    // 解析 frontmatter
    return this.parseMemory(type, name, content, filePath, stat_.mtime);
  }

  /**
   * 写入记忆文件
   */
  async write(memory: Memory): Promise<void> {
    const filePath = this.getFilePath(memory.type, memory.name);
    await mkdir(dirname(filePath), { recursive: true });

    const frontmatter = serializeFm({
      id: memory.id,
      type: memory.type,
      permanence: memory.permanence,
      tags: memory.tags.join(', '),
      weight: String(memory.weight),
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });
    const content = `---\n${frontmatter}\n---\n\n${memory.content}`;
    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * 列出某类型下的所有记忆
   */
  async list(type: MemoryTypeValue): Promise<string[]> {
    const dir = join(this.dataDir, this.typeToDir(type));
    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  }

  /**
   * 获取文件路径
   */
  private getFilePath(type: MemoryTypeValue, name: string): string {
    return join(this.dataDir, this.typeToDir(type), `${name}.md`);
  }

  /**
   * 类型到目录的映射（复用 types.ts 集中定义）
   */
  private typeToDir(type: MemoryTypeValue): string {
    return TYPE_TO_DIR_MAP[type];
  }

  /**
   * 解析记忆的 frontmatter
   */
  private parseMemory(
    type: MemoryTypeValue,
    name: string,
    raw: string,
    filePath: string,
    mtime: Date,
  ): Memory {
    const { frontmatter: meta, body } = parseFrontmatter(raw);

    // 无 frontmatter 时，使用默认值
    if (Object.keys(meta).length === 0) {
      return {
        id: `${type}:${name}`,
        type,
        permanence: 'topic',
        name,
        content: raw,
        tags: [],
        weight: 0.5,
        createdAt: mtime.toISOString(),
        updatedAt: mtime.toISOString(),
        filePath,
      };
    }

    return {
      id: `${type}:${name}`,
      type,
      permanence: (meta['permanence'] as Memory['permanence']) ?? 'topic',
      name,
      content: body.trim(),
      tags: meta['tags']?.split(',').map((s) => s.trim()) ?? [],
      weight: Number(meta['weight'] ?? '0.5'),
      createdAt: meta['createdAt'] ?? mtime.toISOString(),
      updatedAt: meta['updatedAt'] ?? mtime.toISOString(),
      filePath,
    };
  }
}
