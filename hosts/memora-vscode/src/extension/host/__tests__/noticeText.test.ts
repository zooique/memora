/**
 * toNoticeText 单测——宿主错误通知单一出口
 *
 * 守卫三件事：
 * 1. MemoraError 由**宿主自渲染**三层（标题 + 原因 + 建议），不得退化成只有标题的 message
 *    （本函数存在的根因：`err.message` 转发会把内核诊断吞在宿主边界）；
 * 2. 普通 Error 维持 err.message 原语义（零行为变化承诺）；
 * 3. 非 Error 值 String 化兜底（与替换前的原表达式对齐）；
 * 4. 7.0.0 起标签走 `vscode.l10n.t` ⇒ 单测（默认语言）断言**英文标签**；
 *    中文译文由 `l10n/bundle.l10n.zh-cn.json` 提供（键面守卫 ⑧⑨⑩ 覆盖）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { MemoraError } from '@zooique/memora';

// l10n.t 替身：{0} 占位符按参替换（默认语言 = 键本身，与 vscode 运行时一致）
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)] ?? '')),
  },
}));

import { toNoticeText } from '../noticeText.js';

describe('toNoticeText —— 宿主错误通知单一出口', () => {
  // 契约 = 「三层信息不被宿主边界吞掉」+「标签可本地化（默认语言为英文键）」
  it('MemoraError → 三层全文：标题、原因、建议俱在（标签走 l10n）', () => {
    // 构造与内核 forkSession 同形态的结构化错误（title 有、detail 有、建议有）
    const err = new MemoraError({
      title: '无法分叉会话',
      detail: 'Round 不存在于当前会话: round-1791351735059',
      suggestions: ['切换到 Round 所属的会话后再分叉'],
      category: 'config',
    });

    const text = toNoticeText(err);

    // 多行全文：三层信息都必须在——只断言不被吞，不断言精确排版
    expect(text).toContain('❌ Error: 无法分叉会话');
    expect(text).toContain('Reason: Round 不存在于当前会话: round-1791351735059');
    expect(text).toContain('Suggestions:');
    expect(text).toContain('切换到 Round 所属的会话后再分叉');
    // 反面锚：裸 message 只有标题——全文必须比它多（防未来渲染退化）
    expect(text).not.toBe(err.message);
  });

  it('无 detail 的 MemoraError → 不炸，输出标题（+建议若有）', () => {
    const err = new MemoraError({
      title: '装配未完成',
      suggestions: ['等待装配完成'],
      category: 'config',
    });
    const text = toNoticeText(err);
    expect(text).toContain('❌ Error: 装配未完成');
    expect(text).not.toContain('Reason:');
    expect(text).toContain('Suggestions:');
  });

  it('普通 Error → 维持 err.message 原语义', () => {
    expect(toNoticeText(new Error('ENOENT: file not found'))).toBe('ENOENT: file not found');
  });

  it('非 Error 值 → String 化兜底（与替换前原表达式对齐）', () => {
    expect(toNoticeText('plain string')).toBe('plain string');
    expect(toNoticeText(42)).toBe('42');
    expect(toNoticeText(undefined)).toBe('undefined');
  });
});
