/**
 * 模型菜单「新出现项」差集守卫（MODEL-PICKER-NEW-1）
 *
 * 判据落在本域纯函数执行链：
 *   - 首次快照（prev 空）不标 ⇒ 冷启动不会把存量全误报为「新」
 *   - 列表变长才命中新增名；未变的重推 ⇒ 空集（角标自然消失）
 *   - 删除场景无新增（差集不会对缩小列表误报）
 *   - 语义正交：差集只产 name 集合，不触碰 active / is-active
 */
import { describe, expect, it } from 'vitest';
import { diffNewProviderNames } from '../modelPickerNews.js';

describe('diffNewProviderNames · 新出现项差集（MODEL-PICKER-NEW-1）', () => {
  it('首次快照（prev 为空）不标任何项——冷启动存量模型不是「新」', () => {
    expect(diffNewProviderNames([], ['a', 'b']).size).toBe(0);
  });

  it('列表新增 → 只标新出现的 name', () => {
    expect([...diffNewProviderNames(['a', 'b'], ['a', 'b', 'c'])]).toEqual(['c']);
  });

  it('列表未变的重推 → 空集，角标自然消失（完成语义无需定时器）', () => {
    expect(diffNewProviderNames(['a', 'b', 'c'], ['a', 'b', 'c']).size).toBe(0);
  });

  it('列表缩小 → 不误报「新」', () => {
    expect(diffNewProviderNames(['a', 'b', 'c'], ['a']).size).toBe(0);
  });

  it('同名替换（改名后同 key）不算新；只有真新增 key 命中', () => {
    expect(diffNewProviderNames(['a'], ['a']).size).toBe(0);
    expect([...diffNewProviderNames(['a'], ['a', 'b', 'd'])]).toEqual(['b', 'd']);
  });
});
