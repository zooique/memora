/**
 * htmlShell 测试 — `<html lang>` 回落语言与 ADR-042 默认语言对齐
 *
 * 锁的是 SSOT：manifest 默认语言文件是英文，HTML lang 的兜底不得另立一套中文。
 * 曾写死 `zh-CN`，两侧漂移且无任何测试会红（改常量此前是裸改）。
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_HTML_LANG, resolveHtmlLang, buildHtmlHead } from '../htmlShell.js';

describe('htmlShell · <html lang>', () => {
  it('缺省 / 空串回落英文（ADR-042 决策 2：默认语言 = 英文）', () => {
    expect(DEFAULT_HTML_LANG).toBe('en');
    expect(resolveHtmlLang(undefined)).toBe('en');
    expect(resolveHtmlLang('')).toBe('en');
  });

  it('环境语言可得时原样透传，不改写 locale', () => {
    expect(resolveHtmlLang('zh-cn')).toBe('zh-cn');
    expect(resolveHtmlLang('ja')).toBe('ja');
  });

  it('buildHtmlHead 把解析后的 lang 写进文档头', () => {
    const head = buildHtmlHead({
      lang: resolveHtmlLang(undefined),
      cspSource: 'vscode-resource:',
      styles: '',
    });
    expect(head).toContain('<html lang="en">');
  });
});
