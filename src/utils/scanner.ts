/**
 * Markdown 目录扫描工具
 *
 * 从 PersonaManager / SkillManager 提取的公共目录扫描逻辑，
 * 消除跨模块重复的"扫描 *.md → 解析 frontmatter → 提取字段"代码。
 *
 * 使用异步 I/O（与 FileStore / ToolExecutor 保持一致）。
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { parseFrontmatter } from '@/utils/frontmatter.js';
import { getLogger } from '@/utils/loggerHolder.js';

/** 排除的文件名（README / CHANGELOG / LICENSE 不纳入扫描） */
const EXCLUDED_FILES = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);

/** 扫描结果条目（通用 frontmatter 解析产物） */
export interface ScannedMarkdownEntry {
  /** 名称（frontmatter name 字段或文件名去 .md） */
  name: string;
  /** frontmatter 原始键值对 */
  frontmatter: Record<string, string>;
  /** frontmatter 之后的正文 */
  body: string;
  /** 文件绝对路径 */
  filePath: string;
}

/**
 * 扫描目录下的 *.md 文件，解析 frontmatter
 *
 * 排除规则：
 *   - 文件名以 `.` 开头的隐藏文件
 *   - 文件名以 `_` 前缀的私有文件
 *   - README.md / CHANGELOG.md / LICENSE
 *
 * @param dir 目录路径
 * @returns 解析后的条目列表
 */
export async function scanMarkdownDir(dir: string): Promise<ScannedMarkdownEntry[]> {
  try {
    await access(dir);
  } catch {
    getLogger().debug({ dir }, '扫描目录不存在，跳过');
    return [];
  }

  let files: string[];
  try {
    files = (await readdir(dir)).filter(
      (f) =>
        f.endsWith('.md') &&
        !f.startsWith('.') &&
        !f.startsWith('_') &&
        !EXCLUDED_FILES.has(f),
    );
  } catch {
    getLogger().warn({ dir }, '扫描目录失败');
    return [];
  }

  const entries: ScannedMarkdownEntry[] = [];

  for (const file of files) {
    try {
      const filePath = join(dir, file);
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter: fm, body } = parseFrontmatter(raw);

      entries.push({
        name: fm['name'] ?? basename(file, '.md'),
        frontmatter: fm as Record<string, string>,
        body,
        filePath,
      });
    } catch (err) {
      getLogger().warn({ file, err }, '解析 Markdown 文件失败');
    }
  }

  return entries;
}

/**
 * 从 frontmatter 中解析逗号分隔的关键词列表
 *
 * @param fm frontmatter 键值对
 * @param key 关键词字段名（默认 'keywords'）
 * @returns 关键词数组
 */
export function parseKeywords(fm: Record<string, string>, key = 'keywords'): string[] {
  const raw = fm[key];
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 从 frontmatter 中解析正则触发器
 *
 * 支持格式：/pattern/flags 或纯 pattern（默认 'i' flag）
 *
 * @param fm frontmatter 键值对
 * @param key 触发器字段名（默认 'trigger'）
 * @returns 正则表达式，解析失败返回 undefined
 */
export function parseTrigger(fm: Record<string, string>, key = 'trigger'): RegExp | undefined {
  const raw = fm[key];
  if (!raw) return undefined;

  try {
    const pattern = String(raw).trim();
    const match = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    // QC-17 移除非空断言：使用空值合并回退到 pattern（与 match 为 null 时逻辑一致）
    const clean = match?.[1] ?? pattern;
    return new RegExp(clean, 'i');
  } catch {
    getLogger().warn({ trigger: raw }, '触发正则无效，已忽略');
    return undefined;
  }
}

/**
 * 解析目录路径：如果 configDir 存在则 resolve 子目录，否则返回 undefined
 */
export function resolveSubdir(configDir: string | undefined, sub: string): string | undefined {
  if (!configDir) return undefined;
  return resolve(configDir, sub);
}
