/**
 * 话题存储
 *
 * 话题文件结构：<日期>-<话题名>.md
 * 内容：frontmatter + 消息列表（按时间顺序）
 *
 * 详见 02-上下文组装-v4.0.md §6 话题文件
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 */
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { TopicFile, TopicMessage, ArchiveMetadata } from './types.js';
import { parseFrontmatter, serializeFrontmatter as serializeFm } from './frontmatter.js';
import { logger } from '@/logging/logger.js';

/**
 * 话题存储类
 * 负责所有话题文件的 CRUD
 */
export class TopicStore {
  constructor(private readonly dataDir: string) {}

  /**
   * 获取话题文件路径
   * @param date YYYY-MM-DD
   * @param topic 话题名（不含扩展名）
   */
  getFilePath(date: string, topic: string): string {
    return join(this.dataDir, 'topics', `${date}-${topic}.md`);
  }

  /**
   * 读取话题文件
   * 不存在则返回 null
   */
  async read(date: string, topic: string): Promise<TopicFile | null> {
    const filePath = this.getFilePath(date, topic);
    if (!existsSync(filePath)) return null;

    const content = await readFile(filePath, 'utf-8');
    return this.parseTopicFile(date, topic, content);
  }

  /**
   * 写入话题文件（覆盖）
   */
  async write(topic: TopicFile): Promise<void> {
    const filePath = this.getFilePath(topic.date, topic.topic);
    await mkdir(dirname(filePath), { recursive: true });

    const frontmatter = this.serializeFrontmatter(topic);
    const body = topic.messages.map((m) => this.formatMessage(m)).join('\n\n');
    const content = `---\n${frontmatter}\n---\n\n# ${topic.date} (${topic.topic})\n\n${body}\n`;

    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * 重命名话题文件
   *
   * 用于归档时 LLM 自动生成话题标题后，将 `2026-06-11-main.md`
   * 重命名为 `2026-06-11-角色设定讨论.md`。
   *
   * 不覆盖目标：如果目标文件已存在，在原文件名后追加数字后缀。
   *
   * @param date 日期 YYYY-MM-DD
   * @param oldTopic 旧话题名
   * @param newTopic 新话题名（已 slugify 处理）
   * @returns 实际使用的新话题名（可能与 newTopic 不同，因为去重逻辑）
   */
  async renameTopic(date: string, oldTopic: string, newTopic: string): Promise<string> {
    const srcPath = this.getFilePath(date, oldTopic);
    if (!existsSync(srcPath)) return oldTopic;

    const destDir = dirname(srcPath);
    let destName = newTopic;
    let destPath = join(destDir, `${date}-${destName}.md`);

    // 目标文件已存在 → 追加数字后缀去重
    let counter = 1;
    while (existsSync(destPath)) {
      destName = `${newTopic}-${counter}`;
      destPath = join(destDir, `${date}-${destName}.md`);
      counter++;
    }

    await rename(srcPath, destPath);
    logger.debug({ from: `${date}-${oldTopic}`, to: `${date}-${destName}` }, '话题文件已重命名');
    return destName;
  }

  /**
   * 追加消息到话题文件
   * 不存在则创建
   */
  async append(date: string, topic: string, message: TopicMessage): Promise<void> {
    const filePath = this.getFilePath(date, topic);
    await mkdir(dirname(filePath), { recursive: true });

    let existing: TopicFile | null = null;
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      existing = this.parseTopicFile(date, topic, content);
    }

    const next: TopicFile = existing
      ? { ...existing, messages: [...existing.messages, message] }
      : {
          date,
          topic,
          messages: [message],
          keywords: [],
        };

    // 重新写入（避免文件锁问题）
    const frontmatter = this.serializeFrontmatter(next);
    const body = next.messages.map((m) => this.formatMessage(m)).join('\n\n');
    const content = `---\n${frontmatter}\n---\n\n# ${next.topic} (${next.date})\n\n${body}\n`;
    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * 追加话题摘要到 frontmatter
   * M-203-改：事件驱动归档，话题切换时调用
   * 不存在则静默跳过
   */
  async appendSummary(date: string, topic: string, summary: string): Promise<void> {
    const filePath = this.getFilePath(date, topic);
    if (!existsSync(filePath)) return;

    const content = await readFile(filePath, 'utf-8');
    const existing = this.parseTopicFile(date, topic, content);

    if (existing.summary) return; // 已有摘要，幂等跳过

    const updated: TopicFile = { ...existing, summary };
    await this.write(updated);
  }

  /**
   * 列出所有话题文件
   */
  async list(): Promise<string[]> {
    const dir = join(this.dataDir, 'topics');
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.md'));
  }

  /**
   * 将话题原文移到 archive/ 目录（封存不删除 · 记忆减法方案 v1.0）
   *
   * 策略：
   *   - 把 topic-*.md 从 topics/ 移动到 archive/ 目录
   *   - 同时写入 archive-metadata.json 记录元数据
   *   - 原文保留在 archive/ 中，未来可通过 archive-manager 扫描恢复
   *   - 话题文件从 topics/ 移除后，TopicStore.list() 不再列出
   *
   * @param date - 话题日期 YYYY-MM-DD
   * @param topic - 话题名
   * @param refined - 是否已炼化（LLM 归档成功）
   * @returns 封存后的文件路径，话题不存在返回 null
   */
  async moveToArchive(date: string, topic: string, refined: boolean): Promise<string | null> {
    const srcPath = this.getFilePath(date, topic);
    if (!existsSync(srcPath)) {
      logger.debug({ date, topic }, '话题文件不存在，无法封存');
      return null;
    }

    // 目标路径：archive/<文件名>
    const archiveDir = join(this.dataDir, 'archive');
    await mkdir(archiveDir, { recursive: true });
    const fileName = basename(srcPath);
    const destPath = join(archiveDir, fileName);

    // 读取话题文件，获取消息数
    const topicFile = await this.read(date, topic);
    const messageCount = topicFile?.messages.length ?? 0;

    // 移动文件
    await rename(srcPath, destPath);

    // 写入元数据 JSON
    const metadata: ArchiveMetadata = {
      originalFileName: fileName,
      date,
      topic,
      archivedAt: new Date().toISOString(),
      refined,
      refineAttempts: 0,
      messageCount,
    };
    const metadataPath = join(archiveDir, `${date}-${topic}.meta.json`);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    logger.info({ date, topic, refined, messageCount, destPath }, '话题已封存到 archive/');

    return destPath;
  }

  /**
   * 解析话题文件原始内容（公开方法）
   *
   * 供 ArchiveManager 等外部调用者使用——当文件已从 topics/ 移到 archive/ 后，
   * read() 无法访问，但解析逻辑仍应复用 TopicStore 的实现。
   */
  parseContent(date: string, topic: string, raw: string): TopicFile {
    return this.parseTopicFile(date, topic, raw);
  }

  /**
   * 解析话题文件
   */
  private parseTopicFile(date: string, topic: string, raw: string): TopicFile {
    const { frontmatter: meta, body } = parseFrontmatter(raw);

    // 无 frontmatter 时使用默认空文件
    if (Object.keys(meta).length === 0) {
      return { date, topic, messages: [], keywords: [] };
    }

    return {
      date: meta['date'] ?? date,
      topic: meta['topic'] ?? topic,
      messages: this.parseMessages(body),
      summary: meta['summary'],
      keywords: meta['keywords']?.split(',').map((s) => s.trim()) ?? [],
      // v4.0：解析 seed_snapshots（YAML 数组或逗号分隔字符串）
      seedSnapshots: this.parseSeedSnapshots(meta['seed_snapshots']),
    };
  }

  /**
   * 解析 markdown body 中的消息
   * 格式：`## [role] timestamp\n\ncontent\n\n`
   * 使用零宽先行断言按消息头分割，保留每条消息的 `## [` 前缀
   */
  private parseMessages(body: string): TopicMessage[] {
    const messages: TopicMessage[] = [];
    // 去掉首个 # 标题
    const cleaned = body.replace(/^#.*$/m, '').trim();
    // 零宽匹配：按 "## [role]" 分割（不消耗字符，保留前缀）
    const parts = cleaned.split(/(?=^## \[)/m);

    for (const part of parts) {
      if (!part.trim()) continue;
      // 完整匹配 `## [role] timestamp\ncontent`
      const headerMatch = part.match(/^## \[(user|assistant|system|tool)\]\s+(.+?)\n([\s\S]*)$/);
      if (!headerMatch) continue;

      messages.push({
        role: headerMatch[1] as TopicMessage['role'],
        timestamp: headerMatch[2] ?? '',
        content: (headerMatch[3] ?? '').trim(),
      });
    }

    return messages;
  }

  /**
   * 序列化 frontmatter
   */
  private serializeFrontmatter(topic: TopicFile): string {
    // v4.0：对话快照种子序列化为 YAML 数组格式（逗号分隔字符串）
    const seedStr = topic.seedSnapshots?.length ? topic.seedSnapshots.join('; ') : undefined;
    return serializeFm({
      date: topic.date,
      topic: topic.topic,
      ...(topic.summary ? { summary: topic.summary } : {}),
      ...(topic.keywords.length > 0 ? { keywords: topic.keywords.join(', ') } : {}),
      ...(seedStr ? { seed_snapshots: seedStr } : {}),
    });
  }

  /**
   * 解析 seed_snapshots（支持 YAML 数组和逗号分隔字符串两种格式）
   */
  private parseSeedSnapshots(raw: unknown): string[] | undefined {
    if (!raw) return undefined;
    if (Array.isArray(raw)) return raw.map(String).filter((s) => s.length > 0);
    if (typeof raw === 'string')
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return undefined;
  }

  /**
   * v4.0：追加对话快照种子到话题 frontmatter
   *
   * @param date 日期
   * @param topic 话题名
   * @param snapshots 种子句列表
   */
  async appendSeedSnapshots(date: string, topic: string, snapshots: string[]): Promise<void> {
    const filePath = this.getFilePath(date, topic);
    if (!existsSync(filePath)) return;

    const content = await readFile(filePath, 'utf-8');
    const existing = this.parseTopicFile(date, topic, content);

    if (existing.seedSnapshots?.length) return; // 已有种子，幂等跳过

    const updated: TopicFile = { ...existing, seedSnapshots: snapshots };
    await this.write(updated);
    logger.info({ topic, count: snapshots.length }, '对话快照种子已写入');
  }

  /**
   * 格式化单条消息
   */
  private formatMessage(message: TopicMessage): string {
    return `## [${message.role}] ${message.timestamp}\n\n${message.content}`;
  }
}

/**
 * 工具函数：获取当前日期 YYYY-MM-DD（本地时区）
 */
export function todayDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 工具函数：格式化时间戳
 */
export function nowTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}
