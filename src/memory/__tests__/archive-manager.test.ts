/**
 * 归档封存管理器单元测试
 *
 * 覆盖核心方法：
 * - scanAndRetryUnrefined() — 扫描未炼化标记并重新尝试归档
 *
 * 间接测试私有方法（通过 scanAndRetryUnrefined 触发）：
 * - readMetadata() — 解析 .meta.json
 * - cleanupExpiredMetadata() — 清理过期标记
 * - updateMetadataRefined() — 更新 refined 状态
 * - updateMetadataAttempts() — 更新重试次数
 *
 * Mock 策略：
 * - TopicStore：mock parseContent() 和 appendSummary()
 * - TopicSummarizer：mock 函数，控制返回值和异常
 * - 文件系统：使用 tmpdir + 真实文件（ArchiveManager 直接操作文件系统）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveManager } from '@/memory/archive-manager.js';
import type { ArchiveMetadata, TopicSummarizer, TopicFile, TopicMessage } from '@/memory/types.js';

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 构造一个最小可用的 TopicStore mock
 *
 * parseContent() 默认返回包含一条消息的 TopicFile，
 * appendSummary() 默认空实现。
 */
function createMockTopicStore(overrides?: {
  parseContent?: (date: string, topic: string, raw: string) => TopicFile;
  appendSummary?: (date: string, topic: string, summary: string) => Promise<void>;
}) {
  return {
    parseContent:
      overrides?.parseContent ??
      ((date: string, topic: string, _raw: string) => {
        const msg: TopicMessage = {
          role: 'user',
          content: '测试消息',
          timestamp: new Date().toISOString(),
        };
        const file: TopicFile = { date, topic, messages: [msg], keywords: ['测试'] };
        return file;
      }),
    appendSummary: overrides?.appendSummary ?? vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * 构造 .meta.json 文件内容
 *
 * @param overrides - 部分覆盖默认元数据字段
 * @returns JSON 字符串
 */
function makeMetadataJson(overrides: Partial<ArchiveMetadata> = {}): string {
  const defaults: ArchiveMetadata = {
    originalFileName: '2026-06-01-test.md',
    date: '2026-06-01',
    topic: 'test',
    archivedAt: new Date().toISOString(), // 默认当前时间（未过期）
    refined: false,
    refineAttempts: 0,
    messageCount: 5,
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

/**
 * 构造话题文件原始内容（Markdown + frontmatter）
 *
 * @param date - 话题日期
 * @param topic - 话题名
 * @returns Markdown 字符串
 */
function makeTopicFileContent(date: string, topic: string): string {
  return `---
date: ${date}
topic: ${topic}
---

# ${topic} (${date})

## [user] 2026-06-01T10:00:00.000Z

测试消息内容

## [assistant] 2026-06-01T10:00:05.000Z

好的，收到
`;
}

/**
 * 读取 .meta.json 并解析为 ArchiveMetadata
 *
 * @param dir - .meta.json 所在目录
 * @param fileName - 文件名
 * @returns 解析后的元数据
 */
function readMetadataFromDisk(dir: string, fileName: string): ArchiveMetadata {
  const raw = readFileSync(join(dir, fileName), 'utf-8');
  return JSON.parse(raw) as ArchiveMetadata;
}

// ─── 测试套件 ──────────────────────────────────────────────

describe('ArchiveManager · scanAndRetryUnrefined()', () => {
  /** 临时目录根路径 */
  let tmpRoot: string;
  /** .memora/ 目录路径 */
  let memoraDir: string;
  /** archive/ 目录路径 */
  let archiveDir: string;
  /** mock TopicStore */
  let mockTopicStore: ReturnType<typeof createMockTopicStore>;
  /** mock summarizer */
  let mockSummarizer: TopicSummarizer;

  beforeEach(() => {
    // 每个测试独立 tmpdir
    tmpRoot = mkdtempSync(join(tmpdir(), 'memora-archive-test-'));
    memoraDir = join(tmpRoot, '.memora');
    archiveDir = join(memoraDir, 'archive');
    mkdirSync(archiveDir, { recursive: true });

    // 默认 mock
    mockTopicStore = createMockTopicStore();
    mockSummarizer = vi.fn().mockResolvedValue({
      constraints: [],
      preferences: [],
      decisions: [],
      snapshots: [],
      summary: '炼化摘要',
    });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ─── 基础边界 ─────────────────────────────────────────

  it('archive/ 目录不存在 → 返回 0', async () => {
    // 删除 archive/ 目录
    rmSync(archiveDir, { recursive: true, force: true });

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    expect(result).toBe(0);
    // summarizer 不应被调用
    expect(mockSummarizer).not.toHaveBeenCalled();
  });

  it('archive/ 目录为空（无 .meta.json 文件）→ 返回 0', async () => {
    // archive/ 存在但为空
    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    expect(result).toBe(0);
    expect(mockSummarizer).not.toHaveBeenCalled();
  });

  it('archive/ 中有非 .meta.json 文件 → 忽略，返回 0', async () => {
    // 写入一个普通 .md 文件（不是 .meta.json）
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    expect(result).toBe(0);
    expect(mockSummarizer).not.toHaveBeenCalled();
  });

  // ─── 已炼化标记 → 跳过 ───────────────────────────────

  it('有已炼化（refined=true）的元数据 → 跳过不处理', async () => {
    // 写入已炼化的 .meta.json
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: true }),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    // 跳过已炼化的，processed=0
    expect(result).toBe(0);
    expect(mockSummarizer).not.toHaveBeenCalled();
  });

  // ─── 未炼化 → 调用 summarizer 重新炼化 ────────────────

  it('有未炼化（refined=false）的元数据 → 调用 summarizer 重新炼化', async () => {
    // 写入未炼化的 .meta.json + 对应话题原文
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    // 处理了 1 个
    expect(result).toBe(1);
    // summarizer 被调用
    expect(mockSummarizer).toHaveBeenCalledTimes(1);
  });

  // ─── 炼化成功 → 更新 refined=true ─────────────────────

  it('炼化成功 → 更新 refined=true + 调用 appendSummary', async () => {
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    await manager.scanAndRetryUnrefined(mockSummarizer);

    // 验证 .meta.json 已更新为 refined=true
    const updated = readMetadataFromDisk(archiveDir, '2026-06-01-test.meta.json');
    expect(updated.refined).toBe(true);

    // 验证 appendSummary 被调用
    expect(mockTopicStore.appendSummary).toHaveBeenCalledWith('2026-06-01', 'test', '炼化摘要');
  });

  // ─── 炼化返回 null（价值过低）→ 标记 refined=true ────

  it('炼化返回 null（价值过低）→ 标记 refined=true 不再重试', async () => {
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    // summarizer 返回 null
    mockSummarizer = vi.fn().mockResolvedValue(null);

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    await manager.scanAndRetryUnrefined(mockSummarizer);

    // 验证 .meta.json 已更新为 refined=true（不再重试）
    const updated = readMetadataFromDisk(archiveDir, '2026-06-01-test.meta.json');
    expect(updated.refined).toBe(true);

    // appendSummary 不应被调用（没有摘要可写）
    expect(mockTopicStore.appendSummary).not.toHaveBeenCalled();
  });

  // ─── 炼化抛异常 → 更新 refineAttempts ────────────────

  it('炼化抛异常 → 更新 refineAttempts + lastRefineError', async () => {
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false, refineAttempts: 2 }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    // summarizer 抛异常
    mockSummarizer = vi.fn().mockRejectedValue(new Error('LLM 服务不可用'));

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    await manager.scanAndRetryUnrefined(mockSummarizer);

    // 验证 .meta.json 的 refineAttempts 递增
    const updated = readMetadataFromDisk(archiveDir, '2026-06-01-test.meta.json');
    expect(updated.refineAttempts).toBe(3); // 原始 2 + 1
    expect(updated.lastRefineError).toContain('attempt 3');
    // refined 仍为 false（下次启动可重试）
    expect(updated.refined).toBe(false);
  });

  // ─── 超过保留天数的未炼化标记 → 清理 .meta.json ──────

  it('超过保留天数的未炼化标记 → 清理 .meta.json', async () => {
    // archivedAt 设为 10 天前（默认保留 7 天）
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false, archivedAt: tenDaysAgo }),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    await manager.scanAndRetryUnrefined(mockSummarizer);

    // .meta.json 应被删除
    expect(existsSync(join(archiveDir, '2026-06-01-test.meta.json'))).toBe(false);
    // summarizer 不应被调用（过期直接清理，不炼化）
    expect(mockSummarizer).not.toHaveBeenCalled();
  });

  it('自定义 unrefinedRetentionDays → 按配置的天数判断过期', async () => {
    // archivedAt 设为 3 天前
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false, archivedAt: threeDaysAgo }),
      'utf-8',
    );

    // 保留天数设为 2（3 天前 > 2 天，应过期）
    const manager = new ArchiveManager(mockTopicStore as never, memoraDir, {
      unrefinedRetentionDays: 2,
    });
    await manager.scanAndRetryUnrefined(mockSummarizer);

    // .meta.json 应被删除
    expect(existsSync(join(archiveDir, '2026-06-01-test.meta.json'))).toBe(false);
  });

  // ─── 封存话题原文不存在 → 清理 .meta.json ────────────

  it('封存话题原文不存在 → 清理 .meta.json', async () => {
    // 只写 .meta.json，不写话题原文
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false, originalFileName: '2026-06-01-test.md' }),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    await manager.scanAndRetryUnrefined(mockSummarizer);

    // .meta.json 应被删除（原文不存在，无法炼化）
    expect(existsSync(join(archiveDir, '2026-06-01-test.meta.json'))).toBe(false);
    // summarizer 不应被调用
    expect(mockSummarizer).not.toHaveBeenCalled();
  });

  // ─── 超过 maxScanTopics → 停止扫描 ────────────────────

  it('超过 maxScanTopics → 停止扫描', async () => {
    // 写入 3 个未炼化的 .meta.json + 对应话题原文
    for (let i = 1; i <= 3; i++) {
      const dateStr = `2026-06-0${i}`;
      const topicName = `topic-${i}`;
      writeFileSync(
        join(archiveDir, `${dateStr}-${topicName}.meta.json`),
        makeMetadataJson({
          refined: false,
          date: dateStr,
          topic: topicName,
          originalFileName: `${dateStr}-${topicName}.md`,
        }),
        'utf-8',
      );
      writeFileSync(
        join(archiveDir, `${dateStr}-${topicName}.md`),
        makeTopicFileContent(dateStr, topicName),
        'utf-8',
      );
    }

    // maxScanTopics 设为 2
    const manager = new ArchiveManager(mockTopicStore as never, memoraDir, {
      maxScanTopics: 2,
    });
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    // 最多处理 2 个
    expect(result).toBe(2);
    // summarizer 最多被调用 2 次
    expect(mockSummarizer).toHaveBeenCalledTimes(2);
  });

  // ─── 私有方法间接测试 ─────────────────────────────────

  it('readMetadata 解析失败（无效 JSON）→ 返回 0（跳过该文件）', async () => {
    // 写入无效 JSON 的 .meta.json
    writeFileSync(join(archiveDir, '2026-06-01-bad.meta.json'), '{ invalid json }}}', 'utf-8');

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    // 解析失败 → 跳过，processed=0
    expect(result).toBe(0);
    expect(mockSummarizer).not.toHaveBeenCalled();
  });

  it('updateMetadataRefined → 写入 refined=true 后再次扫描应跳过', async () => {
    // 第一次：未炼化 → 炼化成功 → refined=true
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);

    // 第一次扫描：炼化成功
    const first = await manager.scanAndRetryUnrefined(mockSummarizer);
    expect(first).toBe(1);
    expect(mockSummarizer).toHaveBeenCalledTimes(1);

    // 第二次扫描：已炼化，应跳过
    const second = await manager.scanAndRetryUnrefined(mockSummarizer);
    expect(second).toBe(0);
    // summarizer 调用次数不变（第二次没调）
    expect(mockSummarizer).toHaveBeenCalledTimes(1);
  });

  it('updateMetadataAttempts → 炼化失败后 refineAttempts 递增', async () => {
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false, refineAttempts: 0 }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    // summarizer 抛异常
    mockSummarizer = vi.fn().mockRejectedValue(new Error('超时'));

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);

    // 第一次扫描：失败 → attempts=1
    await manager.scanAndRetryUnrefined(mockSummarizer);
    let meta = readMetadataFromDisk(archiveDir, '2026-06-01-test.meta.json');
    expect(meta.refineAttempts).toBe(1);

    // 第二次扫描：再失败 → attempts=2
    await manager.scanAndRetryUnrefined(mockSummarizer);
    meta = readMetadataFromDisk(archiveDir, '2026-06-01-test.meta.json');
    expect(meta.refineAttempts).toBe(2);
    expect(meta.refined).toBe(false); // 仍可重试
  });

  // ─── 混合场景 ─────────────────────────────────────────

  it('混合场景：已炼化 + 未炼化 + 过期 + 原文缺失 → 各自正确处理', async () => {
    const now = new Date().toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    // 1. 已炼化 → 跳过
    writeFileSync(
      join(archiveDir, '2026-06-01-refined.meta.json'),
      makeMetadataJson({
        refined: true,
        date: '2026-06-01',
        topic: 'refined',
        originalFileName: '2026-06-01-refined.md',
        archivedAt: now,
      }),
      'utf-8',
    );

    // 2. 未炼化 + 原文存在 → 炼化成功
    writeFileSync(
      join(archiveDir, '2026-06-02-unrefined.meta.json'),
      makeMetadataJson({
        refined: false,
        date: '2026-06-02',
        topic: 'unrefined',
        originalFileName: '2026-06-02-unrefined.md',
        archivedAt: now,
      }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-02-unrefined.md'),
      makeTopicFileContent('2026-06-02', 'unrefined'),
      'utf-8',
    );

    // 3. 过期未炼化 → 清理
    writeFileSync(
      join(archiveDir, '2026-06-03-expired.meta.json'),
      makeMetadataJson({
        refined: false,
        date: '2026-06-03',
        topic: 'expired',
        originalFileName: '2026-06-03-expired.md',
        archivedAt: tenDaysAgo,
      }),
      'utf-8',
    );

    // 4. 原文缺失 → 清理 .meta.json
    writeFileSync(
      join(archiveDir, '2026-06-04-missing.meta.json'),
      makeMetadataJson({
        refined: false,
        date: '2026-06-04',
        topic: 'missing',
        originalFileName: '2026-06-04-missing.md',
        archivedAt: now,
      }),
      'utf-8',
    );

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    const result = await manager.scanAndRetryUnrefined(mockSummarizer);

    // 已炼化跳过不算 processed，其余 3 个处理了
    expect(result).toBe(3);

    // summarizer 只被调用 1 次（只有 #2 走到炼化步骤）
    expect(mockSummarizer).toHaveBeenCalledTimes(1);

    // #2 的 .meta.json 应更新为 refined=true
    const meta2 = readMetadataFromDisk(archiveDir, '2026-06-02-unrefined.meta.json');
    expect(meta2.refined).toBe(true);

    // #3 的 .meta.json 应被删除
    expect(existsSync(join(archiveDir, '2026-06-03-expired.meta.json'))).toBe(false);

    // #4 的 .meta.json 应被删除
    expect(existsSync(join(archiveDir, '2026-06-04-missing.meta.json'))).toBe(false);
  });

  // ─── parseContent 复用 ────────────────────────────────

  it('炼化时通过 TopicStore.parseContent() 解析封存话题', async () => {
    writeFileSync(
      join(archiveDir, '2026-06-01-test.meta.json'),
      makeMetadataJson({ refined: false }),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '2026-06-01-test.md'),
      makeTopicFileContent('2026-06-01', 'test'),
      'utf-8',
    );

    // 用自定义 parseContent 验证调用参数
    const customParse = vi.fn().mockReturnValue({
      date: '2026-06-01',
      topic: 'test',
      messages: [{ role: 'user', content: 'hello', timestamp: new Date().toISOString() }],
      keywords: ['test'],
    });
    mockTopicStore = createMockTopicStore({ parseContent: customParse });

    const manager = new ArchiveManager(mockTopicStore as never, memoraDir);
    await manager.scanAndRetryUnrefined(mockSummarizer);

    // parseContent 应被调用，参数为 (date, topic, rawContent)
    expect(customParse).toHaveBeenCalledTimes(1);
    expect(customParse).toHaveBeenCalledWith(
      '2026-06-01',
      'test',
      expect.any(String), // 文件原始内容
    );
  });
});
