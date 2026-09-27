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
  applyHunkReverts,
  computeFileDiff,
  formatUnifiedDiff,
  hunkAnchorLine,
  hunkKey,
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

/**
 * `applyHunkReverts`：块级回退原语（拒绝一块 = 区间替换；接受一块 = 用它算新基线）
 *
 * 变异验证锚点：`ordered` 的降序排序一旦改成升序（或删掉），「多块还原 = before」这条
 * 会立即变红——升序会让后一块的行号因前一块长度变化而错位。本组用例即为该不变量的守卫。
 */
describe('applyHunkReverts：块级还原', () => {
  it('无块 → 原文不动', () => {
    expect(applyHunkReverts('a\nb', [])).toBe('a\nb');
  });

  it('还原纯新增块 → 新增行消失，回到写前内容', () => {
    const before = 'a\nc';
    const after = 'a\nB\nc';
    const { hunks } = computeFileDiff(before, after);
    expect(applyHunkReverts(after, hunks)).toBe(before);
  });

  it('还原替换块 → 换回旧行（不是删掉）', () => {
    const before = 'a\nb\nc';
    const after = 'a\nX\nc';
    const { hunks } = computeFileDiff(before, after);
    expect(applyHunkReverts(after, hunks)).toBe(before);
  });

  it('还原纯删除块 → 把删除的旧行插回原位', () => {
    const before = 'a\nB\nc';
    const after = 'a\nc';
    const { hunks } = computeFileDiff(before, after);
    expect(applyHunkReverts(after, hunks)).toBe(before);
  });

  it('还原末尾追加块 → 追加内容移除', () => {
    const before = 'a\nb';
    const after = 'a\nb\nc\nd';
    const { hunks } = computeFileDiff(before, after);
    expect(applyHunkReverts(after, hunks)).toBe(before);
  });

  it('多块一次性还原 = 写前内容（降序处理的守卫）', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nX\nc\nY\ne';
    const { hunks } = computeFileDiff(before, after);
    expect(hunks.length).toBe(2);
    expect(applyHunkReverts(after, hunks)).toBe(before);
  });

  it('只还原其中一块 → 另一块内容保留在同一位置', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nX\nc\nY\ne';
    const { hunks } = computeFileDiff(before, after);
    // 还原第 2 块（Y → d），第 1 块（X）不受影响
    expect(applyHunkReverts(after, [hunks[1]])).toBe('a\nX\nc\nd\ne');
    // 还原第 1 块（X → b），第 2 块（Y）不受影响
    expect(applyHunkReverts(after, [hunks[0]])).toBe('a\nb\nc\nY\ne');
  });

  it('真机形态：中段插入 + 末尾追加，两块分别还原互不串位', () => {
    // 对位 2026-09-27 真机数据：块 1 = 中段插入，块 2 = 文末追加，中间隔着未改动行
    const beforeLines = Array.from({ length: 28 }, (_, i) => `L${i + 1}`);
    const before = beforeLines.join('\n');
    const after = [...beforeLines.slice(0, 27), 'N1', 'N2', 'N3', 'L28', 'T1', 'T2'].join('\n');
    const { hunks } = computeFileDiff(before, after);
    expect(hunks.length).toBe(2);
    // 两块**都是插入**（count > 0、removed 为空）⇒ 还原会改变行数，
    // 升序处理会让后一块的行号整体前移、splice 打空 —— 这条是降序处理的真正守卫
    expect(applyHunkReverts(after, hunks)).toBe(before);
    expect(applyHunkReverts(after, [hunks[0]])).toBe([...beforeLines, 'T1', 'T2'].join('\n'));
    expect(applyHunkReverts(after, [hunks[1]])).toBe(
      [...beforeLines.slice(0, 27), 'N1', 'N2', 'N3', 'L28'].join('\n'),
    );
  });

  it('清空文件的删除块 → 旧内容整份插回', () => {
    const before = 'a\nb';
    const { hunks } = computeFileDiff(before, '');
    expect(applyHunkReverts('', hunks)).toBe(before);
  });
});

/**
 * 「接受一块」的语义闭环（不引入块存活集，靠重算 diff 派生）
 *
 * 推导：基线 = 当前内容剔除**未接受**的块（`applyHunkReverts(after, 其余块)`）。
 * 本组钉死两条：① 被接受的块在新 diff 里消失；② **其余块的行坐标不变**——
 * 这正是「无需维护块索引 / 无坐标漂移面」的实证。
 */
describe('接受一块后的基线（git index 模型）', () => {
  const before = 'a\nb\nc\nd\ne';
  const after = 'a\nX\nc\nY\ne';
  const { hunks } = computeFileDiff(before, after);

  it('接受第 1 块 → 新 diff 只剩第 2 块，且坐标仍是 3', () => {
    const baseline = applyHunkReverts(after, [hunks[1]]);
    expect(baseline).toBe('a\nX\nc\nd\ne');
    expect(computeFileDiff(baseline, after).hunks).toEqual([hunk(3, 3, ['d'])]);
  });

  it('接受第 2 块 → 新 diff 只剩第 1 块，且坐标仍是 1', () => {
    const baseline = applyHunkReverts(after, [hunks[0]]);
    expect(baseline).toBe('a\nb\nc\nY\ne');
    expect(computeFileDiff(baseline, after).hunks).toEqual([hunk(1, 1, ['b'])]);
  });

  it('接受全部块 → diff 为空（与「文件级确认」同一收口，无特判）', () => {
    const baseline = applyHunkReverts(after, []);
    expect(baseline).toBe(after);
    expect(computeFileDiff(baseline, after).hunks).toEqual([]);
  });
});

describe('hunkKey：块寻址指纹', () => {
  it('同一块同一内容 → 同一指纹（渲染与点击对得上）', () => {
    const after = 'a\nX\nc';
    const { hunks } = computeFileDiff('a\nb\nc', after);
    expect(hunkKey(hunks[0], after)).toBe(hunkKey(hunks[0], after));
  });

  it('内容变了 → 指纹变（防止拿旧按钮打新块）', () => {
    const { hunks } = computeFileDiff('a\nb\nc', 'a\nX\nc');
    expect(hunkKey(hunks[0], 'a\nX\nc')).not.toBe(hunkKey(hunks[0], 'a\nZ\nc'));
  });

  it('位置不同、内容相同 → 指纹不同（消歧：两处插入同一行不可互换）', () => {
    const after = 'a\nX\nc\nX\ne';
    const { hunks } = computeFileDiff('a\nb\nc\nd\ne', after);
    expect(hunks.length).toBe(2);
    expect(hunkKey(hunks[0], after)).not.toBe(hunkKey(hunks[1], after));
  });

  it('旧行不同 → 指纹不同（同为新增块也不可互换）', () => {
    const one = computeFileDiff('a\nb\nc', 'a\nX\nc').hunks[0];
    const two = computeFileDiff('a\nz\nc', 'a\nX\nc').hunks[0];
    expect(hunkKey(one, 'a\nX\nc')).not.toBe(hunkKey(two, 'a\nX\nc'));
  });

  it('纯删除块：指纹由「删了什么 + 删在哪」构成（纯删除块无新增行，故只认 removed）', () => {
    const after = 'a\nc';
    const delB = computeFileDiff('a\nB\nc', after).hunks[0];
    const delZ = computeFileDiff('a\nZ\nc', after).hunks[0];
    // 同位置、删掉的内容不同 ⇒ 指纹必须不同（否则会张冠李戴地插回错误的旧行）
    expect(hunkKey(delB, after)).not.toBe(hunkKey(delZ, after));
    // 同位置、内容相同 ⇒ 同一指纹（不会因为「文件别处还有内容」而无谓变化）
    expect(hunkKey(delB, after)).toBe(hunkKey(delB, 'a\nc\nD'));
  });

});

describe('formatUnifiedDiff：上下排列的对照文本', () => {
  it('首行标题 + 改动计数，跨行旧/新内容分块排列', () => {
    const text = formatUnifiedDiff('a\nb\nc', 'a\nX\nc', 'a.md — 本次改动');
    const lines = text.split('\n');
    expect(lines[0]).toBe('a.md — 本次改动');
    expect(lines[1]).toBe('共 1 处改动');
    expect(lines).toContain('- b');
    expect(lines).toContain('+ X');
  });

  it('多块：每块各有自己的分隔头与序号', () => {
    const text = formatUnifiedDiff('a\nb\nc\nd\ne', 'a\nX\nc\nY\ne', 't');
    expect(text).toContain('改动 1/2');
    expect(text).toContain('改动 2/2');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- b', '- d']);
    expect(text.split('\n').filter((l) => l.startsWith('+ '))).toEqual(['+ X', '+ Y']);
    // 顺序也是契约：同一处改动**先旧后新**（上下排列的语义所在），且块间按文件顺序
    expect(text.indexOf('- b')).toBeLessThan(text.indexOf('+ X'));
    expect(text.indexOf('+ X')).toBeLessThan(text.indexOf('- d'));
  });

  it('纯删除块：只有 - 行，没有 + 行（并标明删除位置）', () => {
    const text = formatUnifiedDiff('a\nB\nc', 'a\nc', 't');
    expect(text).toContain('纯删除');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- B']);
    expect(text.split('\n').filter((l) => l.startsWith('+ '))).toEqual([]);
  });

  it('新建文件：只有 + 行；清空文件：只有 - 行', () => {
    const created = formatUnifiedDiff('', 'x\ny', 't');
    expect(created.split('\n').filter((l) => l.startsWith('+ '))).toEqual(['+ x', '+ y']);
    expect(created.split('\n').filter((l) => l.startsWith('- '))).toEqual([]);
    const cleared = formatUnifiedDiff('x\ny', '', 't');
    expect(cleared.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- x', '- y']);
    expect(cleared.split('\n').filter((l) => l.startsWith('+ '))).toEqual([]);
  });

  it('无改动：0 处改动、无块内容', () => {
    const text = formatUnifiedDiff('a\nb', 'a\nb', 't');
    expect(text).toContain('共 0 处改动');
    expect(text.split('\n').filter((l) => l.startsWith('- ') || l.startsWith('+ '))).toEqual([]);
  });

  it('每行改动都带 - / + 前缀（上下排列靠前缀区分，不靠左右分栏）', () => {
    const text = formatUnifiedDiff('a\nb\nc', 'a\nX\nc', 't');
    // 未改动的公共行**不出现**：对照只呈现改动本身（免受全文噪音干扰）
    expect(text).not.toContain('- a');
    expect(text).not.toContain('+ c');
  });
});
