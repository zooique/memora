/**
 * Markdown 渲染器纯函数子集测试
 *
 * 覆盖范围：
 * - isSafeUrl：URL 协议白名单校验（防止 javascript:/data:/file: 等危险协议）
 * - splitTableCells：表格行单元格分割（处理转义 \|）
 * - collectMatches：正则匹配收集器（自动补 g flag）
 * - ALLOWED_LINK_PROTOCOLS / LANGUAGE_WHITELIST：安全白名单常量
 *
 * 仅测试纯函数子集（对齐 domHelpers.format* 提取模式），renderMarkdown 主入口
 * 及其余解析函数重度依赖 DOM，需 JSDOM + 复杂 mock，留待后续按需补充。
 *
 * 纯逻辑测试，无 JSDOM 依赖。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isSafeUrl,
  splitTableCells,
  collectMatches,
  ALLOWED_LINK_PROTOCOLS,
  LANGUAGE_WHITELIST,
} from '../../electron/renderer/components/markdown.js';

// ─── ALLOWED_LINK_PROTOCOLS 常量 ─────────────────────────────

describe('ALLOWED_LINK_PROTOCOLS', () => {
  it('应包含 http/https/mailto 三个协议', () => {
    expect(ALLOWED_LINK_PROTOCOLS).toEqual(['http:', 'https:', 'mailto:']);
  });
});

// ─── LANGUAGE_WHITELIST 常量 ─────────────────────────────────

describe('LANGUAGE_WHITELIST', () => {
  it('纯字母应通过', () => {
    expect(LANGUAGE_WHITELIST.test('typescript')).toBe(true);
  });

  it('字母+数字应通过', () => {
    expect(LANGUAGE_WHITELIST.test('js12')).toBe(true);
  });

  it('含 + 号应通过（c++ 等语言名）', () => {
    expect(LANGUAGE_WHITELIST.test('c++')).toBe(true);
  });

  it('含下划线应拒绝（_ 不在白名单）', () => {
    expect(LANGUAGE_WHITELIST.test('rust_lang')).toBe(false);
  });

  it('含空格应拒绝', () => {
    expect(LANGUAGE_WHITELIST.test('type script')).toBe(false);
  });
});

// ─── isSafeUrl ─────────────────────────────────────────────

describe('isSafeUrl', () => {
  it('http 协议应通过', () => {
    expect(isSafeUrl('http://example.com')).toBe(true);
  });

  it('https 协议应通过', () => {
    expect(isSafeUrl('https://example.com/path')).toBe(true);
  });

  it('mailto 协议应通过', () => {
    expect(isSafeUrl('mailto:test@example.com')).toBe(true);
  });

  it('javascript 协议应拒绝（XSS 防护）', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('data 协议应拒绝', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('file 协议应拒绝', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('相对路径应以 / 开头通过', () => {
    expect(isSafeUrl('/path/to/resource')).toBe(true);
  });

  it('锚点应以 # 开头通过', () => {
    expect(isSafeUrl('#section-1')).toBe(true);
  });

  it('空字符串应拒绝', () => {
    expect(isSafeUrl('')).toBe(false);
  });

  it('纯空格应拒绝（trim 后为空）', () => {
    expect(isSafeUrl('   ')).toBe(false);
  });

  it('非 URL 纯文本应拒绝', () => {
    expect(isSafeUrl('hello world')).toBe(false);
  });

  it('带前后空格的 URL 应 trim 后校验通过', () => {
    expect(isSafeUrl('  https://example.com  ')).toBe(true);
  });
});

// ─── splitTableCells ───────────────────────────────────────

describe('splitTableCells', () => {
  it('标准单元格应正确分割', () => {
    expect(splitTableCells('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('无首尾管道符也应正确分割', () => {
    expect(splitTableCells('a | b | c')).toEqual(['a', 'b', 'c']);
  });

  it('转义管道符 \\| 不应分割', () => {
    // a\|b 是一个整体单元格，c 是第二个单元格
    expect(splitTableCells('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('空单元格应被过滤', () => {
    expect(splitTableCells('| a | | c |')).toEqual(['a', 'c']);
  });

  it('单元格首尾空格应 trim', () => {
    expect(splitTableCells('|  a  |  b  |')).toEqual(['a', 'b']);
  });

  it('空字符串应返回空数组', () => {
    expect(splitTableCells('')).toEqual([]);
  });

  it('只有管道符和空格应返回空数组（空单元格被过滤）', () => {
    expect(splitTableCells('| | |')).toEqual([]);
  });
});

// ─── collectMatches ────────────────────────────────────────

describe('collectMatches', () => {
  it('全局正则应收集所有匹配项', () => {
    const callback = vi.fn();
    collectMatches(/\d+/g, 'a1b22c333', callback);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenNthCalledWith(1, expect.objectContaining({ 0: '1' }));
    expect(callback).toHaveBeenNthCalledWith(2, expect.objectContaining({ 0: '22' }));
    expect(callback).toHaveBeenNthCalledWith(3, expect.objectContaining({ 0: '333' }));
  });

  it('非全局正则应自动补 g flag', () => {
    const callback = vi.fn();
    // 传入非全局正则，collectMatches 内部应自动补 g，否则会无限循环
    collectMatches(/\d+/, 'a1b22c333', callback);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('空文本不应触发回调', () => {
    const callback = vi.fn();
    collectMatches(/\d+/g, '', callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('无匹配不应触发回调', () => {
    const callback = vi.fn();
    collectMatches(/\d+/g, 'no numbers here', callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('回调应接收完整 RegExpExecArray（含 index/input 属性）', () => {
    const callback = vi.fn();
    collectMatches(/(\w)(\d)/g, 'a1b2', callback);
    expect(callback).toHaveBeenNthCalledWith(1, expect.objectContaining({
      0: 'a1',
      1: 'a',
      2: '1',
      index: 0,
      input: 'a1b2',
    }));
  });
});
