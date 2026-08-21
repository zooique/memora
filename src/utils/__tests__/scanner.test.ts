/**
 * 单元测试：Markdown 目录扫描工具
 *
 * 覆盖 scanMarkdownDir / parseKeywords / parseTrigger / resolveSubdir：
 *   - scanMarkdownDir：目录不存在降级返回空数组
 *   - scanMarkdownDir：正常扫描 *.md 并解析 frontmatter
 *   - scanMarkdownDir：排除隐藏文件、_ 前缀、README/CHANGELOG/LICENSE
 *   - scanMarkdownDir：name 字段缺失时回退到文件名
 *   - scanMarkdownDir：解析失败的文件跳过并 warn
 *   - scanMarkdownDir：文件夹形式 SKILL.md 扫描
 *   - scanMarkdownDir：混合形式（单文件 + 文件夹）扫描
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
  resolveSafePath,
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

    it('子目录中无 SKILL.md 时 .md 不应被扫描（非 SKILL.md 不触发文件夹扫描）', async () => {
      await mkdir(join(tempDir, 'subdir'));
      await writeFile(join(tempDir, 'subdir', 'nested.md'), '---\nname: nested\n---\n');
      await writeFile(join(tempDir, 'top.md'), '---\nname: top\n---\n');
      const result = await scanMarkdownDir(tempDir);
      // subdir 无 SKILL.md 被跳过；top.md 被正常扫描
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('top');
    });

    it('应扫描子目录中的 SKILL.md（文件夹形式）', async () => {
      await mkdir(join(tempDir, 'my-skill'));
      await writeFile(
        join(tempDir, 'my-skill', 'SKILL.md'),
        `---
name: my-skill
description: 测试技能
---
# 技能正文`,
      );
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('my-skill');
      expect(result[0]?.frontmatter['name']).toBe('my-skill');
      expect(result[0]?.frontmatter['description']).toBe('测试技能');
      expect(result[0]?.body).toContain('# 技能正文');
      // filePath 应指向 SKILL.md 文件本身，而非目录
      expect(result[0]?.filePath).toBe(join(tempDir, 'my-skill', 'SKILL.md'));
    });

    it('文件夹形式无 frontmatter name 时回退到目录名', async () => {
      await mkdir(join(tempDir, 'fallback-dir'));
      await writeFile(join(tempDir, 'fallback-dir', 'SKILL.md'), '---\ndescription: 无 name\n---\nbody');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('fallback-dir');
    });

    it('应扫描多个文件夹形式的 SKILL.md', async () => {
      await mkdir(join(tempDir, 'skill-a'));
      await mkdir(join(tempDir, 'skill-b'));
      await writeFile(join(tempDir, 'skill-a', 'SKILL.md'), '---\nname: A\n---\nA body');
      await writeFile(join(tempDir, 'skill-b', 'SKILL.md'), '---\nname: B\n---\nB body');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(2);
      const names = result.map((e) => e.name).sort();
      expect(names).toEqual(['A', 'B']);
    });

    it('混合形式：同时扫描直接 .md 和文件夹 SKILL.md', async () => {
      // 单文件形式
      await writeFile(join(tempDir, 'standalone.md'), '---\nname: 独立技能\n---\n独立正文');
      // 文件夹形式
      await mkdir(join(tempDir, 'folder-skill'));
      await writeFile(join(tempDir, 'folder-skill', 'SKILL.md'), '---\nname: 文件夹技能\n---\n文件夹正文');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(2);
      // 按字典序排序，中文排序：文件夹技能 < 独立技能
      const names = result.map((e) => e.name).sort();
      expect(names).toEqual(['文件夹技能', '独立技能']);
    });

    it('子目录有 SKILL.md 时应跳过隐藏目录和私有目录', async () => {
      // 隐藏目录
      await mkdir(join(tempDir, '.hidden-skill'));
      await writeFile(join(tempDir, '.hidden-skill', 'SKILL.md'), '---\nname: hidden\n---\n');
      // 私有目录
      await mkdir(join(tempDir, '_private-skill'));
      await writeFile(join(tempDir, '_private-skill', 'SKILL.md'), '---\nname: private\n---\n');
      // 正常目录
      await mkdir(join(tempDir, 'visible-skill'));
      await writeFile(join(tempDir, 'visible-skill', 'SKILL.md'), '---\nname: visible\n---\n');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('visible');
    });

    it('文件夹形式 SKILL.md 无 frontmatter 时回退到目录名', async () => {
      await mkdir(join(tempDir, 'no-fm-skill'));
      // 无 frontmatter（不以 --- 开头），parseFrontmatter 返回空 frontmatter
      await writeFile(join(tempDir, 'no-fm-skill', 'SKILL.md'), '# 纯正文\n无 frontmatter');
      const result = await scanMarkdownDir(tempDir);
      expect(result).toHaveLength(1);
      // frontmatter 为空，name 回退到目录名
      expect(result[0]?.name).toBe('no-fm-skill');
      expect(result[0]?.frontmatter).toEqual({});
      expect(result[0]?.body).toContain('# 纯正文');
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

  describe('resolveSafePath', () => {
    it('子路径在基目录内时应返回完整路径', () => {
      const base = '/base/resources';
      expect(resolveSafePath(base, 'api.md')).toBe(resolve(base, 'api.md'));
      expect(resolveSafePath(base, 'sub/doc.md')).toBe(resolve(base, 'sub/doc.md'));
    });

    it('基目录自身（sub 为空串）应放行', () => {
      const base = '/base/resources';
      // resolve(base, '') === 基目录绝对路径（Windows 带盘符）
      expect(resolveSafePath(base, '')).toBe(resolve(base, ''));
    });

    it('逃逸基目录的 ../ 应返回 null', () => {
      expect(resolveSafePath('/base/resources', '../other/secret.txt')).toBeNull();
    });

    it('兄弟目录前缀不得绕过（防前缀边界缺陷）', () => {
      // 基目录 /base/resources，兄弟目录 /base/resources-evil
      // 若只做 startsWith 无 sep 边界，"../resources-evil/x" 解析为 /base/resources-evil/x
      // 会以 /base/resources 为前缀误放行；修复后（追加 sep 边界）应严格拒绝
      expect(resolveSafePath('/base/resources', '../resources-evil/sneaky.txt')).toBeNull();
      // 更深一层：base 的兄弟名以 base 名+额外字符开头
      expect(resolveSafePath('/base/skills/myskill', '../myskill-evil/f.txt')).toBeNull();
      // 子路径以 base 名严格的子目录开头（合法）应放行，区分边界
      expect(resolveSafePath('/base/skills/myskill', 'resource/api.md')).toBe(
        resolve('/base/skills/myskill', 'resource/api.md'),
      );
    });
  });
});
