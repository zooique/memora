/**
 * 单元测试：记忆类型定义
 * 验证基元驱动模型的 schema 有效性
 *
 * 注：inferSource / escapeLike / validateSource 的纯函数测试已迁移至
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
    // 含 UNKNOWN（inferSource 兜底值，文件路径未匹配已知目录时的默认标签）
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
      score: 0.8,
    };

    const parsed = parseMemory(memory);
    expect(parsed.id).toBe('rule:core');
    expect(parsed.source).toBe('rule');
    expect(parsed.score).toBe(0.8);
  });

  it('应该拒绝无效的 score 范围', () => {
    // score 必须在 0-1 之间
    const invalid = {
      id: 'x:test',
      content: '测试内容',
      source: 'rule',
      name: 'test',
      createdAt: '2026-06-02T00:00:00.000Z',
      accessedAt: '2026-06-02T00:00:00.000Z',
      score: 1.5,  // 超出范围
    };
    expect(() => parseMemory(invalid)).toThrow();
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
      score: 0.5,
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
      score: 0.5,
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
