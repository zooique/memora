/**
 * 归档封存管理器 — 记忆减法方案 v1.0 · S-306
 *
 * 核心职责：
 *   - 管理 archive/ 目录（话题原文的封存区）
 *   - 扫描"未炼化"标记（LLM 归档失败时留下的 .meta.json）
 *   - 启动时重新尝试归档未炼化的话题
 *   - 清理过期未炼化标记（超过保留天数）
 *
 * 设计原则（记忆减法方案 §4.3 · 封存不删除）：
 *   - 话题原文移到 archive/ 后永久保留在文件系统中
 *   - "未炼化"仅意味着索引中没有摘要，原文不丢失
 *   - 下次启动时自动扫描并重试归档
 *
 * 详见 docs/方案-记忆减法-v1.0.md §四·4.3 归档管线
 */
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/logging/logger.js';
import type { ArchiveMetadata, TopicSummarizer, TopicFile } from './types.js';
import type { TopicStore } from './topic-store.js';

/**
 * 归档管理器配置
 */
export interface ArchiveManagerConfig {
  /** 未炼化标记保留天数（超期自动清理） */
  unrefinedRetentionDays: number;
  /** 单次扫描最大 topic 数 */
  maxScanTopics: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: ArchiveManagerConfig = {
  unrefinedRetentionDays: 7,
  maxScanTopics: 20,
};

/**
 * 归档封存管理器
 *
 * 管理 archive/ 目录下的封存话题原文和元数据。
 * 启动时扫描"未炼化"标记并重新尝试归档。
 */
export class ArchiveManager {
  private readonly archiveDir: string;
  private readonly config: ArchiveManagerConfig;

  constructor(
    private readonly topicStore: TopicStore,
    /** .memora/ 目录路径（用于推导 archive/ 目录） */
    memoraDir: string,
    config?: Partial<ArchiveManagerConfig>,
  ) {
    this.archiveDir = join(memoraDir, 'archive');
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 扫描 archive/ 目录中的元数据文件
   *
   * @returns 所有 .meta.json 文件路径
   */
  private async listMetadataFiles(): Promise<string[]> {
    if (!existsSync(this.archiveDir)) return [];
    const files = await readdir(this.archiveDir);
    return files.filter((f) => f.endsWith('.meta.json'));
  }

  /**
   * 读取指定路径的元数据
   *
   * @param metaPath - .meta.json 文件路径
   * @returns 解析后的元数据，解析失败返回 null
   */
  private async readMetadata(metaPath: string): Promise<ArchiveMetadata | null> {
    try {
      const raw = await readFile(metaPath, 'utf-8');
      return JSON.parse(raw) as ArchiveMetadata;
    } catch {
      logger.warn({ metaPath }, '归档元数据解析失败');
      return null;
    }
  }

  /**
   * 扫描未炼化的话题并重新尝试归档
   *
   * 启动时调用（agent.init() 末尾 fire-and-forget），
   * 扫描 archive/ 中 refined=false 的元数据，
   * 重新调用 summarizer 炼化，成功后更新 refined=true。
   *
   * @param summarizer - 话题摘要生成器（LLM 能力注入）
   * @returns 处理的话题数
   */
  async scanAndRetryUnrefined(summarizer: TopicSummarizer): Promise<number> {
    const metaFiles = await this.listMetadataFiles();
    if (metaFiles.length === 0) return 0;

    let processed = 0;
    for (const metaFile of metaFiles) {
      if (processed >= this.config.maxScanTopics) break;

      const metaPath = join(this.archiveDir, metaFile);
      const metadata = await this.readMetadata(metaPath);
      if (!metadata) continue;

      // 只处理未炼化的
      if (metadata.refined) continue;

      // 超过保留天数，清理标记
      const ageDays =
        (Date.now() - new Date(metadata.archivedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > this.config.unrefinedRetentionDays) {
        await this.cleanupExpiredMetadata(metaPath, metadata);
        processed++;
        continue;
      }

      // 重新尝试归档
      try {
        // 翠幕天罗 P1-2 修复：直接从 archive/ 目录读取封存的话题文件
        // TopicStore.read() 只能读 topics/ 目录，封存后文件已移走
        const topicFile = await this.readArchivedTopic(metadata);
        if (!topicFile) {
          logger.debug(
            { date: metadata.date, topic: metadata.topic },
            '封存话题原文不存在，清理元数据',
          );
          await this.safeUnlink(metaPath);
          processed++;
          continue;
        }

        const result = await summarizer(topicFile.messages);
        if (result === null) {
          logger.debug({ date: metadata.date, topic: metadata.topic }, '重新炼化价值过低，跳过');
          // 标记为 refined=true（不再重试）
          await this.updateMetadataRefined(metaPath, metadata, true);
          processed++;
          continue;
        }

        // 写入话题 frontmatter（通过 TopicStore）
        // 排雷修正：summarizer 现在返回 TopicSummarizerResult，取 .summary 写入
        await this.topicStore.appendSummary(metadata.date, metadata.topic, result.summary);

        // 标记为已炼化
        await this.updateMetadataRefined(metaPath, metadata, true);
        logger.info(
          { date: metadata.date, topic: metadata.topic, messageCount: topicFile.messages.length },
          '封存话题重新炼化成功',
        );
        processed++;
      } catch (err) {
        // 炼化失败，更新重试次数
        const attempts = (metadata.refineAttempts ?? 0) + 1;
        logger.warn(
          { err, date: metadata.date, topic: metadata.topic, attempts },
          '封存话题重新炼化失败',
        );
        await this.updateMetadataAttempts(metaPath, metadata, attempts);
        processed++;
      }
    }

    if (processed > 0) {
      logger.info({ processed }, 'archive/ 未炼化扫描完成');
    }

    return processed;
  }

  /**
   * 直接从 archive/ 目录读取封存的话题文件
   *
   * 翠幕天罗 P1-2 修复：TopicStore.read() 只读 topics/ 目录，
   * 封存后文件已移到 archive/，需要直接读取。
   */
  private async readArchivedTopic(metadata: ArchiveMetadata): Promise<TopicFile | null> {
    const filePath = join(this.archiveDir, metadata.originalFileName);
    if (!existsSync(filePath)) return null;

    try {
      const raw = await readFile(filePath, 'utf-8');
      // 复用 TopicStore 的解析逻辑，避免重复实现 message 解析
      return this.topicStore.parseContent(metadata.date, metadata.topic, raw);
    } catch {
      logger.warn({ filePath }, '读取封存话题文件失败');
      return null;
    }
  }

  /**
   * 更新元数据：标记 refined 状态
   */
  private async updateMetadataRefined(
    metaPath: string,
    existing: ArchiveMetadata,
    refined: boolean,
  ): Promise<void> {
    const updated: ArchiveMetadata = { ...existing, refined };
    await writeFile(metaPath, JSON.stringify(updated, null, 2), 'utf-8');
  }

  /**
   * 更新元数据：更新重试次数和错误
   */
  private async updateMetadataAttempts(
    metaPath: string,
    existing: ArchiveMetadata,
    attempts: number,
  ): Promise<void> {
    const updated: ArchiveMetadata = {
      ...existing,
      refineAttempts: attempts,
      lastRefineError: `Failed at ${new Date().toISOString()} (attempt ${attempts})`,
    };
    await writeFile(metaPath, JSON.stringify(updated, null, 2), 'utf-8');
  }

  /**
   * 清理过期的未炼化标记
   * 只删 .meta.json，不删原文（原文永久封存）
   */
  private async cleanupExpiredMetadata(metaPath: string, metadata: ArchiveMetadata): Promise<void> {
    const ageDays = (Date.now() - new Date(metadata.archivedAt).getTime()) / (1000 * 60 * 60 * 24);
    logger.info(
      { date: metadata.date, topic: metadata.topic, ageDays: Math.round(ageDays) },
      '清理过期未炼化标记（原文保留在 archive/）',
    );
    await this.safeUnlink(metaPath);
  }

  /**
   * 安全删除文件（忽略不存在的错误）
   */
  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      // 文件不存在或无法删除，忽略
    }
  }
}
