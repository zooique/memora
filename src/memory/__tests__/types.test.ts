/**
 * 单元测试：记忆类型定义
 * 验证基元驱动模型的 schema 有效性
 *
 * 注：escapeLike / validateSource 的纯函数测试已迁移至
 * sourceValidation.test.ts（与 sourceValidation.ts 1:1 镜像）。
 * 本文件保留类型 schema 测试 + InMemoryStorage source block 集成测试。
 */
import { describe, expect, it } from 'vitest';
import { parseMemory, SOURCE_LABELS } from '@/memory/types.js';
import { STOPWORDS } from '@/utils/segmenter.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { Memory } from '@/memory/types.js';

describe('记忆类型定义', () => {
  it('应该暴露 6 种 source 标签约定', () => {
    // source 是开放字符串，SOURCE_LABELS 仅为当前约定
    // 含 UNKNOWN（未被已知标签覆盖时的兜底值）
    expect(Object.keys(SOURCE_LABELS)).toHaveLength(6);
    expect(SOURCE_LABELS.PERSONA).toBe('persona');
    expect(SOURCE_LABELS.RULE).toBe('rule');
    expect(SOURCE_LABELS.SKILL).toBe('skill');
    expect(SOURCE_LABELS.WORK_PROJECTION).toBe('work-projection');
    expect(SOURCE_LABELS.UNKNOWN).toBe('unknown');
    expect(SOURCE_LABELS.ROUND_SUMMARY).toBe('round-summary');
  });

  it('应该通过 schema 校验一个有效记忆', () => {
    // 构造符合新 Memory 接口的测试数据
    const memory = {
      id: 'rule:core',
      content: '核心规则内容',
      source: 'rule',
      name: 'core',
      createdAt: '2026-06-02T00:00:00.000Z',
      accessedAt: '2026-06-02T00:00:00.000Z',
    };

    const parsed = parseMemory(memory);
    expect(parsed.id).toBe('rule:core');
    expect(parsed.source).toBe('rule');
  });

  it('应该接受有效的 source 字符串（开放字符串，非枚举）', () => {
    // source 是开放字符串，任何非空字符串都应有效
    const customSource = {
      id: 'custom:test',
      content: '测试内容',
      source: 'custom-source',  // 自定义 source
      name: 'test',
      createdAt: '2026-06-02T00:00:00.000Z',
      accessedAt: '2026-06-02T00:00:00.000Z',
    };
    expect(() => parseMemory(customSource)).not.toThrow();
  });
});

describe('STOPWORDS 停用词集合', () => {
  it('应该包含常用中文停用词', () => {
    expect(STOPWORDS.has('的')).toBe(true);
    expect(STOPWORDS.has('了')).toBe(true);
    expect(STOPWORDS.has('是')).toBe(true);
    expect(STOPWORDS.has('在')).toBe(true);
  });

  it('应该不包含有意义的词', () => {
    expect(STOPWORDS.has('记忆')).toBe(false);
    expect(STOPWORDS.has('规则')).toBe(false);
  });
});

// validateSource 纯函数测试已迁移至 sourceValidation.test.ts
// 以下 InMemoryStorage · source block 校验为跨模块集成测试，验证存储层对 source 校验的集成

describe('InMemoryStorage · source block 校验', () => {
  function makeMemory(source: string): Memory {
    return {
      id: `test:${source}`,
      content: '测试内容',
      source,
      name: 'test',
      createdAt: '2026-06-18T00:00:00.000Z',
      accessedAt: '2026-06-18T00:00:00.000Z',
    };
  }

  it('路径遍历 source 应被 upsert 拒绝（throw）', () => {
    const store = new InMemoryStorage();
    expect(() => store.upsert(makeMemory('skill::../etc/passwd'))).toThrow(/source 校验失败/);
  });

  it('null 字节 source 应被 upsert 拒绝（throw）', () => {
    const store = new InMemoryStorage();
    expect(() => store.upsert(makeMemory('content\x00malicious'))).toThrow(/source 校验失败/);
  });

  it('空字符串 source 应被 upsert 拒绝（throw）', () => {
    const store = new InMemoryStorage();
    expect(() => store.upsert(makeMemory(''))).toThrow(/source 校验失败/);
  });

  it('首尾空格 source 应被 upsert 拒绝（throw）', () => {
    const store = new InMemoryStorage();
    expect(() => store.upsert(makeMemory(' rule '))).toThrow(/source 校验失败/);
  });

  it('typo 级别 source 应允许写入（warn 不 throw）', () => {
    const store = new InMemoryStorage();
    expect(() => store.upsert(makeMemory('rul'))).not.toThrow();
    expect(store.getById('test:rul')).not.toBeNull();
  });

  it('正常 source 应正常写入', () => {
    const store = new InMemoryStorage();
    expect(() => store.upsert(makeMemory('rule'))).not.toThrow();
    expect(store.getById('test:rule')).not.toBeNull();
  });
});

describe('parseMemory 白名单构造（阶段3 score 退役后的数据层清洗契约）', () => {
  /** 构造一条带已退役 score 字段的旧档记忆（模拟宿主 memories.json 历史数据） */
  function legacyMemory(): Record<string, unknown> {
    return {
      id: 'round-summary:legacy',
      content: '旧档内容',
      source: 'round-summary',
      name: 'legacy',
      createdAt: '2026-06-02T00:00:00.000Z',
      accessedAt: '2026-06-02T00:00:00.000Z',
      score: 0.85, // 已物理退役的字段
    };
  }

  it('未知字段（旧档 score）应被剥离，不出现在解析结果上', () => {
    const parsed = parseMemory(legacyMemory());

    // 需经 unknown 转 Record 访问：Memory 类型上已不存在 score 属性（类型层退役的静态证明）
    expect((parsed as unknown as Record<string, unknown>).score).toBeUndefined();
    // 白名单外字段不应驻留（宿主写回时据此完成数据清洗）
    expect(Object.keys(parsed)).not.toContain('score');
  });

  it('解析结果只含 Memory 接口声明的字段', () => {
    const parsed = parseMemory(legacyMemory());

    expect(Object.keys(parsed).sort()).toEqual(
      [
        'accessedAt',
        'content',
        'createdAt',
        'deletedAt',
        'id',
        'isModified',
        'metadata',
        'name',
        'roundId',
        'sessionName',
        'source',
        'summaryType',
        'supersededBy',
      ].sort(),
    );
  });

  it('deletedAt 为 null 应归一为 undefined（null 会让消费方误判为已删除）', () => {
    const parsed = parseMemory({ ...legacyMemory(), deletedAt: null });

    // 关键：必须是 undefined 而非 null——消费方按 `deletedAt === undefined` 判活跃
    expect(parsed.deletedAt).toBeUndefined();
    expect(parsed.deletedAt === undefined).toBe(true);
  });

  it('deletedAt 为合法 ISO 串应原样保留', () => {
    const parsed = parseMemory({
      ...legacyMemory(),
      deletedAt: '2026-09-01T00:00:00.000Z',
    });

    expect(parsed.deletedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('deletedAt 为非法日期应抛错', () => {
    // configError 的 Error.message 为标题「Memory 解析失败」，字段细节在其 detail 中
    expect(() => parseMemory({ ...legacyMemory(), deletedAt: 'not-a-date' })).toThrow(
      /Memory 解析失败/,
    );
  });

  it('可选语义字段非法类型应抛错（summaryType 非法取值）', () => {
    // 兑现 SUMMARY_TYPES「运行时校验与类型声明同源」承诺：非法类型不再 as 断言透传
    expect(() => parseMemory({ ...legacyMemory(), summaryType: 'bogus' })).toThrow(
      /Memory 解析失败/,
    );
  });

  it('可选语义字段非法类型应抛错（isModified/metadata/sessionName/roundId/supersededBy）', () => {
    expect(() => parseMemory({ ...legacyMemory(), isModified: 'yes' })).toThrow(
      /Memory 解析失败/,
    );
    expect(() => parseMemory({ ...legacyMemory(), metadata: 42 })).toThrow(/Memory 解析失败/);
    expect(() => parseMemory({ ...legacyMemory(), sessionName: 123 })).toThrow(
      /Memory 解析失败/,
    );
    expect(() => parseMemory({ ...legacyMemory(), roundId: true })).toThrow(/Memory 解析失败/);
    expect(() => parseMemory({ ...legacyMemory(), supersededBy: ['x'] })).toThrow(
      /Memory 解析失败/,
    );
  });

  it('合法可选字段应通过校验', () => {
    expect(() =>
      parseMemory({
        ...legacyMemory(),
        metadata: { tag: 'v1' },
        summaryType: 'fact',
        sessionName: '2026-06-02-main',
        roundId: 'r1',
        isModified: false,
        supersededBy: 'round-summary:2026-06-02-main:r2',
      }),
    ).not.toThrow();
  });
});
