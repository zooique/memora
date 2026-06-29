/**
 * Markdown 渲染器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - isSafeUrl：URL 协议白名单校验（防止 javascript:/data:/file: 等危险协议）
 * - splitTableCells：表格行单元格分割（处理转义 \|）
 * - collectMatches：正则匹配收集器（自动补 g flag）
 * - ALLOWED_LINK_PROTOCOLS / LANGUAGE_WHITELIST：安全白名单常量
 * - renderMarkdown：主入口（标题/段落/代码块/列表/引用/表格/链接/分隔线等块级+行内渲染）
 *
 * 纯函数子集无 JSDOM 依赖；renderMarkdown 主入口依赖 JSDOM 提供 DOM API。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isSafeUrl,
  splitTableCells,
  collectMatches,
  renderMarkdown,
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

// ─── renderMarkdown 主入口 ───────────────────────────────

describe('renderMarkdown', () => {
  // ─── 块级元素：标题 ───────────────────────────────────

  it('h1-h6 标题应渲染为对应 h 标签 + md-h-N className', () => {
    const fragment = renderMarkdown('# 标题1\n## 标题2\n### 标题3');
    const headings = fragment.querySelectorAll('h1, h2, h3');
    expect(headings.length).toBe(3);
    expect(headings[0]!.tagName).toBe('H1');
    expect(headings[0]!.className).toBe('md-h md-h-1');
    expect(headings[0]!.textContent).toBe('标题1');
    expect(headings[1]!.tagName).toBe('H2');
    expect(headings[2]!.tagName).toBe('H3');
  });

  // ─── 块级元素：段落 ───────────────────────────────────

  it('普通文本应渲染为 p.md-p', () => {
    const fragment = renderMarkdown('这是一段普通文本');
    const p = fragment.querySelector('p.md-p');
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe('这是一段普通文本');
  });

  it('空行分隔的多行文本应渲染为多个段落', () => {
    const fragment = renderMarkdown('第一段\n\n第二段');
    const ps = fragment.querySelectorAll('p.md-p');
    expect(ps.length).toBe(2);
    expect(ps[0]!.textContent).toBe('第一段');
    expect(ps[1]!.textContent).toBe('第二段');
  });

  it('段落内软换行应保留（\\n 转 <br>）', () => {
    const fragment = renderMarkdown('第一行\n第二行');
    const p = fragment.querySelector('p.md-p')!;
    expect(p.querySelectorAll('br').length).toBe(1);
  });

  // ─── 块级元素：代码块 ─────────────────────────────────

  it('代码块应渲染为 div.md-code-block 包裹 header + pre>code', () => {
    const fragment = renderMarkdown('```ts\nconst x = 1;\n```');
    const block = fragment.querySelector('div.md-code-block');
    expect(block).not.toBeNull();
    // 语言标签
    expect(block!.dataset.lang).toBe('ts');
    const langSpan = block!.querySelector('.md-code-lang');
    expect(langSpan!.textContent).toBe('ts');
    // 复制按钮
    const copyBtn = block!.querySelector('.md-code-copy') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.dataset.action).toBe('copy-code');
    expect(copyBtn.dataset.content).toBe('const x = 1;');
    // 代码主体
    const code = block!.querySelector('pre.md-code-pre code.md-code');
    expect(code!.textContent).toBe('const x = 1;');
  });

  it('无语言标签的代码块不应设置 data-lang', () => {
    const fragment = renderMarkdown('```\nplain code\n```');
    const block = fragment.querySelector('div.md-code-block')!;
    expect(block.dataset.lang).toBeUndefined();
    expect(block.querySelector('.md-code-lang')).toBeNull();
  });

  it('未闭合的代码块应渲染已收集内容（流式友好）', () => {
    const fragment = renderMarkdown('```ts\nconst x = 1;');
    const code = fragment.querySelector('code.md-code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('const x = 1;');
  });

  // ─── 块级元素：分隔线 ─────────────────────────────────

  it('--- 应渲染为 hr.md-hr', () => {
    const fragment = renderMarkdown('---');
    const hr = fragment.querySelector('hr.md-hr');
    expect(hr).not.toBeNull();
  });

  it('*** 和 ___ 也应渲染为 hr', () => {
    const fragment = renderMarkdown('***\n\n___');
    expect(fragment.querySelectorAll('hr').length).toBe(2);
  });

  // ─── 块级元素：引用 ───────────────────────────────────

  it('引用块应渲染为 blockquote.md-blockquote', () => {
    const fragment = renderMarkdown('> 这是一段引用');
    const bq = fragment.querySelector('blockquote.md-blockquote');
    expect(bq).not.toBeNull();
    expect(bq!.textContent).toContain('这是一段引用');
  });

  it('多行引用应合并为一个 blockquote', () => {
    const fragment = renderMarkdown('> 第一行\n> 第二行');
    expect(fragment.querySelectorAll('blockquote').length).toBe(1);
    const bq = fragment.querySelector('blockquote')!;
    expect(bq.textContent).toContain('第一行');
    expect(bq.textContent).toContain('第二行');
  });

  // ─── 块级元素：表格 ───────────────────────────────────

  it('表格应渲染为 table.md-table + thead + tbody', () => {
    const fragment = renderMarkdown('| 名称 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |');
    const table = fragment.querySelector('table.md-table');
    expect(table).not.toBeNull();
    // 表头
    const ths = table!.querySelectorAll('thead th.md-th');
    expect(ths.length).toBe(2);
    expect(ths[0]!.textContent).toBe('名称');
    // 数据行
    const trs = table!.querySelectorAll('tbody tr');
    expect(trs.length).toBe(2);
    const firstRowTds = trs[0]!.querySelectorAll('td.md-td');
    expect(firstRowTds[0]!.textContent).toBe('a');
    expect(firstRowTds[1]!.textContent).toBe('1');
  });

  it('表格对齐方式应反映到 th/td 的 style.textAlign', () => {
    const fragment = renderMarkdown('| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |');
    const ths = fragment.querySelectorAll('thead th');
    expect((ths[0] as HTMLElement).style.textAlign).toBe('left');
    expect((ths[1] as HTMLElement).style.textAlign).toBe('center');
    expect((ths[2] as HTMLElement).style.textAlign).toBe('right');
  });

  // ─── 块级元素：无序列表 ───────────────────────────────

  it('无序列表应渲染为 ul.md-ul + li.md-li', () => {
    const fragment = renderMarkdown('- 项目1\n- 项目2');
    const ul = fragment.querySelector('ul.md-ul');
    expect(ul).not.toBeNull();
    const lis = ul!.querySelectorAll('li.md-li');
    expect(lis.length).toBe(2);
    expect(lis[0]!.textContent).toBe('项目1');
  });

  it('嵌套无序列表应生成 md-ul-nested', () => {
    const fragment = renderMarkdown('- 外层\n  - 内层');
    const nested = fragment.querySelector('ul.md-ul-nested');
    expect(nested).not.toBeNull();
    expect(nested!.querySelector('li.md-li')!.textContent).toBe('内层');
  });

  // ─── 块级元素：有序列表 ───────────────────────────────

  it('有序列表应渲染为 ol.md-ol', () => {
    const fragment = renderMarkdown('1. 第一\n2. 第二');
    const ol = fragment.querySelector('ol.md-ol');
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll('li.md-li').length).toBe(2);
  });

  // ─── 行内元素 ─────────────────────────────────────────

  it('行内代码应渲染为 code.md-code-inline', () => {
    const fragment = renderMarkdown('使用 `npm install` 安装');
    const inlineCode = fragment.querySelector('code.md-code-inline');
    expect(inlineCode).not.toBeNull();
    expect(inlineCode!.textContent).toBe('npm install');
  });

  it('加粗文本应渲染为 strong', () => {
    const fragment = renderMarkdown('这是 **加粗** 文本');
    const strong = fragment.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('加粗');
  });

  it('链接应渲染为 a 标签 + 安全 href', () => {
    const fragment = renderMarkdown('[点击](https://example.com)');
    const link = fragment.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('点击');
    expect(link!.getAttribute('href')).toBe('https://example.com');
  });

  it('javascript: 链接应被过滤（XSS 防护）', () => {
    const fragment = renderMarkdown('[恶意](javascript:alert(1))');
    const link = fragment.querySelector('a');
    // 危险协议被过滤，href 不应是 javascript:
    if (link) {
      expect(link.getAttribute('href')).not.toBe('javascript:alert(1)');
    }
  });

  // ─── 综合场景 ─────────────────────────────────────────

  it('空字符串应返回空 DocumentFragment', () => {
    const fragment = renderMarkdown('');
    expect(fragment.childNodes.length).toBe(0);
  });

  it('只有空行的文本应返回空 DocumentFragment', () => {
    const fragment = renderMarkdown('\n\n\n');
    expect(fragment.childNodes.length).toBe(0);
  });

  it('\\r\\n 换行应被统一为 \\n', () => {
    const fragment = renderMarkdown('第一行\r\n第二行');
    const p = fragment.querySelector('p.md-p')!;
    // 应合并为一个段落（\r\n 被统一为 \n，段落内软换行）
    expect(p.textContent).toContain('第一行');
    expect(p.textContent).toContain('第二行');
  });

  it('混合块级元素应正确切分', () => {
    const md = '# 标题\n\n段落内容\n\n```\ncode\n```\n\n- 列表项';
    const fragment = renderMarkdown(md);
    // 应包含 h1、p、div.md-code-block、ul.md-ul 各一个
    expect(fragment.querySelector('h1')).not.toBeNull();
    expect(fragment.querySelector('p.md-p')).not.toBeNull();
    expect(fragment.querySelector('div.md-code-block')).not.toBeNull();
    expect(fragment.querySelector('ul.md-ul')).not.toBeNull();
  });
});
