/**
 * Frontmatter 通用解析/序列化工具
 *
 * 为 memory/store.ts、persona/personaManager.ts、skill/skillManager.ts 提供共享的 frontmatter 处理
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 */

/**
 * 解析 frontmatter 块为键值对
 *
 * @param raw 完整 markdown 内容（含 `---` 包围的 frontmatter）
 * @returns `{ frontmatter, body }`——frontmatter 为键值对对象，body 为 frontmatter 之后的内容
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match || !match[1] || !match[2]) {
    return { frontmatter: {}, body: raw };
  }

  const [, fmBlock, body] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) frontmatter[k] = v;
  }

  return { frontmatter, body };
}

/**
 * 序列化 frontmatter 为 YAML 块内容（不含 `---` 包围符）
 *
 * @param frontmatter 键值对对象
 * @returns 可拼接进 `---\n${result}\n---\n${body}` 的字符串
 */
export function serializeFrontmatter(frontmatter: Record<string, string>): string {
  return Object.entries(frontmatter)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
