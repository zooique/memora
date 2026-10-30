/**
 * quoteDraft 工厂测试 — 快照草稿状态机 + 规范引用块（COPY-2 真机反馈形态优化）
 *
 * 用 @vitest-environment jsdom 提供 DOM 环境（per-file，同 dropdown.test.ts 先例）。
 * 覆盖：
 *   - buildQuotedBlock：多行逐行前缀（多行 bug 回归锚——旧直塞形态只引首行）、
 *     CRLF 归一、空串
 *   - createQuoteDraft：set 快照 / 空选区兜底 / 替换语义（单枚）/ clear / get /
 *     chip 构造（摘要截断 + title 全文 + ✕ 回调）/ consumeFor（置顶拼接 + 消费即清）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildQuotedBlock, createQuoteDraft } from '../quoteDraft.js';

describe('buildQuotedBlock 规范引用块（发送展开形态）', () => {
  it('多行选区逐行加 > 前缀（回归锚：旧形态只引首行，第二行起掉出引用块）', () => {
    expect(buildQuotedBlock('第一行\n第二行\n第三行')).toBe('> 第一行\n> 第二行\n> 第三行');
  });

  it('CRLF 归一为 LF 后逐行前缀', () => {
    expect(buildQuotedBlock('a\r\nb')).toBe('> a\n> b');
  });

  it('单行与空串', () => {
    expect(buildQuotedBlock('单行')).toBe('> 单行');
    expect(buildQuotedBlock('')).toBe('> ');
  });
});

describe('createQuoteDraft 快照草稿状态机', () => {
  /** deps 可换的工厂快捷方式（onRemove 默认 mock，供断言） */
  function mount(onRemove = vi.fn()) {
    return { draft: createQuoteDraft({ document, onRemove }), onRemove };
  }

  it('set 暂存快照，get 取原文', () => {
    const { draft } = mount();
    expect(draft.get()).toBe('');
    draft.set('  引用内容  ');
    expect(draft.get()).toBe('引用内容'); // trim 后存
  });

  it('空选区 / 纯空白不建立草稿（when 已挡，此处兜底）', () => {
    const { draft } = mount();
    draft.set('   ');
    expect(draft.get()).toBe('');
    expect(draft.chip()).toBeNull();
  });

  it('单枚替换语义：再引用覆盖旧快照', () => {
    const { draft } = mount();
    draft.set('第一段');
    draft.set('第二段');
    expect(draft.get()).toBe('第二段');
  });

  it('chip：skill-chip 同构 + 摘要截断 + title 全文', () => {
    const { draft } = mount();
    const full = '一个超过二十四个字符的长选区内容，用来验证摘要截断逻辑是否正确生效加省略号';
    draft.set(full);
    const chip = draft.chip() as HTMLElement;
    expect(chip.className).toBe('skill-chip');
    const name = chip.querySelector('.skill-chip__name') as HTMLElement;
    // 可见文本 = 截断摘要；title = 全文（截断补偿）
    expect(name.textContent?.startsWith('引用：')).toBe(true);
    expect(name.textContent?.endsWith('…')).toBe(true);
    expect(name.textContent!.length).toBeLessThan(`引用：${full}`.length);
    expect(name.title).toBe(full);
  });

  it('chip ✕ 移除：清状态 + 触发 onRemove 回调', () => {
    const onRemove = vi.fn();
    const { draft } = mount(onRemove);
    draft.set('内容');
    const chip = draft.chip() as HTMLElement;
    const remove = chip.querySelector('.skill-chip__remove') as HTMLButtonElement;
    remove.click();
    expect(draft.get()).toBe('');
    expect(onRemove).toHaveBeenCalledTimes(1);
    // 清后再构造 = null
    expect(draft.chip()).toBeNull();
  });

  it('consumeFor：有草稿 = 引用块置顶（\\n\\n 分隔）+ 消费即清', () => {
    const { draft } = mount();
    draft.set('被引用的话');
    const out = draft.consumeFor('用户的问题');
    expect(out).toBe('> 被引用的话\n\n用户的问题');
    expect(draft.get()).toBe(''); // 快照即焚
  });

  it('consumeFor：无草稿 = 原样返回', () => {
    const { draft } = mount();
    expect(draft.consumeFor('原样')).toBe('原样');
  });

  it('clear 直清', () => {
    const { draft } = mount();
    draft.set('内容');
    draft.clear();
    expect(draft.get()).toBe('');
    expect(draft.chip()).toBeNull();
  });
});
