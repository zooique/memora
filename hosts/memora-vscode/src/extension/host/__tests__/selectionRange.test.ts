import { describe, it, expect } from 'vitest';
import { selectionToRefRange } from '../selectionRange.js';

// 引用模式的地基：选区行号必须一次转准（0-based → 1-based），否则模型 read_file 读偏。
// 本套件锁定「基准转换唯一发生地」的全部边界，防止将来有人在多处各转一次造成漂移。
describe('编辑器选区 → 引用行区间（0-based → 1-based）', () => {
  it('多行选区（末列非 0）→ 起止各 +1', () => {
    expect(
      selectionToRefRange({
        start: { line: 4, character: 2 },
        end: { line: 23, character: 10 },
      }),
    ).toEqual({ start: 5, end: 24 });
  });

  it('整行选中（末列 0 且跨行）→ 末行回退一行，不多框空行', () => {
    // 三击 / Shift+↓ 选中第 5-24 行时 VS Code 给 end = (24, 0)，直接 +1 会变 5-25
    expect(
      selectionToRefRange({
        start: { line: 4, character: 0 },
        end: { line: 24, character: 0 },
      }),
    ).toEqual({ start: 5, end: 24 });
  });

  it('单行选区 → start === end（仍是区间引用，不是整文件）', () => {
    expect(
      selectionToRefRange({
        start: { line: 6, character: 0 },
        end: { line: 6, character: 12 },
      }),
    ).toEqual({ start: 7, end: 7 });
  });

  it('折叠选区（仅光标）→ undefined ⇒ 调用方按整文件引用（向后兼容）', () => {
    expect(
      selectionToRefRange({
        start: { line: 9, character: 3 },
        end: { line: 9, character: 3 },
      }),
    ).toBeUndefined();
  });

  it('跨行且末列 0（选中整行）→ 只回退末行，起点不受影响', () => {
    expect(
      selectionToRefRange({
        start: { line: 2, character: 0 },
        end: { line: 3, character: 0 },
      }),
    ).toEqual({ start: 3, end: 3 });
  });
});
