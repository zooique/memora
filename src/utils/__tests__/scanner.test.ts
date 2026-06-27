/**
 * 单元测试：Markdown 目录扫描工具
 *
 * 覆盖 scanMarkdownDir / parseKeywords / parseTrigger / resolveSubdir：
 *   - scanMarkdownDir：目录不存在降级返回空数组
 *   - scanMarkdownDir：正常扫描 *.md 并解析 frontmatter
 *   - scanMarkdownDir：排除隐藏文件、_ 前缀、README/CHANGELOG/LICENSE
 *   - scanMarkdownDir：name 字段缺失时回退到文件名
 *   - scanMarkdownDir：解析失败的文件跳过并 warn
 *   - parseKeywords：逗号分隔、trim、过滤空值
 *   - parseTrigger：/pattern/flags 与纯 pattern 两种格式
 *   - parseTrigger：非法正则降级返回 undefined
 *   - resolveSubdir：configDir 为 undefined 返回 undefined
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  scanMarkdownDir,
  parseKeywords,
  parseTrigger,
  resolveSubdir,
} from '@/utils/scanner.js';
import { setLogger } from '@/utils/loggerHolder.js';

describe('utils/scanner', () => {
  let tempDir: string;

  beforeEach(async () => {
    setLogger(undefined);
    tempDir = await mkdtemp(join(tmpdir(), 'memora-scanner-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('scanMarkdownDir', () => {
    it('目录不存在应返回空数组', async () => {
      const result = await scanMarkdownDir(join(tempDir, 'not-exists'));
      expect(result).toEqual([]);
    });

    it('应扫描目录下的 *.md 文件并解析 frontmatter', async () => {
      await writeFile(
        join(tempDir, 'rule1.md'),
        `---
name: 规则一
keywords: 记忆, 归档
---
# 规则一正文`,
      );
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('规则一');
      expect(result[0]?.frontmatter['name']).toBe('规则一');
      expect(result[0]?.frontmatter['keywords']).toBe('记忆, 归档');
      expect(result[0]?.body).toContain('# 规则一正文');
      expect(result[0]?.filePath).toBe(join(tempDir, 'rule1.md'));
    });

    it('应扫描多个 *.md 文件', async () => {
      await writeFile(join(tempDir, 'a.md'), '---\nname: A\n---\nA body');
      await writeFile(join(tempDir, 'b.md'), '---\nname: B\n---\nB body');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(2);
      const names = result.map((e) => e.name).sort();
      expect(names).toEqual(['A', 'B']);
    });

    it('应排除以 . 开头的隐藏文件', async () => {
      await writeFile(join(tempDir, '.hidden.md'), '---\nname: hidden\n---\n');
      await writeFile(join(tempDir, 'visible.md'), '---\nname: visible\n---\n');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('visible');
    });

    it('应排除以 _ 开头的私有文件', async () => {
      await writeFile(join(tempDir, '_private.md'), '---\nname: private\n---\n');
      await writeFile(join(tempDir, 'public.md'), '---\nname: public\n---\n');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('public');
    });

    it('应排除 README.md / CHANGELOG.md / LICENSE', async () => {
      await writeFile(join(tempDir, 'README.md'), '---\nname: readme\n---\n');
      await writeFile(join(tempDir, 'CHANGELOG.md'), '---\nname: changelog\n---\n');
      await writeFile(join(tempDir, 'LICENSE'), '---\nname: license\n---\n');
      await writeFile(join(tempDir, 'rule.md'), '---\nname: rule\n---\n');
      const result = await scanMarkdownDir(tempDir);
      // LICENSE 不以 .md 结尾，本就不被扫描；README/CHANGELOG 应被排除
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('rule');
    });

    it('应排除非 .md 扩展名的文件', async () => {
      await writeFile(join(tempDir, 'note.txt'), '---\nname: note\n---\n');
      await writeFile(join(tempDir, 'data.json'), '{}');
      await writeFile(join(tempDir, 'rule.md'), '---\nname: rule\n---\n');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('rule');
    });

    it('frontmatter 无 name 字段时回退到文件名（去 .md）', async () => {
      await writeFile(join(tempDir, 'fallback.md'), '---\nkeywords: test\n---\nbody');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('fallback');
    });

    it('无 frontmatter 的 *.md 文件应被正常扫描（frontmatter 为空对象）', async () => {
      await writeFile(join(tempDir, 'plain.md'), '# 纯正文\n无 frontmatter');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.frontmatter).toEqual({});
      expect(result[0]?.name).toBe('plain'); // 回退到文件名
      expect(result[0]?.body).toContain('纯正文');
    });

    it('空目录应返回空数组', async () => {
      const result = await scanMarkdownDir(tempDir);
      expect(result).toEqual([]);
    });

    it('子目录中的 *.md 不应被扫描（readdir 非递归）', async () => {
      await mkdir(join(tempDir, 'subdir'));
      await writeFile(join(tempDir, 'subdir', 'nested.md'), '---\nname: nested\n---\n');
      await writeFile(join(tempDir, 'top.md'), '---\nname: top\n---\n');
      const result = await scanMarkdownDir(tempDir);
      // readdir 返回子目录名，endsWith('.md') 过滤掉 'subdir'
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('top');
    });
  });

  describe('parseKeywords', () => {
    it('应按逗号分隔并 trim', () => {
      const result = parseKeywords({ keywords: '记忆, 归档 , 衰减' });
      expect(result).toEqual(['记忆', '归档', '衰减']);
    });

    it('应过滤空字符串', () => {
      const result = parseKeywords({ keywords: 'a, , b, ,c' });
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('字段不存在应返回空数组', () => {
      expect(parseKeywords({})).toEqual([]);
      expect(parseKeywords({ other: 'x' })).toEqual([]);
    });

    it('字段为空字符串应返回空数组', () => {
      expect(parseKeywords({ keywords: '' })).toEqual([]);
    });

    it('应支持自定义字段名', () => {
      const result = parseKeywords({ tags: 'a, b, c' }, 'tags');
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('纯空白字符串应返回空数组', () => {
      expect(parseKeywords({ keywords: '   ' })).toEqual([]);
    });

    it('单个关键词应返回单元素数组', () => {
      expect(parseKeywords({ keywords: 'solo' })).toEqual(['solo']);
    });

    it('非字符串值应通过 String() 转换', () => {
      // frontmatter 类型是 Record<string, string>，但运行时可能传入其他类型
      const result = parseKeywords({ keywords: 'a,b,c' } as Record<string, string>);
      expect(result).toEqual(['a', 'b', 'c']);
    });
  });

  describe('parseTrigger', () => {
    it('应解析 /pattern/flags 格式', () => {
      const result = parseTrigger({ trigger: '/hello/g' });
      expect(result).toBeInstanceOf(RegExp);
      expect(result?.source).toBe('hello');
      expect(result?.flags).toBe('g');
    });

    it('应解析 /pattern/flags 的多标志', () => {
      const result = parseTrigger({ trigger: '/test/gim' });
      expect(result?.flags).toBe('gim');
    });

    it('纯 pattern 应使用默认 i 标志', () => {
      const result = parseTrigger({ trigger: 'hello' });
      expect(result?.source).toBe('hello');
      expect(result?.flags).toBe('i');
    });

    it('字段不存在应返回 undefined', () => {
      expect(parseTrigger({})).toBeUndefined();
      expect(parseTrigger({ other: 'x' })).toBeUndefined();
    });

    it('字段为空字符串应返回 undefined', () => {
      expect(parseTrigger({ trigger: '' })).toBeUndefined();
    });

    it('非法正则应返回 undefined 并 warn', () => {
      // 未闭合的字符类是非法正则
      const result = parseTrigger({ trigger: '[invalid' });
      expect(result).toBeUndefined();
    });

    it('应支持自定义字段名', () => {
      const result = parseTrigger({ pattern: '/abc/g' }, 'pattern');
      expect(result?.source).toBe('abc');
      expect(result?.flags).toBe('g');
    });

    it('带空白前后的 pattern 应正确 trim', () => {
      const result = parseTrigger({ trigger: '  /hello/g  ' });
      expect(result?.source).toBe('hello');
      expect(result?.flags).toBe('g');
    });
  });

  describe('resolveSubdir', () => {
    it('configDir 存在时应返回 resolve 拼接的绝对路径', () => {
      // resolveSubdir 内部使用 resolve()，会返回带盘符的绝对路径
      const result = resolveSubdir('/path/to/config', 'rules');
      expect(result).toBe(resolve('/path/to/config', 'rules'));
    });

    it('configDir 为 undefined 时应返回 undefined', () => {
      expect(resolveSubdir(undefined, 'rules')).toBeUndefined();
    });

    it('应支持多级子目录', () => {
      const result = resolveSubdir('/config', 'a/b/c');
      expect(result).toBe(resolve('/config', 'a/b/c'));
    });

    it('configDir 为空字符串时应返回 undefined（falsy 短路）', () => {
      // 空字符串是 falsy，触发 if (!configDir) 分支
      expect(resolveSubdir('', 'rules')).toBeUndefined();
    });
  });
});
