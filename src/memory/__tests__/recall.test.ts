/**
 * 记忆召回工具函数测试
 * 覆盖关键词提取 + touchScores 批量 touch
 *
 * 注：`recall()` 召回编排已随「减法」退役（2026-09-10，见 docs/白话设计文档.md 第二步）——
 * 它是「检查点恢复的温记忆召回」的唯一消费者，随跨重启恢复链整体退役；
 * 原文件中的 recall 相关用例（双通道融合排序 / 降级策略 / 分层分轨 / cap 分配）一并退役。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractKeywords, touchScores } from '@/memory/recall.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';

describe('extractKeywords · 关键词提取', () => {
  it('应该提取中文关键词并过滤停用词', () => {
    const keywords = extractKeywords('我想学习编程的技巧');
    // 应该包含有意义的词，过滤掉停用词
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).not.toContain('的');
    expect(keywords).not.toContain('我');
  });

  it('应该提取英文关键词', () => {
    const keywords = extractKeywords('Learn TypeScript programming');
    expect(keywords).toContain('learn');
    expect(keywords).toContain('typescript');
    expect(keywords).toContain('programming');
  });

  it('应该过滤长度小于 2 的词', () => {
    const keywords = extractKeywords('a bb ccc');
    expect(keywords).not.toContain('a');
    expect(keywords).toContain('bb');
    expect(keywords).toContain('ccc');
  });

  it('应该去重', () => {
    const keywords = extractKeywords('测试 测试 测试');
    const testCount = keywords.filter((k) => k === '测试').length;
    expect(testCount).toBe(1);
  });
});

describe('touchScores · 批量持久化 touch（只刷 accessedAt）', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = {
      upsert: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
      getBySource: vi.fn(),
      search: vi.fn(),
      count: vi.fn(() => 0),
      countBySource: vi.fn(() => 0),
      // score 物理退役后 touch 为唯一写位：只刷新 accessedAt（原子）
      touch: vi.fn(() => true),
      getAllSources: vi.fn(() => new Map()),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
  });

  it('应对每个 id 调用 touch 刷新 accessedAt', async () => {
    await touchScores(mockStorage, ['content:1', 'content:2']);

    // 应调用 2 次 touch
    expect(mockStorage.touch).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mockStorage.touch).mock.calls;
    expect(calls[0]![0]).toBe('content:1');
    expect(calls[1]![0]).toBe('content:2');
    // 第二参为 ISO 时间戳（承接「只 touch 不 +score」定案，score 已物理退役）
    expect(typeof calls[0]![1]).toBe('string');
  });

  it('touch 返回 false（记忆不存在/已删除）不报错', async () => {
    vi.mocked(mockStorage.touch).mockReturnValue(false);

    // touchScores 不检查返回值，fire-and-forget 由 storage 层静默处理
    await expect(touchScores(mockStorage, ['content:deleted'])).resolves.toBeUndefined();
  });

  it('空 ids 数组应直接返回，不调用 touch', async () => {
    await touchScores(mockStorage, []);

    expect(mockStorage.touch).not.toHaveBeenCalled();
  });
});
