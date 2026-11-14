/**
 * 开活范围声明 · 规范化与重叠判定单测（判据 4）
 *
 * 钉住三件容易漂移的事：`./a` 与 `a` 必须同一条、分隔符 / 大小写要统一、
 * 目录祖先按路径段边界判断（`src/a` 不能命中 `src/ab`）。
 */
import { describe, expect, it } from 'vitest';
import { findScopeOverlap, normalizeScopePath, normalizeScopePaths } from '../sessionScope.js';

describe('sessionScope · 规范化', () => {
  it('`./a` / `a\\b` / 尾部斜杠 / 大小写都收敛到同一处', () => {
    expect(normalizeScopePath('./a')).toBe('a');
    expect(normalizeScopePath('a/')).toBe('a');
    expect(normalizeScopePath('A\\B\\C')).toBe('a/b/c');
    expect(normalizeScopePath('././a//b')).toBe('a/b');
  });

  it("`.` 与空串 = 整仓（`''`），绝对路径落在仓库内会截成相对", () => {
    expect(normalizeScopePath('.')).toBe('');
    expect(normalizeScopePath(' ./ ')).toBe('');
    // Windows 形态：盘符 + 反斜杠也要认
    expect(normalizeScopePath('F:\\zooique\\memora\\src\\a', 'f:/zooique/memora')).toBe('src/a');
    // 仓库外的绝对路径保持原样（不误判成整仓）
    expect(normalizeScopePath('D:/elsewhere/x', 'f:/zooique/memora')).toBe('d:/elsewhere/x');
  });

  it('一组声明去重且保序', () => {
    expect(normalizeScopePaths(['docs', './docs', 'SRC\\a'])).toEqual(['docs', 'src/a']);
  });
});

describe('sessionScope · 重叠判定', () => {
  it('相同路径 / 目录祖先算重叠，且回出「撞在哪」两侧', () => {
    expect(findScopeOverlap(['docs/a.md'], ['docs/a.md'])).toEqual({
      requested: 'docs/a.md',
      declared: 'docs/a.md',
    });
    expect(findScopeOverlap(['src/agent/loop.ts'], ['src/agent'])).toEqual({
      requested: 'src/agent/loop.ts',
      declared: 'src/agent',
    });
    // 反向祖先（对方更细）也算
    expect(findScopeOverlap(['src'], ['src/agent'])).toEqual({
      requested: 'src',
      declared: 'src/agent',
    });
  });

  it('整仓与任何路径都重叠，并显示为 `.`', () => {
    expect(findScopeOverlap([''], ['docs'])).toEqual({ requested: '.', declared: 'docs' });
    expect(findScopeOverlap(['docs'], [''])).toEqual({ requested: 'docs', declared: '.' });
  });

  it('按段边界比较：`src/a` 不命中 `src/ab`；无交集返回 undefined', () => {
    expect(findScopeOverlap(['src/a'], ['src/ab'])).toBeUndefined();
    expect(findScopeOverlap(['docs'], ['src/agent'])).toBeUndefined();
  });
});
