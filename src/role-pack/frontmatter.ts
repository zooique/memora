/**
 * 角色包专用 frontmatter 解析器（轻量 YAML 子集）
 *
 * 为什么独立于 utils/frontmatter.ts：
 *   - utils/frontmatter.ts 是扁平键值对解析（`key: value` 逐行），被 memory/store.ts
 *     与 scanner.ts（persona/skill）共享——改它会破坏共享消费者；
 *   - 角色包规范（role-pack-spec §二）定案**嵌套 YAML**（strategy 嵌套对象、skills 结构化数组），
 *     是角色包特有需求，因此在本模块内实现轻量子集解析器。
 *
 * 支持子集（角色包 frontmatter 实际用到的形状）：
 *   - 标量：字符串 / 数字 / 布尔 / null / 空值
 *   - 内联数组：`[a, b, c]`
 *   - 块序列：`- item`（每项缩进同级）
 *   - 嵌套映射：缩进表达层级（2 空格为标准，兼容任意一致缩进）
 *   - 行内注释：`#` 后内容忽略（不处理引号内的 #，角色包 frontmatter 不涉及）
 *
 * 不支持（超出子集即抛错，由调用方降级处理）：
 *   - 引号转义 / 多行字符串（| / >）
 *   - 锚点 / 别名 / 合并键
 *   - 复杂类型（时间戳 / 十六进制 / 科学计数）
 *
 * 未知键策略（对齐 spec §五「L2 未知键警告并忽略」）：
 *   - 解析器保留全部键，由调用方（rolePackManager）决定哪些是未知键；
 *   - 解析器自身只做形状解析，不判键名。
 */

/** 解析结果 */
export interface ParsedRolePackFrontmatter {
  /** 嵌套 frontmatter 对象（YAML 映射） */
  frontmatter: Record<string, unknown>;
  /** frontmatter 之后的正文（不含结束 `---`） */
  body: string;
}

/** 内部行结构：缩进 + 内容 */
interface FmLine {
  indent: number;
  content: string;
}

/**
 * 解析角色包 frontmatter 块为嵌套对象
 *
 * @param raw 完整 markdown 内容（含 `---` 包围的 frontmatter）
 * @returns 嵌套 frontmatter + body；结构不匹配时返回空 frontmatter + 原始内容
 */
export function parseRolePackFrontmatter(raw: string): ParsedRolePackFrontmatter {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const fmBlock = match[1] ?? '';
  const body = match[2] ?? '';

  const lines = tokenize(fmBlock);
  if (lines.length === 0) {
    return { frontmatter: {}, body };
  }

  const parsed = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  const frontmatter = isMapping(parsed) ? parsed : {};
  return { frontmatter, body };
}

/**
 * 将 frontmatter 块切成带缩进的行，剔除空行与注释
 */
function tokenize(fmBlock: string): FmLine[] {
  const lines: FmLine[] = [];
  for (const rawLine of fmBlock.split('\n')) {
    // 去行尾空白
    const trimmedRight = rawLine.replace(/\s+$/, '');
    if (trimmedRight.trim() === '') continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    let content = rawLine.trim();
    // 行内注释（# 前有空白才认为是注释分隔，避免 `a#b` 被截断）
    const hashIdx = content.indexOf(' #');
    if (hashIdx >= 0) content = content.slice(0, hashIdx).trim();
    if (content === '') continue;
    lines.push({ indent, content });
  }
  return lines;
}

/** 解析结果：映射或序列 */
type ParsedBlock = Record<string, unknown> | unknown[];

/** 判断是否为映射 */
function isMapping(v: ParsedBlock): v is Record<string, unknown> {
  return !Array.isArray(v);
}

/**
 * 从指定行开始解析一个块（映射或序列）
 *
 * @param lines 全部行
 * @param start 起始行下标
 * @param indent 该块的基准缩进
 * @returns 解析结果
 */
function parseBlock(lines: FmLine[], start: number, indent: number): ParsedBlock {
  const first = lines[start];
  if (!first) return {};
  if (first.content.startsWith('- ')) {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

/**
 * 解析映射块：`key: value` / `key:` / `key: [a, b]` / `key:` + 缩进子块
 */
function parseMapping(lines: FmLine[], start: number, indent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    // 缩进变浅：本块结束
    if (line.indent < indent) break;
    // 同缩进但属于上一块的序列项：异常（调用方校验）
    if (line.indent > indent) {
      // 理论不可达（子块在 parseValue 内消费），防御性跳过
      i++;
      continue;
    }
    if (line.content.startsWith('- ')) break;

    const colonIdx = line.content.indexOf(':');
    if (colonIdx < 0) {
      // 非键值行：跳过（宽松）
      i++;
      continue;
    }
    const key = line.content.slice(0, colonIdx).trim();
    const rawValue = line.content.slice(colonIdx + 1).trim();

    if (key === '') {
      i++;
      continue;
    }

    if (rawValue === '') {
      // 值为空：可能是嵌套块或空值
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const child = parseBlock(lines, i + 1, next.indent);
        result[key] = child;
        // 跳过分隔子块与父级之间的行：由 while 循环按缩进判断
        i++;
        // 找到子块结束后的下一个同缩进行
        while (i < lines.length && lines[i]!.indent > indent) i++;
      } else {
        result[key] = null;
        i++;
      }
      continue;
    }

    result[key] = parseScalar(rawValue);
    i++;
  }

  return result;
}

/**
 * 解析块序列：`- item` / `- key: value`（映射项）
 */
function parseSequence(lines: FmLine[], start: number, indent: number): unknown[] {
  const result: unknown[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      // 前一序列项的嵌套内容：已在下方消费，防御性跳过
      i++;
      continue;
    }
    if (!line.content.startsWith('- ')) break;

    const itemRaw = line.content.slice(2).trim();
    const colonIdx = itemRaw.indexOf(':');
    const isMappingItem = colonIdx > 0 && !itemRaw.startsWith('[');

    if (!isMappingItem) {
      result.push(parseScalar(itemRaw));
      i++;
      continue;
    }

    // 映射项：`- key: value` 或 `- key:` + 缩进子块
    const key = itemRaw.slice(0, colonIdx).trim();
    const valueRaw = itemRaw.slice(colonIdx + 1).trim();
    const item: Record<string, unknown> = {};
    if (valueRaw === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const child = parseBlock(lines, i + 1, next.indent);
        item[key] = child;
        i++;
        while (i < lines.length && lines[i]!.indent > indent) i++;
      } else {
        item[key] = null;
        i++;
      }
    } else {
      item[key] = parseScalar(valueRaw);
      i++;
    }

    // 映射项的后继字段：`- key: value` 后同序列项缩进更深但未超出子块的行
    // （如 `- capability: file:write` 后跟 `  description: ...` 缩进 2 > 序列 indent 0）
    // 需继续收集到该映射项的其余键
    while (
      i < lines.length &&
      lines[i]!.indent > indent &&
      !lines[i]!.content.startsWith('- ')
    ) {
      const subLine = lines[i]!;
      const subColon = subLine.content.indexOf(':');
      if (subColon < 0) {
        i++;
        continue;
      }
      const subKey = subLine.content.slice(0, subColon).trim();
      const subValue = subLine.content.slice(subColon + 1).trim();
      if (subValue === '') {
        const next = lines[i + 1];
        if (next && next.indent > subLine.indent) {
          const child = parseBlock(lines, i + 1, next.indent);
          item[subKey] = child;
          i++;
          while (i < lines.length && lines[i]!.indent > subLine.indent) i++;
        } else {
          item[subKey] = null;
          i++;
        }
      } else {
        item[subKey] = parseScalar(subValue);
        i++;
      }
    }

    result.push(item);
  }

  return result;
}

/**
 * 解析标量：内联数组 / 数字 / 布尔 / null / 字符串
 */
function parseScalar(raw: string): unknown {
  const t = raw.trim();

  // 内联数组 [a, b, c]
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }

  // 数字
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  // 布尔
  if (t === 'true') return true;
  if (t === 'false') return false;
  // null / 空
  if (t === 'null' || t === '~') return null;
  // 字符串（去引号，若有）
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}
