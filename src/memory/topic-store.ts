/**
 * 话题存储
 *
 * 话题文件结构：<日期>-<话题名>.md
 * 内容：frontmatter + 消息列表（按时间顺序）
 *
 * 详见 agent上下文组装协议.md §6 话题文件
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { TopicFile, TopicMessage } from './types.js';

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
    const content = `---\n${frontmatter}\n---\n\n# ${topic.topic} (${topic.date})\n\n${body}\n`;

    await writeFile(filePath, content, 'utf-8');
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
   * 列出所有话题文件
   */
  async list(): Promise<string[]> {
    const dir = join(this.dataDir, 'topics');
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.md'));
  }

  /**
   * 解析话题文件
   */
  private parseTopicFile(date: string, topic: string, raw: string): TopicFile {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    // 默认值（无 frontmatter）
    if (!match || !match[1] || !match[2]) {
      return {
        date,
        topic,
        messages: [],
        keywords: [],
      };
    }

    const [, fmBlock, body] = match;
    const meta: Record<string, string> = {};
    for (const line of fmBlock.split('\n')) {
      const [k, v] = line.split(':').map((s) => s.trim());
      if (k && v) meta[k] = v;
    }

    // 解析消息列表
    const messages = this.parseMessages(body);

    return {
      date: meta['date'] ?? date,
      topic: meta['topic'] ?? topic,
      messages,
      summary: meta['summary'],
      keywords: meta['keywords']?.split(',').map((s) => s.trim()) ?? [],
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
    const lines = [`date: ${topic.date}`, `topic: ${topic.topic}`];
    if (topic.summary) lines.push(`summary: ${topic.summary}`);
    if (topic.keywords.length > 0) {
      lines.push(`keywords: ${topic.keywords.join(', ')}`);
    }
    return lines.join('\n');
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

// 避免未使用警告
void writeFileSync;
