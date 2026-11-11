/**
 * 附件行渲染域测试 — 成员顺序与显隐判据（HOST-ATT-1 汇流后）
 *
 * 为什么要有这条：图片行已于 2026-11-11 并入 `#refChips`，图片 chip 由采集层产 DOM、
 * 但**插在哪、行隐不隐**由本模块单点决定。这层判据此前只被 `chatView.test.ts` 的集成面
 * 间接覆盖（`imageCount` / `appendImageChips` 在 `__tests__` 下零命中）⇒ 一旦顺序或显隐
 * 判据被改动，集成面未必红。本文件直接对渲染域断言两件事：
 *   ① 行内顺序 = 活动文件 → 注入 → 图片 → 引用组（引用组必须连续，图片不许插进去）；
 *   ② **只有图片时这行可见**（图片计数参与空判据，不能被当成「零成员」连坐隐藏）。
 *
 * 测试形态：jsdom 环境（被测对象天然是 DOM 构造层）；不 mock `@vscode/l10n`
 * ——无 bundle 时 `t()` 返回源键，断言只认 class / dataset，不认译文。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createAttachmentRowView, type AttachmentRowState } from '../scripts/attachmentRowView.js';

/** 图片 chip 的测试替身标记：采集层真实 class 与顺序无关，本文件只验「插在哪」 */
const IMAGE_MARK = 'data-test-image-chip';
/** 引用回复胶囊的测试替身标记（真实胶囊由 chatView 的 quoteDraft 产出） */
const QUOTE_MARK = 'data-test-quote-chip';

/**
 * 搭一个最小 DOM：附件行容器 + 注入回执行（回执本文件不验，只要求节点存在即为 null 也可）
 *
 * @returns 容器节点
 */
function mountRow(): HTMLElement {
  document.body.innerHTML = '<div id="refChips" hidden></div>';
  const row = document.getElementById('refChips') as HTMLElement;
  row.hidden = true;
  return row;
}

/**
 * 创建渲染域实例：图片一律以带标记的替身 chip 追加，便于按顺序断言
 *
 * @param row 附件行容器
 * @returns 渲染域窄接口
 */
function createView(row: HTMLElement) {
  return createAttachmentRowView({
    document,
    row,
    receipt: null,
    post: () => {},
    onRemoveInjection: () => {},
    appendImageChips: (parent) => {
      // 复刻真实采集层的行为边界：只往给定父节点追加，不碰行状态
      const chip = document.createElement('span');
      chip.className = 'skill-chip image-chip';
      chip.setAttribute(IMAGE_MARK, '');
      parent.appendChild(chip);
    },
    refHandlers: {
      onOpen: () => {},
      onTogglePin: () => {},
      onRemove: () => {},
      onClearAll: () => {},
    },
  });
}

/**
 * 全空状态快照（各用例按需覆盖字段）
 *
 * @param over 覆盖项
 * @returns 状态快照
 */
function stateOf(over: Partial<AttachmentRowState> = {}): AttachmentRowState {
  return {
    activeFile: { kind: 'none' },
    injections: [],
    imageCount: 0,
    refs: [],
    quoteChip: null,
    ...over,
  };
}

describe('attachmentRowView · 行内顺序', () => {
  it('活动文件 → 注入 → 图片 → 引用回复胶囊 → 引用组（图片不得插进引用组）', () => {
    const row = mountRow();
    const view = createView(row);
    const quote = document.createElement('span');
    quote.setAttribute(QUOTE_MARK, '');

    view.render(
      stateOf({
        activeFile: { kind: 'attached', label: 'src/a.ts', injected: false },
        injections: ['problems'] as const,
        imageCount: 1,
        refs: [{ path: 'src/b.ts', kind: 'file', pinned: false }],
        quoteChip: quote,
      }),
    );

    // 按 DOM 顺序取各成员的下标：任何一步缺失都会让断言变得可读（-1）
    const indexOf = (selector: string): number =>
      Array.from(row.children).indexOf(row.querySelector(selector) as Element);
    const activeIdx = indexOf('.active-file-chip');
    const injectionIdx = indexOf('.injection-chip');
    const imageIdx = indexOf(`[${IMAGE_MARK}]`);
    const quoteIdx = indexOf(`[${QUOTE_MARK}]`);
    const refIdx = indexOf(
      '.skill-chip:not(.active-file-chip):not(.injection-chip):not(.image-chip)',
    );
    const clearIdx = indexOf('.ref-chips__clear');

    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeLessThan(injectionIdx);
    expect(injectionIdx).toBeLessThan(imageIdx);
    expect(imageIdx).toBeLessThan(quoteIdx);
    expect(quoteIdx).toBeLessThan(refIdx);
    // 引用组连续：清空按钮紧跟引用 chip，图片没有被夹在两者之间
    expect(refIdx).toBeLessThan(clearIdx);
    expect(imageIdx).toBeLessThan(clearIdx);
  });
});

describe('attachmentRowView · 显隐判据', () => {
  it('只有图片时行可见（图片计数参与空判据）', () => {
    const row = mountRow();
    const view = createView(row);

    view.render(stateOf({ imageCount: 1 }));

    expect(row.hidden).toBe(false);
    expect(row.querySelector(`[${IMAGE_MARK}]`)).not.toBeNull();
  });

  it('可见态迁回空态时行隐藏且清空（图片计数为 0 不得让空行露头）', () => {
    const row = mountRow();
    const view = createView(row);

    // 先造一个有成员的可见态：不先转一次可见，后面的「hidden === true」会被初始态白送
    view.render(stateOf({ imageCount: 1 }));
    expect(row.hidden).toBe(false);
    expect(row.children.length).toBeGreaterThan(0);

    view.render(stateOf());

    expect(row.hidden).toBe(true);
    expect(row.children.length).toBe(0);
  });
});
