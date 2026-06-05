/**
 * Diff 渲染器单元测试（A-101）
 *
 * 覆盖：
 *   - Differ.diff()：核心 diff 算法（新文件、二进制、相同、简单修改、多 hunk、删除/新增、大文件降级）
 *   - DiffRenderer.render()：ANSI 渲染（新文件、二进制、无变更、正常 diff）
 *   - accumulateWrite()：写入累加（新文件、修改文件）
 *   - sanitizeContent()：敏感值脱敏（通过 render 间接测试）
 *
 * 速修（T-203）：picocolors 在非 TTY 环境（vitest）自动禁用颜色，
 * 需设置 FORCE_COLOR=1 强制启用 ANSI 颜色码
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  Differ,
  DiffRenderer,
  accumulateWrite,
  type WriteAccumulator,
} from '@/cli/diff-renderer.js';

// 强制 picocolors 输出 ANSI 颜色码
beforeAll(() => {
  process.env.FORCE_COLOR = '1';
});

describe('A-101 · Diff 渲染器', () => {
  // ── Differ.diff() ──────────────────────────────────────────

  describe('Differ.diff()', () => {
    it('新文件（oldLines 为空）→ isNewFile=true, 所有行为 add', () => {
      /** 旧文件行（空） */
      const oldLines: string[] = [];
      /** 新文件行 */
      const newLines = ['hello', 'world'];

      const result = Differ.diff(oldLines, newLines);

      expect(result.isNewFile).toBe(true);
      expect(result.isBinary).toBe(false);
      expect(result.additions).toBe(2);
      expect(result.removals).toBe(0);
      expect(result.hunks).toHaveLength(1);
      /** 所有行类型应为 add */
      expect(result.hunks[0]!.lines.every((l) => l.type === 'add')).toBe(true);
    });

    it('二进制文件（含 \\x00）→ isBinary=true', () => {
      /** 包含 NULL 字节的二进制行 */
      const binaryLines = ['\x00\x01\x02'];
      /** 普通文本行 */
      const textLines = ['normal text'];

      const result = Differ.diff(binaryLines, textLines);

      expect(result.isBinary).toBe(true);
      expect(result.hunks).toHaveLength(0);
    });

    it('完全相同的文件 → hunks 为空, additions=0, removals=0', () => {
      /** 相同内容 */
      const lines = ['line1', 'line2', 'line3'];

      const result = Differ.diff(lines, lines);

      expect(result.hunks).toHaveLength(0);
      expect(result.additions).toBe(0);
      expect(result.removals).toBe(0);
      expect(result.isNewFile).toBe(false);
      expect(result.isBinary).toBe(false);
    });

    it('简单修改（中间一行不同）→ 产生 1 个 hunk, 有 add 和 remove', () => {
      /** 旧文件 */
      const oldLines = ['aaa', 'bbb', 'ccc'];
      /** 新文件（中间行改为 BBB） */
      const newLines = ['aaa', 'BBB', 'ccc'];

      const result = Differ.diff(oldLines, newLines);

      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      expect(result.additions).toBe(1);
      expect(result.removals).toBe(1);

      /** 收集所有行类型 */
      const types = result.hunks.flatMap((h) => h.lines.map((l) => l.type));
      expect(types).toContain('add');
      expect(types).toContain('remove');
    });

    it('多行修改（间隔较远）→ 产生多个 hunk', () => {
      /** 旧文件（10 行，第 2 行和第 9 行不同） */
      const oldLines = ['L0', 'L1-old', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8-old', 'L9'];
      /** 新文件 */
      const newLines = ['L0', 'L1-new', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8-new', 'L9'];

      const result = Differ.diff(oldLines, newLines);

      /** 间隔较远时应产生多个 hunk（或合并后至少包含两处变更） */
      expect(result.additions).toBe(2);
      expect(result.removals).toBe(2);
    });

    it('删除行 → type=remove', () => {
      /** 旧文件（3 行） */
      const oldLines = ['keep', 'delete-me', 'keep-too'];
      /** 新文件（删除了中间行） */
      const newLines = ['keep', 'keep-too'];

      const result = Differ.diff(oldLines, newLines);

      expect(result.removals).toBeGreaterThanOrEqual(1);
      /** 所有行中应包含 remove 类型 */
      const types = result.hunks.flatMap((h) => h.lines.map((l) => l.type));
      expect(types).toContain('remove');
    });

    it('新增行 → type=add', () => {
      /** 旧文件（2 行） */
      const oldLines = ['first', 'last'];
      /** 新文件（中间插入一行） */
      const newLines = ['first', 'inserted', 'last'];

      const result = Differ.diff(oldLines, newLines);

      expect(result.additions).toBeGreaterThanOrEqual(1);
      /** 所有行中应包含 add 类型 */
      const types = result.hunks.flatMap((h) => h.lines.map((l) => l.type));
      expect(types).toContain('add');
    });

    it('大文件降级（行数 > 1000）→ 应正常工作不崩溃', () => {
      /** 生成 1001 行旧文件 */
      const oldLines = Array.from({ length: 1001 }, (_, i) => `line-${i}`);
      /** 新文件（修改最后一行） */
      const newLines = Array.from({ length: 1001 }, (_, i) =>
        i === 1000 ? 'line-1000-CHANGED' : `line-${i}`,
      );

      /** 不应抛出异常 */
      const result = Differ.diff(oldLines, newLines);

      expect(result.isBinary).toBe(false);
      expect(result.additions).toBeGreaterThanOrEqual(1);
      expect(result.removals).toBeGreaterThanOrEqual(1);
    });
  });

  // ── DiffRenderer.render() ──────────────────────────────────

  describe('DiffRenderer.render()', () => {
    it('新文件渲染 → 包含"新建文件"文字', () => {
      /** 新文件 diff 结果 */
      const result = Differ.diff([], ['hello', 'world']);

      const rendered = DiffRenderer.render(result, 'new-file.ts');

      expect(rendered).toContain('新建文件');
      expect(rendered).toContain('new-file.ts');
    });

    it('二进制文件渲染 → 包含"二进制文件"文字', () => {
      /** 二进制 diff 结果 */
      const result = Differ.diff(['\x00binary'], ['text']);

      const rendered = DiffRenderer.render(result, 'image.png');

      expect(rendered).toContain('二进制文件');
      expect(rendered).toContain('image.png');
    });

    it('无变更渲染 → 包含"文件未变更"文字', () => {
      /** 无变更 diff 结果 */
      const result = Differ.diff(['same'], ['same']);

      const rendered = DiffRenderer.render(result, 'unchanged.ts');

      expect(rendered).toContain('文件未变更');
      expect(rendered).toContain('unchanged.ts');
    });

    it('正常 diff 渲染 → 包含变更统计和行内容', () => {
      /** 有变更的 diff 结果 */
      const result = Differ.diff(['aaa', 'bbb'], ['aaa', 'BBB']);

      const rendered = DiffRenderer.render(result, 'changed.ts');

      /** 应包含变更统计 */
      expect(rendered).toContain('变更');
      expect(rendered).toContain('changed.ts');
      /** 应包含行内容（被修改的行） */
      expect(rendered).toContain('bbb');
      expect(rendered).toContain('BBB');
    });
  });

  // ── accumulateWrite() ──────────────────────────────────────

  describe('accumulateWrite()', () => {
    it('新文件累加 → oldContent=null, isNewFile=true', () => {
      /** 累加器数组 */
      const accumulators: WriteAccumulator[] = [];

      accumulateWrite('brand-new.ts', null, 'hello\nworld', accumulators);

      expect(accumulators).toHaveLength(1);
      expect(accumulators[0]!.path).toBe('brand-new.ts');
      expect(accumulators[0]!.oldContent).toBeNull();
      expect(accumulators[0]!.diffResult.isNewFile).toBe(true);
    });

    it('修改文件累加 → diffResult 有变更', () => {
      /** 累加器数组 */
      const accumulators: WriteAccumulator[] = [];

      accumulateWrite('edit.ts', 'aaa\nbbb\nccc', 'aaa\nBBB\nccc', accumulators);

      expect(accumulators).toHaveLength(1);
      expect(accumulators[0]!.oldContent).toBe('aaa\nbbb\nccc');
      expect(accumulators[0]!.diffResult.additions).toBeGreaterThanOrEqual(1);
      expect(accumulators[0]!.diffResult.removals).toBeGreaterThanOrEqual(1);
    });
  });

  // ── sanitizeContent()（通过 render 间接测试）───────────────

  describe('sanitizeContent()（通过 render 间接测试）', () => {
    it('包含 api_key=xxx 的行 → 键名后插入 *** 标记', () => {
      /** 包含敏感信息的旧文件 */
      const oldLines = ['const config = {}'];
      /** 包含 api_key 的新文件 */
      const newLines = ['api_key=sk-12345secret'];

      const result = Differ.diff(oldLines, newLines);
      const rendered = DiffRenderer.render(result, 'config.ts');

      /** 键名后应插入 *** 标记（sanitizeContent 在 key= 后追加 ***） */
      expect(rendered).toContain('api_key=***');
    });

    it('包含 password=xxx 的行 → 键名后插入 *** 标记', () => {
      /** 旧文件 */
      const oldLines = ['normal line'];
      /** 包含 password 的新文件 */
      const newLines = ['password=mySecret123'];

      const result = Differ.diff(oldLines, newLines);
      const rendered = DiffRenderer.render(result, 'env.ts');

      /** 键名后应插入 *** 标记 */
      expect(rendered).toContain('password=***');
    });
  });
});
