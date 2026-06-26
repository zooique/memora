/**
 * 安全的 Markdown 渲染器（零依赖，使用 DOM API）
 *
 * 职责：
 * - 将 Markdown 文本解析为 DOM 节点（DocumentFragment）
 * - 支持 LLM 常见输出格式：代码块、列表、表格、标题、加粗、斜体、链接、引用、分割线
 * - 流式友好：每次调用都是无状态的完整渲染，可重复调用
 *
 * 安全设计：
 * - 所有文本通过 textContent 设置（天然防 XSS）
 * - 链接 URL 经过协议白名单校验（仅允许 http/https/mailto）
 * - 不使用 innerHTML，避免 HTML 注入
 * - 代码块语言标签经过白名单过滤（仅允许字母数字和连字符）
 *
 * 设计契约：docs/memora-sprite-preview.html §6.2 .message-bubble
 * 精灵消息使用系统字体栈（--font-sprite），代码块使用等宽字体
 */

// ─── 常量 ─────────────────────────────────────────────────

/** 允许的链接协议白名单（防止 javascript: 等危险协议） */
const ALLOWED_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const;

/** 代码块语言白名单正则（仅允许字母数字和连字符，防止注入） */
const LANGUAGE_WHITELIST = /^[a-zA-Z0-9+-]+$/;

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 将 Markdown 文本渲染为 DocumentFragment
 *
 * @param text Markdown 格式文本
 * @returns DocumentFragment，可直接 appendChild 到目标元素
 */
export function renderMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  // 统一换行符（处理 \r\n 和 \r）
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 按行分割，保留空行用于段落分隔
  const lines = normalizedText.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // 跳过空行（段落分隔由后续块元素处理）
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 1. 代码块（```lang ... ```）
    if (line.trimStart().startsWith('```')) {
      const { node, consumed } = parseFencedCodeBlock(lines, i);
      if (node) {
        fragment.appendChild(node);
        i += consumed;
        continue;
      }
    }

    // 2. 标题（# ~ ######）
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const heading = document.createElement(`h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
      heading.className = `md-h md-h-${level}`;
      appendInlineContent(heading, headingMatch[2]!);
      fragment.appendChild(heading);
      i++;
      continue;
    }

    // 3. 分割线（--- 或 *** 或 ___）
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      const hr = document.createElement('hr');
      hr.className = 'md-hr';
      fragment.appendChild(hr);
      i++;
      continue;
    }

    // 4. 引用块（> ...）
    if (line.trimStart().startsWith('>')) {
      const { node, consumed } = parseBlockquote(lines, i);
      fragment.appendChild(node);
      i += consumed;
      continue;
    }

    // 5. 表格（| a | b | 后跟 |---|---|）
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]+$/.test(lines[i + 1]!)) {
      const { node, consumed } = parseTable(lines, i);
      if (node) {
        fragment.appendChild(node);
        i += consumed;
        continue;
      }
    }

    // 6. 无序列表（- / * / + 开头）
    if (/^\s*[-*+]\s+/.test(line)) {
      const { node, consumed } = parseUnorderedList(lines, i);
      fragment.appendChild(node);
      i += consumed;
      continue;
    }

    // 7. 有序列表（1. / 2. 开头）
    if (/^\s*\d+\.\s+/.test(line)) {
      const { node, consumed } = parseOrderedList(lines, i);
      fragment.appendChild(node);
      i += consumed;
      continue;
    }

    // 8. 普通段落（连续非空行合并为一个 <p>）
    const { node, consumed } = parseParagraph(lines, i);
    fragment.appendChild(node);
    i += consumed;
  }

  return fragment;
}

// ─── 块级元素解析 ─────────────────────────────────────────

/**
 * 解析代码块（```lang ... ```）
 *
 * 支持语言标签高亮（仅作为 CSS 类名，不做语法高亮——保持零依赖）。
 * 若代码块未闭合（流式中常见），渲染到文本末尾。
 *
 * UX-PP-07 代码块独立复制按钮 + 语言标签：
 * 结构为 `<div class="md-code-block">` 包裹 header（语言标签 + 复制按钮）+ `<pre><code>`，
 * 对齐 Trae IDE / Cursor 等大厂对话流的代码块四动作实践（此处实现核心两动作：复制 + 语言标签）。
 *
 * @returns { node: HTMLElement | null, consumed: number }
 */
function parseFencedCodeBlock(
  lines: string[],
  startIdx: number,
): { node: HTMLElement | null; consumed: number } {
  const startLine = lines[startIdx]!.trim();
  // 提取语言标签（```ts 或 ``` 或 ```javascript）
  const langMatch = startLine.match(/^```([\w+-]*)$/);
  const lang = langMatch?.[1] ?? '';

  // 收集代码内容，直到遇到闭合的 ```
  const codeLines: string[] = [];
  let i = startIdx + 1;
  let closed = false;

  while (i < lines.length) {
    if (lines[i]!.trim() === '```') {
      closed = true;
      break;
    }
    codeLines.push(lines[i]!);
    i++;
  }

  // 流式中代码块可能未闭合：仍然渲染已收集的内容
  // 但 consumed 只计算到已处理的行
  const consumed = closed ? i - startIdx + 1 : i - startIdx;

  // UX-PP-07 容器：div.md-code-block 包裹 header + pre
  const container = document.createElement('div');
  container.className = 'md-code-block';

  // 语言标签（经过白名单过滤，作为 data 属性供 CSS 选择）
  const safeLang = lang && LANGUAGE_WHITELIST.test(lang) ? lang : '';
  if (safeLang) {
    container.dataset.lang = safeLang;
  }

  // 代码块头部：语言标签 + 复制按钮
  const header = document.createElement('div');
  header.className = 'md-code-header';

  // 语言标签（若有）
  if (safeLang) {
    const langSpan = document.createElement('span');
    langSpan.className = 'md-code-lang';
    langSpan.textContent = safeLang;
    header.appendChild(langSpan);
  }

  // 复制按钮：data-action="copy-code" 由 ChatPanelManager 事件委托统一处理
  const copyBtn = document.createElement('button');
  copyBtn.className = 'md-code-copy';
  copyBtn.title = '复制代码';
  copyBtn.textContent = '复制';
  copyBtn.dataset.action = 'copy-code';
  // 代码内容作为 data-content 供事件委托读取（textContent 防 XSS）
  copyBtn.dataset.content = codeLines.join('\n');
  header.appendChild(copyBtn);

  container.appendChild(header);

  // 代码主体：pre > code
  const pre = document.createElement('pre');
  pre.className = 'md-code-pre';
  const code = document.createElement('code');
  code.className = 'md-code';
  // 使用 textContent 设置代码内容（防 XSS）
  code.textContent = codeLines.join('\n');
  pre.appendChild(code);
  container.appendChild(pre);

  return { node: container, consumed: consumed > 0 ? consumed : 1 };
}

/**
 * 解析引用块（> ...）
 *
 * 连续的 > 开头行合并为一个 <blockquote>。
 * 支持引用内嵌 Markdown（递归调用 renderMarkdown）。
 */
function parseBlockquote(lines: string[], startIdx: number): { node: HTMLElement; consumed: number } {
  const quoteLines: string[] = [];
  let i = startIdx;

  while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
    // 移除前导 > 和可选空格
    quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''));
    i++;
  }

  const blockquote = document.createElement('blockquote');
  blockquote.className = 'md-blockquote';
  // 递归渲染引用内容（支持嵌套 Markdown）
  blockquote.appendChild(renderMarkdown(quoteLines.join('\n')));

  return { node: blockquote, consumed: i - startIdx };
}

/**
 * 解析表格（| a | b | + |---|---|）
 *
 * 第一行为表头，第二行为分隔符（对齐方式），后续行为数据。
 * 对齐方式：:--- 左对齐，:---: 居中，---: 右对齐。
 */
function parseTable(lines: string[], startIdx: number): { node: HTMLElement | null; consumed: number } {
  const headerLine = lines[startIdx]!;
  const separatorLine = lines[startIdx + 1]!;

  // 解析对齐方式
  const aligns = separatorLine.split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => {
      if (s.startsWith(':') && s.endsWith(':')) return 'center';
      if (s.endsWith(':')) return 'right';
      return 'left';
    });

  // 解析表头单元格
  const headers = splitTableCells(headerLine);
  if (headers.length === 0) return { node: null, consumed: 1 };

  // 收集数据行
  const dataLines: string[] = [];
  let i = startIdx + 2;
  while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
    dataLines.push(lines[i]!);
    i++;
  }

  const table = document.createElement('table');
  table.className = 'md-table';

  // 表头
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headers.forEach((cell, idx) => {
    const th = document.createElement('th');
    th.className = 'md-th';
    if (aligns[idx]) {
      th.style.textAlign = aligns[idx] as 'left' | 'center' | 'right';
    }
    appendInlineContent(th, cell);
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // 数据行
  if (dataLines.length > 0) {
    const tbody = document.createElement('tbody');
    dataLines.forEach(line => {
      const cells = splitTableCells(line);
      const tr = document.createElement('tr');
      cells.forEach((cell, idx) => {
        const td = document.createElement('td');
        td.className = 'md-td';
        if (aligns[idx]) {
          td.style.textAlign = aligns[idx] as 'left' | 'center' | 'right';
        }
        appendInlineContent(td, cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  return { node: table, consumed: i - startIdx };
}

/** 分割表格行单元格（处理转义的 \|） */
function splitTableCells(line: string): string[] {
  // 移除首尾的 |
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // 按未转义的 | 分割
  return trimmed.split(/(?<!\\)\|/)
    .map(s => s.replace(/\\\|/g, '|').trim())
    .filter(s => s.length > 0);
}

/**
 * 解析无序列表（- / * / + 开头）
 *
 * 支持嵌套（通过缩进判断层级）。
 */
function parseUnorderedList(lines: string[], startIdx: number): { node: HTMLElement; consumed: number } {
  const ul = document.createElement('ul');
  ul.className = 'md-ul';

  let i = startIdx;
  let currentLevel = -1;
  // 嵌套栈：每层一个 <ul> 元素
  const stack: HTMLUListElement[] = [ul];

  while (i < lines.length) {
    const match = lines[i]!.match(/^(\s*)([-*+])\s+(.+)$/);
    if (!match) break;

    const indent = match[1]!.length;
    const content = match[3]!;

    // 计算层级（每 2 空格为一级）
    const level = Math.floor(indent / 2);

    if (currentLevel === -1) currentLevel = level;

    // 调整嵌套栈
    if (level > currentLevel) {
      // 进入更深层级：在当前最后一个 <li> 下创建新的 <ul>
      const parentLi = stack[stack.length - 1]!.lastElementChild as HTMLLIElement | null;
      if (parentLi) {
        const nestedUl = document.createElement('ul');
        nestedUl.className = 'md-ul md-ul-nested';
        parentLi.appendChild(nestedUl);
        stack.push(nestedUl);
        currentLevel = level;
      }
    } else if (level < currentLevel) {
      // 返回上层：弹出栈
      while (stack.length > 1 && currentLevel > level) {
        stack.pop();
        currentLevel--;
      }
    }

    const li = document.createElement('li');
    li.className = 'md-li';
    appendInlineContent(li, content);
    stack[stack.length - 1]!.appendChild(li);

    i++;
  }

  return { node: ul, consumed: i - startIdx };
}

/**
 * 解析有序列表（1. / 2. 开头）
 *
 * 支持嵌套（通过缩进判断层级）。
 */
function parseOrderedList(lines: string[], startIdx: number): { node: HTMLElement; consumed: number } {
  const ol = document.createElement('ol');
  ol.className = 'md-ol';

  let i = startIdx;
  let currentLevel = -1;
  const stack: HTMLOListElement[] = [ol];

  while (i < lines.length) {
    const match = lines[i]!.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (!match) break;

    const indent = match[1]!.length;
    const content = match[3]!;

    const level = Math.floor(indent / 2);

    if (currentLevel === -1) currentLevel = level;

    if (level > currentLevel) {
      const parentLi = stack[stack.length - 1]!.lastElementChild as HTMLLIElement | null;
      if (parentLi) {
        const nestedOl = document.createElement('ol');
        nestedOl.className = 'md-ol md-ol-nested';
        parentLi.appendChild(nestedOl);
        stack.push(nestedOl);
        currentLevel = level;
      }
    } else if (level < currentLevel) {
      while (stack.length > 1 && currentLevel > level) {
        stack.pop();
        currentLevel--;
      }
    }

    const li = document.createElement('li');
    li.className = 'md-li';
    appendInlineContent(li, content);
    stack[stack.length - 1]!.appendChild(li);

    i++;
  }

  return { node: ol, consumed: i - startIdx };
}

/**
 * 解析段落（连续非空行合并为一个 <p>）
 *
 * 段落结束条件：空行、代码块开始、标题、列表、引用、表格、分割线。
 */
function parseParagraph(lines: string[], startIdx: number): { node: HTMLElement; consumed: number } {
  const paragraphLines: string[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i]!;
    // 空行结束段落
    if (line.trim() === '') break;
    // 块级元素开始结束段落
    if (line.trimStart().startsWith('```')) break;
    if (/^#{1,6}\s+/.test(line)) break;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) break;
    if (line.trimStart().startsWith('>')) break;
    if (/^\s*[-*+]\s+/.test(line)) break;
    if (/^\s*\d+\.\s+/.test(line)) break;
    // 表格：下一行是分隔符才结束
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]+$/.test(lines[i + 1]!)) break;

    paragraphLines.push(line);
    i++;
  }

  const p = document.createElement('p');
  p.className = 'md-p';
  // 段落内行用 <br> 分隔（保留软换行）
  appendInlineContent(p, paragraphLines.join('\n'));
  // 将 \n 转换为 <br>
  convertNewlinesToBr(p);

  return { node: p, consumed: i - startIdx };
}

// ─── 行内元素解析 ─────────────────────────────────────────

/**
 * 解析行内 Markdown 内容并追加到目标元素
 *
 * 支持的行内元素：
 * - 行内代码 `code`
 * - 加粗 **text**
 * - 斜体 *text*
 * - 链接 [text](url)
 * - 删除线 ~~text~~
 *
 * 处理顺序：先提取行内代码（避免代码内的 * 被误解析），再处理其他格式。
 */
function appendInlineContent(target: HTMLElement, text: string): void {
  // 行内代码正则：`code`（非贪婪）
  const inlineCodeRegex = /`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineCodeRegex.exec(text)) !== null) {
    // 处理代码前的普通文本（可能包含加粗/斜体/链接）
    if (match.index > lastIndex) {
      const beforeText = text.slice(lastIndex, match.index);
      appendFormattedText(target, beforeText);
    }
    // 行内代码
    const code = document.createElement('code');
    code.className = 'md-code-inline';
    code.textContent = match[1]!; // textContent 防 XSS
    target.appendChild(code);

    lastIndex = match.index + match[0].length;
  }

  // 处理剩余文本
  if (lastIndex < text.length) {
    appendFormattedText(target, text.slice(lastIndex));
  }
}

/**
 * 解析加粗、斜体、链接、删除线等格式化文本
 *
 * 使用递归下降解析，按优先级处理：
 * 1. 链接 [text](url)
 * 2. 加粗 **text**
 * 3. 斜体 *text*
 * 4. 删除线 ~~text~~
 * 5. 普通文本
 */
function appendFormattedText(target: HTMLElement, text: string): void {
  // 链接正则：[text](url)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  // 加粗正则：**text**
  const boldRegex = /\*\*([^*]+)\*\*/g;
  // 斜体正则：*text*（避免与加粗冲突）
  const italicRegex = /(?<!\*)\*([^*]+)\*(?!\*)/g;
  // 删除线正则：~~text~~
  const strikethroughRegex = /~~([^~]+)~~/g;

  // 合并所有匹配项，按位置排序
  type InlineMatch = { start: number; end: number; type: 'link' | 'bold' | 'italic' | 'strike'; text: string; url?: string };
  const matches: InlineMatch[] = [];

  collectMatches(linkRegex, text, (m) => {
    matches.push({ start: m.index, end: m.index + m[0].length, type: 'link', text: m[1]!, url: m[2]! });
  });
  collectMatches(boldRegex, text, (m) => {
    matches.push({ start: m.index, end: m.index + m[0].length, type: 'bold', text: m[1]! });
  });
  collectMatches(italicRegex, text, (m) => {
    matches.push({ start: m.index, end: m.index + m[0].length, type: 'italic', text: m[1]! });
  });
  collectMatches(strikethroughRegex, text, (m) => {
    matches.push({ start: m.index, end: m.index + m[0].length, type: 'strike', text: m[1]! });
  });

  // 按位置排序，移除重叠项（保留先出现的）
  matches.sort((a, b) => a.start - b.start);
  const filtered: InlineMatch[] = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m);
      lastEnd = m.end;
    }
  }

  // 构建节点
  let pos = 0;
  for (const m of filtered) {
    // 前面的普通文本
    if (m.start > pos) {
      target.appendChild(document.createTextNode(text.slice(pos, m.start)));
    }

    switch (m.type) {
      case 'link': {
        const a = document.createElement('a');
        a.className = 'md-link';
        a.textContent = m.text; // textContent 防 XSS
        // URL 协议白名单校验
        if (m.url && isSafeUrl(m.url)) {
          a.href = m.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        } else {
          // 不安全 URL：禁用链接，显示为纯文本样式
          a.classList.add('md-link-unsafe');
          a.removeAttribute('href');
        }
        target.appendChild(a);
        break;
      }
      case 'bold': {
        const strong = document.createElement('strong');
        strong.className = 'md-bold';
        // 加粗内可能还有其他格式，递归处理
        appendFormattedText(strong, m.text);
        target.appendChild(strong);
        break;
      }
      case 'italic': {
        const em = document.createElement('em');
        em.className = 'md-italic';
        appendFormattedText(em, m.text);
        target.appendChild(em);
        break;
      }
      case 'strike': {
        const del = document.createElement('del');
        del.className = 'md-strike';
        appendFormattedText(del, m.text);
        target.appendChild(del);
        break;
      }
    }

    pos = m.end;
  }

  // 末尾剩余文本
  if (pos < text.length) {
    target.appendChild(document.createTextNode(text.slice(pos)));
  }
}

/** 收集正则匹配项的辅助函数 */
function collectMatches(
  regex: RegExp,
  text: string,
  callback: (m: RegExpExecArray) => void,
): void {
  const localRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = localRegex.exec(text)) !== null) {
    callback(m);
  }
}

/**
 * 将元素内的 \n 文本节点转换为 <br>
 *
 * 段落内的软换行需要显示为换行，但 textContent 不会渲染 \n。
 * 遍历文本节点，按 \n 分割并插入 <br>。
 *
 * 注意：跳过行内代码（.md-code-inline）内的文本节点，
 * 代码内的换行应保留原样（由 CSS white-space 处理）。
 */
function convertNewlinesToBr(element: HTMLElement): void {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    // 跳过行内代码内的文本节点（代码内换行由 CSS white-space: pre 处理）
    const parent = textNode.parentElement;
    if (parent && parent.classList.contains('md-code-inline')) continue;

    const text = textNode.textContent ?? '';
    if (!text.includes('\n')) continue;

    const fragment = document.createDocumentFragment();
    const parts = text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) {
        fragment.appendChild(document.createElement('br'));
      }
      if (part.length > 0) {
        fragment.appendChild(document.createTextNode(part));
      }
    });
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

// ─── 安全工具 ─────────────────────────────────────────────

/**
 * 校验 URL 是否安全（协议白名单）
 *
 * 防止 javascript:、data: 等危险协议。
 * 相对 URL（如 /path）也允许，但 Electron 中通常无意义。
 */
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;

  // 相对 URL 允许
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;

  try {
    const parsed = new URL(trimmed);
    return ALLOWED_LINK_PROTOCOLS.includes(parsed.protocol as typeof ALLOWED_LINK_PROTOCOLS[number]);
  } catch {
    // 非 URL 格式（如纯文本），不允许作为链接
    return false;
  }
}
