/**
 * fileChangeDiff 单测（纯逻辑 · node 环境 · 无需 mock vscode）
 *
 * 覆盖逐行差异算法的全部形态：无改动 / 单行替换 / 纯新增 / 纯删除 / 删增相邻合并 /
 * 多处不连续改动 / 首行末行边界 / 清空文件 / 新建文件 / 超限降级 / 锚点行 clamp。
 *
 * 变异验证锚点：`lcsHunks` 里「删除 / 新增」两分支的判据一旦取反，`removed` 就会整体丢失
 * —— 本文件多条用例（纯删除 / 替换）会立即变红，证明断言确实咬住了该判据。
 *
 * @module __tests__/fileChangeDiff.test
 */

import { describe, it, expect } from 'vitest';
import {
  computeFileDiff,
  hunkAnchorLine,
  isRemovedOnly,
  MAX_LCS_LINES,
  type DiffHunk,
} from '../fileChangeDiff.js';

const hunk = (startLine: number, endLine: number, removed: string[] = []): DiffHunk => ({
  startLine,
  endLine,
  removed,
});

describe('computeFileDiff：基本形态', () => {
  it('内容完全一致 → 无改动块', () => {
    const diff = computeFileDiff('a\nb\nc', 'a\nb\nc');
    expect(diff.hunks).toEqual([]);
    expect(diff.degraded).toBe(false);
  });

  it('单行替换 → 1 块，携带被替换的旧行', () => {
    const diff = computeFileDiff('a\nb\nc', 'a\nX\nc');
    expect(diff.hunks).toEqual([hunk(1, 1, ['b'])]);
    expect(diff.degraded).toBe(false);
  });

  it('中间纯新增 → 1 块，removed 为空', () => {
    const diff = computeFileDiff('a\nc', 'a\nB\nc');
    expect(diff.hunks).toEqual([hunk(1, 1, [])]);
  });

  it('中间纯删除 → 1 块且为删除块（endLine < startLine）', () => {
    const diff = computeFileDiff('a\nB\nc', 'a\nc');
    expect(diff.hunks).toEqual([hunk(1, 0, ['B'])]);
    expect(isRemovedOnly(diff.hunks[0])).toBe(true);
  });

  it('删 N 增 M 相邻 → 合并为同一块（不拆成「删除块 + 新增块」）', () => {
    const diff = computeFileDiff('a\nb\nc', 'a\nx\ny\nc');
    expect(diff.hunks).toEqual([hunk(1, 2, ['b'])]);
  });
});

describe('computeFileDiff：边界形态', () => {
  it('首行改动 → startLine = 0', () => {
    const diff = computeFileDiff('a\nb', 'X\nb');
    expect(diff.hunks).toEqual([hunk(0, 0, ['a'])]);
  });

  it('末行改动 → startLine 指向末行', () => {
    const diff = computeFileDiff('a\nb', 'a\nY');
    expect(diff.hunks).toEqual([hunk(1, 1, ['b'])]);
  });

  it('清空文件 → 全部旧行进入 removed，新文件无覆盖行', () => {
    const diff = computeFileDiff('a\nb', '');
    expect(diff.hunks).toEqual([hunk(0, -1, ['a', 'b'])]);
    expect(isRemovedOnly(diff.hunks[0])).toBe(true);
  });

  it('新建文件（写前为空）→ 1 块覆盖全部新行，removed 为空', () => {
    const diff = computeFileDiff('', 'x\ny');
    expect(diff.hunks).toEqual([hunk(0, 1, [])]);
  });

  it('两侧皆空 → 无改动块', () => {
    expect(computeFileDiff('', '').hunks).toEqual([]);
  });

  it('多处不连续改动 → 拆成多块', () => {
    const diff = computeFileDiff('a\nb\nc\nd\ne', 'a\nX\nc\nY\ne');
    expect(diff.hunks).toEqual([hunk(1, 1, ['b']), hunk(3, 3, ['d'])]);
  });

  it('末尾追加 → 1 块落在新增行上', () => {
    const diff = computeFileDiff('a\nb', 'a\nb\nc\nd');
    expect(diff.hunks).toEqual([hunk(2, 3, [])]);
  });
});

describe('computeFileDiff：降级', () => {
  it('中间段超出 MAX_LCS_LINES → 降级为整体一块并标记 degraded', () => {
    const size = MAX_LCS_LINES + 100;
    const before = Array.from({ length: size }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: size }, (_, i) => `new-${i}`).join('\n');
    const diff = computeFileDiff(before, after);
    expect(diff.degraded).toBe(true);
    expect(diff.hunks.length).toBe(1);
    expect(diff.hunks[0].startLine).toBe(0);
    expect(diff.hunks[0].endLine).toBe(size - 1);
    expect(diff.hunks[0].removed.length).toBe(size);
  });

  it('公共首尾裁剪后可回到精确模式（未被整体降级）', () => {
    // 首尾各 2000 行公共，中间只有 3 行改动 → 裁剪后规模极小，不应降级
    const head = Array.from({ length: 2000 }, (_, i) => `h-${i}`);
    const tail = Array.from({ length: 2000 }, (_, i) => `t-${i}`);
    const before = [...head, 'm1', 'm2', 'm3', ...tail].join('\n');
    const after = [...head, 'm1', 'M2', 'm3', ...tail].join('\n');
    const diff = computeFileDiff(before, after);
    expect(diff.degraded).toBe(false);
    expect(diff.hunks).toEqual([hunk(2001, 2001, ['m2'])]);
  });
});

describe('hunkAnchorLine', () => {
  it('非删除块 → 块首行', () => {
    expect(hunkAnchorLine(hunk(2, 4), 10)).toBe(2);
  });

  it('删除块 → 删除位置（新文件中的插入点）', () => {
    expect(hunkAnchorLine(hunk(3, 2, ['x']), 10)).toBe(3);
  });

  it('越界 → clamp 到末行', () => {
    expect(hunkAnchorLine(hunk(99, 99), 3)).toBe(2);
  });

  it('新文件为空 → 0', () => {
    expect(hunkAnchorLine(hunk(0, -1, ['x']), 0)).toBe(0);
  });
});

describe('isRemovedOnly', () => {
  it('endLine < startLine 才判为纯删除', () => {
    expect(isRemovedOnly(hunk(1, 0, ['a']))).toBe(true);
    expect(isRemovedOnly(hunk(1, 1, []))).toBe(false);
    expect(isRemovedOnly(hunk(1, 1, ['a']))).toBe(false);
  });
});
