/**
 * Markdown 渲染器高级场景测试（M2 补测）
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围（与 markdown.test.ts 互补，聚焦未覆盖的高级场景）：
 * - 标题完整覆盖：h4/h5/h6 + 标题内行内格式
 * - 代码块高级：多行复制内容 + 语言白名单拒绝 + 代码内 * 不被解析
 * - 引用块嵌套：引用内标题 + 引用内行内格式
 * - 表格高级：无数据行 + 单元格转义 \| + 单元格行内 Markdown
 * - 无序列表高级：三种符号 + 多层嵌套 + 缩进返回上层
 * - 有序列表高级：多层嵌套 + 缩进返回上层
 * - 段落结束条件：遇代码块/列表/引用/标题截断
 * - 行内格式完整：斜体 + 删除线 + 加粗内嵌套 + 不安全 URL 降级 + 行内代码优先
 * - convertNewlinesToBr：跳过行内代码内换行 + 多软换行
 * - 流式综合：未闭合引用 + 未闭合表格降级
 *
 * 这些场景对应 markdown.ts 中 parseFencedCodeBlock/parseBlockquote/parseTable/
 * parseUnorderedList/parseOrderedList/parseParagraph/appendInlineContent/
 * appendFormattedText/convertNewlinesToBr 的关键分支。
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../../electron/renderer/components/markdown.js';

// ─── renderMarkdown 标题完整覆盖 ─────────────────────────

describe('renderMarkdown 标题完整覆盖', () => {
  it('h4/h5/h6 标题应渲染为对应 h 标签 + md-h-N className', () => {
    // 覆盖 h4-h6 分支（现有测试仅覆盖 h1-h3）
    const fragment = renderMarkdown('#### h4\n##### h5\n###### h6');
    const h4 = fragment.querySelector('h4');
    const h5 = fragment.querySelector('h5');
    const h6 = fragment.querySelector('h6');
    expect(h4).not.toBeNull();
    expect(h5).not.toBeNull();
    expect(h6).not.toBeNull();
    expect(h4!.className).toBe('md-h md-h-4');
    expect(h5!.className).toBe('md-h md-h-5');
    expect(h6!.className).toBe('md-h md-h-6');
  });

  it('标题内行内格式应正确渲染（加粗 + 链接）', () => {
    // 标题通过 appendInlineContent 处理内容，应支持行内格式
    const fragment = renderMarkdown('# **加粗** 标题');
    const h1 = fragment.querySelector('h1')!;
    const strong = h1.querySelector('strong.md-bold');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('加粗');
  });
});

// ─── 代码块高级场景 ─────────────────────────────────────

describe('renderMarkdown 代码块高级场景', () => {
  it('多行代码块复制按钮 dataset.content 应含完整内容（含换行）', () => {
    // 验证 copyBtn.dataset.content = codeLines.join('\n')
    const fragment = renderMarkdown('```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```');
    const copyBtn = fragment.querySelector('.md-code-copy') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    // 复制内容应包含所有行，以 \n 分隔
    expect(copyBtn.dataset.content).toBe('const a = 1;\nconst b = 2;\nconst c = 3;');
    // 代码主体内容应一致
    const code = fragment.querySelector('code.md-code')!;
    expect(code.textContent).toBe('const a = 1;\nconst b = 2;\nconst c = 3;');
  });

  it('语言标签含非法字符（空格/下划线）应被白名单拒绝', () => {
    // LANGUAGE_WHITELIST = /^[a-zA-Z0-9+-]+$/，含空格或下划线应被拒绝
    const fragment = renderMarkdown('```type script\nx\n```');
    const block = fragment.querySelector('div.md-code-block') as HTMLElement;
    expect(block).not.toBeNull();
    // data-lang 不应被设置
    expect(block.dataset.lang).toBeUndefined();
    // 语言标签 span 不应被创建
    expect(block.querySelector('.md-code-lang')).toBeNull();
  });

  it('代码块内的 * 不应被解析为加粗（textContent 设置防解析）', () => {
    // 验证 parseFencedCodeBlock 用 textContent 设置内容，不走 appendInlineContent
    const fragment = renderMarkdown('```\n**not bold** *not italic*\n```');
    const code = fragment.querySelector('code.md-code')!;
    // 内容应原样保留
    expect(code.textContent).toBe('**not bold** *not italic*');
    // 不应生成 strong/em 元素
    expect(fragment.querySelector('strong')).toBeNull();
    expect(fragment.querySelector('em')).toBeNull();
  });
});

// ─── 引用块嵌套 ─────────────────────────────────────────

describe('renderMarkdown 引用块嵌套', () => {
  it('引用块内应支持嵌套 Markdown（标题）', () => {
    // parseBlockquote 递归调用 renderMarkdown
    const fragment = renderMarkdown('> # 引用内标题');
    const bq = fragment.querySelector('blockquote.md-blockquote')!;
    const h1 = bq.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe('引用内标题');
  });

  it('引用块内应支持行内格式（加粗）', () => {
    const fragment = renderMarkdown('> **加粗引用**');
    const bq = fragment.querySelector('blockquote.md-blockquote')!;
    const strong = bq.querySelector('strong.md-bold');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('加粗引用');
  });
});

// ─── 表格高级场景 ───────────────────────────────────────

describe('renderMarkdown 表格高级场景', () => {
  it('只有表头+分隔符（无数据行）应正确渲染 thead 无 tbody', () => {
    // 验证 parseTable 在 dataLines.length === 0 时不创建 tbody
    const fragment = renderMarkdown('| 名称 | 值 |\n|---|---|');
    const table = fragment.querySelector('table.md-table')!;
    expect(table.querySelector('thead')).not.toBeNull();
    // 无数据行时不应创建 tbody
    expect(table.querySelector('tbody')).toBeNull();
    // 表头单元格应存在
    expect(table.querySelectorAll('thead th.md-th').length).toBe(2);
  });

  it('表格单元格内应支持转义 \\|', () => {
    // splitTableCells 处理转义 \|
    const fragment = renderMarkdown('| a \\| b | c |\n|---|---|\n| 1 \\| 2 | 3 |');
    const trs = fragment.querySelectorAll('tbody tr');
    expect(trs.length).toBe(1);
    const tds = trs[0]!.querySelectorAll('td.md-td');
    expect(tds[0]!.textContent).toBe('1 | 2');
    expect(tds[1]!.textContent).toBe('3');
  });

  it('表格单元格内应支持行内 Markdown（加粗 + 链接）', () => {
    // appendInlineContent 在 th/td 上调用，应支持行内格式
    const fragment = renderMarkdown('| 名称 | 链接 |\n|---|---|\n| **加粗** | [点我](https://x.com) |');
    const trs = fragment.querySelectorAll('tbody tr');
    expect(trs.length).toBe(1);
    const tds = trs[0]!.querySelectorAll('td.md-td');
    // 第一列含加粗
    const strong = tds[0]!.querySelector('strong.md-bold');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('加粗');
    // 第二列含链接
    const link = tds[1]!.querySelector('a.md-link')!;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('点我');
    expect(link.getAttribute('href')).toBe('https://x.com');
  });
});

// ─── 无序列表高级场景 ───────────────────────────────────

describe('renderMarkdown 无序列表高级场景', () => {
  it('三种符号 -/*/+ 应都支持', () => {
    // 正则 /^(\s*)([-*+])\s+(.+)$/ 支持三种符号
    const fragment = renderMarkdown('- 减号\n* 星号\n+ 加号');
    const ul = fragment.querySelector('ul.md-ul')!;
    const lis = ul.querySelectorAll('li.md-li');
    expect(lis.length).toBe(3);
    expect(lis[0]!.textContent).toBe('减号');
    expect(lis[1]!.textContent).toBe('星号');
    expect(lis[2]!.textContent).toBe('加号');
  });

  it('多层嵌套（3 层）应正确生成 md-ul-nested', () => {
    // 验证嵌套栈：每 2 空格为一级
    const md = '- 第一层\n  - 第二层\n    - 第三层';
    const fragment = renderMarkdown(md);
    const uls = fragment.querySelectorAll('ul.md-ul');
    // 应有 3 个 ul（根 + 2 个嵌套）
    expect(uls.length).toBe(3);
    // 嵌套 ul 应有 md-ul-nested 类
    const nested = fragment.querySelectorAll('ul.md-ul-nested');
    expect(nested.length).toBe(2);
    // 最内层应为"第三层"
    const innermostLi = nested[1]!.querySelector('li.md-li');
    expect(innermostLi!.textContent).toBe('第三层');
  });

  it('缩进返回上层应正确（栈弹出）', () => {
    // 验证 level < currentLevel 时弹出栈
    const md = '- 外层1\n  - 内层\n- 外层2';
    const fragment = renderMarkdown(md);
    const rootUl = fragment.querySelector('ul.md-ul')!;
    // 根 ul 直接子元素应有 2 个 li（外层1、外层2）
    const directLis = rootUl.querySelectorAll(':scope > li.md-li');
    expect(directLis.length).toBe(2);
    // li.textContent 会包含嵌套子元素的文本，用 firstChild.nodeValue 取直接文本
    expect(directLis[0]!.firstChild?.nodeValue).toBe('外层1');
    expect(directLis[1]!.firstChild?.nodeValue).toBe('外层2');
    // 内层应嵌套在第一个 li 下
    const nested = directLis[0]!.querySelector('ul.md-ul-nested');
    expect(nested).not.toBeNull();
    expect(nested!.querySelector('li.md-li')!.textContent).toBe('内层');
  });
});

// ─── 有序列表高级场景 ───────────────────────────────────

describe('renderMarkdown 有序列表高级场景', () => {
  it('多层嵌套应生成 md-ol-nested', () => {
    const md = '1. 第一层\n  1. 第二层\n    1. 第三层';
    const fragment = renderMarkdown(md);
    const ols = fragment.querySelectorAll('ol.md-ol');
    expect(ols.length).toBe(3);
    const nested = fragment.querySelectorAll('ol.md-ol-nested');
    expect(nested.length).toBe(2);
  });

  it('缩进返回上层应正确（栈弹出）', () => {
    // 验证有序列表 level < currentLevel 时弹出栈
    const md = '1. 外层1\n  1. 内层\n2. 外层2';
    const fragment = renderMarkdown(md);
    const rootOl = fragment.querySelector('ol.md-ol')!;
    const directLis = rootOl.querySelectorAll(':scope > li.md-li');
    expect(directLis.length).toBe(2);
    // li.textContent 会包含嵌套子元素的文本，用 firstChild.nodeValue 取直接文本
    expect(directLis[0]!.firstChild?.nodeValue).toBe('外层1');
    expect(directLis[1]!.firstChild?.nodeValue).toBe('外层2');
  });
});

// ─── 段落结束条件 ───────────────────────────────────────

describe('renderMarkdown 段落结束条件', () => {
  it('段落遇代码块开始应截断（不合并到段落）', () => {
    // parseParagraph 检测 line.trimStart().startsWith('```') 时 break
    const md = '段落内容\n```ts\ncode\n```';
    const fragment = renderMarkdown(md);
    // 应有 1 个段落 + 1 个代码块
    expect(fragment.querySelectorAll('p.md-p').length).toBe(1);
    expect(fragment.querySelectorAll('div.md-code-block').length).toBe(1);
    const p = fragment.querySelector('p.md-p')!;
    expect(p.textContent).toBe('段落内容');
  });

  it('段落遇列表/引用/标题应截断', () => {
    // 综合验证多个块级元素结束条件
    const md = '段落内容\n- 列表项\n> 引用\n# 标题';
    const fragment = renderMarkdown(md);
    // 段落应在列表前截断
    const p = fragment.querySelector('p.md-p')!;
    expect(p.textContent).toBe('段落内容');
    // 应有列表、引用、标题
    expect(fragment.querySelector('ul.md-ul')).not.toBeNull();
    expect(fragment.querySelector('blockquote.md-blockquote')).not.toBeNull();
    expect(fragment.querySelector('h1')).not.toBeNull();
  });
});

// ─── 行内格式完整覆盖 ───────────────────────────────────

describe('renderMarkdown 行内格式完整覆盖', () => {
  it('斜体 *text* 应渲染为 em.md-italic', () => {
    // 现有测试仅覆盖加粗，此处补测斜体
    const fragment = renderMarkdown('这是 *斜体* 文本');
    const em = fragment.querySelector('em.md-italic');
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe('斜体');
  });

  it('删除线 ~~text~~ 应渲染为 del.md-strike', () => {
    const fragment = renderMarkdown('这是 ~~删除线~~ 文本');
    const del = fragment.querySelector('del.md-strike');
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe('删除线');
  });

  it('加粗内嵌套删除线应递归渲染', () => {
    // appendFormattedText 在 bold 分支递归调用 appendFormattedText
    // 注：bold 正则用 [^*]+ 排除 *，加粗内不能嵌套斜体，但可嵌套删除线（~~ 不与 * 冲突）
    const fragment = renderMarkdown('**加粗 ~~删除线~~ 嵌套**');
    const strong = fragment.querySelector('strong.md-bold')!;
    expect(strong).not.toBeNull();
    const del = strong.querySelector('del.md-strike');
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe('删除线');
  });

  it('不安全 URL 链接应添加 md-link-unsafe 类并移除 href', () => {
    // 现有测试用 if(link) 规避断言，此处直接断言降级行为
    const fragment = renderMarkdown('[恶意](javascript:alert(1))');
    const link = fragment.querySelector('a')!;
    expect(link).not.toBeNull();
    // 应有 md-link-unsafe 类
    expect(link.classList.contains('md-link-unsafe')).toBe(true);
    // href 应被移除
    expect(link.getAttribute('href')).toBeNull();
    // 文本仍应保留
    expect(link.textContent).toBe('恶意');
  });

  it('行内代码内的 * 不应被解析为斜体（行内代码优先）', () => {
    // appendInlineContent 先提取行内代码，再对剩余文本调用 appendFormattedText
    const fragment = renderMarkdown('使用 `*not italic*` 代码');
    const inlineCode = fragment.querySelector('code.md-code-inline')!;
    expect(inlineCode).not.toBeNull();
    // 行内代码内容应原样保留
    expect(inlineCode.textContent).toBe('*not italic*');
    // 不应生成 em 元素
    expect(fragment.querySelector('em')).toBeNull();
  });
});

// ─── convertNewlinesToBr ────────────────────────────────

describe('renderMarkdown convertNewlinesToBr', () => {
  it('段落内行内代码内的 \\n 不应转为 <br>', () => {
    // convertNewlinesToBr 跳过 .md-code-inline 内的文本节点
    const fragment = renderMarkdown('文本 `code\nline2` 结束');
    const p = fragment.querySelector('p.md-p')!;
    // 行内代码内的 \n 应保留在 textContent 中
    const inlineCode = p.querySelector('code.md-code-inline')!;
    expect(inlineCode.textContent).toBe('code\nline2');
    // 段落内不应有 <br>（因为 \n 在行内代码内，跳过）
    // 注意：段落本身只有一行，不会有 <br>
    expect(p.querySelectorAll('br').length).toBe(0);
  });

  it('多个软换行应生成多个 <br>', () => {
    // 验证 convertNewlinesToBr 对多个 \n 的处理
    const fragment = renderMarkdown('第一行\n第二行\n第三行');
    const p = fragment.querySelector('p.md-p')!;
    // 应有 2 个 <br>
    expect(p.querySelectorAll('br').length).toBe(2);
  });
});

// ─── 流式综合场景 ───────────────────────────────────────

describe('renderMarkdown 流式综合场景', () => {
  it('未闭合引用应渲染已收集内容（流式友好）', () => {
    // parseBlockquote 不需要闭合标记，连续 > 行收集完即返回
    // 这里测试单行引用后跟非引用内容
    const fragment = renderMarkdown('> 引用内容\n普通段落');
    const bq = fragment.querySelector('blockquote.md-blockquote');
    expect(bq).not.toBeNull();
    expect(bq!.textContent).toContain('引用内容');
    // 后续应为段落（fragment 直接子元素，不在 blockquote 内）
    // DocumentFragment 不支持 :scope >，用 children 遍历找直接子元素 p
    const directChildren = Array.from(fragment.children);
    const directP = directChildren.find(el => el.tagName === 'P' && el.classList.contains('md-p'));
    expect(directP).not.toBeNull();
    expect(directP!.textContent).toBe('普通段落');
  });

  it('未闭合表格（缺分隔符）应降级为段落', () => {
    // 表格检测需要下一行是分隔符；无分隔符则进入段落解析
    const md = '| a | b |\n这是段落';
    const fragment = renderMarkdown(md);
    // 不应有 table 元素
    expect(fragment.querySelector('table')).toBeNull();
    // 应有段落（| a | b | 和"这是段落"会被合并为一个段落，因为没有空行分隔）
    const p = fragment.querySelector('p.md-p');
    expect(p).not.toBeNull();
    expect(p!.textContent).toContain('| a | b |');
    expect(p!.textContent).toContain('这是段落');
  });
});
