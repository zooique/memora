/**
 * Frontmatter 通用解析/序列化工具
 *
 * 直接消费者为 utils/scanner.ts、skill/skillManager.ts、role-pack/rolePackManager.ts（frontmatter 解析），
 * 并经 index.ts 导出供宿主复用。
 */

/**
 * 解析 frontmatter 块为键值对
 *
 * 合法性约定：
 *   - 空 frontmatter 块（`---\n\n---\nbody`）合法，返回 `{ frontmatter: {}, body }`
 *   - 空 body（`---\nkey: val\n---\n`，纯元数据文件）合法，返回 `{ frontmatter, body: '' }`
 *   - 两者都空（`---\n---\n`）合法，返回 `{ frontmatter: {}, body: '' }`
 *   - 仅当输入不匹配 `^---\n...\n---\n...$` 结构时，才返回 fallback `{ frontmatter: {}, body: raw }`
 *
 * @param raw 完整 markdown 内容（含 `---` 包围的 frontmatter）
 * @returns `{ frontmatter, body }`——frontmatter 为键值对对象，body 为 frontmatter 之后的内容
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  // 结束 `---` 后允许可选换行（\n?），兼容"以 --- 收尾无尾随换行"的合法文件；
  // 已先规整掉末尾换行（\n+$），避免"文件以 --- 结尾"被误判为不匹配而整体落入 body。
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  // 仅当结构不匹配时返回 fallback；空 frontmatter 块和空 body 块为合法输入
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  // match[1] / match[2] 类型为 string | undefined，但 regex 已确保结构匹配时两者必有值
  // 使用显式非空断言告诉 TS 这两个捕获组在通过 !match 检查后必为 string
  const fmBlock = match[1] ?? '';
  const body = match[2] ?? '';
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
