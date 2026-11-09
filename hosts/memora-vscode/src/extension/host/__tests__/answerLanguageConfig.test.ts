/**
 * answerLanguageConfig 测试 — `memora.answerLanguage` 的唯一读取点与装配参数
 *
 * 用 node 环境 + vi.mock('vscode')：本模块的全部职责就是「从哪个键读、默认什么、怎么传」，
 * 这三件事没有别的判据来源。键名与 manifest 的一致性另由 responseLanguage.test.ts 的
 * manifest 守卫覆盖（那边读真实 package.json，这边锁读取行为）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** vi.hoisted：mock 工厂在 import 之前求值，普通 const 会撞 TDZ */
const h = vi.hoisted(() => ({ get: vi.fn(), displayLanguage: 'zh-cn' }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: h.get }),
  },
  env: {
    get language() {
      return h.displayLanguage;
    },
  },
}));

import { answerLanguageAssembly, readAnswerLanguageOverride } from '../answerLanguageConfig.js';

describe('answerLanguageConfig · memora.answerLanguage', () => {
  beforeEach(() => {
    h.get.mockReset();
    // 真实 API 语义：未设置时返回调用方传入的默认值（替身必须保真，否则测的是替身）
    h.get.mockImplementation((_key: string, fallback?: unknown) => fallback);
    h.displayLanguage = 'zh-cn';
  });

  it('读 memora.answerLanguage，缺省空串（空 = 跟随显示语言）', () => {
    expect(readAnswerLanguageOverride()).toBe('');
    // 判据是「键 + 默认值」两件事：改键名会让设置静默失效
    expect(h.get).toHaveBeenCalledWith('answerLanguage', '');
  });

  it('用户填了值就原样返回，本层不做清洗', () => {
    h.get.mockReturnValue('  日语  ');
    // 清洗（空白折叠 / auto 哨兵）归 buildResponseLanguageDirective，读取层「读什么给什么」
    expect(readAnswerLanguageOverride()).toBe('  日语  ');
  });

  it('装配参数 = 显示语言 + 读取器；读取器每次现取（不缓存旧值）', () => {
    h.get.mockReturnValue('日语');
    const input = answerLanguageAssembly();
    expect(input.display).toBe('zh-cn');
    expect(input.readOverride?.()).toBe('日语');
    h.get.mockReturnValue('');
    expect(input.readOverride?.()).toBe('');
  });
});
