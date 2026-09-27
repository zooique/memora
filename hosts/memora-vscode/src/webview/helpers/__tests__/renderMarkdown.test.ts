/**
 * renderMarkdown 守卫测试（宿主渲染纵深防线 · 静默失败修复）
 *
 * 覆盖「净化前有可读文本 && 净化后为空 → 回退转义原文」判据（守卫 W1/W2）：
 * - W1：全文本工具骨架被净化撕空 → 回退为转义非空串，不显示空白；
 * - W2：合法「无文本」markdown（如 `---` 分隔线）不被误回退——判据是
 *   「净化前有可读字符且净化后为空」，非「原文非空」。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../renderMarkdown.js';
import type { SanitizeFn } from '../sanitizer.js';

/** 仿真「全标签被 DOMPurify 撕空」的净化函数 */
function purgeAll(): SanitizeFn {
  return () => '';
}

/** 仿真「原样放行」的净化函数（不含标签判据） */
function passthrough(): SanitizeFn {
  return (html: string) => html;
}

describe('renderMarkdown · 净化后为空回退转义（纵深防线）', () => {
  it('W1: 全文本工具标签净化后为空 → 回退转义显原文（不空白）', () => {
    const text = '<tool_call>\n<function=list_dir</parameter>\n</function>\n</tool_call>';
    const html = renderMarkdown(text, purgeAll());
    // 回退为转义原文，非空且不残留可执行标签
    expect(html).not.toBe('');
    expect(html).toContain('&lt;tool_call&gt;');
    expect(html).not.toContain('<tool_call>');
  });

  it('W2: 合法无文本 markdown（---）净化后仍非空 → 不误回退（照常渲染）', () => {
    const html = renderMarkdown('---', passthrough());
    // marked 解析 --- 为 <hr>，净化非空，正常路径不被「原文非空」误伤
    expect(html).not.toBe('');
    expect(html).toContain('<hr');
  });

  it('普通文本净化非空 → 原样返回，不受回退影响', () => {
    const html = renderMarkdown('你好，世界', passthrough());
    expect(html).toContain('你好，世界');
  });
});
